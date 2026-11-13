/**
 * dsh-session-kit — archive import.
 *
 * Derived from dsh-session-port@0.2.1 (MIT) `lib/host.js` import path
 * (attachment restore + delivery/seed rewrite are inherited verbatim), extended
 * to batch imports from this plugin's own archives, DSH's built-in session-log
 * export ZIP, and bare `.jsonl` files.
 *
 * Every imported session becomes a NEW session:
 *   - a fresh id, no lineage (`parentSession`/`origin` dropped, `isSeeded: false`)
 *   - `cwd` resolved by the helper (requested, then source, then defaults)
 *   - delivery markers and the inherited `session/end-seed` flag rewritten so the
 *     current-format reader accepts the log as a standalone Session
 *   - archive attachments restored into the local store and references rewritten
 *   - written through `sessionPersistence` (create -> append -> flush -> close)
 *   - attached to the workspace whose path matches, then read back for proof
 *
 * Subagent transcripts are never imported: an `origin: 'subagent'` log is
 * skipped (and reported) because a subagent Session has no standalone agent
 * composition here. With `restoreWorkspaceFiles: true` the archive's
 * `workspaces/` tree is unpacked into the target directory with strict path
 * validation (absolute paths, `..`, drive letters and backslash separators are
 * rejected as zip-slip), sensitive/build-cache entries are skipped, and an
 * existing file is never overwritten.
 *
 * Existing sessions are never touched; archives are preflighted before the first
 * write, so an unsupported format version or a corrupt archive fails without
 * leaving partial sessions behind.
 *
 * @module dsh-session-kit/import
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath } from 'node:path';

import { restoreAttachmentEntries, errorText } from './attachments.js';
import {
  SessionPortFormatError,
  findRootLogEntry,
  isZipBuffer,
  parseSessionLog,
  rewriteAttachmentRefs,
  rewriteDeliveryIdentity,
  rewriteSeedMarkers,
  validateEvents,
} from './format.js';
import { readZipEntries } from './zip.js';

/** Default cap on one import request body. */
export const DEFAULT_MAX_IMPORT_BYTES = 512 * 1024 * 1024;
/** Upper bound on sessions restored by one import. */
export const MAX_IMPORT_SESSIONS = 100;
/** Archive prefix of the optional workspace-file tree. */
const WORKSPACE_PREFIX = 'workspaces/';

/** Cached helper modules; a failed import is retried on the next call. */
let sessionsModule;
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
 * Resolve the workspace-safety module for restore filtering. A missing module
 * degrades to the built-in conservative exclusion list instead of failing the
 * import, because writing a sensitive file is the only thing that must not
 * happen silently.
 * @param {object | undefined} deps - helper module override that may carry `workspaceFiles`.
 * @returns {Promise<object | undefined>} workspace module or undefined.
 */
async function loadWorkspaceFilesOptional(deps) {
  if (deps !== undefined && deps !== null && deps.workspaceFiles !== undefined && deps.workspaceFiles !== null) {
    return deps.workspaceFiles;
  }
  if (workspaceModule === undefined) {
    try {
      workspaceModule = await import('./workspace-files.js');
    } catch {
      return undefined;
    }
  }
  return workspaceModule;
}

/**
 * Lowercase sha256 hex digest of bytes.
 * @param {Buffer | Uint8Array} data - bytes to digest.
 * @returns {string} hex digest.
 */
function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Drop a UTF-8 BOM left by Windows editors. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Fold the latest log-backed title out of one event list. */
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
 * Escape one archive entry name into the local attachment-store spelling.
 * This plugin writes `attachments/media/...`; DSH's built-in export writes
 * `media/...` and `files/...` at the archive root.
 * @param {string} name - normalized archive entry name.
 * @returns {string | undefined} `media/...` or `files/...`, or undefined for other entries.
 */
function localAttachmentName(name) {
  const local = name.startsWith('attachments/') ? name.slice('attachments/'.length) : name;
  return local.startsWith('media/') || local.startsWith('files/') ? local : undefined;
}

/**
 * Classify one session-log entry name found in an archive.
 * @param {string} name - archive entry name.
 * @returns {'full' | 'compact' | 'compressed' | undefined} mode, or undefined when not a session log.
 */
function modeFromLogName(name) {
  if (/^sessions\/[^/]+\/session\.compact(?:\.v\d+)?\.jsonl$/u.test(name)) return 'compact';
  if (/^sessions\/[^/]+\/session\.compressed(?:\.v\d+)?\.jsonl$/u.test(name)) return 'compressed';
  if (/^sessions\/[^/]+\/session(?:\.v\d+)?\.jsonl$/u.test(name)) return 'full';
  if (/^session(?:\.v\d+)?\.jsonl$/u.test(name)) return 'full';
  return undefined;
}

/**
 * Validate one archive-relative path before it is joined to the target root.
 * @param {string} value - path using `/` separators.
 * @returns {string | undefined} the rejection reason, or undefined when safe.
 */
function validateArchiveRelativePath(value) {
  if (typeof value !== 'string' || value === '') return '空路径';
  if (value.includes('\\')) return '包含反斜杠分隔符';
  if (value.startsWith('/')) return '绝对路径';
  if (/^[A-Za-z]:/u.test(value)) return 'Windows 盘符';
  if (/[\u0000-\u001f\u007f]/u.test(value)) return '控制字符';
  for (const segment of value.split('/')) {
    if (segment === '') return '空路径段';
    if (segment === '.' || segment === '..') return '路径穿越（..）';
  }
  return undefined;
}

/** Conservative built-in exclusions used when the workspace module is absent. */
const FALLBACK_EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next', 'target', '__pycache__',
  '.cache', '.pnpm-store', '.yarn', '.idea', '.vscode', '.ssh', '.aws', '.gnupg', '.config',
]);
const FALLBACK_SENSITIVE_BASENAME = /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.git-credentials|\.ds_store|credentials(?:\..*)?|secrets?(?:\..*)?)$/u;
const FALLBACK_SENSITIVE_EXTENSION = /\.(?:pem|key|p12|keystore)$/u;
const FALLBACK_SENSITIVE_PREFIX = /^id_(?:rsa|ed25519)/u;

/**
 * Whether one archive-relative path must not be restored. The workspace
 * module owns the full exclusion list; without it the conservative built-in
 * list still refuses credentials, VCS metadata and build caches.
 * @param {string} relPath - archive-relative POSIX path.
 * @param {object | undefined} workspaceFiles - workspace collector module.
 * @returns {boolean} true when the file must be skipped.
 */
function isUnsafeRestorePath(relPath, workspaceFiles) {
  if (workspaceFiles !== undefined) {
    try {
      if (typeof workspaceFiles.isSensitivePath === 'function' && workspaceFiles.isSensitivePath(relPath)) return true;
    } catch {
      // Fall through to the directory rule below.
    }
    try {
      if (typeof workspaceFiles.isExcludedDir === 'function' && workspaceFiles.isExcludedDir(relPath)) return true;
    } catch {
      // Fall through to the built-in list when the module misbehaves.
    }
    return false;
  }
  const segments = relPath.split('/');
  for (const segment of segments.slice(0, -1)) {
    if (FALLBACK_EXCLUDED_DIRS.has(segment)) return true;
  }
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  return FALLBACK_SENSITIVE_BASENAME.test(base)
    || FALLBACK_SENSITIVE_EXTENSION.test(base)
    || FALLBACK_SENSITIVE_PREFIX.test(base);
}

/**
 * Read one archive buffer into its importable parts. Nothing is written.
 * @param {Buffer} buffer - archive bytes (ZIP) or a bare JSONL file.
 * @returns {{sessions: Array<{text: string, mode: 'full'|'compact'}>,
 *   attachments: Array<{name: string, data: Uint8Array}>, entries: Map<string, Uint8Array>,
 *   workspaces: Array<object>, checksums: Record<string, string> | undefined,
 *   warnings: string[]}} parsed archive.
 * @throws {SessionPortFormatError} `invalid-zip`, `no-log`, `manifest-invalid`,
 *   `checksum-mismatch`.
 */
function parseArchive(buffer) {
  if (!isZipBuffer(buffer)) {
    const text = stripBom(buffer.toString('utf8'));
    if (text.trim() === '') throw new SessionPortFormatError('empty-file', '导入文件是空的');
    return { sessions: [{ text, mode: 'full' }], attachments: [], entries: new Map(), workspaces: [], checksums: undefined, warnings: [] };
  }

  let rawEntries;
  try {
    rawEntries = readZipEntries(buffer);
  } catch (error) {
    throw new SessionPortFormatError('invalid-zip', `ZIP 文件无法解析：${errorText(error)}`);
  }
  const entries = rawEntries.map((entry) => ({ name: entry.name.replaceAll('\\', '/'), data: entry.data }));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const warnings = [];

  /** @type {Array<{text: string, mode: 'full'|'compact'}>} */
  const sessions = [];
  const manifestEntry = byName.get('manifest.json');
  let manifest;
  if (manifestEntry !== undefined) {
    try {
      manifest = JSON.parse(Buffer.from(manifestEntry.data).toString('utf8'));
    } catch {
      manifest = undefined;
    }
  }
  const workspaces = Array.isArray(manifest?.workspaces) ? manifest.workspaces.filter((entry) => entry !== null && typeof entry === 'object') : [];

  if (manifest !== undefined && manifest !== null && manifest.kind === 'dsh-session-kit') {
    if (manifest.manifestVersion !== 1) {
      throw new SessionPortFormatError(
        'manifest-invalid',
        `不支持的归档清单版本 ${String(manifest.manifestVersion)}（当前支持 manifestVersion 1）`,
      );
    }
    if (!Array.isArray(manifest.sessions) || manifest.sessions.length === 0) {
      throw new SessionPortFormatError('manifest-invalid', '归档清单里没有任何会话');
    }
    const checksums = manifest.checksums !== null && typeof manifest.checksums === 'object'
      && manifest.checksums.algorithm === 'sha256' && typeof manifest.checksums.files === 'object'
      ? manifest.checksums.files
      : undefined;
    for (const [name, expected] of Object.entries(checksums ?? {})) {
      const entry = byName.get(name);
      if (entry === undefined) {
        warnings.push(`压缩包缺少清单登记的文件：${name}`);
        continue;
      }
      if (typeof expected === 'string' && sha256Hex(Buffer.from(entry.data)) !== expected) {
        warnings.push(`文件校验和与清单不一致：${name}`);
      }
    }
    for (const session of manifest.sessions) {
      const logPath = session !== null && typeof session === 'object' && typeof session.log === 'string'
        ? session.log.replaceAll('\\', '/')
        : undefined;
      if (logPath === undefined) {
        throw new SessionPortFormatError('manifest-invalid', '归档清单的会话条目缺少 log 字段');
      }
      const logEntry = byName.get(logPath);
      if (logEntry === undefined) {
        throw new SessionPortFormatError('manifest-invalid', `归档清单引用的会话日志不存在：${logPath}`);
      }
      const logText = Buffer.from(logEntry.data).toString('utf8');
      if (typeof session.logSha256 === 'string' && session.logSha256 !== ''
        && sha256Hex(Buffer.from(logEntry.data)) !== session.logSha256) {
        throw new SessionPortFormatError(
          'checksum-mismatch',
          `会话日志 ${logPath} 的 sha256 与清单不一致，归档可能已损坏`,
        );
      }
      const mode = session.mode === 'compact' || manifest.mode === 'compact'
        ? 'compact'
        : modeFromLogName(logPath) ?? 'full';
      const meta = {
        ...(typeof session.id === 'string' && session.id !== '' ? { sourceId: session.id } : {}),
        ...(session.archived === true ? { archived: true } : {}),
        ...(session.pinned === true ? { pinned: true } : {}),
      };
      sessions.push({ text: logText, mode, ...(Object.keys(meta).length > 0 ? { meta } : {}) });
    }
    return { sessions, attachments: collectAttachmentEntries(entries), entries: new Map(entries.map((entry) => [entry.name, entry.data])), workspaces, checksums, warnings };
  }

  const pluginLogs = entries.filter((entry) => modeFromLogName(entry.name) !== undefined
    && entry.name.startsWith('sessions/'));
  if (pluginLogs.length > 0) {
    for (const entry of pluginLogs) {
      sessions.push({
        text: Buffer.from(entry.data).toString('utf8'),
        mode: modeFromLogName(entry.name) ?? 'full',
      });
    }
  } else {
    const rootName = findRootLogEntry(entries);
    if (rootName === undefined) {
      const top = entries.filter((entry) => !entry.name.includes('/')).slice(0, 6).map((entry) => entry.name);
      throw new SessionPortFormatError(
        'no-log',
        `压缩包里没有找到会话日志（session.vN.jsonl）${top.length > 0 ? `；顶层文件：${top.join('、')}` : ''}`,
      );
    }
    const rootEntry = byName.get(rootName);
    sessions.push({ text: Buffer.from(rootEntry.data).toString('utf8'), mode: 'full' });
    if (entries.some((entry) => entry.name.startsWith('subagents/'))) {
      warnings.push('压缩包包含子会话（subagents/），本次只导入主会话');
    }
  }
  return { sessions, attachments: collectAttachmentEntries(entries), entries: new Map(entries.map((entry) => [entry.name, entry.data])), workspaces, checksums: undefined, warnings };
}

/**
 * Extract the archive attachment entries into the local store spelling.
 * @param {Array<{name: string, data: Uint8Array}>} entries - archive entries.
 * @returns {Array<{name: string, data: Uint8Array}>} attachment entries.
 */
function collectAttachmentEntries(entries) {
  const attachments = [];
  const seenNames = new Set();
  for (const entry of entries) {
    const local = localAttachmentName(entry.name);
    if (local === undefined || seenNames.has(local)) continue;
    seenNames.add(local);
    attachments.push({ name: local, data: entry.data });
  }
  return attachments;
}

/**
 * Resolve the directory workspace files are restored into and every imported
 * session records. The explicit `cwd` wins; a relative value resolves against
 * the process directory. Without one the helper's target resolution is used.
 * @param {object} ctx - composed host context.
 * @param {object} helpers - resolved sessions helper module.
 * @param {string | undefined} requestedCwd - explicit target directory.
 * @returns {Promise<string | undefined>} absolute target directory.
 */
async function resolveRestoreDirectory(ctx, helpers, requestedCwd) {
  if (typeof requestedCwd === 'string' && requestedCwd.trim() !== '') {
    const value = requestedCwd.trim();
    return isAbsolute(value) ? value : resolvePath(value);
  }
  try {
    return await helpers.resolveTargetDirectory(ctx, {});
  } catch {
    return undefined;
  }
}

/**
 * Restore the archive's workspace tree into `targetRoot`.
 *
 * The path of every entry is validated before the first byte is written, so a
 * single zip-slip entry rejects the whole tree without partial writes. Then
 * sensitive/build-cache entries are skipped, an existing file is never
 * overwritten, and the total restored bytes stay within the import budget.
 * @param {object} options - restore request.
 * @param {object} options.archive - parsed archive (entries + workspaces).
 * @param {string} options.targetRoot - absolute target directory.
 * @param {object | undefined} options.workspaceFiles - workspace collector module for exclusion rules.
 * @param {number} options.maxBytes - restored-byte budget.
 * @param {AbortSignal | undefined} options.signal - cancellation.
 * @returns {Promise<{restoredFiles: number, restoredBytes: number, skipped: number, warnings: string[]}>} restore stats.
 * @throws {SessionPortFormatError} `zip-slip`, `too-large`.
 */
async function restoreWorkspaceEntries({ archive, targetRoot, workspaceFiles, maxBytes, signal }) {
  const warnings = [];
  const bases = [];
  for (const workspace of archive.workspaces) {
    const archivePath = typeof workspace.archivePath === 'string'
      ? workspace.archivePath.replaceAll('\\', '/').replace(/\/+$/u, '')
      : '';
    if (!archivePath.startsWith(WORKSPACE_PREFIX)) continue;
    const invalidBase = validateArchiveRelativePath(archivePath);
    if (invalidBase !== undefined) {
      throw new SessionPortFormatError('zip-slip', `清单里的工作区路径不安全：${archivePath}（${invalidBase}）`);
    }
    bases.push({
      base: archivePath,
      path: typeof workspace.path === 'string' ? workspace.path : undefined,
    });
  }
  if (bases.length === 0) return { restoredFiles: 0, restoredBytes: 0, skipped: 0, warnings };
  bases.sort((left, right) => right.base.length - left.base.length);

  /** @type {Array<{rel: string, data: Uint8Array}>} */
  const candidates = [];
  let skipped = 0;
  for (const [name, data] of archive.entries) {
    const owner = bases.find((candidate) => name === candidate.base || name.startsWith(`${candidate.base}/`));
    if (owner === undefined) continue;
    const rel = name.slice(owner.base.length + 1);
    const invalid = validateArchiveRelativePath(rel);
    if (invalid !== undefined) {
      throw new SessionPortFormatError('zip-slip', `压缩包包含不安全的条目路径 "${name}"：${invalid}`);
    }
    if (isUnsafeRestorePath(rel, workspaceFiles)) {
      skipped += 1;
      continue;
    }
    candidates.push({ rel, data });
  }

  let restoredFiles = 0;
  let restoredBytes = 0;
  let skippedExisting = 0;
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const targetPath = join(targetRoot, ...candidate.rel.split('/'));
    const containment = relativePath(targetRoot, targetPath);
    if (containment === '' || containment.startsWith('..') || isAbsolute(containment)) {
      throw new SessionPortFormatError('zip-slip', `压缩包条目越出目标目录：${candidate.rel}`);
    }
    if (restoredBytes + candidate.data.byteLength > maxBytes) {
      throw new SessionPortFormatError(
        'too-large',
        `恢复工作区文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)} MiB）`,
      );
    }
    try {
      await stat(targetPath);
      skippedExisting += 1;
      continue;
    } catch {
      // Absent: write it below.
    }
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, candidate.data, { flag: 'wx' });
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EEXIST') {
        skippedExisting += 1;
        continue;
      }
      warnings.push(`恢复工作区文件失败：${candidate.rel}（${errorText(error)}）`);
      skipped += 1;
      continue;
    }
    restoredFiles += 1;
    restoredBytes += candidate.data.byteLength;
  }
  if (skipped > 0) warnings.push(`恢复工作区文件时跳过 ${skipped} 个敏感/排除/失败条目`);
  if (skippedExisting > 0) warnings.push(`恢复工作区文件时跳过 ${skippedExisting} 个已存在的文件（不覆盖）`);
  return { restoredFiles, restoredBytes, skipped: skipped + skippedExisting, warnings };
}

/**
 * Resolve the agent preset an imported session requests, dropping it when this
 * machine's roster cannot resolve it (a missing preset would leave the Session
 * unable to compose its agent).
 * @param {object} helpers - resolved sessions helper module.
 * @param {object} ctx - composed host context.
 * @param {string | undefined} requested - preset id recorded on the source header.
 * @returns {Promise<{preset?: string, warning?: string}>} resolvable preset or a warning.
 */
async function resolveAgentPreset(helpers, ctx, requested) {
  if (typeof requested !== 'string' || requested.trim() === '') return {};
  const presets = helpers.servicesOf(ctx).agentPresets;
  if (presets === undefined || typeof presets.resolve !== 'function') {
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
 * Re-open one freshly written session through the query service, which replays
 * and validates the stored log exactly as opening it in the UI does.
 * @param {object} helpers - resolved sessions helper module.
 * @param {object} ctx - composed host context.
 * @param {string} sessionId - the session just created.
 * @returns {Promise<{ok: boolean, detail?: string, skipped?: boolean}>} verification result.
 */
async function verifyImportedSession(helpers, ctx, sessionId) {
  const { sessionQuery } = helpers.servicesOf(ctx);
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
    return { ok: true, skipped: true };
  }
  try {
    const snapshot = await sessionQuery.readSession(sessionId);
    if (snapshot === undefined || snapshot === null || snapshot.session === undefined || snapshot.session === null) {
      return { ok: false, detail: '读回的会话没有存储头信息' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}

/**
 * Import one archive as new sessions.
 *
 * The archive is fully preflighted (parse, event validation, format-version
 * gate, session cap, duplicate source ids) before the first write, so an
 * unusable archive leaves no sessions behind. Subagent transcripts are always
 * skipped; workspace files are restored only when requested and only into the
 * resolved target directory. A write failure aborts the batch after the
 * sessions already written; verification failures and workspace binding
 * failures degrade to per-session warnings and never throw.
 *
 * @param {object} ctx - composed host context.
 * @param {object} options - import request.
 * @param {Buffer | Uint8Array} options.buffer - archive bytes (ZIP or bare JSONL).
 * @param {string} [options.cwd] - target working directory for the new sessions (and workspace-file restore).
 * @param {string} [options.workspaceId] - preferred workspace to join.
 * @param {boolean} [options.restoreWorkspaceFiles] - unpack the archive's workspaces/ tree into `cwd`.
 * @param {number} [options.maxImportBytes] - request size cap (also the restore byte budget).
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {object} [options.deps] - helper-module override (`lib/sessions.js` shape plus optional `workspaceFiles`).
 * @returns {Promise<{sessions: Array<{sessionId: string, title?: string, eventCount: number, mode: string, verified: boolean, warnings: string[]}>, warnings: string[], restoredFiles: number, restoredBytes: number, skipped: number}>} import result.
 * @throws {SessionPortFormatError} with codes `empty-file`, `too-large`,
 *   `invalid-zip`, `no-log`, `manifest-invalid`, `checksum-mismatch`,
 *   `format-version`, `duplicate-session`, `too-many-sessions`, `no-session`,
 *   `zip-slip`, `unavailable`, `write-failed`.
 */
export async function importArchive(ctx, options = {}) {
  const {
    buffer,
    cwd,
    workspaceId,
    restoreWorkspaceFiles = false,
    maxImportBytes = DEFAULT_MAX_IMPORT_BYTES,
    skipDuplicates = false,
    onProgress,
    signal,
    deps,
  } = options;
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) {
    throw new SessionPortFormatError('empty-file', '导入文件是空的');
  }
  if (!Number.isSafeInteger(maxImportBytes) || maxImportBytes <= 0) {
    throw new SessionPortFormatError('invalid-argument', 'maxImportBytes 必须是正整数');
  }
  if (buffer.length > maxImportBytes) {
    throw new SessionPortFormatError(
      'too-large',
      `导入文件超过大小上限（${Math.round(maxImportBytes / 1024 / 1024)} MiB）`,
    );
  }

  const helpers = await loadSessions(deps);
  const archive = parseArchive(Buffer.from(buffer));
  const warnings = [...archive.warnings];

  const currentVersion = await helpers.detectFormatVersion(ctx, undefined);
  /** @type {Array<{mode: 'full'|'compact', header: object, events: Array<object>}>} */
  let docs = [];
  const seenIds = new Set();
  let skippedSubagents = 0;
  for (const source of archive.sessions) {
    signal?.throwIfAborted();
    const parsed = parseSessionLog(stripBom(source.text));
    if (parsed.header.origin === 'subagent') {
      skippedSubagents += 1;
      continue;
    }
    validateEvents(parsed.events);
    if (parsed.header.version !== currentVersion) {
      throw new SessionPortFormatError(
        'format-version',
        `该会话是格式 v${String(parsed.header.version)}，当前 DSH 使用 v${currentVersion}；请先用对应版本的 DSH 打开并重新导出`,
      );
    }
    if (seenIds.has(parsed.header.id)) {
      throw new SessionPortFormatError('duplicate-session', `压缩包内出现重复的会话 id：${parsed.header.id}`);
    }
    seenIds.add(parsed.header.id);
    docs.push({
      mode: source.mode,
      header: parsed.header,
      events: parsed.events,
      ...(source.meta !== undefined ? { meta: source.meta } : {}),
    });
  }
  if (skippedSubagents > 0) {
    warnings.push(`跳过 ${skippedSubagents} 个子代理会话（子代理不导入）`);
  }
  if (docs.length === 0) {
    throw new SessionPortFormatError(
      'no-session',
      skippedSubagents > 0
        ? '压缩包里只有子代理会话，没有可导入的主对话'
        : '压缩包里没有找到会话日志',
    );
  }
  if (docs.length > MAX_IMPORT_SESSIONS) {
    throw new SessionPortFormatError(
      'too-many-sessions',
      `一次最多导入 ${MAX_IMPORT_SESSIONS} 个会话（压缩包内可导入 ${docs.length} 个）`,
    );
  }

  const persistence = helpers.servicesOf(ctx).sessionPersistence;
  if (persistence === undefined) {
    throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法导入');
  }

  // Duplicate preflight: imported sessions always get a new id, but if the
  // archive's source id already exists locally the import is a copy of a known
  // conversation. Report it (or skip with skipDuplicates) before writing.
  const existingIds = await listExistingSessionIds(persistence);
  const duplicates = docs.filter((doc) => existingIds.has(doc.header.id)).map((doc) => doc.header.id);
  if (duplicates.length > 0) {
    if (skipDuplicates === true) {
      docs = docs.filter((doc) => !existingIds.has(doc.header.id));
      warnings.push(`跳过 ${duplicates.length} 个本地已存在的会话（skipDuplicates）：${duplicates.join(', ')}`);
      if (docs.length === 0) {
        throw new SessionPortFormatError('no-session', '压缩包里的会话都已存在，且已选择跳过重复项');
      }
    } else {
      for (const id of duplicates) {
        warnings.push(`会话 ${id} 在本机已存在；本次导入会创建新 id 的副本`);
      }
    }
  }

  // Optional workspace-tree restore. Path validation runs before any write, so
  // a zip-slip archive aborts here with no files and no sessions created.
  const hasWorkspaces = Array.isArray(archive.workspaces) && archive.workspaces.length > 0;
  let restoreTarget;
  let restored = { restoredFiles: 0, restoredBytes: 0, skipped: 0 };
  if (hasWorkspaces && restoreWorkspaceFiles === true) {
    restoreTarget = await resolveRestoreDirectory(ctx, helpers, cwd);
    if (restoreTarget === undefined) {
      warnings.push('无法确定工作区恢复目录，未恢复工作区文件');
    } else {
      await mkdir(restoreTarget, { recursive: true });
      const workspaceFiles = await loadWorkspaceFilesOptional(deps);
      if (workspaceFiles === undefined) {
        warnings.push('工作区文件安全模块不可用，恢复时使用内置排除规则');
      }
      const restoredResult = await restoreWorkspaceEntries({
        archive,
        targetRoot: restoreTarget,
        workspaceFiles,
        maxBytes: maxImportBytes,
        signal,
      });
      restored = {
        restoredFiles: restoredResult.restoredFiles,
        restoredBytes: restoredResult.restoredBytes,
        skipped: restoredResult.skipped,
      };
      warnings.push(...restoredResult.warnings);
    }
  } else if (hasWorkspaces) {
    warnings.push('压缩包包含工作区文件，未选择恢复（restoreWorkspaceFiles=true 可恢复）');
  }

  // Restore archive attachments once; the store is content-addressed, so one
  // object serves every imported session that references it.
  let replacements = new Map();
  if (archive.attachments.length > 0) {
    const restoredAttachments = await restoreAttachmentEntries(
      helpers.servicesOf(ctx).attachments,
      archive.attachments,
      signal,
    );
    replacements = restoredAttachments.replacements;
    warnings.push(...restoredAttachments.warnings);
  }

  /** @type {Array<object>} */
  const imported = [];
  for (const doc of docs) {
    signal?.throwIfAborted();
    const newId = await helpers.mintSessionId(persistence);
    const targetCwd = restoreTarget !== undefined
      ? restoreTarget
      : await helpers.resolveTargetDirectory(ctx, { requestedCwd: cwd, sourceCwd: doc.header.cwd });
    const sessionWarnings = [];
    const preset = await resolveAgentPreset(helpers, ctx, doc.header.agentPreset);
    if (preset.warning !== undefined) sessionWarnings.push(preset.warning);
    const header = {
      version: currentVersion,
      id: newId,
      createdAt: doc.header.createdAt,
      cwd: targetCwd,
      isSeeded: false,
      delegationDepth: 0,
      ...(preset.preset !== undefined ? { agentPreset: preset.preset } : {}),
    };
    let events = replacements.size > 0 ? rewriteAttachmentRefs(doc.events, replacements) : doc.events;
    events = rewriteDeliveryIdentity(events, newId, currentVersion);
    events = rewriteSeedMarkers(events);
    try {
      await helpers.writeNewSession(persistence, header, events, 0);
    } catch (error) {
      throw new SessionPortFormatError(
        'write-failed',
        `会话 ${doc.header.id} 写入失败：${errorText(error)}${imported.length > 0
          ? `（已成功导入的 ${imported.length} 个会话会保留）`
          : ''}`,
      );
    }
    const joined = await helpers.attachToWorkspace(ctx, { sessionId: newId, workspaceId, cwd: targetCwd });
    if (joined !== undefined && joined !== null && joined.warning !== undefined) sessionWarnings.push(joined.warning);
    const verified = await verifyImportedSession(helpers, ctx, newId);
    if (!verified.ok && verified.detail !== undefined) {
      sessionWarnings.push(`会话已写入，但当前 DSH 无法重新打开它：${verified.detail}`);
    }
    await restoreRegistryState(helpers, ctx, newId, doc.meta, sessionWarnings);
    const title = typeof helpers.foldTitle === 'function'
      ? (() => {
          try {
            const folded = helpers.foldTitle(events);
            return typeof folded === 'string' && folded.trim() !== '' ? folded.trim() : localFoldTitle(events);
          } catch {
            return localFoldTitle(events);
          }
        })()
      : localFoldTitle(events);
    imported.push({
      sessionId: newId,
      ...(title !== undefined ? { title } : {}),
      eventCount: events.length,
      mode: doc.mode,
      verified: verified.ok,
      warnings: sessionWarnings,
    });
    if (typeof onProgress === 'function') {
      await onProgress({
        index: imported.length,
        total: docs.length,
        ...(doc.meta?.sourceId !== undefined ? { sourceId: doc.meta.sourceId } : {}),
        sessionId: newId,
        ...(title !== undefined ? { title } : {}),
        mode: doc.mode,
        verified: verified.ok,
        warnings: sessionWarnings,
      });
    }
  }

  return {
    sessions: imported,
    warnings,
    restoredFiles: restored.restoredFiles,
    restoredBytes: restored.restoredBytes,
    skipped: restored.skipped,
  };
}

/** Existing persisted session ids, used by the duplicate preflight. */
async function listExistingSessionIds(persistence) {
  const ids = new Set();
  if (typeof persistence?.list !== 'function') return ids;
  try {
    const listed = await persistence.list();
    for (const snapshot of Array.isArray(listed) ? listed : []) {
      const id = snapshot?.header?.id ?? snapshot?.id;
      if (typeof id === 'string' && id !== '') ids.add(id);
    }
  } catch {
    // A listing failure only disables duplicate reporting, never the import.
  }
  return ids;
}

/** Re-apply archived/pinned membership to an imported session, best effort. */
async function restoreRegistryState(helpers, ctx, sessionId, meta, warnings) {
  const registry = helpers.servicesOf(ctx).workspaceRegistry;
  if (registry === undefined || meta === undefined || meta === null) return;
  if (meta.archived === true && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(sessionId, { stopActivity: false });
    } catch (error) {
      warnings.push(`会话已导入，但恢复归档状态失败：${errorText(error)}`);
    }
  }
  if (meta.pinned === true && typeof registry.pinSession === 'function') {
    try {
      await registry.pinSession(sessionId);
    } catch (error) {
      warnings.push(`会话已导入，但恢复置顶状态失败：${errorText(error)}`);
    }
  }
}

/**
 * Read one import file from the host filesystem (agent-tool path).
 * @param {string} path - archive path (absolute, or relative to `cwd`).
 * @param {{cwd?: string, maxImportBytes?: number}} options - resolution base and cap.
 * @returns {Promise<{buffer: Buffer, filename: string, resolved: string}>} file bytes.
 * @throws {SessionPortFormatError} `file-missing`, `too-large`, `invalid-argument`.
 */
export async function readImportFile(path, { cwd, maxImportBytes = DEFAULT_MAX_IMPORT_BYTES } = {}) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new SessionPortFormatError('invalid-argument', 'readImportFile 需要一个文件路径');
  }
  if (!Number.isSafeInteger(maxImportBytes) || maxImportBytes <= 0) {
    throw new SessionPortFormatError('invalid-argument', 'maxImportBytes 必须是正整数');
  }
  const resolved = isAbsolute(path) ? path : resolvePath(cwd ?? process.cwd(), path);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    throw new SessionPortFormatError('file-missing', `找不到文件 ${resolved}：${errorText(error)}`);
  }
  if (!info.isFile()) throw new SessionPortFormatError('file-missing', `${resolved} 不是文件`);
  if (info.size > maxImportBytes) {
    throw new SessionPortFormatError(
      'too-large',
      `导入文件超过大小上限（${Math.round(maxImportBytes / 1024 / 1024)} MiB）`,
    );
  }
  const buffer = await readFile(resolved);
  return { buffer, filename: resolved.split(/[\\/]/u).pop() ?? resolved, resolved };
}
