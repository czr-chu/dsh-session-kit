/**
 * dsh-session-kit — trash operations: list, restore, purge.
 *
 * Deleting a session moves its storage directory into
 * `<DSH_HOME>/session-kit-trash/<stamp>/` and writes an `operation.json`
 * manifest (see `lib/manage.js`). This module is the only reader of that
 * layout: it lists what is recoverable, moves a session directory back to its
 * recorded project directory, and erases an operation on explicit request.
 *
 * Safety rules, all checked before a write:
 *  - an operation id is one plain path segment; the resolved directory must be
 *    a real (non-symlink) child of the resolved trash root;
 *  - the manifest must carry the expected kind and a version this build knows;
 *    an operation without a manifest is listed but cannot be restored (its
 *    original directory was never recorded);
 *  - restore never overwrites: a target that already exists is skipped, and the
 *    original directory must be outside the trash root;
 *  - purge requires `confirm: true` and only removes directories proved to be
 *    inside the trash root.
 *
 * What this module does not do: it never deletes attachment blobs (the
 * attachment store has no delete seam), never restores subagent transcripts as
 * separate sessions, and never touches a live session's directory.
 *
 * @module dsh-session-kit/trash
 */

import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import { errorText } from './attachments.js';
import { SessionPortFormatError } from './format.js';
import {
  TRASH_MANIFEST_KIND,
  TRASH_MANIFEST_NAME,
  TRASH_MANIFEST_VERSION,
  resolveTrashRoot,
} from './manage.js';

/** Upper bound on operations returned by one listing. */
export const MAX_TRASH_OPERATIONS = 500;

/** Bound on the filesystem walk used for one operation's size. */
const MAX_WALK_FILES = 20_000;

/** True for a plain string that can be one path segment. */
function isPlainSegment(value) {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\');
}

/** Whether one path is the same as or inside another directory. */
function isWithin(child, parent) {
  const normalizedChild = resolvePath(child);
  const normalizedParent = resolvePath(parent);
  if (normalizedChild === normalizedParent) return true;
  const rel = relative(normalizedParent, normalizedChild);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** One filesystem entry's stats, or undefined when it does not exist. */
async function statOrUndefined(path) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

/**
 * Sum the regular files under one directory, bounded and symlink-free.
 * @param {string} directory - absolute directory.
 * @returns {Promise<number>} bytes counted before the walk bound.
 */
async function directoryBytes(directory) {
  let total = 0;
  let visited = 0;
  const queue = [directory];
  while (queue.length > 0 && visited < MAX_WALK_FILES) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_FILES) break;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await stat(path)).size;
      } catch {
        // An unreadable file simply contributes nothing to the estimate.
      }
    }
  }
  return total;
}

/** Read and validate one operation manifest. */
async function readManifest(operationDir) {
  const path = join(operationDir, TRASH_MANIFEST_NAME);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (parsed.kind !== TRASH_MANIFEST_KIND) return undefined;
  if (parsed.version !== TRASH_MANIFEST_VERSION) {
    throw new SessionPortFormatError(
      'trash-manifest-invalid',
      `回收站清单版本 ${String(parsed.version)} 不受支持（当前支持 ${TRASH_MANIFEST_VERSION}）`,
    );
  }
  return parsed;
}

/** Normalize the manifest's session entries, dropping malformed ones. */
function manifestSessions(manifest) {
  if (!Array.isArray(manifest?.sessions)) return [];
  return manifest.sessions
    .filter((entry) => entry !== null && typeof entry === 'object')
    .filter((entry) => typeof entry.id === 'string' && entry.id !== '' && isPlainSegment(entry.trashedName))
    .map((entry) => ({
      id: entry.id,
      trashedName: entry.trashedName,
      ...(typeof entry.originalDir === 'string' && isAbsolute(entry.originalDir)
        ? { originalDir: entry.originalDir }
        : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
    }));
}

/** Resolve and validate one operation directory under the trash root. */
async function operationDirectory(trashRoot, operationId) {
  if (!isPlainSegment(operationId)) {
    throw new SessionPortFormatError('invalid-argument', 'operationId 必须是回收站目录下的一个目录名');
  }
  const candidate = resolvePath(join(trashRoot, operationId));
  if (!isWithin(candidate, trashRoot) || candidate === resolvePath(trashRoot)) {
    throw new SessionPortFormatError('unsafe-location', '回收站操作目录不在回收站根目录内：' + candidate);
  }
  const info = await statOrUndefined(candidate);
  if (info === undefined) {
    throw new SessionPortFormatError('not-found', '回收站里找不到操作 ' + operationId);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SessionPortFormatError('unsafe-location', '回收站操作路径不是目录或不是符号链接：' + candidate);
  }
  return candidate;
}

/**
 * List the trash operations that can be restored or purged.
 * @param {object} ctx - the plugin context (unused today; kept for symmetry).
 * @param {{trashDir?: string}} [options] - trash directory override.
 * @returns {Promise<{trashRoot: string, operations: Array<object>, warnings: string[]}>} inventory.
 */
export async function listTrashOperations(ctx, options = {}) {
  void ctx;
  const trashRoot = resolveTrashRoot(options);
  const warnings = [];
  let entries;
  try {
    entries = await readdir(trashRoot, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return { trashRoot, operations: [], warnings };
    }
    throw new SessionPortFormatError('trash-failed', '读取回收站目录失败：' + errorText(error));
  }
  const operations = [];
  for (const entry of entries.slice(0, MAX_TRASH_OPERATIONS)) {
    if (!entry.isDirectory()) continue;
    const operationDir = join(trashRoot, entry.name);
    const info = await statOrUndefined(operationDir);
    if (info === undefined || info.isSymbolicLink()) continue;
    let manifest;
    try {
      manifest = await readManifest(operationDir);
    } catch (error) {
      warnings.push('跳过无法解析的操作 ' + entry.name + '：' + errorText(error));
      continue;
    }
    const sessions = manifestSessions(manifest);
    if (manifest === undefined) {
      warnings.push('操作 ' + entry.name + ' 缺少清单，只能人工检查，不能自动恢复');
    }
    const bytes = await directoryBytes(operationDir);
    operations.push({
      operationId: entry.name,
      createdAt: typeof manifest?.createdAt === 'string'
        ? manifest.createdAt
        : (info.mtime instanceof Date ? info.mtime.toISOString() : undefined),
      restorable: manifest !== undefined,
      sessionCount: sessions.length,
      sessions,
      archived: Array.isArray(manifest?.archived) ? manifest.archived.map(String) : [],
      pinned: Array.isArray(manifest?.pinned) ? manifest.pinned.map(String) : [],
      bytes,
      hasFiles: manifest?.files !== undefined,
    });
  }
  operations.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
  return { trashRoot, operations, warnings };
}

/** Re-attach one restored session to the workspace its original directory names. */
async function reattachRestoredSession(ctx, session, warnings) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || typeof registry.resolveByPath !== 'function') return;
  try {
    const workspace = await registry.resolveByPath(session.originalDir);
    if (workspace === undefined || workspace === null || typeof workspace.attachSession !== 'function') return;
    await workspace.attachSession(session.id);
  } catch (error) {
    warnings.push('会话 ' + session.id + ' 已恢复，但没能重新加入工作区：' + errorText(error));
  }
}

/** Restore the archive/pin state recorded in the manifest, best effort. */
async function restoreRegistryState(ctx, operation, ids, warnings) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined) return;
  const archived = Array.isArray(operation.archived) ? operation.archived.map(String) : [];
  const pinned = Array.isArray(operation.pinned) ? operation.pinned.map(String) : [];
  for (const id of ids) {
    if (pinned.includes(id) && !archived.includes(id)
      && typeof registry.pinSession === 'function') {
      try {
        await registry.pinSession(id);
      } catch (error) {
        warnings.push('会话 ' + id + ' 已恢复，但没能恢复置顶状态：' + errorText(error));
      }
    }
    if (archived.includes(id) && typeof registry.archiveSession === 'function') {
      try {
        await registry.archiveSession(id);
      } catch (error) {
        warnings.push('会话 ' + id + ' 已恢复，但没能恢复归档状态：' + errorText(error));
      }
    }
  }
}

/**
 * Move one operation's session directories back and re-register them.
 *
 * Partial restores are allowed: an operation keeps the manifest (rewritten to
 * the remaining sessions) so a later call can finish. A target that already
 * exists is skipped rather than overwritten.
 * @param {object} ctx - the plugin context.
 * @param {{trashDir?: string, operationId: string, sessionIds?: string[]}} options - which operation and sessions.
 * @returns {Promise<object>} restore outcome.
 */
export async function restoreTrashOperation(ctx, options = {}) {
  const trashRoot = resolveTrashRoot(options);
  const operationDir = await operationDirectory(trashRoot, options.operationId);
  const manifest = await readManifest(operationDir);
  if (manifest === undefined) {
    throw new SessionPortFormatError(
      'trash-manifest-missing',
      '操作 ' + options.operationId + ' 没有清单，无法自动恢复原位置',
    );
  }
  const all = manifestSessions(manifest);
  if (all.length === 0) {
    throw new SessionPortFormatError('trash-manifest-invalid', '操作清单里没有可恢复的会话');
  }
  const requested = Array.isArray(options.sessionIds) && options.sessionIds.length > 0
    ? new Set(options.sessionIds.map(String))
    : undefined;
  const selected = requested === undefined ? all : all.filter((entry) => requested.has(entry.id));
  if (selected.length === 0) {
    throw new SessionPortFormatError('not-found', '所选会话不在这个回收站操作里');
  }

  const sessionsRoot = typeof manifest.sessionsRoot === 'string' && isAbsolute(manifest.sessionsRoot)
    ? manifest.sessionsRoot
    : undefined;
  const restored = [];
  const skipped = [];
  const warnings = [];
  for (const session of selected) {
    if (session.originalDir === undefined) {
      skipped.push({ id: session.id, reason: 'no-original-location' });
      continue;
    }
    if (isWithin(session.originalDir, trashRoot)
      || (sessionsRoot !== undefined && !isWithin(session.originalDir, sessionsRoot))) {
      skipped.push({ id: session.id, reason: 'unsafe-location' });
      continue;
    }
    const source = join(operationDir, session.trashedName);
    const info = await statOrUndefined(source);
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
      skipped.push({ id: session.id, reason: 'missing' });
      continue;
    }
    const target = join(session.originalDir, session.trashedName);
    if ((await statOrUndefined(target)) !== undefined) {
      skipped.push({ id: session.id, reason: 'target-exists' });
      continue;
    }
    try {
      await mkdir(session.originalDir, { recursive: true });
      await rename(source, target);
    } catch (error) {
      skipped.push({ id: session.id, reason: 'move-failed', error: errorText(error) });
      continue;
    }
    restored.push({ id: session.id, path: target });
    await reattachRestoredSession(ctx, session, warnings);
  }

  const restoredIds = restored.map((entry) => entry.id);
  await restoreRegistryState(ctx, manifest, restoredIds, warnings);

  // Rewrite the manifest for a partial restore, or drop the operation when
  // nothing restorable is left. Files (if any) keep the operation alive.
  const remaining = all.filter((entry) => !restoredIds.includes(entry.id));
  const hasFiles = manifest?.files !== undefined;
  try {
    if (remaining.length === 0 && !hasFiles) {
      await rm(operationDir, { recursive: true, force: true });
    } else if (remaining.length !== all.length) {
      const next = { ...manifest, sessions: remaining, archived: [], pinned: [] };
      await writeFile(join(operationDir, TRASH_MANIFEST_NAME), JSON.stringify(next) + '\n', { mode: 0o600 });
    }
  } catch (error) {
    warnings.push('恢复完成，但更新回收站清单失败：' + errorText(error));
  }

  return { operationId: options.operationId, restored, skipped, warnings };
}

/**
 * Permanently erase trash operations.
 *
 * This is the only irreversible operation in the plugin besides permanent
 * session delete; it requires an explicit `confirm: true` (enforced here, on the
 * route and in the tool) and only removes directories proved to be inside the
 * trash root.
 * @param {object} ctx - the plugin context (unused today).
 * @param {{trashDir?: string, operationIds: string[] | 'all', confirm?: boolean, olderThanDays?: number}} options - purge scope.
 * @returns {Promise<object>} purge outcome.
 */
export async function purgeTrashOperations(ctx, options = {}) {
  void ctx;
  if (options.confirm !== true) {
    throw new SessionPortFormatError(
      'confirm-required',
      'purgeTrashOperations 需要 confirm:true（清理不可恢复）',
    );
  }
  const trashRoot = resolveTrashRoot(options);
  let operationIds;
  if (options.operationIds === 'all') {
    const listed = await listTrashOperations(ctx, options);
    const cutoff = Number.isSafeInteger(options.olderThanDays) && options.olderThanDays > 0
      ? Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000
      : undefined;
    operationIds = listed.operations
      .filter((operation) => cutoff === undefined
        || operation.createdAt === undefined
        || Date.parse(operation.createdAt) <= cutoff)
      .map((operation) => operation.operationId);
  } else if (Array.isArray(options.operationIds) && options.operationIds.length > 0) {
    operationIds = options.operationIds.map(String);
  } else {
    throw new SessionPortFormatError('invalid-argument', 'operationIds 必须是目录名数组或 "all"');
  }

  const removed = [];
  let freedBytes = 0;
  const warnings = [];
  for (const operationId of operationIds) {
    let operationDir;
    try {
      operationDir = await operationDirectory(trashRoot, operationId);
    } catch (error) {
      if (error instanceof SessionPortFormatError && error.code === 'not-found') {
        warnings.push('跳过不存在的操作 ' + operationId);
        continue;
      }
      throw error;
    }
    const bytes = await directoryBytes(operationDir);
    try {
      await rm(operationDir, { recursive: true, force: true });
    } catch (error) {
      warnings.push('清理 ' + operationId + ' 失败：' + errorText(error));
      continue;
    }
    removed.push(operationId);
    freedBytes += bytes;
  }
  return { trashRoot, removed, freedBytes, warnings };
}
