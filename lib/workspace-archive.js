/**
 * dsh-session-kit — archive and restore a whole workspace.
 *
 * DSH has no workspace-level archive: a Workspace is a registry record, and
 * sessions are archived one at a time. Deleting the registration keeps the
 * directory and every session log, but the sessions lose their grouping and
 * surface under the unnamed workspace. This module implements the missing
 * unit without touching either bytes or DSH storage:
 *
 *   1. read the workspace and its attached session ids;
 *   2. archive each attached session through the official registry API
 *      (active sessions are refused, so archiving can never stop live work),
 *      remembering which sessions were already archived or pinned;
 *   3. write a `record.json` manifest under
 *      `<DSH_HOME>/session-kit-workspace-archive/<archiveId>/` with the
 *      workspace title/path/order and per-session flags;
 *   4. delete the workspace *registration* only — the directory, the session
 *      logs and every workspace file stay in place.
 *
 * Restore is idempotent: it reuses an existing workspace at the recorded path
 * or creates one, attaches the recorded sessions (their header `cwd` must still
 * resolve to that directory), unarchives only the sessions this archive
 * archived, re-pins the sessions that were pinned before, and then removes the
 * archive record. A session that cannot be attached (for example because the
 * project directory was moved) stays archived and leaves the record in a
 * `partial` state for a later retry.
 *
 * What this module does not do: it never deletes or moves the workspace
 * directory, never rewrites a session log, never imports a session from an
 * archive, and never archives subagent transcripts that were not workspace
 * members. It is a grouping operation plus the official per-session flag.
 *
 * @module dsh-session-kit/workspace-archive
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import { SessionPortFormatError } from './format.js';
import { servicesOf } from './sessions.js';

/** Manifest kind written for every workspace archive. */
export const WORKSPACE_ARCHIVE_KIND = 'dsh-session-kit-workspace-archive';

/** Manifest schema version understood by this build. */
export const WORKSPACE_ARCHIVE_VERSION = 1;

/** Directory name under DSH_HOME that receives workspace archive records. */
export const WORKSPACE_ARCHIVE_DIR = 'session-kit-workspace-archive';

/** Manifest file name inside one archive directory. */
export const WORKSPACE_ARCHIVE_RECORD = 'record.json';

/** Upper bound on archives returned by one listing. */
export const MAX_WORKSPACE_ARCHIVES = 500;

/** ISO-like local stamp used in archive directory names. */
function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '');
}

/** One-line message for an arbitrary thrown value. */
function errorText(error) {
  if (error instanceof Error) return error.message.split('\n')[0];
  return String(error);
}

/** Resolve DSH_HOME without importing the desktop shell. */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env !== '') return env;
  return join(homedir(), '.dsh');
}

/** Resolve the archive root, allowing tests to isolate it. */
function archiveRootOf(options = {}) {
  const explicit = options.archiveRoot;
  if (typeof explicit === 'string' && explicit !== '') return resolvePath(explicit);
  return join(dshHome(), WORKSPACE_ARCHIVE_DIR);
}

/** True for a plain single path segment. */
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

/** Current registry archive set, tolerating an older registry without it. */
function archivedSet(registry) {
  try {
    const ids = registry?.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}

/** Current registry pin set, tolerating an older registry without it. */
function pinnedSet(registry) {
  try {
    const ids = registry?.pinnedSessionIds;
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}

/** Read one archive record; undefined for a missing/malformed file. */
async function readRecord(directory) {
  let text;
  try {
    text = await readFile(join(directory, WORKSPACE_ARCHIVE_RECORD), 'utf8');
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
  if (parsed.kind !== WORKSPACE_ARCHIVE_KIND) return undefined;
  if (parsed.version !== WORKSPACE_ARCHIVE_VERSION) {
    throw new SessionPortFormatError(
      'workspace-archive-invalid',
      `工作区归档清单版本 ${String(parsed.version)} 不受支持（当前支持 ${WORKSPACE_ARCHIVE_VERSION}）`,
    );
  }
  return parsed;
}

/** Normalize one record's session rows, dropping malformed entries. */
function recordSessions(record) {
  if (!Array.isArray(record?.sessions)) return [];
  return record.sessions
    .filter((entry) => entry !== null && typeof entry === 'object')
    .filter((entry) => typeof entry.id === 'string' && entry.id !== '')
    .map((entry) => ({
      id: entry.id,
      archived: entry.archived === true,
      pinned: entry.pinned === true,
    }));
}

/** Normalize a record's workspace metadata. */
function recordWorkspace(record) {
  const workspace = record?.workspace;
  if (workspace === null || typeof workspace !== 'object') return undefined;
  if (typeof workspace.path !== 'string' || !isAbsolute(workspace.path)) return undefined;
  return {
    ...(typeof workspace.id === 'string' && workspace.id !== '' ? { workspaceId: workspace.id } : {}),
    ...(typeof workspace.title === 'string' ? { title: workspace.title } : {}),
    path: workspace.path,
    ...(typeof workspace.createdAt === 'string' ? { createdAt: workspace.createdAt } : {}),
    ...(typeof workspace.updatedAt === 'string' ? { updatedAt: workspace.updatedAt } : {}),
  };
}

/** Summary of one archive record for listings. */
function archiveSummary(archiveId, record, warnings = []) {
  const workspace = recordWorkspace(record);
  const sessions = recordSessions(record);
  const pending = Array.isArray(record?.pendingSessionIds)
    ? record.pendingSessionIds.map(String)
    : [];
  return {
    archiveId,
    archivedAt: typeof record?.archivedAt === 'string' ? record.archivedAt : '',
    workspace: workspace ?? { path: '' },
    sessionCount: sessions.length,
    preArchivedCount: sessions.filter((entry) => entry.archived).length,
    pinnedCount: sessions.filter((entry) => entry.pinned).length,
    status: pending.length > 0 ? 'partial' : 'ready',
    ...(typeof record?.restoredAt === 'string' ? { restoredAt: record.restoredAt } : {}),
    ...(pending.length > 0 ? { pendingSessionIds: pending } : {}),
    warnings,
  };
}

/** Write a record atomically inside its archive directory. */
async function writeRecord(directory, record) {
  const temporary = join(directory, `${WORKSPACE_ARCHIVE_RECORD}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, join(directory, WORKSPACE_ARCHIVE_RECORD));
}

/** Resolve and validate one workspace by id. */
async function resolveWorkspace(ctx, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    throw new SessionPortFormatError('invalid-argument', 'workspaceId 不能为空');
  }
  const registry = servicesOf(ctx).workspaceRegistry;
  if (registry === undefined || registry === null || typeof registry.delete !== 'function') {
    throw new SessionPortFormatError('unavailable', '工作区注册表不可用，无法归档工作区');
  }
  const requested = workspaceId.trim();
  let workspace;
  if (typeof registry.get === 'function') {
    try {
      workspace = registry.get(requested);
    } catch {
      workspace = undefined;
    }
  }
  if (workspace === undefined && typeof registry.list === 'function') {
    try {
      const list = await registry.list();
      workspace = (Array.isArray(list) ? list : []).find((entry) => String(entry?.id ?? '') === requested);
    } catch (error) {
      throw new SessionPortFormatError('workspace-not-found', `读取工作区列表失败：${errorText(error)}`);
    }
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
    throw new SessionPortFormatError('workspace-not-found', `工作区目录不存在：${path}`);
  }
  if (!info.isDirectory()) {
    throw new SessionPortFormatError('workspace-not-found', `工作区路径不是目录：${path}`);
  }
  return {
    registry,
    workspace,
    workspaceId: String(workspace.id),
    path: resolvePath(path),
    ...(typeof workspace.title === 'string' && workspace.title !== '' ? { title: workspace.title } : {}),
  };
}

/** Read the workspace order snapshot, tolerating an unavailable registry. */
async function workspaceOrder(registry) {
  try {
    const list = await registry.list();
    return (Array.isArray(list) ? list : [])
      .map((workspace) => String(workspace?.id ?? ''))
      .filter((id) => id !== '');
  } catch {
    return [];
  }
}

/**
 * Archive every attached session, record the workspace, then remove its
 * registration. Nothing is deleted from disk.
 * @param {object} ctx - plugin context.
 * @param {{workspaceId: string, confirm?: boolean, archiveRoot?: string}} options - target.
 * @returns {Promise<object>} archive summary and counts.
 */
export async function archiveWorkspace(ctx, options = {}) {
  if (options.confirm !== true) {
    throw new SessionPortFormatError(
      'confirm-required',
      '归档工作区会把其下所有会话标记为归档，并移除工作区注册（目录与会话日志保留）；需要 confirm:true',
    );
  }
  const target = await resolveWorkspace(ctx, options.workspaceId);
  const registry = target.registry;
  if (typeof registry.archiveSession !== 'function' || typeof registry.unarchiveSession !== 'function') {
    throw new SessionPortFormatError('unavailable', '工作区注册表缺少归档接口');
  }
  const sessionIds = Array.isArray(target.workspace.sessionIds)
    ? target.workspace.sessionIds.map(String)
    : [];
  const beforeArchived = archivedSet(registry);
  const beforePinned = pinnedSet(registry);
  const sessions = sessionIds.map((id) => ({
    id,
    archived: beforeArchived.has(id),
    pinned: beforePinned.has(id),
  }));
  const order = await workspaceOrder(registry);
  const index = order.indexOf(target.workspaceId);
  const beforeId = index >= 0 ? order[index + 1] : undefined;

  const root = archiveRootOf(options);
  const archiveId = `${stamp()}-${target.workspaceId}-${randomUUID().slice(0, 8)}`;
  const directory = join(root, archiveId);
  if (!isWithin(directory, root)) {
    throw new SessionPortFormatError('workspace-archive-failed', `归档目录不在根目录内：${directory}`);
  }
  const record = {
    kind: WORKSPACE_ARCHIVE_KIND,
    version: WORKSPACE_ARCHIVE_VERSION,
    archiveId,
    archivedAt: new Date().toISOString(),
    workspace: {
      id: target.workspaceId,
      ...(target.title === undefined ? {} : { title: target.title }),
      path: target.path,
      ...(typeof target.workspace.createdAt === 'string' ? { createdAt: target.workspace.createdAt } : {}),
      ...(typeof target.workspace.updatedAt === 'string' ? { updatedAt: target.workspace.updatedAt } : {}),
    },
    order: {
      index,
      ...(beforeId === undefined ? {} : { beforeId }),
    },
    sessions,
  };

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeRecord(directory, record);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw new SessionPortFormatError('workspace-archive-failed', `无法写入归档清单：${errorText(error)}`);
  }

  const archivedNow = [];
  try {
    for (const id of sessionIds) {
      if (beforeArchived.has(id)) continue;
      await registry.archiveSession(id);
      archivedNow.push(id);
    }
  } catch (error) {
    const warnings = [];
    for (const id of archivedNow.reverse()) {
      try {
        await registry.unarchiveSession(id);
      } catch (rollbackError) {
        warnings.push(`会话 ${id} 回滚取消失败：${errorText(rollbackError)}`);
      }
    }
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    const active = /active/iu.test(`${error?.name ?? ''} ${errorText(error)}`);
    const failure = new SessionPortFormatError(
      active ? 'active' : 'workspace-archive-failed',
      active
        ? `工作区 ${target.workspaceId} 仍有活动会话，归档前请先停止：${errorText(error)}`
        : `归档工作区失败：${errorText(error)}`,
    );
    failure.warnings = warnings;
    throw failure;
  }

  try {
    const removed = await registry.delete(target.workspace.id);
    if (removed === false) {
      throw new Error('工作区注册已不存在');
    }
  } catch (error) {
    const warnings = [];
    for (const id of archivedNow.reverse()) {
      try {
        await registry.unarchiveSession(id);
      } catch (rollbackError) {
        warnings.push(`会话 ${id} 回滚取消失败：${errorText(rollbackError)}`);
      }
    }
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    const failure = new SessionPortFormatError(
      'workspace-archive-failed',
      `移除工作区注册失败，已回滚会话归档：${errorText(error)}`,
    );
    failure.warnings = warnings;
    throw failure;
  }

  return {
    archive: archiveSummary(archiveId, record),
    archivedCount: archivedNow.length,
    alreadyArchivedCount: sessions.filter((entry) => entry.archived).length,
    workspaceRemoved: true,
  };
}

/**
 * Restore one archived workspace: recreate/reuse the registration, attach the
 * recorded sessions, unarchive the sessions this archive archived, and re-pin
 * the sessions that were pinned before. The record is removed only when every
 * recorded session could be attached.
 * @param {object} ctx - plugin context.
 * @param {{archiveId: string, archiveRoot?: string}} options - archive to restore.
 * @returns {Promise<object>} restore outcome.
 */
export async function restoreWorkspace(ctx, options = {}) {
  const archiveId = options.archiveId;
  if (!isPlainSegment(archiveId)) {
    throw new SessionPortFormatError('invalid-argument', 'archiveId 必须是单个目录名');
  }
  const root = archiveRootOf(options);
  const directory = join(root, archiveId);
  if (!isWithin(directory, root)) {
    throw new SessionPortFormatError('workspace-archive-invalid', `归档目录不在根目录内：${directory}`);
  }
  let record;
  try {
    record = await readRecord(directory);
  } catch (error) {
    throw new SessionPortFormatError('workspace-archive-invalid', errorText(error));
  }
  if (record === undefined) {
    throw new SessionPortFormatError('workspace-archive-not-found', `找不到工作区归档 ${archiveId}`);
  }
  const meta = recordWorkspace(record);
  if (meta === undefined) {
    throw new SessionPortFormatError('workspace-archive-invalid', `归档 ${archiveId} 的工作区路径无效`);
  }
  const registry = servicesOf(ctx).workspaceRegistry;
  if (registry === undefined || registry === null || typeof registry.create !== 'function') {
    throw new SessionPortFormatError('unavailable', '工作区注册表不可用，无法恢复工作区');
  }
  let info;
  try {
    info = await stat(meta.path);
  } catch {
    throw new SessionPortFormatError(
      'workspace-not-found',
      `工作区目录不存在，无法恢复：${meta.path}（目录恢复后重试）`,
    );
  }
  if (!info.isDirectory()) {
    throw new SessionPortFormatError('workspace-not-found', `工作区路径不是目录：${meta.path}`);
  }

  let workspace;
  let reused = false;
  if (typeof registry.resolveByPath === 'function') {
    try {
      workspace = await registry.resolveByPath(meta.path);
    } catch {
      workspace = undefined;
    }
  }
  if (workspace === undefined && typeof registry.list === 'function') {
    try {
      const list = await registry.list();
      workspace = (Array.isArray(list) ? list : []).find(
        (entry) => typeof entry?.path === 'string' && resolvePath(entry.path) === resolvePath(meta.path),
      );
    } catch {
      workspace = undefined;
    }
  }
  if (workspace === undefined || workspace === null) {
    workspace = await registry.create(meta.path, meta.title);
  } else {
    reused = true;
  }
  const warnings = [];
  if (meta.title !== undefined && typeof workspace.setTitle === 'function' && workspace.title !== meta.title) {
    try {
      await workspace.setTitle(meta.title);
    } catch (error) {
      warnings.push(`恢复工作区标题失败：${errorText(error)}`);
    }
  }
  if (!reused && typeof registry.insertBefore === 'function' && record?.order !== undefined) {
    const beforeId = typeof record.order.beforeId === 'string' ? record.order.beforeId : undefined;
    try {
      if (beforeId === undefined) await registry.insertBefore(String(workspace.id));
      else {
        const order = await workspaceOrder(registry);
        if (order.includes(beforeId)) await registry.insertBefore(String(workspace.id), beforeId);
      }
    } catch (error) {
      warnings.push(`恢复工作区顺序失败：${errorText(error)}`);
    }
  }

  const sessions = recordSessions(record);
  const restored = [];
  const skipped = [];
  const pending = [];
  for (const entry of sessions) {
    try {
      await workspace.attachSession(entry.id);
    } catch (error) {
      pending.push(entry.id);
      skipped.push({ id: entry.id, reason: 'attach-failed', message: errorText(error) });
      continue;
    }
    if (!entry.archived && typeof registry.unarchiveSession === 'function') {
      try {
        await registry.unarchiveSession(entry.id);
      } catch (error) {
        warnings.push(`会话 ${entry.id} 取消归档失败：${errorText(error)}`);
      }
    }
    if (entry.pinned && !entry.archived && typeof registry.pinSession === 'function') {
      try {
        await registry.pinSession(entry.id);
      } catch (error) {
        warnings.push(`会话 ${entry.id} 恢复置顶失败：${errorText(error)}`);
      }
    }
    restored.push(entry.id);
  }

  const completed = pending.length === 0;
  if (completed) {
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      warnings.push(`归档记录清理失败：${errorText(error)}`);
    });
  } else {
    try {
      await writeRecord(directory, {
        ...record,
        restoredAt: new Date().toISOString(),
        pendingSessionIds: pending,
        lastWarnings: warnings.slice(-20),
      });
    } catch (error) {
      warnings.push(`归档记录更新失败：${errorText(error)}`);
    }
  }

  return {
    archiveId,
    workspace: {
      workspaceId: String(workspace.id),
      ...(typeof workspace.title === 'string' ? { title: workspace.title } : {}),
      path: meta.path,
      reused,
    },
    restored,
    skipped,
    warnings,
    completed,
    ...(completed ? {} : { pendingSessionIds: pending }),
  };
}

/**
 * List the workspace archive records, newest first.
 * @param {object} ctx - plugin context (unused today; kept for symmetry).
 * @param {{archiveRoot?: string}} [options] - test override.
 * @returns {Promise<{archiveRoot: string, archives: Array<object>, warnings: string[]}>} listing.
 */
export async function listWorkspaceArchives(ctx, options = {}) {
  const root = archiveRootOf(options);
  const warnings = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { archiveRoot: root, archives: [], warnings };
    return { archiveRoot: root, archives: [], warnings: [`无法读取工作区归档目录：${errorText(error)}`] };
  }
  const archives = [];
  for (const entry of entries) {
    if (archives.length >= MAX_WORKSPACE_ARCHIVES) break;
    if (!entry.isDirectory()) continue;
    const archiveId = entry.name;
    if (!isPlainSegment(archiveId)) continue;
    let record;
    try {
      record = await readRecord(join(root, archiveId));
    } catch (error) {
      warnings.push(`${archiveId}：${errorText(error)}`);
      continue;
    }
    if (record === undefined) {
      warnings.push(`${archiveId}：缺少有效的 ${WORKSPACE_ARCHIVE_RECORD}`);
      continue;
    }
    archives.push(archiveSummary(archiveId, record));
  }
  archives.sort((left, right) => (right.archivedAt ?? '').localeCompare(left.archivedAt ?? ''));
  return { archiveRoot: root, archives, warnings };
}
