/**
 * dsh-session-kit -- workspace-level backup builder.
 *
 * A DSH workspace is the unit that owns projects and their session membership.
 * This wrapper turns one workspace into one archive: every session the workspace
 * registry lists for it, plus the workspace tree collected exactly once under
 * the workspace's own root. It reuses lib/export.js for the archive itself and
 * only adds the workspace-level selection, root pinning, naming, and manifest
 * metadata, so normal multi-session exports keep their existing behavior.
 *
 * @module dsh-session-kit/workspace-backup
 */

import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { errorText } from './attachments.js';
import { buildArchive } from './export.js';
import { SessionPortFormatError, sanitizeFileName } from './format.js';

/** Default export mode for a workspace backup. */
const DEFAULT_MODE = 'full';

/** Load the DSH helper module, honoring the documented test seam. */
async function loadHelpers(deps) {
  if (deps !== null && deps !== undefined && typeof deps.servicesOf === 'function') return deps;
  return import('./sessions.js');
}

/** Find one workspace in the registry list by id (registry entries expose id). */
function findWorkspace(workspaces, workspaceId) {
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace === null || typeof workspace !== 'object') continue;
    const id = workspace.id ?? workspace.workspaceId;
    if (typeof id === 'string' && id === workspaceId) return workspace;
  }
  return undefined;
}

/** Deduplicate the workspace's session ids, preserving registry order. */
function normaliseSessionIds(value) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** The archive-friendly timestamp used by both export naming conventions. */
function timestampOf(now) {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, '')
    .replace('T', '-');
}

/** One path-safe file name slug for a workspace title or id. */
function workspaceSlug(workspace, workspaceId) {
  const source = typeof workspace.title === 'string' && workspace.title.trim() !== ''
    ? workspace.title
    : workspaceId;
  return sanitizeFileName(source, workspaceId).replace(/\s+/gu, '-').replace(/^-+|-+$/gu, '') || workspaceId;
}

/**
 * Build one workspace-level backup archive.
 *
 * Resolves the workspace through the workspace registry, keeps only its session
 * ids that still exist (missing ids become warnings), and delegates to
 * lib/export.js with workspace-file collection pinned to the workspace root and
 * a manifest.backup marker. The result is one ZIP with one workspace tree and
 * all of that workspace's main conversations.
 * @param {object} ctx - composed host context.
 * @param {object} options - workspace backup request.
 * @param {string} options.workspaceId - workspace registry id to back up.
 * @param {'full' | 'compact'} [options.mode] - export mode; defaults to full.
 * @param {boolean} [options.includeAttachments] - pack referenced attachment bytes.
 * @param {boolean} [options.includeSubagents] - keep subagent transcripts.
 * @param {ReadonlyArray<string>} [options.workspaceExclude] - extra workspace exclusions.
 * @param {number} [options.workspaceMaxBytes] - cap on packed workspace bytes.
 * @param {number} [options.maxExportBytes] - cap on the produced archive size.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {object} [options.deps] - helper-module override forwarded to buildArchive.
 * @param {string} [options.dshVersion] - source DSH version recorded in the manifest.
 * @param {number} [options.now] - archive timestamp (tests pass a fixed value).
 * @returns {Promise<object>} the archive result with a workspace-level filename and workspace metadata.
 * @throws {SessionPortFormatError} code 'invalid-argument' | 'unavailable' |
 *   'workspace-not-found' | 'missing-sessions' plus buildArchive failures.
 */
export async function buildWorkspaceBackup(ctx, options = {}) {
  const workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId.trim() : '';
  if (workspaceId === '') {
    throw new SessionPortFormatError('invalid-argument', '需要一个非空的工作区 id');
  }
  const helpers = await loadHelpers(options.deps);
  const services = typeof helpers.servicesOf === 'function' ? helpers.servicesOf(ctx) : {};
  const registry = services?.workspaceRegistry;
  if (registry === null || registry === undefined || typeof registry.list !== 'function') {
    throw new SessionPortFormatError('unavailable', '工作区注册表不可用，无法备份工作区');
  }
  let workspaces;
  try {
    workspaces = await registry.list();
  } catch (error) {
    throw new SessionPortFormatError('unavailable', '读取工作区列表失败：' + errorText(error));
  }
  const workspace = findWorkspace(workspaces, workspaceId);
  if (workspace === undefined) {
    throw new SessionPortFormatError('workspace-not-found', '找不到工作区：' + workspaceId);
  }
  const rawPath = typeof workspace.path === 'string' ? workspace.path.trim() : '';
  if (rawPath === '') {
    throw new SessionPortFormatError('invalid-argument', '工作区缺少目录路径：' + workspaceId);
  }
  const workspacePath = resolvePath(rawPath);
  let info;
  try {
    info = await stat(workspacePath);
  } catch {
    throw new SessionPortFormatError('invalid-argument', '工作区目录不存在：' + rawPath);
  }
  if (!info.isDirectory()) {
    throw new SessionPortFormatError('invalid-argument', '工作区路径不是目录：' + rawPath);
  }

  if (typeof helpers.listSessionEntries !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话列表服务不可用，无法备份工作区');
  }
  const includeSubagents = options.includeSubagents === true;
  let entries;
  try {
    entries = await helpers.listSessionEntries(ctx, { includeSubagents });
  } catch (error) {
    throw new SessionPortFormatError('unavailable', '读取会话列表失败：' + errorText(error));
  }
  const existing = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = entry !== null && typeof entry === 'object' ? entry.id : undefined;
    if (typeof id === 'string' && id !== '') existing.add(id);
  }
  const warnings = [];
  const sessionIds = [];
  for (const id of normaliseSessionIds(workspace.sessionIds)) {
    if (existing.has(id)) sessionIds.push(id);
    else warnings.push('工作区记录里的会话不存在，已跳过：' + id);
  }
  if (sessionIds.length === 0) {
    throw new SessionPortFormatError('missing-sessions', '工作区里没有可导出的会话：' + workspaceId);
  }

  const backup = {
    kind: 'workspace',
    workspaceId,
    ...(typeof workspace.title === 'string' && workspace.title.trim() !== '' ? { title: workspace.title } : {}),
    path: workspacePath,
  };
  const archive = await buildArchive(ctx, {
    sessionIds,
    mode: options.mode === undefined ? DEFAULT_MODE : options.mode,
    includeAttachments: options.includeAttachments !== false,
    includeWorkspaceFiles: true,
    includeSubagents,
    ...(options.workspaceExclude === undefined ? {} : { workspaceExclude: options.workspaceExclude }),
    ...(options.workspaceMaxBytes === undefined ? {} : { workspaceMaxBytes: options.workspaceMaxBytes }),
    ...(options.maxExportBytes === undefined ? {} : { maxExportBytes: options.maxExportBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deps === undefined ? {} : { deps: options.deps }),
    ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
    ...(options.now === undefined ? {} : { now: options.now }),
    backup,
  });

  // A workspace backup must contain exactly its own tree. The root is pinned,
  // so another fact can only appear if the collector reported a foreign path.
  const facts = Array.isArray(archive.manifest?.workspaces) ? archive.manifest.workspaces : [];
  for (const fact of facts) {
    if (fact !== null && typeof fact === 'object' && typeof fact.path === 'string'
      && resolvePath(fact.path) !== workspacePath) {
      warnings.push('导出清单包含工作区之外的目录，已忽略：' + fact.path);
    }
  }

  const filename = 'workspace-' + workspaceSlug(workspace, workspaceId) + '-'
    + archive.sessionCount + '-sessions-' + timestampOf(options.now === undefined ? Date.now() : options.now) + '.zip';
  const workspaceMeta = {
    workspaceId,
    ...(typeof workspace.title === 'string' && workspace.title.trim() !== '' ? { title: workspace.title } : {}),
    path: workspacePath,
  };
  return {
    ...archive,
    filename,
    warnings: [...warnings, ...(Array.isArray(archive.warnings) ? archive.warnings : [])],
    workspace: workspaceMeta,
  };
}
