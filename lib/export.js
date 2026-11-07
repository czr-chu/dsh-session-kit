/**
 * dsh-session-kit — batch session archive builder.
 *
 * Derived from dsh-session-port@0.2.1 (MIT) `lib/host.js` / `lib/attachments.js`
 * export paths, reworked for this plugin: one ZIP carries MANY sessions, each
 * under `sessions/<safeSessionId>/`, a v1 `manifest.json` with sha256
 * checksums, a human-readable `README.md`, and an optional `compact` mode that
 * stores the conversational spine instead of the raw log.
 *
 * Optional workspace-file export copies a whole workspace tree into
 * `workspaces/<archiveKey>/` through `lib/workspace-files.js`, which owns the
 * exclusion rules (VCS/build caches, credentials and secret material) and the
 * symlink/size safety. Subagent transcript sessions are excluded unless the
 * caller explicitly opts in with `includeSubagents: true`.
 *
 * Archive layout:
 *   manifest.json
 *   README.md
 *   sessions/<safeSessionId>/session.v4.jsonl           (mode=full)
 *   sessions/<safeSessionId>/session.compact.v4.jsonl   (mode=compact)
 *   sessions/<safeSessionId>/meta.json
 *   attachments/media/<attachmentId>.<ext>
 *   attachments/files/<prefix>/<digest>/<name>
 *   workspaces/<archiveKey>/<relative path>             (includeWorkspaceFiles)
 *
 * The module reads DSH only through the `lib/sessions.js` helper seam, so it
 * has no `@deepseek-ai/*` import; `deps` lets tests and alternative hosts
 * substitute that helper module (and `deps.workspaceFiles` the workspace
 * collector).
 *
 * @module dsh-session-kit/export
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative as relativePath, resolve as resolvePath } from 'node:path';

import { collectAttachmentEntries, errorText } from './attachments.js';
import {
  SessionPortFormatError,
  collectAttachmentRefs,
  fileEntryName,
  imageEntryName,
  safeSessionIdSegment,
  sanitizeFileName,
  serializeSessionLog,
  sessionLogFileName,
} from './format.js';
import { writeZipEntries } from './zip.js';

/** Manifest discriminator written into every archive of this plugin. */
export const ARCHIVE_KIND = 'dsh-session-kit';
/** Current manifest schema version. */
export const MANIFEST_VERSION = 1;
/** Export modes this builder implements. */
export const EXPORT_MODES = Object.freeze(['full', 'compact']);

const MODE_SET = new Set(EXPORT_MODES);

/** Cached helper modules; a failed import is retried on the next call. */
let sessionsModule;
let compactModule;
let workspaceModule;

/**
 * Resolve the `lib/sessions.js` helper module (or the caller's test seam).
 * @param {object | undefined} deps - explicit helper module override.
 * @returns {Promise<object>} helper module namespace.
 */
async function loadSessions(deps) {
  if (deps !== undefined && deps !== null) return deps;
  if (sessionsModule === undefined) {
    try {
      sessionsModule = await import('./sessions.js');
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话读取模块不可用：${errorText(error)}`);
    }
  }
  return sessionsModule;
}

/**
 * Resolve the `lib/compact.js` `compactSession` function.
 * @param {object | undefined} deps - helper module override that may carry `compactSession`.
 * @returns {Promise<Function>} the compaction function.
 */
async function loadCompactSession(deps) {
  if (deps !== undefined && deps !== null && typeof deps.compactSession === 'function') {
    return deps.compactSession;
  }
  if (compactModule === undefined) {
    try {
      compactModule = (await import('./compact.js')).compactSession;
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话精简模块不可用：${errorText(error)}`);
    }
  }
  return compactModule;
}

/**
 * Resolve the `lib/workspace-files.js` collector (or the caller's test seam).
 * @param {object | undefined} deps - helper module override that may carry `workspaceFiles`.
 * @returns {Promise<object>} workspace collector module.
 */
async function loadWorkspaceFiles(deps) {
  if (deps !== undefined && deps !== null && deps.workspaceFiles !== undefined && deps.workspaceFiles !== null) {
    return deps.workspaceFiles;
  }
  if (workspaceModule === undefined) {
    try {
      workspaceModule = await import('./workspace-files.js');
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `工作区文件模块不可用：${errorText(error)}`);
    }
  }
  return workspaceModule;
}

/**
 * Lowercase sha256 hex digest of a byte sequence.
 * @param {Buffer | Uint8Array | string} data - bytes or UTF-8 text.
 * @returns {string} hex digest.
 */
function sha256Hex(data) {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

/**
 * Fold the latest log-backed title out of one event list (local fallback used
 * when the helper module does not expose `foldTitle`).
 * @param {ReadonlyArray<object>} events - committed events.
 * @returns {string | undefined} trimmed title.
 */
function localFoldTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== null && typeof event === 'object' && event.type === 'session/title') {
      const title = event.data?.title;
      if (typeof title === 'string' && title.trim() !== '') return title.trim();
    }
  }
  return undefined;
}

/**
 * Read the folded title through the helper module when it offers one.
 * @param {object} helpers - resolved sessions helper module.
 * @param {ReadonlyArray<object>} events - committed events.
 * @returns {string | undefined} trimmed title.
 */
function titleOf(helpers, events) {
  if (typeof helpers.foldTitle === 'function') {
    try {
      const folded = helpers.foldTitle(events);
      if (typeof folded === 'string' && folded.trim() !== '') return folded.trim();
    } catch {
      // A decorative fold must not fail the export; fall back below.
    }
  }
  return localFoldTitle(events);
}

/**
 * The in-archive name of one compact session log.
 * @param {number} version - session format version.
 * @returns {string} file name.
 */
function compactLogFileName(version) {
  return Number.isSafeInteger(version) && version > 0
    ? `session.compact.v${version}.jsonl`
    : 'session.compact.jsonl';
}

/**
 * Load the cheap session index (titles, workspace binding, updatedAt) once.
 * The index is cosmetic metadata: a failure degrades to header facts instead
 * of failing the whole export.
 * @param {object} helpers - resolved sessions helper module.
 * @param {object} ctx - composed host context.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<Map<string, object>>} session id -> index entry.
 */
async function readSessionIndex(helpers, ctx, signal) {
  const index = new Map();
  if (typeof helpers.listSessionEntries !== 'function') return index;
  try {
    const entries = await helpers.listSessionEntries(ctx, { signal, includeSubagents: true });
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
        index.set(entry.id, entry);
      }
    }
  } catch {
    // Metadata is optional; header facts and the log title cover the manifest.
  }
  return index;
}

/**
 * Read the workspace roster, tolerating a deployment without a registry.
 * @param {object} helpers - resolved sessions helper module.
 * @param {object} ctx - composed host context.
 * @returns {Promise<Array<object>>} workspace entries.
 */
async function readWorkspaces(helpers, ctx) {
  if (typeof helpers.listWorkspaceEntries !== 'function') return [];
  try {
    const entries = await helpers.listWorkspaceEntries(ctx);
    return Array.isArray(entries) ? entries.filter((entry) => entry !== null && typeof entry === 'object') : [];
  } catch {
    return [];
  }
}

/** Whether one absolute path stays inside another. */
function pathInside(value, root) {
  const rel = relativePath(root, value);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Validate and clone caller-provided backup metadata for the manifest.
 * @param {unknown} value - requested backup metadata.
 * @returns {object} JSON-safe copy.
 * @throws {SessionPortFormatError} code 'invalid-argument'.
 */
function normalizeBackupMetadata(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionPortFormatError('invalid-argument', 'backup 元数据必须是对象');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new SessionPortFormatError('invalid-argument', 'backup 元数据无法序列化：' + errorText(error));
  }
  if (serialized === undefined) {
    throw new SessionPortFormatError('invalid-argument', 'backup 元数据无法序列化为 JSON');
  }
  return JSON.parse(serialized);
}

/**
 * Build the download file name for one archive.
 * @param {{now: number, sessionCount: number, sessionTitle?: string, sessionId?: string}} facts - archive facts.
 * @returns {string} `.zip` file name.
 */
function archiveFileName({ now, sessionCount, sessionTitle, sessionId }) {
  if (sessionCount === 1 && typeof sessionId === 'string' && sessionId !== '') {
    return `${sanitizeFileName(sessionTitle ?? sessionId, sessionId)}-session-kit.zip`;
  }
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, '')
    .replace('T', '-');
  return `session-kit-${sessionCount}-sessions-${stamp}.zip`;
}

/**
 * An archive path for one workspace file: reuse the collector's `archivePath`
 * when it is already under `workspaces/`; otherwise place it under `base`.
 * Every segment is validated so a malformed collector result cannot write a
 * traversal or absolute entry into the archive.
 * @param {unknown} archivePath - collector-provided archive path.
 * @param {string} base - `workspaces/<key>` prefix for the root.
 * @param {string} relPath - root-relative path of the file.
 * @returns {string} safe archive path.
 */
function safeWorkspaceArchivePath(archivePath, base, relPath) {
  const candidate = typeof archivePath === 'string' && archivePath !== ''
    ? archivePath.replaceAll('\\', '/')
    : relPath;
  const path = candidate.startsWith('workspaces/') ? candidate : `${base}/${candidate.replace(/^\.?\//u, '')}`;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new SessionPortFormatError(
        'invalid-workspace-path',
        `工作区文件的归档路径不安全：${String(archivePath)}`,
      );
    }
  }
  if (/^[A-Za-z]:/u.test(path) || path.startsWith('/')) {
    throw new SessionPortFormatError(
      'invalid-workspace-path',
      `工作区文件的归档路径不安全：${String(archivePath)}`,
    );
  }
  return path;
}

/**
 * A deterministic `workspaces/<key>` prefix when the collector does not
 * provide one (the production collector always does).
 * @param {string} rootPath - workspace root.
 * @returns {string} archive prefix.
 */
function fallbackWorkspaceKey(rootPath) {
  const slug = rootPath
    .replaceAll('\\', '/')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80) || 'workspace';
  return `workspaces/${slug}-${sha256Hex(Buffer.from(rootPath, 'utf8')).slice(0, 8)}`;
}

/**
 * Root-relative spelling of one touched/presented path. Paths outside the
 * workspace root stay absolute so the manifest never invents a relative path.
 * @param {string} rootPath - workspace root.
 * @param {unknown} absolutePath - touched path.
 * @returns {string | undefined} relative POSIX path or the original absolute path.
 */
function workspaceRelative(rootPath, absolutePath) {
  if (typeof absolutePath !== 'string' || absolutePath === '') return undefined;
  try {
    const rel = relativePath(rootPath, absolutePath).replaceAll('\\', '/');
    if (rel === '') return undefined;
    if (rel === '..' || rel.startsWith('../')) return absolutePath;
    return rel;
  } catch {
    return absolutePath;
  }
}

/**
 * Human-readable archive README explaining the layout and the manifest.
 * @param {object} facts - archive facts used in the text.
 * @returns {string} README text.
 */
function readmeText({
  mode, sessionCount, eventCount, attachmentCount, formatVersion, createdAt,
  workspaceCount, workspaceFileCount, workspaceBytes,
}) {
  const layout = [
    'manifest.json                                 归档清单（会话、附件、工作区、sha256 校验）',
    'README.md                                     本文件',
    'sessions/<会话文件夹>/session.v4.jsonl         完整会话日志（mode=full）',
    'sessions/<会话文件夹>/session.compact.v4.jsonl 精简会话日志（mode=compact）',
    'sessions/<会话文件夹>/meta.json                该会话的元数据',
    'attachments/media/<附件 id>.<ext>              图片附件',
    'attachments/files/<前缀>/<摘要>/<文件名>        文件附件',
  ];
  if (workspaceCount > 0) {
    layout.push('workspaces/<工作区 key>/<相对路径>            工作区文件实体（已排除 VCS/构建缓存/敏感文件）');
  }
  return [
    '# dsh-session-kit 会话归档',
    '',
    `- 生成时间：${createdAt}`,
    `- 导出模式：${mode}（${mode === 'compact' ? '仅对话主线，可重新导入并继续对话' : '完整会话日志'}）`,
    `- 会话数：${sessionCount}；事件数：${eventCount}；附件数：${attachmentCount}`,
    ...(workspaceCount > 0
      ? [`- 工作区：${workspaceCount} 个，文件 ${workspaceFileCount} 个，共 ${workspaceBytes} 字节（敏感文件与构建缓存已排除）`]
      : []),
    `- 会话格式版本：v${formatVersion}`,
    '',
    '## 目录结构',
    '',
    '```',
    ...layout,
    '```',
    '',
    '## 如何恢复',
    '',
    '在 DSH 的「会话管理」（dsh-session-kit 插件）里导入本压缩包：每个会话都会作为**新会话**导入，',
    '不会覆盖或删除已有会话。导入会恢复附件、改写指向源会话的内部标记，并重新绑定当前工作目录。',
    ...(workspaceCount > 0
      ? ['', '导入时勾选「恢复工作区文件」可把 `workspaces/` 下的文件安全解压到目标工作目录；已存在的文件不会被覆盖。']
      : []),
    '',
    '> 会话日志是 DSH 的标准 v4 JSONL（第一行会话头，随后每行一条事件）；',
    '> `manifest.json` 记录每个日志与附件的 sha256，可用于校验归档是否完整。',
    '',
  ].join('\n');
}

/**
 * Build one multi-session session archive.
 *
 * Every selected session is read through `sessionQuery.readSession` (the same
 * replay-validated view the shipped exporter uses); a live session is flushed
 * first by the helper. With `mode: 'compact'` each log is replaced by its
 * conversational spine. Subagent transcripts are skipped unless
 * `includeSubagents: true`. With `includeWorkspaceFiles: true` each selected
 * session's workspace root is collected through `lib/workspace-files.js`
 * (secret/build-cache exclusions, no symlink following) and packed under
 * `workspaces/<archiveKey>/`; `workspaceMaxBytes` degrades over-budget trees
 * with an explicit warning instead of silently truncating.
 *
 * @param {object} ctx - composed host context.
 * @param {object} options - export request.
 * @param {ReadonlyArray<string>} options.sessionIds - session ids to include (non-empty).
 * @param {'full' | 'compact'} [options.mode] - export mode; defaults to full.
 * @param {boolean} [options.includeAttachments] - pack referenced attachment bytes.
 * @param {boolean} [options.includeWorkspaceFiles] - pack whole workspace trees.
 * @param {boolean} [options.includeSubagents] - keep `origin: 'subagent'` transcripts.
 * @param {ReadonlyArray<string>} [options.workspaceExclude] - extra workspace path patterns/dirs to exclude.
 * @param {number} [options.workspaceMaxBytes] - cap on packed workspace-file bytes; excess is dropped with a warning.
 * @param {number} [options.maxExportBytes] - cap on the produced archive size; throws `too-large`.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {object} [options.deps] - helper-module override (`lib/sessions.js` shape plus optional `compactSession` / `workspaceFiles`).
 * @param {string} [options.dshVersion] - optional source DSH version recorded in the manifest.
 * @param {number} [options.now] - archive timestamp (tests pass a fixed value).
 * @param {object} [options.backup] - optional backup metadata written to `manifest.backup`
 *   (for example `{kind: 'workspace', workspaceId, title, path}`). When `kind` is
 *   `workspace` and `path` is absolute, workspace-file collection is pinned to that
 *   one root so a workspace-level backup never packs several workspace trees.
 * @returns {Promise<{filename: string, data: Buffer, manifest: object, warnings: string[],
 *   sessionCount: number, eventCount: number, attachmentCount: number,
 *   workspaceCount: number, workspaceFileCount: number, workspaceBytes: number}>} archive.
 * @throws {SessionPortFormatError} with codes `missing-sessions`, `invalid-mode`,
 *   `invalid-argument`, `unavailable`, `not-found`, `compact-failed`,
 *   `invalid-workspace-path`, `too-large`.
 */
export async function buildArchive(ctx, options = {}) {
  const {
    sessionIds,
    mode = 'full',
    includeAttachments = true,
    includeWorkspaceFiles = false,
    includeSubagents = false,
    workspaceExclude,
    workspaceMaxBytes,
    maxExportBytes,
    signal,
    deps,
    dshVersion,
    now = Date.now(),
    backup,
  } = options;

  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new SessionPortFormatError('missing-sessions', '没有选择要导出的会话');
  }
  if (!MODE_SET.has(mode)) {
    throw new SessionPortFormatError(
      'invalid-mode',
      `未知的导出模式 "${String(mode)}"（仅支持 full / compact）`,
    );
  }
  if (maxExportBytes !== undefined && (!Number.isSafeInteger(maxExportBytes) || maxExportBytes <= 0)) {
    throw new SessionPortFormatError('invalid-argument', 'maxExportBytes 必须是正整数');
  }
  if (workspaceMaxBytes !== undefined && (!Number.isSafeInteger(workspaceMaxBytes) || workspaceMaxBytes <= 0)) {
    throw new SessionPortFormatError('invalid-argument', 'workspaceMaxBytes 必须是正整数');
  }
  const backupMeta = backup === undefined ? undefined : normalizeBackupMetadata(backup);
  const backupRoot = backupMeta !== undefined && backupMeta !== null && backupMeta.kind === 'workspace'
    && typeof backupMeta.path === 'string' && isAbsolute(backupMeta.path)
    ? resolvePath(backupMeta.path)
    : undefined;
  const workspacePatterns = Array.isArray(workspaceExclude)
    ? workspaceExclude.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
    : [];

  const helpers = await loadSessions(deps);
  const compactSession = mode === 'compact' ? await loadCompactSession(deps) : undefined;
  const formatVersion = await helpers.detectFormatVersion(ctx, undefined);
  const index = await readSessionIndex(helpers, ctx, signal);
  const attachmentsService = helpers.servicesOf(ctx).attachments;
  const workspaceFiles = includeWorkspaceFiles ? await loadWorkspaceFiles(deps) : undefined;

  /** @type {Array<object>} per-session prepared records. */
  const prepared = [];
  const warnings = [];
  const seen = new Set();
  for (const rawId of sessionIds) {
    signal?.throwIfAborted();
    const id = String(rawId ?? '').trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    let doc;
    try {
      doc = await helpers.readSessionDoc(ctx, id);
    } catch (error) {
      throw new SessionPortFormatError('not-found', `读取会话 ${id} 失败：${errorText(error)}`);
    }
    if (doc === undefined || doc === null || doc.header === undefined || doc.header === null) {
      throw new SessionPortFormatError('not-found', `会话 ${id} 没有存储头信息`);
    }
    if (includeSubagents !== true && doc.header.origin === 'subagent') {
      warnings.push(`跳过子代理会话 ${id}（includeSubagents=false）`);
      continue;
    }
    let header = doc.header;
    let events = Array.isArray(doc.events) ? doc.events : [];
    if (compactSession !== undefined) {
      let compacted;
      try {
        compacted = await compactSession({ header: doc.header, events });
      } catch (error) {
        throw new SessionPortFormatError('compact-failed', `会话 ${id} 精简失败：${errorText(error)}`);
      }
      if (compacted === undefined || compacted === null || compacted.header === undefined
        || compacted.header === null || !Array.isArray(compacted.events)) {
        throw new SessionPortFormatError('compact-failed', `会话 ${id} 精简结果没有返回 { header, events }`);
      }
      header = compacted.header;
      events = compacted.events;
    }
    const sessionFormatVersion = Number.isSafeInteger(header.version) ? header.version : formatVersion;
    const logText = serializeSessionLog(header, events);
    const info = index.get(id);
    prepared.push({
      id,
      header,
      events,
      logText,
      logSha256: sha256Hex(logText),
      logPath: `sessions/${safeSessionIdSegment(id)}/${mode === 'compact'
        ? compactLogFileName(sessionFormatVersion)
        : sessionLogFileName(sessionFormatVersion)}`,
      formatVersion: sessionFormatVersion,
      refs: collectAttachmentRefs(events),
      info,
      // The listing title is the current projection; the log fold is the
      // archive-local fallback when the listing could not be read.
      title: (typeof info?.title === 'string' && info.title.trim() !== ''
        ? info.title.trim()
        : titleOf(helpers, events)),
    });
  }
  if (prepared.length === 0) {
    throw new SessionPortFormatError(
      'missing-sessions',
      warnings.length > 0 ? '没有可导出的会话（子代理会话默认不导出）' : '没有选择要导出的会话',
    );
  }

  // Merge attachment references across every selected session: the store is
  // content-addressed, so one archive stores each object once.
  const combined = { images: new Map(), files: new Map() };
  for (const session of prepared) {
    for (const [key, ref] of session.refs.images) if (!combined.images.has(key)) combined.images.set(key, ref);
    for (const [key, ref] of session.refs.files) if (!combined.files.has(key)) combined.files.set(key, ref);
  }

  /** @type {Array<{name: string, data: Uint8Array}>} */
  const attachmentFiles = [];
  /** @type {Set<string>} archive paths actually written. */
  const packedPaths = new Set();
  /** @type {Array<object>} manifest attachment facts. */
  const attachmentFacts = [];
  if (includeAttachments && combined.images.size + combined.files.size > 0) {
    const packed = await collectAttachmentEntries(attachmentsService, combined, signal);
    warnings.push(...packed.warnings);
    for (const entry of packed.entries) {
      const name = `attachments/${entry.name}`;
      packedPaths.add(name);
      attachmentFiles.push({ name, data: entry.data });
    }
    for (const ref of combined.images.values()) {
      const path = `attachments/${imageEntryName(ref)}`;
      if (!packedPaths.has(path)) continue;
      attachmentFacts.push({
        id: ref.attachmentId,
        kind: 'image',
        bytes: ref.bytes,
        ...(ref.mediaType !== undefined ? { mediaType: ref.mediaType } : {}),
        ...(ref.name !== undefined ? { name: ref.name } : {}),
        path,
      });
    }
    for (const ref of combined.files.values()) {
      const path = `attachments/${fileEntryName(ref)}`;
      if (!packedPaths.has(path)) continue;
      attachmentFacts.push({
        id: ref.attachmentId,
        kind: 'file',
        bytes: ref.bytes,
        ...(ref.name !== undefined ? { name: ref.name } : {}),
        path,
      });
    }
  }

  // Workspace trees: group the selected sessions by workspace root, record the
  // touched/presented paths, then collect every root through the workspace
  // collector (which owns the secret/build-cache exclusions and symlink rules).
  /** @type {Array<{name: string, data: Uint8Array}>} */
  const workspaceFileEntries = [];
  /** @type {Array<object>} manifest workspace facts. */
  const workspaceFacts = [];
  /** @type {Map<string, {touched: string[], presented: string[]}>} */
  const touchedBySession = new Map();
  let workspaceBytes = 0;
  if (includeWorkspaceFiles) {
    const workspacesById = new Map();
    for (const workspace of await readWorkspaces(helpers, ctx)) {
      if (typeof workspace.workspaceId === 'string' && workspace.workspaceId !== '') {
        workspacesById.set(workspace.workspaceId, workspace);
      }
    }
    /** @type {Map<string, {root: string, sessionIds: string[]}>} */
    const groups = new Map();
    for (const session of prepared) {
      let root;
      if (backupRoot !== undefined) {
        // A workspace-level backup names the root explicitly: every selected
        // session belongs to that workspace, so one tree is packed exactly once.
        root = backupRoot;
        const cwd = session.header.cwd;
        if (typeof cwd === 'string' && isAbsolute(cwd) && !pathInside(cwd, backupRoot)) {
          warnings.push(`会话 ${session.id} 的 cwd 不在备份工作区内，文件按工作区根目录收集`);
        }
      }
      const workspaceId = session.info?.workspaceId;
      if (root === undefined && typeof workspaceId === 'string') {
        const workspace = workspacesById.get(workspaceId);
        if (typeof workspace?.path === 'string' && workspace.path !== '') root = workspace.path;
      }
      if (root === undefined && typeof session.header.cwd === 'string' && session.header.cwd !== '') {
        root = session.header.cwd;
      }
      if (root === undefined) {
        warnings.push(`会话 ${session.id} 没有可用的工作区目录，未收集工作区文件`);
        continue;
      }
      let group = groups.get(root);
      if (group === undefined) {
        group = { root, sessionIds: [] };
        groups.set(root, group);
      }
      group.sessionIds.push(session.id);

      const derived = workspaceFiles.deriveTouchedFiles(session.events, session.header.cwd ?? root);
      const toRelative = (paths) => {
        const values = [];
        for (const value of paths instanceof Set ? paths : Array.isArray(paths) ? paths : []) {
          const relative = workspaceRelative(root, value);
          if (relative !== undefined) values.push(relative);
        }
        return [...new Set(values)].sort();
      };
      touchedBySession.set(session.id, {
        touched: toRelative(derived?.paths),
        presented: toRelative(derived?.presented),
      });
    }

    const candidateFiles = [];
    for (const group of groups.values()) {
      signal?.throwIfAborted();
      let archiveBase;
      try {
        const provided = workspaceFiles.workspaceArchiveKey(group.root);
        archiveBase = typeof provided === 'string' && provided.startsWith('workspaces/')
          ? provided.replace(/\/+$/u, '')
          : fallbackWorkspaceKey(group.root);
      } catch {
        archiveBase = fallbackWorkspaceKey(group.root);
      }
      let collected;
      try {
        collected = await workspaceFiles.collectWorkspaceTree(group.root, {
          ...(workspacePatterns.length > 0 ? { excludePatterns: workspacePatterns } : {}),
          ...(workspaceMaxBytes !== undefined
            ? { maxTotalBytes: Math.max(1, workspaceMaxBytes - workspaceBytes) }
            : {}),
        });
      } catch (error) {
        warnings.push(`工作区 ${group.root} 读取失败，未包含其文件：${errorText(error)}`);
        workspaceFacts.push({
          path: group.root,
          archivePath: archiveBase,
          sessionIds: group.sessionIds,
          bytes: 0,
          files: 0,
          skipped: 0,
        });
        continue;
      }
      const skipped = Array.isArray(collected?.skipped) ? collected.skipped.length : 0;
      for (const warning of Array.isArray(collected?.warnings) ? collected.warnings : []) {
        if (warnings.length < 40) warnings.push(`工作区 ${group.root}：${String(warning)}`);
      }
      const files = Array.isArray(collected?.files) ? [...collected.files] : [];
      files.sort((left, right) => String(left?.relPath ?? '').localeCompare(String(right?.relPath ?? '')));
      for (const file of files) {
        const relPath = typeof file?.relPath === 'string' ? file.relPath : undefined;
        const absPath = typeof file?.absPath === 'string' ? file.absPath : undefined;
        const size = Number.isSafeInteger(file?.size) ? file.size : undefined;
        if (relPath === undefined || absPath === undefined || size === undefined || size < 0) continue;
        const archivePath = safeWorkspaceArchivePath(file.archivePath, archiveBase, relPath);
        candidateFiles.push({
          root: group.root,
          archivePath,
          absPath,
          size,
        });
      }
      workspaceFacts.push({
        path: group.root,
        archivePath: archiveBase,
        sessionIds: group.sessionIds,
        bytes: 0,
        files: 0,
        skipped,
      });
    }

    // Global workspace budget: include files in deterministic order, drop the
    // remainder with one explicit warning rather than a partial silent cut.
    candidateFiles.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
    let budgetSkipped = 0;
    for (const candidate of candidateFiles) {
      if (workspaceMaxBytes !== undefined && workspaceBytes + candidate.size > workspaceMaxBytes) {
        budgetSkipped += 1;
        continue;
      }
      let data;
      try {
        data = new Uint8Array(await readFile(candidate.absPath));
      } catch (error) {
        warnings.push(`工作区文件读取失败，已跳过：${candidate.archivePath}（${errorText(error)}）`);
        budgetSkipped += 1;
        continue;
      }
      workspaceFileEntries.push({ name: candidate.archivePath, data });
      workspaceBytes += data.byteLength;
      for (const fact of workspaceFacts) {
        if (fact.path === candidate.root) {
          fact.bytes += data.byteLength;
          fact.files += 1;
        }
      }
    }
    if (budgetSkipped > 0) {
      warnings.push(
        workspaceMaxBytes !== undefined
          ? `工作区文件超过上限 ${workspaceMaxBytes} 字节，已跳过 ${budgetSkipped} 个文件`
          : `工作区文件有 ${budgetSkipped} 个无法读取或超出收集上限，已跳过`,
      );
    }
  }

  /** @type {Array<{name: string, data: Buffer}>} */
  const files = [];
  /** @type {Record<string, string>} */
  const checksums = {};
  const manifestSessions = [];
  let eventCount = 0;
  for (const session of prepared) {
    const info = session.info;
    const createdAt = Number.isSafeInteger(info?.createdAt) ? info.createdAt : session.header.createdAt;
    const updatedAt = Number.isSafeInteger(info?.updatedAt) ? info.updatedAt : createdAt;
    const attachmentIds = [];
    for (const ref of session.refs.images.values()) {
      if (packedPaths.has(`attachments/${imageEntryName(ref)}`)) attachmentIds.push(ref.attachmentId);
    }
    for (const ref of session.refs.files.values()) {
      if (packedPaths.has(`attachments/${fileEntryName(ref)}`)) attachmentIds.push(ref.attachmentId);
    }
    const touched = touchedBySession.get(session.id);
    const meta = {
      id: session.id,
      title: session.title,
      cwd: typeof info?.cwd === 'string' ? info.cwd : session.header.cwd,
      workspaceId: typeof info?.workspaceId === 'string' ? info.workspaceId : undefined,
      mode,
      formatVersion: session.formatVersion,
      eventCount: session.events.length,
      isSeeded: session.header.isSeeded === true,
      ...(typeof session.header.agentPreset === 'string' ? { agentPreset: session.header.agentPreset } : {}),
      log: session.logPath,
      logSha256: session.logSha256,
      attachments: [...new Set(attachmentIds)],
      ...(touched !== undefined ? { touchedFiles: touched.touched, presentedFiles: touched.presented } : {}),
    };
    const logData = Buffer.from(session.logText, 'utf8');
    files.push({ name: session.logPath, data: logData });
    checksums[session.logPath] = session.logSha256;
    const metaName = `sessions/${safeSessionIdSegment(session.id)}/meta.json`;
    const metaData = Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    files.push({ name: metaName, data: metaData });
    checksums[metaName] = sha256Hex(metaData);
    eventCount += session.events.length;
    manifestSessions.push({
      id: session.id,
      title: session.title,
      cwd: meta.cwd,
      ...(meta.workspaceId !== undefined ? { workspaceId: meta.workspaceId } : {}),
      createdAt,
      updatedAt,
      formatVersion: session.formatVersion,
      mode,
      eventCount: session.events.length,
      log: session.logPath,
      logSha256: session.logSha256,
      attachments: meta.attachments,
      ...(touched !== undefined ? { touchedFiles: touched.touched, presentedFiles: touched.presented } : {}),
    });
  }
  for (const entry of attachmentFiles) {
    files.push({ name: entry.name, data: Buffer.from(entry.data) });
    checksums[entry.name] = sha256Hex(entry.data);
  }
  for (const entry of workspaceFileEntries) {
    files.push({ name: entry.name, data: Buffer.from(entry.data) });
    checksums[entry.name] = sha256Hex(entry.data);
  }

  const manifestWorkspaces = workspaceFacts;
  const createdAt = new Date(now).toISOString();
  const readme = readmeText({
    mode,
    sessionCount: prepared.length,
    eventCount,
    attachmentCount: attachmentFacts.length,
    formatVersion,
    createdAt,
    workspaceCount: manifestWorkspaces.length,
    workspaceFileCount: workspaceFileEntries.length,
    workspaceBytes,
  });
  const readmeData = Buffer.from(readme, 'utf8');
  checksums['README.md'] = sha256Hex(readmeData);

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    kind: ARCHIVE_KIND,
    createdAt,
    source: {
      sessionFormatVersion: formatVersion,
      compression: 'deflate',
      ...(typeof dshVersion === 'string' && dshVersion !== '' ? { dshVersion } : {}),
    },
    mode,
    sessions: manifestSessions,
    attachments: attachmentFacts,
    ...(includeWorkspaceFiles ? { workspaces: manifestWorkspaces } : {}),
    ...(backupMeta !== undefined ? { backup: backupMeta } : {}),
    checksums: { algorithm: 'sha256', files: checksums },
  };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const data = writeZipEntries([
    { name: 'manifest.json', data: manifestData },
    { name: 'README.md', data: readmeData },
    ...files,
  ]);
  if (maxExportBytes !== undefined && data.length > maxExportBytes) {
    throw new SessionPortFormatError(
      'too-large',
      `导出包 ${data.length} 字节超过上限 ${maxExportBytes} 字节；请减少会话、关闭工作区文件/附件或改用精简模式`,
    );
  }

  return {
    filename: archiveFileName({
      now,
      sessionCount: prepared.length,
      sessionTitle: prepared.length === 1 ? prepared[0].title : undefined,
      sessionId: prepared.length === 1 ? prepared[0].id : undefined,
    }),
    data,
    manifest,
    warnings,
    sessionCount: prepared.length,
    eventCount,
    attachmentCount: attachmentFacts.length,
    workspaceCount: manifestWorkspaces.length,
    workspaceFileCount: workspaceFileEntries.length,
    workspaceBytes,
  };
}

/**
 * The plugin-owned export directory used when a caller names none.
 * @param {string} [dshHome] - DSH home override (tests); defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns {string} absolute export directory.
 */
export function defaultExportDirectory(dshHome) {
  const explicit = typeof dshHome === 'string' && dshHome.trim() !== '' ? dshHome.trim() : undefined;
  const envHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : undefined;
  const home = explicit ?? envHome ?? join(homedir(), '.dsh');
  return join(home, 'session-kit', 'exports');
}
