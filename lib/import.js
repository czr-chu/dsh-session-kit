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
 * Existing sessions are never touched; archives are preflighted before the first
 * write, so an unsupported format version or a corrupt archive fails without
 * leaving partial sessions behind.
 *
 * @module dsh-session-kit/import
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';

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

/** Cached helper module; a failed import is retried on the next call. */
let sessionsModule;

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
 * @returns {'full' | 'compact' | undefined} mode, or undefined when not a session log.
 */
function modeFromLogName(name) {
  if (/^sessions\/[^/]+\/session\.compact(?:\.v\d+)?\.jsonl$/u.test(name)) return 'compact';
  if (/^sessions\/[^/]+\/session(?:\.v\d+)?\.jsonl$/u.test(name)) return 'full';
  if (/^session(?:\.v\d+)?\.jsonl$/u.test(name)) return 'full';
  return undefined;
}

/**
 * Read one archive buffer into its importable parts. Nothing is written.
 * @param {Buffer} buffer - archive bytes (ZIP) or a bare JSONL file.
 * @returns {{sessions: Array<{text: string, mode: 'full'|'compact'}>,
 *   attachments: Array<{name: string, data: Uint8Array}>, warnings: string[]}} parsed archive.
 * @throws {SessionPortFormatError} `invalid-zip`, `no-log`, `manifest-invalid`,
 *   `checksum-mismatch`, `duplicate-session`.
 */
function parseArchive(buffer) {
  if (!isZipBuffer(buffer)) {
    const text = stripBom(buffer.toString('utf8'));
    if (text.trim() === '') throw new SessionPortFormatError('empty-file', '导入文件是空的');
    return { sessions: [{ text, mode: 'full' }], attachments: [], warnings: [] };
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
  const seenIds = new Set();
  const manifestEntry = byName.get('manifest.json');
  let manifest;
  if (manifestEntry !== undefined) {
    try {
      manifest = JSON.parse(Buffer.from(manifestEntry.data).toString('utf8'));
    } catch {
      manifest = undefined;
    }
  }

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
      sessions.push({ text: logText, mode });
    }
  } else {
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
  }

  const attachments = [];
  const seenNames = new Set();
  for (const entry of entries) {
    const local = localAttachmentName(entry.name);
    if (local === undefined || seenNames.has(local)) continue;
    seenNames.add(local);
    attachments.push({ name: local, data: entry.data });
  }
  return { sessions, attachments, warnings };
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
 * unusable archive leaves no sessions behind. A write failure aborts the batch
 * after the sessions already written; verification failures and workspace
 * binding failures degrade to per-session warnings and never throw.
 *
 * @param {object} ctx - composed host context.
 * @param {object} options - import request.
 * @param {Buffer | Uint8Array} options.buffer - archive bytes (ZIP or bare JSONL).
 * @param {string} [options.cwd] - requested working directory for the new sessions.
 * @param {string} [options.workspaceId] - preferred workspace to join.
 * @param {number} [options.maxImportBytes] - request size cap.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {object} [options.deps] - helper-module override (`lib/sessions.js` shape).
 * @returns {Promise<{sessions: Array<{sessionId: string, title?: string, eventCount: number, mode: string, verified: boolean, warnings: string[]}>, warnings: string[]}>} import result.
 * @throws {SessionPortFormatError} with codes `empty-file`, `too-large`,
 *   `invalid-zip`, `no-log`, `manifest-invalid`, `checksum-mismatch`,
 *   `format-version`, `duplicate-session`, `too-many-sessions`,
 *   `unavailable`, `write-failed`.
 */
export async function importArchive(ctx, options = {}) {
  const {
    buffer,
    cwd,
    workspaceId,
    maxImportBytes = DEFAULT_MAX_IMPORT_BYTES,
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
  if (archive.sessions.length === 0) {
    throw new SessionPortFormatError('no-log', '压缩包里没有找到会话日志');
  }
  if (archive.sessions.length > MAX_IMPORT_SESSIONS) {
    throw new SessionPortFormatError(
      'too-many-sessions',
      `一次最多导入 ${MAX_IMPORT_SESSIONS} 个会话（压缩包内有 ${archive.sessions.length} 个）`,
    );
  }

  const currentVersion = await helpers.detectFormatVersion(ctx, undefined);
  /** @type {Array<{mode: 'full'|'compact', header: object, events: Array<object>}>} */
  const docs = [];
  const seenIds = new Set();
  for (const source of archive.sessions) {
    signal?.throwIfAborted();
    const parsed = parseSessionLog(stripBom(source.text));
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
    docs.push({ mode: source.mode, header: parsed.header, events: parsed.events });
  }

  const persistence = helpers.servicesOf(ctx).sessionPersistence;
  if (persistence === undefined) {
    throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法导入');
  }

  // Restore archive attachments once; the store is content-addressed, so one
  // object serves every imported session that references it.
  let replacements = new Map();
  if (archive.attachments.length > 0) {
    const restored = await restoreAttachmentEntries(
      helpers.servicesOf(ctx).attachments,
      archive.attachments,
      signal,
    );
    replacements = restored.replacements;
    warnings.push(...restored.warnings);
  }

  /** @type {Array<object>} */
  const imported = [];
  for (const doc of docs) {
    signal?.throwIfAborted();
    const newId = await helpers.mintSessionId(persistence);
    const targetCwd = await helpers.resolveTargetDirectory(ctx, {
      requestedCwd: cwd,
      sourceCwd: doc.header.cwd,
    });
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
  }

  return { sessions: imported, warnings };
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
