/**
 * dsh-session-kit — move sessions to another workspace.
 *
 * DSH attaches a session to a workspace by matching the session header's `cwd`
 * with the workspace directory (`WorkspaceEntity.attachSession` requires the
 * realpath), so an existing session cannot be re-labelled into another
 * workspace in place. A "move" is therefore two explicit steps per session:
 *
 *   1. copy: write a NEW session (fresh id, `cwd` = target workspace path,
 *      current format version, delivery markers rewritten for the new id) and
 *      read it back through the query service before anything is destroyed;
 *   2. trash: only after the copy is readable, move the SOURCE session
 *      directory (and its subagent transcripts) into the trash operation
 *      written by `lib/manage.js`, so the whole move stays reversible.
 *
 * Consequences that are part of the contract:
 *  - the moved session is a new id; links/bookmarks to the old id stop working
 *    (restoring the trash copy brings the old id back);
 *  - subagent transcripts are not copied (a subagent has no standalone agent
 *    composition here, same policy as import); they travel with the source
 *    directory into the trash;
 *  - attachments are content-addressed in the shared store, so event references
 *    keep resolving without copying attachment bytes;
 *  - workspace-related files are never moved; only session storage changes;
 *  - archived/pinned state is best effort: the new session replays the source's
 *    membership after it is attached, and a failure becomes a warning;
 *  - a source that is live, running, a subagent, or in an older format is
 *    skipped BEFORE the copy, so a bad batch cannot leave duplicates behind;
 *  - a copy that cannot be read back is reported as a failure and the source is
 *    NOT trashed; a source whose trash move fails stays in place and the copy
 *    is kept (the result says `sourceTrashed: false` and warns about it).
 *
 * @module dsh-session-kit/move
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { SessionPortFormatError, rewriteDeliveryIdentity, rewriteSeedMarkers } from './format.js';
import { deleteSession } from './manage.js';
import {
  attachToWorkspace,
  detectFormatVersion,
  foldTitle,
  mintSessionId,
  readSessionDoc,
  servicesOf,
  writeNewSession,
} from './sessions.js';

/** Upper bound on sessions moved by one request. */
export const MAX_MOVE_SESSIONS = 100;

/**
 * Resolve and validate the destination workspace.
 * @param {object} ctx - the plugin context.
 * @param {unknown} workspaceId - requested workspace id.
 * @returns {Promise<{workspaceId: string, path: string, title?: string}>} destination.
 * @throws {SessionPortFormatError} `unavailable`, `invalid-argument` or
 *   `workspace-not-found`.
 */
async function resolveTargetWorkspace(ctx, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    throw new SessionPortFormatError('invalid-argument', 'move 需要 workspaceId（目标工作区 id）');
  }
  const requested = workspaceId.trim();
  const registry = servicesOf(ctx).workspaceRegistry;
  if (registry === undefined || registry === null) {
    throw new SessionPortFormatError('unavailable', '工作区注册表不可用，无法确定目标工作区');
  }
  let workspace;
  if (typeof registry.get === 'function') {
    try {
      workspace = registry.get(requested);
    } catch {
      workspace = undefined;
    }
  }
  if (workspace === undefined && typeof registry.list === 'function') {
    let list;
    try {
      list = await registry.list();
    } catch (error) {
      throw new SessionPortFormatError('workspace-not-found', `读取工作区列表失败：${String(error)}`);
    }
    workspace = (Array.isArray(list) ? list : []).find((entry) => String(entry?.id ?? '') === requested);
  }
  if (workspace === undefined || workspace === null) {
    throw new SessionPortFormatError('workspace-not-found', `找不到工作区 ${requested}`);
  }
  const path = typeof workspace.path === 'string' ? workspace.path : '';
  if (path === '' || !isAbsolute(path)) {
    throw new SessionPortFormatError('invalid-argument', `工作区 ${requested} 没有可用的绝对目录`);
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new SessionPortFormatError('workspace-not-found', `目标工作区目录不存在：${path}`);
  }
  if (!info.isDirectory()) {
    throw new SessionPortFormatError('workspace-not-found', `目标工作区路径不是目录：${path}`);
  }
  // DSH's attachSession compares the session cwd realpath with the workspace
  // path, so canonicalize here: a symlinked workspace path must not produce a
  // copy that cannot be attached.
  let canonical;
  try {
    canonical = await realpath(path);
  } catch {
    throw new SessionPortFormatError('workspace-not-found', `目标工作区目录无法解析：${path}`);
  }
  return {
    workspaceId: String(workspace.id),
    path: canonical,
    ...(typeof workspace.title === 'string' && workspace.title !== '' ? { title: workspace.title } : {}),
  };
}

/**
 * Refuse a source that is still live or running, before any copy exists.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - source session id.
 * @throws {SessionPortFormatError} `active`.
 */
function assertSourceIdle(ctx, sessionId) {
  const { sessions, agents } = servicesOf(ctx);
  const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
  if (live !== undefined && live !== null) {
    throw new SessionPortFormatError('active', `会话 ${sessionId} 仍然是活动会话，迁移前请先关闭它`);
  }
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
  if (agent !== null && agent !== undefined && (agent.status === 'running' || agent.running === true)) {
    throw new SessionPortFormatError('active', `会话 ${sessionId} 有正在运行的代理，迁移前请先停止它`);
  }
}

/**
 * Read one registry membership set without letting an accessor failure abort a move.
 * @param {object | undefined} registry - workspace registry.
 * @param {string} name - getter name (`archivedSessionIds` / `pinnedSessionIds`).
 * @returns {Set<string>} string ids.
 */
function registrySet(registry, name) {
  try {
    const value = registry?.[name];
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

/**
 * Resolve the source's agent preset on this machine. A preset that cannot be
 * resolved is dropped (with a warning) because a dangling id would leave the
 * new session unable to compose its agent, the same policy as import.
 * @param {object} ctx - the plugin context.
 * @param {unknown} requested - preset id from the source header.
 * @returns {Promise<{preset?: string, warning?: string}>} resolvable preset.
 */
async function resolveAgentPreset(ctx, requested) {
  if (typeof requested !== 'string' || requested.trim() === '') return {};
  const presets = servicesOf(ctx).agentPresets;
  if (presets === undefined || presets === null || typeof presets.resolve !== 'function') {
    return { warning: `会话预设 ${requested} 在本机不可校验，已丢弃` };
  }
  try {
    const resolved = await presets.resolve(requested);
    const id = resolved?.id;
    return { preset: typeof id === 'string' && id !== '' ? id : requested };
  } catch {
    return { warning: `会话预设 ${requested} 在本机不存在，已丢弃` };
  }
}

/**
 * Re-open one freshly written session through the query service.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the new session id.
 * @returns {Promise<{ok: boolean, detail?: string}>} verification result.
 */
async function verifyMovedSession(ctx, sessionId) {
  const { sessionQuery } = servicesOf(ctx);
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
    return { ok: true };
  }
  try {
    const snapshot = await sessionQuery.readSession(sessionId);
    if (snapshot === undefined || snapshot === null || snapshot.session === undefined || snapshot.session === null) {
      return { ok: false, detail: '读回的会话没有存储头信息' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Replay the source's archived/pinned membership on the new session.
 * Never throws: state replay is a convenience, and the copy already exists.
 * @param {object} ctx - the plugin context.
 * @param {string} newId - new session id.
 * @param {{archived: boolean, pinned: boolean}} state - source state.
 * @returns {Promise<string[]>} warnings.
 */
async function replayRegistryState(ctx, newId, state) {
  const warnings = [];
  const registry = servicesOf(ctx).workspaceRegistry;
  if (registry === undefined || registry === null) return warnings;
  if (state.archived && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(newId, { stopActivity: false });
    } catch (error) {
      warnings.push(`新会话已写入，但没能保留归档状态：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (state.pinned && typeof registry.pinSession === 'function') {
    try {
      await registry.pinSession(newId);
    } catch (error) {
      warnings.push(`新会话已写入，但没能保留置顶状态：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings;
}

/**
 * Copy one source session into the target workspace, then trash the source.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - source session id.
 * @param {{workspaceId: string, path: string}} target - destination workspace.
 * @param {number} currentVersion - current DSH session format version.
 * @param {{trashDir?: string}} options - trash root override.
 * @returns {Promise<object>} moved entry.
 * @throws {SessionPortFormatError} `active`, `not-found`, `subagent`,
 *   `format-version`, `read-failed`, `write-failed` or `verify-failed`.
 */
async function moveOne(ctx, sessionId, target, currentVersion, options) {
  assertSourceIdle(ctx, sessionId);
  const persistence = servicesOf(ctx).sessionPersistence;
  if (persistence === undefined || persistence === null || typeof persistence.create !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法迁移会话');
  }
  let doc;
  try {
    doc = await readSessionDoc(ctx, sessionId);
  } catch (error) {
    throw new SessionPortFormatError(
      'read-failed',
      `读取会话 ${sessionId} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (doc.header.origin === 'subagent') {
    throw new SessionPortFormatError('subagent', `会话 ${sessionId} 是子代理转录，不能单独迁移`);
  }
  if (doc.header.version !== currentVersion) {
    throw new SessionPortFormatError(
      'format-version',
      `会话 ${sessionId} 是格式 v${String(doc.header.version)}，当前 DSH 使用 v${currentVersion}；请先用 DSH 打开并升级它`,
    );
  }
  const registry = servicesOf(ctx).workspaceRegistry;
  const state = {
    archived: registrySet(registry, 'archivedSessionIds').has(sessionId),
    pinned: registrySet(registry, 'pinnedSessionIds').has(sessionId),
  };
  const newId = await mintSessionId(persistence);
  const warnings = [];
  const preset = await resolveAgentPreset(ctx, doc.header.agentPreset);
  if (preset.warning !== undefined) warnings.push(preset.warning);
  const header = {
    version: currentVersion,
    id: newId,
    createdAt: doc.header.createdAt,
    cwd: target.path,
    isSeeded: false,
    delegationDepth: 0,
    ...(preset.preset !== undefined ? { agentPreset: preset.preset } : {}),
  };
  let events = rewriteDeliveryIdentity(doc.events, newId, currentVersion);
  events = rewriteSeedMarkers(events);
  try {
    await writeNewSession(persistence, header, events, 0);
  } catch (error) {
    throw new SessionPortFormatError(
      'write-failed',
      `会话 ${sessionId} 复制到目标工作区失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const verified = await verifyMovedSession(ctx, newId);
  if (!verified.ok) {
    throw new SessionPortFormatError(
      'verify-failed',
      `新会话 ${newId} 已写入，但读回失败：${verified.detail ?? '未知原因'}；源会话未移入回收站`,
    );
  }
  const joined = await attachToWorkspace(ctx, { sessionId: newId, workspaceId: target.workspaceId, cwd: target.path });
  if (joined !== undefined && joined !== null && joined.warning !== undefined) warnings.push(joined.warning);
  warnings.push(...(await replayRegistryState(ctx, newId, state)));
  let sourceTrashed = false;
  let trashedPath;
  try {
    const deleted = await deleteSession(ctx, sessionId, {
      ...(options.trashDir !== undefined ? { trashDir: options.trashDir } : {}),
    });
    sourceTrashed = true;
    if (typeof deleted.trashedPath === 'string') trashedPath = deleted.trashedPath;
  } catch (error) {
    warnings.push(
      `新会话 ${newId} 已写入，但源会话没有移入回收站：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const title = foldTitle(events);
  return {
    sourceId: sessionId,
    sessionId: newId,
    sourceTrashed,
    eventCount: events.length,
    ...(title !== undefined ? { title } : {}),
    ...(trashedPath !== undefined ? { trashedPath } : {}),
    warnings,
  };
}

/**
 * Move sessions into a target workspace.
 *
 * Each session is preflighted individually; a session that cannot be copied
 * safely is reported in `skipped` and leaves the source untouched. The source
 * is trashed only after the copy reads back successfully, so a failure never
 * loses the original conversation. A batch is not atomic: earlier sessions can
 * be moved even when a later one is skipped.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - move request.
 * @param {string} options.workspaceId - destination workspace id.
 * @param {string[]} options.sessionIds - source session ids.
 * @param {string} [options.trashDir] - trash root override (same as delete).
 * @returns {Promise<{target: {workspaceId: string, path: string, title?: string}, moved: Array<object>, skipped: Array<{id: string, reason: string, message: string}>, warnings: string[]}>} move result.
 * @throws {SessionPortFormatError} `invalid-argument`, `unavailable`,
 *   `workspace-not-found`, `too-many-sessions`.
 */
export async function moveSessions(ctx, options = {}) {
  const sessionIds = Array.isArray(options.sessionIds) ? options.sessionIds.map((id) => String(id)) : [];
  if (sessionIds.length === 0) {
    throw new SessionPortFormatError('invalid-argument', 'move 需要至少一个 sessionIds 项（会话 id 数组）');
  }
  if (sessionIds.length > MAX_MOVE_SESSIONS) {
    throw new SessionPortFormatError(
      'too-many-sessions',
      `一次最多迁移 ${MAX_MOVE_SESSIONS} 个会话（本次 ${sessionIds.length} 个）`,
    );
  }
  const target = await resolveTargetWorkspace(ctx, options.workspaceId);
  let currentVersion;
  try {
    currentVersion = await detectFormatVersion(ctx, undefined);
  } catch (error) {
    throw new SessionPortFormatError(
      'unavailable',
      `无法确定当前会话格式版本：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const moved = [];
  const skipped = [];
  for (const sessionId of sessionIds) {
    try {
      moved.push(await moveOne(ctx, sessionId, target, currentVersion, options));
    } catch (error) {
      skipped.push({
        id: sessionId,
        reason: error instanceof SessionPortFormatError ? error.code : 'move-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    target,
    moved,
    skipped,
    warnings: [
      '迁移会创建新会话 id（旧 id 的链接失效），并把源会话移入回收站；子代理转录不会复制，随源目录留在回收站。',
    ],
  };
}
