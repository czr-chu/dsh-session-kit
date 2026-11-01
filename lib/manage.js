/**
 * dsh-session-kit -- session management core: archive, unarchive, and delete.
 *
 * Archive state lives in the workspace registry (the same durable archive and
 * pin sets every DSH surface reads), so an archived session stays in the
 * listing but is marked and filtered by the registry's own rules. Deletion is
 * deliberately not an erase: the session directory (and every subagent
 * descendant session directory) is moved under
 * <DSH_HOME>/session-kit-trash/<stamp>/, so the bytes remain recoverable and
 * the registry is then cleaned of detach/pin/archive entries for the moved ids.
 * A user-visible fork/seeded child (origin unset) is NOT a deletion descendant:
 * deleting its parent leaves it in place, and its own subagent children stay
 * reachable through it.
 *
 * Delete safety is the strict part:
 *  - a live session or a running agent refuses the whole operation;
 *  - every directory to move is derived from the persistence backend's own
 *    location fact and must be a session directory named encodeSegment(id)
 *    under a project directory (--...-- or _no-cwd);
 *  - every target is checked before anything moves, and a failed move rolls the
 *    already-moved directories back.
 *
 * @module dsh-session-kit/manage
 */

import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import { errorText } from './attachments.js';
import { SessionPortFormatError } from './format.js';

/** Canonical project directory names a session directory may live under. */
const PROJECT_DIR_PATTERN = /^--.*--$/u;

/** Canonical session log file names written by the JSONL backend. */
const SESSION_LOG_PATTERN = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u;

/** The directory name DSH uses for sessions whose header records no cwd. */
const NO_CWD_PROJECT = '_no-cwd';

/** Resolve one optional composed service without throwing on a missing context. */
function serviceOf(ctx, name) {
  return ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
}

/** Require a non-empty session id argument. */
function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new SessionPortFormatError('invalid-argument', '需要一个非空的会话 id');
  }
  return sessionId.trim();
}

/** Require the workspace registry (archive state owner). */
function requireRegistry(ctx) {
  const registry = serviceOf(ctx, 'workspaceRegistry');
  if (registry === null || registry === undefined) {
    throw new SessionPortFormatError('unavailable', '工作区注册表服务不可用，无法管理归档状态');
  }
  return registry;
}

/**
 * Encode one session id as a single safe filesystem segment.
 *
 * Mirrors the JSONL backend's encodeSegment (session-persistence-jsonl/src/
 * format.ts): [A-Za-z0-9._-] stay literal, '.' and '..' are special-cased, and
 * every other UTF-16 code unit becomes ~XXXX. This is what makes the moved
 * destination path independent of anything the id might contain.
 * @param {string} raw - the session id.
 * @returns {string} one safe path segment.
 * @throws {SessionPortFormatError} when the id is empty.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new SessionPortFormatError('invalid-argument', '无法编码空的会话 id');
  }
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char !== '~' && /^[A-Za-z0-9._-]$/u.test(char)) out += char;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Archive one session so every DSH grouping surface hides it.
 *
 * The registry owns the durable archive set and asks the composed
 * workspace/session-activity providers whether the session is still running.
 * Without stopActivity that check refuses an active session; the refusal is
 * surfaced with the stable code 'active'.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the session to archive.
 * @param {{stopActivity?: boolean}} [options] - stop running work instead of refusing.
 * @returns {Promise<{sessionId: string}>} the archived session id.
 * @throws {SessionPortFormatError} code 'active' | 'not-found' | 'unavailable' | 'archive-failed'.
 */
export async function archiveSession(ctx, sessionId, options = {}) {
  const id = requireSessionId(sessionId);
  const registry = requireRegistry(ctx);
  if (typeof registry.archiveSession !== 'function') {
    throw new SessionPortFormatError('unavailable', '工作区注册表不支持归档会话');
  }
  const stopActivity = options?.stopActivity === true;
  try {
    await registry.archiveSession(id, { stopActivity });
  } catch (error) {
    throw translateArchiveError(error, id);
  }
  return { sessionId: id };
}

/** Translate one registry failure into a stable, readable management error. */
function translateArchiveError(error, id) {
  const name = error !== null && typeof error === 'object' ? error.name : undefined;
  if (name === 'WorkspaceActiveSessionError' || (error !== null && typeof error === 'object' && Array.isArray(error.activity))) {
    const activity = Array.isArray(error.activity)
      ? error.activity.map((entry) => (entry !== null && typeof entry === 'object' && typeof entry.kind === 'string' ? entry.kind : undefined)).filter((kind) => kind !== undefined)
      : [];
    const suffix = activity.length > 0 ? '（仍在运行：' + activity.join('、') + '）' : '';
    return new SessionPortFormatError('active', '会话 ' + id + ' 正在运行，无法归档' + suffix + '；可改用 stopActivity 先停止再归档');
  }
  if (name === 'WorkspaceUnknownSessionError') {
    return new SessionPortFormatError('not-found', '找不到会话 ' + id + '，无法归档：' + errorText(error));
  }
  return new SessionPortFormatError('archive-failed', '归档会话 ' + id + ' 失败：' + errorText(error));
}

/**
 * Remove one session from the registry archive set. Idempotent: an id that is
 * not archived resolves without writing.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the session to unarchive.
 * @returns {Promise<{sessionId: string}>} the unarchived session id.
 * @throws {SessionPortFormatError} code 'unavailable' | 'unarchive-failed'.
 */
export async function unarchiveSession(ctx, sessionId) {
  const id = requireSessionId(sessionId);
  const registry = requireRegistry(ctx);
  if (typeof registry.unarchiveSession !== 'function') {
    throw new SessionPortFormatError('unavailable', '工作区注册表不支持恢复归档会话');
  }
  try {
    await registry.unarchiveSession(id);
  } catch (error) {
    throw new SessionPortFormatError('unarchive-failed', '取消归档会话 ' + id + ' 失败：' + errorText(error));
  }
  return { sessionId: id };
}

/** The Harness home used when no trash directory is supplied. */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return resolvePath(env.trim());
  return join(homedir(), '.dsh');
}

/**
 * Resolve the trash root for one delete call.
 * @param {{trashDir?: string}} options - caller override.
 * @returns {string} absolute trash root directory.
 * @throws {SessionPortFormatError} when an explicit trashDir is empty.
 */
function resolveTrashRoot(options) {
  const explicit = options?.trashDir;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || explicit.trim() === '') {
      throw new SessionPortFormatError('invalid-argument', 'trashDir 必须是非空路径');
    }
    return resolvePath(explicit.trim());
  }
  return join(dshHome(), 'session-kit-trash');
}

/** A filesystem-safe local-time-independent operation stamp. */
function operationStamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

/**
 * Create the per-operation directory under the trash root.
 * @param {string} trashRoot - absolute trash root.
 * @returns {Promise<string>} the created operation directory.
 */
async function createTrashOperationDir(trashRoot) {
  try {
    await mkdir(trashRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new SessionPortFormatError('delete-failed', '无法创建回收站目录 ' + trashRoot + '：' + errorText(error));
  }
  const base = operationStamp();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? join(trashRoot, base) : join(trashRoot, base + '-' + attempt);
    try {
      await mkdir(candidate, { recursive: false, mode: 0o700 });
      return candidate;
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EEXIST') continue;
      throw new SessionPortFormatError('delete-failed', '无法创建回收站目录 ' + candidate + '：' + errorText(error));
    }
  }
  throw new SessionPortFormatError('delete-failed', '无法创建唯一的回收站目录（' + trashRoot + '）');
}

/** Whether one path is the same as or inside another directory. */
function isInside(child, parent) {
  const normalizedChild = resolvePath(child);
  const normalizedParent = resolvePath(parent);
  if (normalizedChild === normalizedParent) return true;
  const rel = relative(normalizedParent, normalizedChild);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Refuse a live session or a running agent for every id in the deletion set. */
function assertNotActive(sessions, agents, ids) {
  for (const id of ids) {
    const live = typeof sessions?.get === 'function' ? sessions.get(id) : undefined;
    if (live !== undefined && live !== null) {
      throw new SessionPortFormatError('active', '会话 ' + id + ' 仍然是活动会话，删除前请先关闭它');
    }
    const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined;
    if (agent !== null && agent !== undefined && (agent.status === 'running' || agent.running === true)) {
      throw new SessionPortFormatError('active', '会话 ' + id + ' 有正在运行的代理，删除前请先停止它');
    }
  }
}

/**
 * Collect one session id and every stored subagent descendant.
 *
 * Only sessions whose header records origin 'subagent' cascade, and recursion
 * passes only through those nodes: a user-visible fork/seeded child (origin
 * unset, parentSession pointing at a deleted session) is preserved, together
 * with its own subtree, because it is a conversation the user owns rather than
 * a transcript fragment of the deleted session.
 * @param {string} rootId - the requested session.
 * @param {Map<string, object>} byId - every stored snapshot keyed by header id.
 * @returns {Set<string>} the root and all subagent descendants.
 */
function lineageClosure(rootId, byId) {
  const targets = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [candidateId, snapshot] of byId) {
      if (targets.has(candidateId)) continue;
      const header = snapshot?.header;
      if (header === null || typeof header !== 'object' || header.origin !== 'subagent') continue;
      const parent = header.parentSession;
      if (typeof parent === 'string' && targets.has(parent)) {
        targets.add(candidateId);
        changed = true;
      }
    }
  }
  return targets;
}

/**
 * Resolve the freshest metadata for one deletion target.
 *
 * Lineage comes from the persistence listing (one read for the whole batch);
 * the locator is re-read through persistence.stat so a stale listing cannot
 * point at a directory the backend no longer owns. A listed session that stat
 * reports as absent is a definite miss.
 * @param {object} persistence - session persistence service.
 * @param {string} id - session id.
 * @param {object | undefined} listed - listing snapshot.
 * @returns {Promise<object>} snapshot carrying the authoritative location.
 */
async function resolveDeleteSnapshot(persistence, id, listed) {
  if (typeof persistence.stat !== 'function') return listed;
  let fresh;
  try {
    fresh = await persistence.stat(id);
  } catch (error) {
    throw new SessionPortFormatError('delete-failed', '无法读取会话 ' + id + ' 的存储位置：' + errorText(error));
  }
  if (fresh === null || fresh === undefined) {
    throw new SessionPortFormatError('not-found', '会话存储里找不到会话 ' + id);
  }
  return { ...(listed !== undefined ? listed : {}), ...fresh, header: fresh.header ?? listed?.header };
}

/**
 * Derive and verify the on-disk session directory of one stored session.
 *
 * The persistence location is the backend's own fact; the directory is only
 * accepted when its leaf equals encodeSegment(id) and its parent is a canonical
 * project directory, so a corrupted or foreign location can never redirect the
 * move outside the session store.
 * @param {string} id - session id.
 * @param {object | undefined} snapshot - persistence list entry.
 * @returns {{sessionDir: string, projectDir: string, logPath: string}} verified paths.
 * @throws {SessionPortFormatError} code 'unsafe-location'.
 */
function verifySessionLocation(id, snapshot) {
  const location = snapshot?.location;
  if (location === null || typeof location !== 'object' || typeof location.path !== 'string' || location.path === '') {
    throw new SessionPortFormatError('unsafe-location', '会话 ' + id + ' 没有可用的文件系统存储位置，拒绝删除');
  }
  if (location.kind !== undefined && location.kind !== 'jsonl') {
    throw new SessionPortFormatError('unsafe-location', '会话 ' + id + ' 的存储不是文件系统会话目录（kind=' + String(location.kind) + '），拒绝删除');
  }
  const logPath = resolvePath(location.path);
  const sessionDir = dirname(logPath);
  const projectDir = dirname(sessionDir);
  const expectedSegment = encodeSegment(id);
  if (basename(sessionDir) !== expectedSegment) {
    throw new SessionPortFormatError('unsafe-location', '会话 ' + id + ' 的存储目录名 "' + basename(sessionDir) + '" 与 id 编码 "' + expectedSegment + '" 不一致，拒绝删除');
  }
  if (!SESSION_LOG_PATTERN.test(basename(logPath))) {
    throw new SessionPortFormatError('unsafe-location', '会话 ' + id + ' 的存储文件 "' + basename(logPath) + '" 不是规范的会话日志，拒绝删除');
  }
  const projectName = basename(projectDir);
  if (projectName !== NO_CWD_PROJECT && !PROJECT_DIR_PATTERN.test(projectName)) {
    throw new SessionPortFormatError('unsafe-location', '会话 ' + id + ' 的父目录 "' + projectName + '" 不是 DSH 项目目录（--...-- 或 _no-cwd），拒绝删除');
  }
  return { sessionDir, projectDir, logPath };
}

/** Confirm one session directory is a real directory that can be moved. */
async function assertMovableDirectory(id, sessionDir) {
  let info;
  try {
    info = await lstat(sessionDir);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new SessionPortFormatError('not-found', '会话 ' + id + ' 的存储目录已不存在：' + sessionDir);
    }
    throw new SessionPortFormatError('delete-failed', '无法检查会话 ' + id + ' 的存储目录：' + errorText(error));
  }
  if (info.isSymbolicLink()) {
    throw new SessionPortFormatError('unsafe-location', '会话 ' + id + ' 的存储目录是符号链接，拒绝删除');
  }
  if (!info.isDirectory()) {
    throw new SessionPortFormatError('unsafe-location', '会话 ' + id + ' 的存储路径不是目录，拒绝删除');
  }
}

/** Move one directory, falling back to copy + remove across filesystems. */
async function moveDirectory(source, destination) {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (error === null || typeof error !== 'object' || error.code !== 'EXDEV') throw error;
  }
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false });
  await rm(source, { recursive: true, force: false });
}

/** Log one management cleanup warning without changing the operation outcome. */
function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.('session-kit: ' + message);
  } catch {
    // Logging a cleanup warning must never change the delete outcome.
  }
}

/**
 * Detach moved ids from every workspace, then unpin and unarchive them.
 * Failures are logged: the directories are already in the trash, so throwing
 * would misreport a completed move as a failed delete.
 * @param {object} ctx - the plugin context.
 * @param {ReadonlyArray<string>} ids - moved session ids.
 */
async function cleanupRegistry(ctx, ids) {
  const registry = serviceOf(ctx, 'workspaceRegistry');
  if (registry === null || registry === undefined) return;
  let workspaces = [];
  if (typeof registry.list === 'function') {
    try {
      workspaces = await registry.list();
    } catch (error) {
      warn(ctx, '读取工作区列表失败：' + errorText(error));
      workspaces = [];
    }
  }
  for (const id of ids) {
    for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
      let owned = [];
      try {
        owned = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.map(String) : [];
      } catch (error) {
        warn(ctx, '读取工作区 ' + String(workspace?.id) + ' 的会话列表失败：' + errorText(error));
        continue;
      }
      if (!owned.includes(id)) continue;
      if (typeof workspace.detachSession !== 'function') {
        warn(ctx, '工作区 ' + String(workspace?.id) + ' 不支持移除会话 ' + id);
        continue;
      }
      try {
        await workspace.detachSession(id);
      } catch (error) {
        warn(ctx, '工作区 ' + String(workspace?.id) + ' 移除会话 ' + id + ' 失败：' + errorText(error));
      }
    }
    if (typeof registry.unpinSession === 'function') {
      try {
        await registry.unpinSession(id);
      } catch (error) {
        warn(ctx, '取消置顶会话 ' + id + ' 失败：' + errorText(error));
      }
    }
    if (typeof registry.unarchiveSession === 'function') {
      try {
        await registry.unarchiveSession(id);
      } catch (error) {
        warn(ctx, '取消归档会话 ' + id + ' 失败：' + errorText(error));
      }
    }
  }
}

/**
 * Move one session and every subagent descendant into the session trash.
 *
 * User-visible fork/seeded children (origin unset) are never part of the move,
 * even when their parentSession points at the deleted session.
 *
 * Nothing is erased: each session directory is moved (rename, or copy + remove
 * when the trash is on another filesystem) under
 * <trashRoot>/<ISO stamp>/<encodeSegment(id)>/. The operation refuses before
 * moving anything when a target is live/running, missing, or its stored
 * location is not a verifiable session directory. A move failure rolls the
 * already-moved directories back and reports code 'delete-failed'.
 *
 * After a successful move the ids are detached from every workspace, unpinned,
 * and unarchived; those cleanup failures never turn a completed move into a
 * failed delete (they are logged).
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the session to delete.
 * @param {{trashDir?: string}} [options] - trash root override (default <DSH_HOME>/session-kit-trash).
 * @returns {Promise<{sessionIds: string[], trashedPath: string}>} the deleted ids (root first) and the trash operation directory.
 * @throws {SessionPortFormatError} code 'invalid-argument' | 'unavailable' | 'not-found' | 'active' | 'unsafe-location' | 'delete-failed'.
 */
export async function deleteSession(ctx, sessionId, options = {}) {
  const rootId = requireSessionId(sessionId);
  const sessions = serviceOf(ctx, 'sessions');
  const agents = serviceOf(ctx, 'agents');
  const persistence = serviceOf(ctx, 'sessionPersistence');
  if (persistence === null || persistence === undefined || typeof persistence.list !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法删除会话');
  }

  // Refuse a live root before touching the store: a session that is still
  // attached cannot be moved safely even if persistence happens to list it.
  assertNotActive(sessions, agents, [rootId]);

  let snapshots;
  try {
    snapshots = await persistence.list();
  } catch (error) {
    throw new SessionPortFormatError('delete-failed', '读取会话存储列表失败：' + errorText(error));
  }
  const byId = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const header = snapshot !== null && typeof snapshot === 'object' ? snapshot.header : undefined;
    const id = header !== null && typeof header === 'object' ? header.id : undefined;
    if (typeof id === 'string' && id !== '') byId.set(id, snapshot);
  }
  if (!byId.has(rootId)) {
    throw new SessionPortFormatError('not-found', '会话存储里找不到会话 ' + rootId);
  }
  const targets = lineageClosure(rootId, byId);
  assertNotActive(sessions, agents, [...targets]);

  // Precheck every target before the first move.
  const plans = [];
  const seenDirectories = new Map();
  for (const id of targets) {
    const snapshot = await resolveDeleteSnapshot(persistence, id, byId.get(id));
    const plan = verifySessionLocation(id, snapshot);
    const previous = seenDirectories.get(plan.sessionDir);
    if (previous !== undefined) {
      throw new SessionPortFormatError('unsafe-location', '会话 ' + id + ' 与 ' + previous + ' 指向同一个存储目录，拒绝删除');
    }
    seenDirectories.set(plan.sessionDir, id);
    await assertMovableDirectory(id, plan.sessionDir);
    plans.push({ id, sessionDir: plan.sessionDir });
  }

  const trashRoot = resolveTrashRoot(options);
  for (const plan of plans) {
    if (isInside(trashRoot, plan.sessionDir)) {
      throw new SessionPortFormatError('unsafe-location', '回收站目录位于会话存储目录内，拒绝删除：' + trashRoot);
    }
  }
  const trashPath = await createTrashOperationDir(trashRoot);

  const moved = [];
  try {
    for (const plan of plans) {
      const destination = join(trashPath, encodeSegment(plan.id));
      await moveDirectory(plan.sessionDir, destination);
      moved.push({ source: plan.sessionDir, destination });
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of [...moved].reverse()) {
      try {
        await moveDirectory(entry.destination, entry.source);
      } catch (rollbackError) {
        rollbackFailures.push(entry.source + '（' + errorText(rollbackError) + '）');
      }
    }
    const rollbackNote = rollbackFailures.length === 0
      ? ''
      : '；已移动的目录回滚失败，仍位于 ' + trashPath + '：' + rollbackFailures.join('、');
    throw new SessionPortFormatError('delete-failed', '移动会话目录到回收站失败：' + errorText(error) + rollbackNote);
  }

  await cleanupRegistry(ctx, [...targets]);

  const descendents = [...targets].filter((id) => id !== rootId).sort();
  return { sessionIds: [rootId, ...descendents], trashedPath: trashPath };
}
