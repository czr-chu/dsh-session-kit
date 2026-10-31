/**
 * dsh-session-kit -- host-side session access helpers.
 *
 * Everything here reads DSH services through the composed plugin context
 * (ctx.get(name)), never through a direct @deepseek-ai import, so the bundle
 * stays installable from a plain workspace directory. The helpers are the one
 * place session listing, title folding, id minting, workspace attachment, and
 * new-session persistence are implemented; the route/tool/import modules call
 * them instead of re-deriving the same rules.
 *
 * @module dsh-session-kit/sessions
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Format version assumed when no stored session can tell us the current one. */
export const FALLBACK_SESSION_FORMAT_VERSION = 4;

/** Event type carrying the authoritative log-backed title. */
const TITLE_EVENT = 'session/title';

/** One-line message of an arbitrary thrown value. */
function errorText(error) {
  if (error instanceof Error) return error.message.split('\n')[0];
  return String(error);
}

/**
 * Resolve the optional composed services this bundle consumes.
 * A missing member stays undefined so every caller can degrade explicitly.
 * @param {object} ctx - the plugin context.
 * @returns {object} service handles.
 */
export function servicesOf(ctx) {
  return {
    sessionQuery: ctx.get('sessionQuery'),
    sessionPersistence: ctx.get('sessionPersistence'),
    sessions: ctx.get('sessions'),
    attachments: ctx.get('attachments'),
    workspaceRegistry: ctx.get('workspaceRegistry'),
    agentPresets: ctx.get('agentPresets'),
    workingDirectory: ctx.get('workingDirectory'),
  };
}

/**
 * The session format generation this Harness writes.
 *
 * A configured override wins; otherwise the newest stored header decides,
 * because a running Harness always has at least one stored session in
 * practice. The compiled-in fallback answers a truly empty store, and an
 * unreadable corpus falls back the same way (the import path still validates
 * against the real backend).
 * @param {object} ctx - the plugin context.
 * @param {number | undefined} configured - configured override.
 * @returns {Promise<number>} the format version to require of imported logs.
 */
export async function detectFormatVersion(ctx, configured) {
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  const query = ctx.get('sessionQuery');
  try {
    const records = await query.listSessions();
    if (Array.isArray(records) && records.length > 0) {
      const versions = records
        .map((record) => (record !== null && typeof record === 'object' ? record.header?.version : undefined))
        .filter((version) => Number.isSafeInteger(version) && version >= 0);
      if (versions.length > 0) return Math.max(...versions);
    }
  } catch {
    // An unreadable corpus falls back to the compiled-in version; the import
    // itself is still validated against the real persistence backend.
  }
  return FALLBACK_SESSION_FORMAT_VERSION;
}

/**
 * Read one complete logical session log for export.
 *
 * A live session is flushed first so at least the durable prefix exists before
 * the read, then the query service returns the replay-validated snapshot the
 * built-in log export uses. Both the header and the events are detached from
 * the query's cached values so callers may rewrite them freely.
 * @param {object} ctx - the plugin context.
 * @param {string} id - the session to read.
 * @returns {Promise<{header: object, events: Array<object>, inheritedEventCount: number}>} detached log.
 * @throws {Error} when the session cannot be read.
 */
export async function readSessionDoc(ctx, id) {
  const sessionId = String(id ?? '').trim();
  if (sessionId === '') throw new Error('缺少要读取的会话 id');
  const { sessionQuery, sessions } = servicesOf(ctx);
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
    throw new Error('会话查询服务不可用，无法读取会话');
  }
  const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
  if (live !== undefined && typeof sessions?.flush === 'function') {
    try {
      await sessions.flush(live);
    } catch (error) {
      throw new Error('会话的最新内容尚未写入存储：' + errorText(error));
    }
  }
  let snapshot;
  try {
    snapshot = await sessionQuery.readSession(sessionId);
  } catch (error) {
    throw new Error('读取会话 ' + sessionId + ' 失败：' + errorText(error));
  }
  if (snapshot === null || typeof snapshot !== 'object' || snapshot.session === undefined || snapshot.session === null) {
    throw new Error('会话 ' + sessionId + ' 没有存储头信息');
  }
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  return {
    header: structuredClone(snapshot.session),
    events: structuredClone(events),
    inheritedEventCount: Number.isSafeInteger(snapshot.inheritedEventCount) ? snapshot.inheritedEventCount : 0,
  };
}

/** Normalize a title candidate into a non-empty trimmed string. */
function normalizeTitle(value) {
  if (typeof value !== 'string') return undefined;
  const title = value.trim();
  return title === '' ? undefined : title;
}

/**
 * Read one session's latest title without failing the listing.
 *
 * The installed query service resolves a SessionTitleSnapshot object; older
 * drafts of this idea assumed a bare string. Both spellings are accepted so
 * the listing survives a contract change, and any failure means "no title".
 * @param {object} query - session query service.
 * @param {string} id - session id.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<{title?: string, updatedAt?: number}>} folded title facts.
 */
async function readTitleFact(query, id, signal) {
  if (typeof query.readTitle !== 'function') return {};
  try {
    const snapshot = await query.readTitle(id, signal);
    if (snapshot === null || snapshot === undefined) return {};
    if (typeof snapshot === 'string') return { title: normalizeTitle(snapshot) };
    if (typeof snapshot === 'object') {
      const title = normalizeTitle(snapshot.title);
      return {
        ...(title === undefined ? {} : { title }),
        ...(Number.isSafeInteger(snapshot.updatedAt) ? { updatedAt: snapshot.updatedAt } : {}),
      };
    }
  } catch {
    // Titles are cosmetic; an unreadable one must not fail the listing.
  }
  return {};
}

/**
 * List every stored workspace with the sessions it owns.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<Array<{workspaceId: string, title?: string, path?: string, sessionIds: string[]}>>} workspaces.
 */
export async function listWorkspaceEntries(ctx) {
  const registry = servicesOf(ctx).workspaceRegistry;
  if (registry === undefined || typeof registry.list !== 'function') return [];
  let workspaces;
  try {
    workspaces = await registry.list();
  } catch {
    return [];
  }
  const entries = [];
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace === null || typeof workspace !== 'object' || workspace.id === undefined) continue;
    entries.push({
      workspaceId: String(workspace.id),
      ...(typeof workspace.title === 'string' ? { title: workspace.title } : {}),
      ...(typeof workspace.path === 'string' ? { path: workspace.path } : {}),
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
    });
  }
  return entries;
}

/** Index workspaces by the session ids they own (first workspace wins). */
function workspaceIndex(workspaces) {
  const index = new Map();
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!index.has(sessionId)) index.set(sessionId, workspace);
    }
  }
  return index;
}

/**
 * List the sessions a user can pick in the export panel.
 *
 * This is the cheap listing path: it never opens a log, so eventCount stays 0
 * unless the record already carries it. Titles, running state, and workspace
 * ownership are best-effort decorations.
 * @param {object} ctx - the plugin context.
 * @param {{signal?: AbortSignal, includeSubagents?: boolean}} [options] - cancellation and subagent visibility.
 * @returns {Promise<Array<object>>} session entries.
 */
export async function listSessionEntries(ctx, options = {}) {
  const signal = options?.signal;
  const includeSubagents = options?.includeSubagents === true;
  const { sessionQuery } = servicesOf(ctx);
  if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') {
    throw new Error('会话查询服务不可用，无法列出会话');
  }
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
  let records;
  try {
    records = await sessionQuery.listSessions(signal);
  } catch (error) {
    throw new Error('读取会话列表失败：' + errorText(error));
  }
  const workspaceBySession = workspaceIndex(await listWorkspaceEntries(ctx));
  const entries = [];
  for (const record of Array.isArray(records) ? records : []) {
    const header = record !== null && typeof record === 'object' ? record.header : undefined;
    if (header === null || typeof header !== 'object') continue;
    if (typeof header.id !== 'string' || header.id === '') continue;
    // The panel lists human conversations by default. Subagent sessions are
    // transcript fragments of their parent; exporting them standalone is
    // possible through an explicit id or the includeSubagents option.
    if (!includeSubagents && header.origin === 'subagent') continue;
    const id = header.id;
    const titleFact = await readTitleFact(sessionQuery, id, signal);
    const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined;
    const workspace = workspaceBySession.get(id);
    entries.push({
      id,
      ...(titleFact.title === undefined ? {} : { title: titleFact.title }),
      ...(typeof header.cwd === 'string' && header.cwd !== '' ? { cwd: header.cwd } : {}),
      ...(workspace === undefined ? {} : { workspaceId: workspace.workspaceId }),
      ...(workspace?.title === undefined ? {} : { workspaceTitle: workspace.title }),
      createdAt: header.createdAt,
      updatedAt: Number.isSafeInteger(titleFact.updatedAt) ? titleFact.updatedAt : header.createdAt,
      running: agent?.status === 'running',
      formatVersion: header.version,
      ...(header.origin === 'subagent' ? { origin: 'subagent' } : {}),
      eventCount: Number.isSafeInteger(record?.eventCount) ? record.eventCount : 0,
    });
  }
  return entries;
}

/** True when a path names an existing directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Choose the working directory an imported session records.
 * @param {object} ctx - the plugin context.
 * @param {{requestedCwd?: string, sourceCwd?: string}} candidates - preferred absolute directories.
 * @returns {Promise<string>} an absolute existing directory.
 */
export async function resolveTargetDirectory(ctx, { requestedCwd, sourceCwd } = {}) {
  if (typeof requestedCwd === 'string' && isAbsolute(requestedCwd) && (await isDirectory(requestedCwd))) {
    return requestedCwd;
  }
  if (typeof sourceCwd === 'string' && isAbsolute(sourceCwd) && (await isDirectory(sourceCwd))) {
    return sourceCwd;
  }
  const fallback = servicesOf(ctx).workingDirectory?.defaultDirectory;
  if (typeof fallback === 'string' && fallback !== '' && (await isDirectory(fallback))) return fallback;
  return process.cwd();
}

/**
 * Mint an unused session id in the store's own spelling.
 * @param {object} persistence - the session persistence service.
 * @returns {Promise<string>} session-<uuid> that no stored session owns.
 */
export async function mintSessionId(persistence) {
  if (persistence === undefined || typeof persistence?.stat !== 'function') {
    return 'session-' + randomUUID();
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = 'session-' + randomUUID();
    try {
      const existing = await persistence.stat(id);
      if (existing === undefined || existing === null) return id;
    } catch {
      // An unreadable store cannot prove the id is taken; create() stays the
      // authoritative uniqueness check and fails loudly if it is.
      return id;
    }
  }
  throw new Error('无法生成唯一的会话 id，请重试');
}

/**
 * Add one written session to the workspace whose directory it records.
 *
 * Attachment to a workspace is a convenience, not a write guarantee, so this
 * never throws: a failure becomes a caller-visible warning instead of a
 * silently missing sidebar row.
 * @param {object} ctx - the plugin context.
 * @param {{sessionId: string, workspaceId?: string, cwd?: string}} target - session and preferred workspace.
 * @returns {Promise<{workspaceId?: string, warning?: string}>} the workspace it joined, or why it did not.
 */
export async function attachToWorkspace(ctx, target = {}) {
  try {
    const { sessionId, workspaceId, cwd } = target;
    const registry = servicesOf(ctx).workspaceRegistry;
    if (registry === undefined || typeof sessionId !== 'string' || sessionId === '') return {};
    const requested = typeof workspaceId === 'string' && workspaceId !== '' ? workspaceId : undefined;
    let workspace;
    let fellBack = false;
    if (requested !== undefined && typeof registry.get === 'function') {
      workspace = registry.get(requested);
      fellBack = workspace === undefined;
    }
    if (workspace === undefined && typeof registry.resolveByPath === 'function' && typeof cwd === 'string' && cwd !== '') {
      try {
        workspace = await registry.resolveByPath(cwd);
      } catch {
        workspace = undefined;
      }
    }
    if (workspace === undefined) {
      return requested === undefined ? {} : { warning: '找不到工作区 ' + requested + '，会话没有加入任何工作区' };
    }
    try {
      await workspace.attachSession(sessionId);
    } catch (error) {
      return { warning: '会话已写入，但没能加入工作区 ' + String(workspace.id) + '：' + errorText(error) };
    }
    const joinedId = String(workspace.id);
    if (fellBack && requested !== undefined) {
      return { workspaceId: joinedId, warning: '找不到请求的工作区 ' + requested + '，会话已加入工作区 ' + joinedId };
    }
    return { workspaceId: joinedId };
  } catch (error) {
    return { warning: '会话工作区归属未能确定：' + errorText(error) };
  }
}

/**
 * Fold the latest log-backed title out of one event list.
 * @param {Array<object>} events - committed events.
 * @returns {string | undefined} the trimmed title, when any.
 */
export function foldTitle(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === null || typeof event !== 'object' || event.type !== TITLE_EVENT) continue;
    const title = normalizeTitle(event.data?.title);
    if (title !== undefined) return title;
  }
  return undefined;
}

/**
 * Commit one brand-new session: create, append every event in one batch,
 * flush the durability barrier, then release write ownership.
 *
 * The session is created before anything else is written, so a later failure
 * leaves one visible session rather than unreachable attachment objects; a
 * close failure never masks the original write failure.
 * @param {object} persistence - the session persistence service.
 * @param {object} header - complete header (id already minted).
 * @param {ReadonlyArray<object>} events - dense events starting at seq 0.
 * @param {number} [inheritedEventCount] - fork-inherited prefix length.
 * @returns {Promise<{id: string}>} the stored session id.
 */
export async function writeNewSession(persistence, header, events, inheritedEventCount = 0) {
  if (persistence === undefined || typeof persistence.create !== 'function') {
    throw new Error('会话存储服务不可用，无法写入会话');
  }
  if (header === null || typeof header !== 'object' || typeof header.id !== 'string' || header.id === '') {
    throw new Error('写入会话需要带 id 的会话头');
  }
  if (!Array.isArray(events)) throw new Error('写入会话需要事件数组');
  const createOptions = header.isSeeded === true
    ? { inheritedEventCount: Number.isSafeInteger(inheritedEventCount) ? inheritedEventCount : 0 }
    : undefined;
  let handle;
  try {
    handle = await persistence.create(header, createOptions);
  } catch (error) {
    throw new Error('创建会话失败：' + errorText(error));
  }
  let failure;
  try {
    if (events.length > 0) await handle.append(events);
    await handle.flush();
  } catch (error) {
    failure = new Error('写入会话内容失败：' + errorText(error));
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (failure === undefined) failure = new Error('关闭会话失败：' + errorText(closeError));
  }
  if (failure !== undefined) throw failure;
  return { id: header.id };
}

/**
 * Detached, JSON-safe summary of one session header.
 * @param {object} header - session header.
 * @returns {object} the lineage-free summary fields.
 */
export function sessionHeaderToSummary(header) {
  const record = header !== null && typeof header === 'object' ? header : {};
  return {
    id: typeof record.id === 'string' ? record.id : '',
    ...(typeof record.cwd === 'string' && record.cwd !== '' ? { cwd: record.cwd } : {}),
    createdAt: record.createdAt,
    isSeeded: record.isSeeded === true,
    ...(typeof record.parentSession === 'string' && record.parentSession !== '' ? { parentSession: record.parentSession } : {}),
    ...(record.origin === 'subagent' ? { origin: 'subagent' } : {}),
    ...(typeof record.agentPreset === 'string' && record.agentPreset !== '' ? { agentPreset: record.agentPreset } : {}),
  };
}
