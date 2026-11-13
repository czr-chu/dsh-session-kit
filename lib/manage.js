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

import { cp, lstat, mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import { errorText } from './attachments.js';
import { SessionPortFormatError } from './format.js';
import { deriveSessionFilePlan } from './session-files.js';

/** Trash operation manifest file, shared with `lib/trash.js`. */
export const TRASH_MANIFEST_NAME = 'operation.json';

/** Manifest kind stamped into every trash operation. */
export const TRASH_MANIFEST_KIND = 'dsh-session-kit-trash';

/** Manifest schema version; a newer version is refused by the restorer. */
export const TRASH_MANIFEST_VERSION = 1;

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
 *
 * Shared with `lib/trash.js` so listing/restoring/purging resolves the same
 * directory the delete path used.
 * @param {{trashDir?: string}} options - caller override.
 * @returns {string} absolute trash root directory.
 * @throws {SessionPortFormatError} when an explicit trashDir is empty.
 */
export function resolveTrashRoot(options) {
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
 * Resolve the effective file plan for one delete call: the caller's precomputed
 * plan when supplied, otherwise a fresh best-effort derivation.
 * @param {object} ctx - the plugin context.
 * @param {ReadonlyArray<string>} targets - sessions being deleted.
 * @param {{trashDir?: string, filePlan?: object}} options - delete options.
 * @returns {Promise<object>} the normalized plan.
 */
async function resolveDeleteFilePlan(ctx, targets, options) {
  const supplied = options?.filePlan;
  if (supplied !== undefined) {
    if (supplied === null || typeof supplied !== 'object' || !Array.isArray(supplied.files)) {
      throw new SessionPortFormatError('invalid-argument', 'filePlan 必须是 deriveSessionFilePlan 的返回对象');
    }
    return {
      files: supplied.files,
      skipped: Array.isArray(supplied.skipped) ? supplied.skipped : [],
      warnings: Array.isArray(supplied.warnings) ? supplied.warnings : [],
      totalBytes: Number.isSafeInteger(supplied.totalBytes) ? supplied.totalBytes : 0,
    };
  }
  try {
    return await deriveSessionFilePlan(ctx, [...targets], options?.trashDir !== undefined ? { trashDir: options.trashDir } : {});
  } catch (error) {
    if (error instanceof SessionPortFormatError) throw error;
    throw new SessionPortFormatError('delete-failed', '推导会话相关文件失败：' + errorText(error));
  }
}

/**
 * Re-validate every planned file immediately before moving it and compute its
 * trash destination. The plan can be stale (the file moved, vanished, or became
 * a symlink), so this refuses anything outside its root, runtime state, or a
 * non-regular file before the first move.
 * The plan's root is not trusted: it must be one of the workspace roots that
 * the deleted sessions actually own (or be inside one), so a stale or tampered
 * plan can never redirect a move outside the user's workspace.
 * @param {object} plan - normalized file plan.
 * @param {{trashPath?: string, trashRoot: string, storageDirs: Set<string>, allowedRoots: Set<string>, permanent?: boolean}} context - trash, runtime, and allowed workspace locations.
 * @returns {Promise<{moves: Array<object>, skipped: Array<object>, warnings: string[]}>} validated moves.
 */
async function prevalidatePlannedFiles(plan, context) {
  const { trashPath, trashRoot, storageDirs, allowedRoots, permanent = false } = context;
  const moves = [];
  const skipped = [];
  const warnings = [];
  const destinations = new Set();
  for (const entry of plan.files) {
    const original = entry !== null && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : undefined;
    const rootValue = entry !== null && typeof entry === 'object' && typeof entry.root === 'string' ? entry.root : undefined;
    if (original === undefined || rootValue === undefined) {
      skipped.push({ path: original === undefined ? '' : original, reason: 'invalid-entry' });
      continue;
    }
    const absolute = resolvePath(original);
    const root = resolvePath(rootValue);
    const rootAllowed = [...allowedRoots].some((allowed) => root === allowed || isInside(root, allowed));
    if (!rootAllowed) {
      skipped.push({ path: absolute, reason: 'root-not-allowed' });
      continue;
    }
    if (absolute === root || !isInside(absolute, root)) {
      skipped.push({ path: absolute, reason: 'outside-workspace' });
      continue;
    }
    if (isInside(absolute, trashRoot) || isInside(absolute, dshHome())
      || [...storageDirs].some((directory) => isInside(absolute, directory))) {
      skipped.push({ path: absolute, reason: 'excluded-runtime-state' });
      continue;
    }
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined;
      skipped.push({ path: absolute, reason: code === 'ENOENT' ? 'missing' : 'unreadable' });
      continue;
    }
    if (info.isSymbolicLink()) {
      skipped.push({ path: absolute, reason: 'symlink' });
      continue;
    }
    if (!info.isFile()) {
      skipped.push({ path: absolute, reason: 'not-a-file' });
      continue;
    }
    const relativePath = relative(root, absolute);
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      skipped.push({ path: absolute, reason: 'outside-workspace' });
      continue;
    }
    const posixRelative = relativePath.split(sep).join('/');
    if (permanent) {
      moves.push({ source: absolute, entry, size: info.size, relative: posixRelative });
      continue;
    }
    const destination = join(trashPath, 'files', encodeSegment(root), posixRelative);
    if (destinations.has(destination)) {
      warnings.push('多个计划文件指向同一回收站路径，已跳过：' + absolute);
      skipped.push({ path: absolute, reason: 'conflict' });
      continue;
    }
    let destinationExists = false;
    try {
      await lstat(destination);
      destinationExists = true;
    } catch {
      destinationExists = false;
    }
    if (destinationExists) {
      warnings.push('回收站目标已存在，已跳过：' + destination);
      skipped.push({ path: absolute, reason: 'conflict' });
      continue;
    }
    destinations.add(destination);
    moves.push({ source: absolute, destination, entry, size: info.size, relative: posixRelative });
  }
  return { moves, skipped, warnings };
}

/** Restore moved files in reverse order; returns one failure note per unrestored path. */
async function rollbackMovedFiles(moved) {
  const failures = [];
  for (const move of [...moved].reverse()) {
    try {
      await mkdir(dirname(move.source), { recursive: true, mode: 0o700 });
      await moveDirectory(move.destination, move.source);
    } catch (error) {
      failures.push(move.source + '（' + errorText(error) + '）');
    }
  }
  return failures;
}

/**
 * Move the prevalidated files under <trashPath>/files/<encoded root>/<relative>
 * and write the files manifest. Any failure rolls every moved file back, so the
 * session directories are never touched by a partial file move.
 * @param {Array<object>} moves - validated moves.
 * @param {{trashPath: string, plan: object, targets: ReadonlyArray<string>}} context - trash and plan facts.
 * @returns {Promise<{moved: Array<object>, bytes: number, manifestPath: string}>} file move outcome.
 */
async function movePlannedFiles(moves, context) {
  const { trashPath, plan, targets } = context;
  const moved = [];
  let bytes = 0;
  try {
    for (const move of moves) {
      await mkdir(dirname(move.destination), { recursive: true, mode: 0o700 });
      await moveDirectory(move.source, move.destination);
      moved.push(move);
      bytes += move.size;
    }
    const manifest = {
      manifestVersion: 1,
      kind: 'dsh-session-kit-files',
      createdAt: new Date().toISOString(),
      trashPath,
      sessionIds: [...targets].sort(),
      totalBytes: bytes,
      files: moved.map((move) => ({
        path: move.entry.path,
        relative: move.relative,
        root: move.entry.root,
        bytes: move.size,
        evidence: Array.isArray(move.entry.evidence) ? move.entry.evidence : [],
        weak: move.entry.weak === true,
        sessionIds: Array.isArray(move.entry.sessionIds) ? move.entry.sessionIds : [],
        trashedPath: move.destination,
      })),
      skipped: Array.isArray(plan.skipped) ? plan.skipped : [],
    };
    const manifestPath = join(trashPath, 'files-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    return { moved, bytes, manifestPath };
  } catch (error) {
    const rollbackFailures = await rollbackMovedFiles(moved);
    const rollbackNote = rollbackFailures.length === 0
      ? ''
      : '；已移动的文件回滚失败：' + rollbackFailures.join('、');
    throw new SessionPortFormatError('delete-failed', '移动会话相关文件到回收站失败：' + errorText(error) + rollbackNote);
  }
}

/**
 * Normalize the explicit related-file selection. Invalid entries are skipped
 * with a warning instead of failing the delete: the selection is user input,
 * and a stale client path must never abort an otherwise valid operation.
 * @param {unknown} selectedFiles - raw caller value.
 * @returns {{accepted: Set<string>, warnings: string[], invalid: number}} absolute selection.
 */
function normalizeFileSelection(selectedFiles) {
  const accepted = new Set();
  const warnings = [];
  let invalid = 0;
  const requested = Array.isArray(selectedFiles) ? selectedFiles : [];
  for (const raw of requested) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      invalid += 1;
      warnings.push('所选文件条目不是有效路径，已跳过：' + String(raw));
      continue;
    }
    if (!isAbsolute(raw)) {
      invalid += 1;
      warnings.push('所选文件必须是绝对路径，已跳过：' + raw);
      continue;
    }
    accepted.add(resolvePath(raw.trim()));
  }
  return { accepted, warnings, invalid };
}

/**
 * Keep only the explicitly selected files of one derived plan.
 * @param {object} plan - derived plan.
 * @param {{accepted: Set<string>}} selection - normalized selection.
 * @returns {{files: Array<object>, warnings: string[], unmatched: number}} filtered files.
 */
function selectPlannedFiles(plan, selection) {
  const matched = new Set();
  const files = [];
  for (const entry of plan.files) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
    const absolute = resolvePath(entry.path);
    if (!selection.accepted.has(absolute)) continue;
    matched.add(absolute);
    files.push({ ...entry, path: absolute });
  }
  const warnings = [];
  let unmatched = 0;
  for (const selected of selection.accepted) {
    if (matched.has(selected)) continue;
    unmatched += 1;
    warnings.push('所选文件不在本次推导计划中，已跳过：' + selected);
  }
  return { files, warnings, unmatched };
}

/**
 * Permanently delete the prevalidated files. There is no rollback: on failure
 * the error reports exactly which files were erased and which were not.
 * @param {Array<object>} moves - validated moves.
 * @returns {Promise<{removed: Array<object>, bytes: number}>} erased files.
 */
async function permanentlyDeleteFiles(moves) {
  const removed = [];
  let bytes = 0;
  try {
    for (const move of moves) {
      await unlink(move.source);
      removed.push(move);
      bytes += move.size;
    }
    return { removed, bytes };
  } catch (error) {
    const removedSources = new Set(removed.map((move) => move.source));
    const remaining = moves.filter((move) => !removedSources.has(move.source)).map((move) => move.source);
    throw new SessionPortFormatError(
      'delete-failed',
      '永久删除文件失败：' + errorText(error)
      + '；已删除 ' + removed.length + ' 个文件（不可恢复）'
      + '；未删除：' + (remaining.length === 0 ? '无' : remaining.join('、'))
      + '；会话目录未删除',
    );
  }
}

/**
 * Permanently remove the verified session directories. There is no rollback: on
 * failure the error reports which sessions were erased and which remain.
 * @param {Array<{id: string, sessionDir: string}>} plans - verified session directories.
 * @param {{filesErased: number}} facts - already erased file count for the report.
 * @returns {Promise<string[]>} erased session ids.
 */
async function permanentlyDeleteSessions(plans, facts) {
  const removed = [];
  try {
    for (const plan of plans) {
      await rm(plan.sessionDir, { recursive: true, force: false });
      removed.push(plan.id);
    }
    return removed;
  } catch (error) {
    const remaining = plans.filter((plan) => !removed.includes(plan.id)).map((plan) => plan.id);
    throw new SessionPortFormatError(
      'delete-failed',
      '永久删除会话目录失败：' + errorText(error)
      + '；已删除会话：' + (removed.length === 0 ? '无' : removed.join('、'))
      + '；未删除会话：' + remaining.join('、')
      + (facts.filesErased > 0 ? '；已删除的 ' + facts.filesErased + ' 个文件不可恢复' : ''),
    );
  }
}

/**
 * Delete one session and every origin='subagent' descendant.
 *
 * Two irreversible-or-not modes share the same prechecks (live/running refusal,
 * verifiable session directories, every path validated before the first write):
 *
 *  - permanent=false (default): related files and session directories move to
 *    <trashRoot>/<ISO stamp>/..., with a files-manifest.json for selected files.
 *    A file failure rolls the moved files back before any session directory
 *    moves; a later session failure rolls both back. Nothing is erased.
 *  - permanent=true: selected related files are unlinked and session
 *    directories removed recursively. There is NO rollback; a failure reports
 *    exactly which files/sessions were erased and which remain.
 *
 * User-visible fork/seeded children (origin unset) are never part of either
 * mode. Related files are opt-in: removeFiles requires an explicit
 * selectedFiles array (a subset of the freshly derived plan) so no caller can
 * bulk-handle every derived file silently. Unselected files are left in place.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the session to delete.
 * @param {{trashDir?: string, removeFiles?: boolean, selectedFiles?: string[], filePlan?: object, permanent?: boolean}} [options] - trash root, related-file selection, precomputed plan, and permanent-erase mode.
 * @returns {Promise<{sessionIds: string[], permanent: boolean, trashedPath?: string, filesMoved?: number, filesRemoved?: number, filesSkipped: number, filesBytes: number, filesTrashPath?: string, fileWarnings: string[]}>} delete outcome and statistics.
 * @throws {SessionPortFormatError} code 'invalid-argument' | 'invalid-selection' | 'unavailable' | 'not-found' | 'active' | 'unsafe-location' | 'delete-failed'.
 */
/** Read one registry id collection as a plain string array, tolerating iterables. */
function registryIds(registry, key) {
  try {
    const value = registry?.[key];
    if (value === undefined || value === null || typeof value[Symbol.iterator] !== 'function') return [];
    return [...value].map((id) => String(id));
  } catch {
    return [];
  }
}

/**
 * Write the operation manifest that makes a trash operation restorable.
 *
 * The manifest is what `lib/trash.js` reads to list, restore and purge an
 * operation; a delete that cannot write it still succeeds (the move already
 * happened) but the caller reports a warning, because the trash entry then has
 * no recorded original location.
 * @param {string} trashPath - the operation directory.
 * @param {{rootId: string, plans: Array<{id: string, sessionDir: string}>, byId: Map<string, object>, filePhase: object, archived: string[], pinned: string[]}} payload - operation facts.
 * @returns {Promise<string | undefined>} manifest path, or undefined on failure.
 */
async function writeTrashManifest(trashPath, payload) {
  const sessions = payload.plans.map((plan) => {
    const header = payload.byId.get(plan.id)?.header;
    const record = header !== null && typeof header === 'object' ? header : {};
    return {
      id: plan.id,
      trashedName: encodeSegment(plan.id),
      originalDir: dirname(plan.sessionDir),
      ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
      ...(Number.isSafeInteger(record.createdAt) ? { createdAt: record.createdAt } : {}),
      ...(Number.isSafeInteger(record.version) ? { formatVersion: record.version } : {}),
    };
  });
  const files = payload.filePhase?.filesTrashPath === undefined
    ? undefined
    : {
        trashPath: relative(trashPath, payload.filePhase.filesTrashPath),
        ...(typeof payload.filePhase.manifestPath === 'string'
          ? { manifestPath: relative(trashPath, payload.filePhase.manifestPath) }
          : {}),
      };
  // `sessionsRoot` lets the restorer prove an original directory still belongs
  // to the session store instead of trusting an arbitrary absolute path.
  const sessionsRoot = payload.plans.length === 0 ? undefined : dirname(dirname(payload.plans[0].sessionDir));
  const manifest = {
    kind: TRASH_MANIFEST_KIND,
    version: TRASH_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    ...(sessionsRoot !== undefined ? { sessionsRoot } : {}),
    rootSessionId: payload.rootId,
    sessionIds: [payload.rootId, ...payload.plans.map((plan) => plan.id).filter((id) => id !== payload.rootId)],
    sessions,
    ...(files !== undefined ? { files } : {}),
    archived: payload.archived,
    pinned: payload.pinned,
  };
  const path = join(trashPath, TRASH_MANIFEST_NAME);
  try {
    await writeFile(path, JSON.stringify(manifest) + '\n', { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

export async function deleteSession(ctx, sessionId, options = {}) {
  const rootId = requireSessionId(sessionId);
  const removeFiles = options?.removeFiles === true;
  const permanent = options?.permanent === true;
  if (removeFiles && !Array.isArray(options?.selectedFiles)) {
    throw new SessionPortFormatError(
      'invalid-selection',
      'removeFiles 需要 selectedFiles 数组，明确列出要处理的相关文件（不允许隐式处理全部推导文件）',
    );
  }
  const selection = removeFiles
    ? normalizeFileSelection(options.selectedFiles)
    : { accepted: new Set(), warnings: [], invalid: 0 };

  const sessions = serviceOf(ctx, 'sessions');
  const agents = serviceOf(ctx, 'agents');
  const persistence = serviceOf(ctx, 'sessionPersistence');
  if (persistence === null || persistence === undefined || typeof persistence.list !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法删除会话');
  }

  // Refuse a live root before touching the store: a session that is still
  // attached cannot be deleted safely even if persistence happens to list it.
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

  // Precheck every target before the first deletion. Permanent mode validates
  // the same way: every storage directory must be a verifiable session
  // directory, never a symlink or an arbitrary path.
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
  let trashPath;
  if (!permanent) {
    for (const plan of plans) {
      if (isInside(trashRoot, plan.sessionDir)) {
        throw new SessionPortFormatError('unsafe-location', '回收站目录位于会话存储目录内，拒绝删除：' + trashRoot);
      }
    }
    trashPath = await createTrashOperationDir(trashRoot);
  }

  // Related workspace files are handled before session directories, so a file
  // failure can never leave a half-deleted session tree.
  let filePhase = {
    removed: [],
    moved: [],
    skipped: [],
    warnings: [],
    bytes: 0,
    filesTrashPath: undefined,
    manifestPath: undefined,
  };
  const selectionWarnings = [...selection.warnings];
  let selectionSkipped = selection.invalid;
  if (removeFiles) {
    let plan = await resolveDeleteFilePlan(ctx, [...targets], options);
    const selected = selectPlannedFiles(plan, selection);
    selectionWarnings.push(...selected.warnings);
    selectionSkipped += selected.unmatched;
    plan = { ...plan, files: selected.files };
    const storageDirs = new Set();
    for (const snapshot of byId.values()) {
      const locationPath = snapshot?.location?.path;
      if (typeof locationPath === 'string' && locationPath !== '') storageDirs.add(resolvePath(dirname(locationPath)));
    }
    // A move may only target a workspace this delete actually owns: the
    // registered workspace path or the session header cwd.
    const allowedRoots = new Set();
    const registry = serviceOf(ctx, 'workspaceRegistry');
    if (typeof registry?.list === 'function') {
      try {
        for (const workspace of await registry.list()) {
          if (workspace === null || typeof workspace !== 'object') continue;
          if (typeof workspace.path !== 'string' || workspace.path === '') continue;
          const owned = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [];
          if (!owned.some((id) => targets.has(id))) continue;
          allowedRoots.add(resolvePath(workspace.path));
        }
      } catch (error) {
        warn(ctx, '读取工作区列表失败，改用会话 cwd 校验文件根：' + errorText(error));
      }
    }
    for (const id of targets) {
      const cwd = byId.get(id)?.header?.cwd;
      if (typeof cwd === 'string' && isAbsolute(cwd)) allowedRoots.add(resolvePath(cwd));
    }
    const validated = await prevalidatePlannedFiles(plan, {
      trashPath,
      trashRoot,
      storageDirs,
      allowedRoots,
      permanent,
    });
    const skipped = [...(Array.isArray(plan.skipped) ? plan.skipped : []), ...validated.skipped];
    const relWarnings = [
      ...(Array.isArray(plan.warnings) ? plan.warnings : []),
      ...validated.warnings,
      ...selectionWarnings,
    ];
    if (permanent) {
      const erased = validated.moves.length === 0
        ? { removed: [], bytes: 0 }
        : await permanentlyDeleteFiles(validated.moves);
      filePhase = { ...filePhase, removed: erased.removed, skipped, warnings: relWarnings, bytes: erased.bytes };
    } else if (validated.moves.length > 0) {
      const outcome = await movePlannedFiles(validated.moves, { trashPath, plan, targets: [...targets] });
      filePhase = {
        ...filePhase,
        moved: outcome.moved,
        skipped,
        warnings: relWarnings,
        bytes: outcome.bytes,
        filesTrashPath: join(trashPath, 'files'),
        manifestPath: outcome.manifestPath,
      };
    } else {
      filePhase = { ...filePhase, skipped, warnings: relWarnings };
    }
    for (const warning of filePhase.warnings) warn(ctx, warning);
  }

  const descendents = [...targets].filter((id) => id !== rootId).sort();

  if (permanent) {
    await permanentlyDeleteSessions(plans, { filesErased: filePhase.removed.length });
    await cleanupRegistry(ctx, [...targets]);
    return {
      sessionIds: [rootId, ...descendents],
      permanent: true,
      filesRemoved: filePhase.removed.length,
      filesSkipped: filePhase.skipped.length + selectionSkipped,
      filesBytes: filePhase.bytes,
      fileWarnings: filePhase.warnings,
    };
  }

  // Record how to undo this operation before the first directory moves: the
  // manifest carries each session's original project directory plus the
  // archive/pin state the registry is about to forget.
  const registry = serviceOf(ctx, 'workspaceRegistry');
  const manifestPath = await writeTrashManifest(trashPath, {
    rootId,
    plans,
    byId,
    filePhase,
    archived: registryIds(registry, 'archivedSessionIds'),
    pinned: registryIds(registry, 'pinnedSessionIds'),
  });
  if (manifestPath === undefined) {
    warn(ctx, '回收站操作清单写入失败，本次删除无法自动恢复原位置：' + trashPath);
  }

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
    const fileRollbackFailures = filePhase.moved.length === 0 ? [] : await rollbackMovedFiles(filePhase.moved);
    if (filePhase.moved.length > 0 && fileRollbackFailures.length === 0 && filePhase.manifestPath !== undefined) {
      try {
        await rm(filePhase.manifestPath, { force: true });
      } catch {
        // Removing our own manifest is best-effort; the files are restored.
      }
    }
    if (rollbackFailures.length === 0 && manifestPath !== undefined) {
      try {
        await rm(manifestPath, { force: true });
      } catch {
        // Removing our own manifest is best-effort; the directories are back.
      }
    }
    const fileRollbackNote = fileRollbackFailures.length === 0
      ? ''
      : '；已移动的文件回滚失败：' + fileRollbackFailures.join('、');
    throw new SessionPortFormatError(
      'delete-failed',
      '移动会话目录到回收站失败：' + errorText(error) + rollbackNote + fileRollbackNote,
    );
  }

  await cleanupRegistry(ctx, [...targets]);

  return {
    sessionIds: [rootId, ...descendents],
    permanent: false,
    trashedPath: trashPath,
    filesMoved: filePhase.moved.length,
    filesSkipped: filePhase.skipped.length + selectionSkipped,
    filesBytes: filePhase.bytes,
    ...(filePhase.filesTrashPath !== undefined ? { filesTrashPath: filePhase.filesTrashPath } : {}),
    fileWarnings: filePhase.warnings,
  };
}
