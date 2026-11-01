/**
 * dsh-session-kit — Host half.
 *
 * Derived from dsh-session-port@0.2.1 (MIT) `index.js` (route fencing, tool
 * registration and error mapping are inherited), extended with a session list
 * route, a batch export/import surface, and session management (archive /
 * unarchive / delete-to-trash).
 *
 * Two faces over the same operations in `lib/export.js`, `lib/import.js` and
 * `lib/manage.js`:
 *
 *  - the authenticated browser routes the client half calls
 *    (GET /session-kit/{info,list}, POST /session-kit/{export,import,archive,
 *    unarchive,delete}), fenced by the Connection service exactly like every
 *    other plugin-owned route; and
 *  - one agent tool (`session_kit`) with list / export / import / archive /
 *    unarchive / delete actions.
 *
 * Export/import options carried over the routes and the tool:
 * `includeWorkspaceFiles` (pack whole workspace trees), `includeSubagents`
 * (keep subagent transcripts; default false), `workspaceExclude` (extra
 * workspace path patterns) and `restoreWorkspaceFiles` (unpack the archive's
 * workspaces/ tree into the target directory).
 *
 * Management semantics: archive/unarchive go through the workspace registry;
 * delete only moves session directories into `<DSH_HOME>/session-kit-trash`
 * (never a permanent erase) and requires an explicit id list. Batches are
 * capped at {@link MAX_MANAGE_BATCH} sessions and report one result per id.
 *
 * The plugin imports no DSH package: session-query, persistence, attachments,
 * workspaces, presets and the working directory are read off `ctx` through the
 * Cordis service registry, keeping the bundle dependency-free.
 *
 * @module dsh-session-kit
 */

import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorText } from './lib/attachments.js';
import { buildArchive, defaultExportDirectory } from './lib/export.js';
import { SessionPortFormatError } from './lib/format.js';
import { importArchive, readImportFile } from './lib/import.js';

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-session-kit';

/** Services the plugin cannot work without. */
export const inject = ['tools', 'sessionQuery', 'sessionPersistence'];

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/session-kit';
/** Cap on the JSON export/manage request body. */
const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** Upper bound on one archive/unarchive/delete batch. */
export const MAX_MANAGE_BATCH = 500;
/** Directory name under DSH_HOME that receives deleted session folders. */
const TRASH_DIR_NAME = 'session-kit-trash';

/** Cached helper modules; a failed import is retried on the next call. */
let sessionsModule;
let manageModule;

/**
 * Normalize the test-only module injection seam.
 *
 * A Loader YAML cannot express object values, so `modules` is inert in
 * production and exists so tests can drive the routes without a real
 * `lib/manage.js` / `lib/sessions.js` (and so a composition can substitute
 * them). When present, a missing member means "that helper is unavailable".
 * @param {unknown} config - raw Loader row config.
 * @returns {{sessions?: object, manage?: object} | undefined} override set.
 */
function moduleOverrides(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const modules = raw.modules;
  if (modules === null || typeof modules !== 'object' || Array.isArray(modules)) return undefined;
  return { sessions: modules.sessions, manage: modules.manage };
}

/**
 * Resolve the session helper module lazily so the Host half still loads when
 * the module is absent (only the routes that need it then fail loudly).
 * @param {{sessions?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} helper module namespace.
 */
async function loadSessions(overrides) {
  if (overrides !== undefined) {
    if (overrides.sessions === undefined || overrides.sessions === null) {
      throw new SessionPortFormatError('unavailable', '会话服务模块不可用');
    }
    return overrides.sessions;
  }
  if (sessionsModule === undefined) {
    try {
      sessionsModule = await import('./lib/sessions.js');
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话服务模块不可用：${errorText(error)}`);
    }
  }
  return sessionsModule;
}

/**
 * Resolve the management module lazily (archive/unarchive/delete helpers).
 * @param {{manage?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} management module namespace.
 */
async function loadManage(overrides) {
  if (overrides !== undefined) {
    if (overrides.manage === undefined || overrides.manage === null) {
      throw new SessionPortFormatError('unavailable', '会话管理模块不可用');
    }
    return overrides.manage;
  }
  if (manageModule === undefined) {
    try {
      manageModule = await import('./lib/manage.js');
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话管理模块不可用：${errorText(error)}`);
    }
  }
  return manageModule;
}

/**
 * Cordis entry point.
 * @param {object} ctx - the plugin context.
 * @param {object} [config] - the Loader row's config (all fields optional).
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config);
  const overrides = moduleOverrides(config);
  registerRoutes(ctx, settings, overrides);
  registerTool(ctx, settings, overrides);
}

/**
 * Normalize the Loader row config. Unknown keys are ignored rather than
 * rejected, because the Loader injects schema defaults we do not own.
 * @param {unknown} config - raw row config.
 * @returns {{
 *   maxImportBytes: number,
 *   maxExportBytes: number,
 *   includeAttachments: boolean,
 *   includeWorkspaceFiles: boolean,
 *   includeSubagents: boolean,
 *   restoreWorkspaceFiles: boolean,
 *   workspaceExclude: string[],
 *   workspaceMaxBytes: number | undefined,
 *   trashDir: string | undefined,
 *   defaultMode: 'full'|'compact',
 * }} resolved settings.
 */
function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  return {
    maxImportBytes:
      Number.isSafeInteger(raw.maxImportBytes) && raw.maxImportBytes > 0
        ? raw.maxImportBytes
        : 512 * 1024 * 1024,
    maxExportBytes:
      Number.isSafeInteger(raw.maxExportBytes) && raw.maxExportBytes > 0
        ? raw.maxExportBytes
        : 1024 * 1024 * 1024,
    includeAttachments: raw.includeAttachments !== false,
    includeWorkspaceFiles: raw.includeWorkspaceFiles === true,
    includeSubagents: raw.includeSubagents === true,
    restoreWorkspaceFiles: raw.restoreWorkspaceFiles === true,
    workspaceExclude: Array.isArray(raw.workspaceExclude)
      ? raw.workspaceExclude.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
      : [],
    workspaceMaxBytes: Number.isSafeInteger(raw.workspaceMaxBytes) && raw.workspaceMaxBytes > 0
      ? raw.workspaceMaxBytes
      : undefined,
    trashDir: typeof raw.trashDir === 'string' && raw.trashDir.trim() !== '' ? raw.trashDir.trim() : undefined,
    defaultMode: raw.defaultMode === 'full' ? 'full' : 'compact',
  };
}

/**
 * The directory deleted session folders are moved into.
 * @param {string | undefined} configured - `trashDir` config override.
 * @returns {string} absolute trash directory.
 */
function trashDirectory(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, TRASH_DIR_NAME);
}

/**
 * Register the browser routes once the optional web carrier is up.
 *
 * `webServer` and `connection` are optional services: a headless deployment
 * keeps the tool and simply has no browser face. They are also not guaranteed
 * to be initialized when this plugin's own fiber applies during a cold boot, so
 * `ctx.inject()` re-runs the registration when both become available.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 */
function registerRoutes(ctx, settings, overrides) {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    const connection = webCtx.get('connection');
    if (webServer === undefined || connection === undefined) return;
    webCtx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            dispatchRequest(ctx, settings, overrides, connection, req, res).catch((error) => {
              // `dispatchRequest` already answers every expected failure; this is
              // the last resort so a rejection never leaves a socket hanging.
              try {
                sendJson(res, 500, { ok: false, code: 'internal', message: errorText(error) });
              } catch {
                res.destroy();
              }
            });
          },
        }),
      'session-kit: browser routes',
    );
  });
}

/**
 * Route one fenced request under the plugin prefix.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} connection - the Connection service owning the trust fence.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function dispatchRequest(ctx, settings, overrides, connection, req, res) {
  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.end();
    return;
  }
  const url = new URL(String(req.url ?? '/'), 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (path === `${ROUTE_PREFIX}/info` && method === 'GET') {
      const helpers = await loadSessions(overrides);
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        sessionFormatVersion: await helpers.detectFormatVersion(ctx, undefined),
        capabilities: {
          list: true,
          export: true,
          import: true,
          compact: true,
          workspaceFiles: true,
          subagents: true,
          restoreWorkspaceFiles: true,
          manage: true,
          archive: true,
          unarchive: true,
          delete: true,
          attachments: helpers.servicesOf(ctx).attachments !== undefined,
          tool: 'session_kit',
        },
        trash: {
          directory: trashDirectory(settings.trashDir),
          mode: 'move',
          batchLimit: MAX_MANAGE_BATCH,
        },
        defaults: {
          mode: settings.defaultMode,
          includeAttachments: settings.includeAttachments,
          includeWorkspaceFiles: settings.includeWorkspaceFiles,
          includeSubagents: settings.includeSubagents,
          restoreWorkspaceFiles: settings.restoreWorkspaceFiles,
          ...(settings.workspaceMaxBytes !== undefined ? { workspaceMaxBytes: settings.workspaceMaxBytes } : {}),
        },
      });
      return;
    }
    if (path === `${ROUTE_PREFIX}/list` && method === 'GET') {
      const helpers = await loadSessions(overrides);
      const includeSubagents = url.searchParams.get('includeSubagents') === '1';
      const [sessions, workspaces] = await Promise.all([
        helpers.listSessionEntries(ctx, { includeSubagents }),
        typeof helpers.listWorkspaceEntries === 'function' ? helpers.listWorkspaceEntries(ctx) : Promise.resolve([]),
      ]);
      sendJson(res, 200, { ok: true, sessions, workspaces });
      return;
    }
    if (path === `${ROUTE_PREFIX}/export` && method === 'POST') {
      await handleExport(ctx, settings, overrides, req, res);
      return;
    }
    if (path === `${ROUTE_PREFIX}/import` && method === 'POST') {
      await handleImport(ctx, settings, url, req, res);
      return;
    }
    if (path === `${ROUTE_PREFIX}/archive` && method === 'POST') {
      await handleManage(ctx, settings, overrides, req, res, 'archive');
      return;
    }
    if (path === `${ROUTE_PREFIX}/unarchive` && method === 'POST') {
      await handleManage(ctx, settings, overrides, req, res, 'unarchive');
      return;
    }
    if (path === `${ROUTE_PREFIX}/delete` && method === 'POST') {
      await handleManage(ctx, settings, overrides, req, res, 'delete');
      return;
    }
    sendJson(res, 404, { ok: false, code: 'not-found', message: `没有这个接口：${method} ${path}` });
  } catch (error) {
    sendJson(res, statusOf(error), { ok: false, code: codeOf(error), message: errorText(error) });
  }
}

/**
 * Parse one archive/unarchive/delete id list.
 *
 * `'all'` is accepted only where the caller allows it (the archive tool
 * action). Arrays are trimmed, de-duplicated in order, and capped at
 * {@link MAX_MANAGE_BATCH}; delete/unarchive refusals keep the destructive
 * operations explicit.
 * @param {unknown} value - raw `sessionIds` value.
 * @param {{allowAll?: boolean}} [options] - whether `'all'` is meaningful.
 * @returns {string[] | 'all' | undefined} normalized list, `'all'`, or undefined when absent.
 * @throws {SessionPortFormatError} `invalid-sessionIds`, `too-many-sessions`.
 */
function parseSessionIdList(value, { allowAll = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (value === 'all') {
    if (allowAll) return 'all';
    throw new SessionPortFormatError('invalid-sessionIds', '这里不允许 "all"，请显式给出会话 id');
  }
  if (!Array.isArray(value)) {
    throw new SessionPortFormatError(
      'invalid-sessionIds',
      allowAll ? 'sessionIds 必须是会话 id 数组或 "all"' : 'sessionIds 必须是会话 id 数组',
    );
  }
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new SessionPortFormatError('invalid-sessionIds', 'sessionIds 的每一项都必须是非空字符串');
    }
    const id = entry.trim();
    if (!allowAll && id === 'all') {
      throw new SessionPortFormatError('invalid-sessionIds', '这里不允许 "all"，请显式给出会话 id');
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) throw new SessionPortFormatError('invalid-sessionIds', 'sessionIds 不能为空');
  if (ids.length > MAX_MANAGE_BATCH) {
    throw new SessionPortFormatError('too-many-sessions', `一次最多处理 ${MAX_MANAGE_BATCH} 个会话（本次 ${ids.length} 个）`);
  }
  return ids;
}

/**
 * HTTP status for one failed manage result code.
 * @param {string | undefined} code - error code reported by `lib/manage.js`.
 * @returns {number} 404 / 409 / 500.
 */
function statusForManageCode(code) {
  if (code === 'not-found') return 404;
  if (code === 'active') return 409;
  return 500;
}

/**
 * The workspace registry's currently archived session ids, when it exposes them.
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @returns {Promise<string[] | undefined>} archived ids or undefined.
 */
async function archivedSessionIdsOf(ctx, overrides) {
  try {
    const helpers = await loadSessions(overrides);
    const registry = helpers.servicesOf(ctx)?.workspaceRegistry;
    const ids = registry?.archivedSessionIds;
    if (Array.isArray(ids)) return ids.map((id) => String(id));
    if (ids !== undefined && ids !== null && typeof ids === 'object' && typeof ids[Symbol.iterator] === 'function') {
      return [...ids].map((id) => String(id));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one manage action over a batch, one result per requested id.
 *
 * A per-id failure never aborts the batch: the result records the message and
 * the stable code from `lib/manage.js`. Nothing here deletes permanently;
 * `delete` delegates the trash move to the management module.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {'archive'|'unarchive'|'delete'} action - operation to run.
 * @param {string[]} sessionIds - explicit ids (already expanded and capped).
 * @param {{stopActivity?: boolean}} [options] - archive-only activity stop.
 * @returns {Promise<{results: Array<object>, archivedSessionIds?: string[], trashedPath?: string}>} batch outcome.
 * @throws {SessionPortFormatError} `unavailable` when the management module is absent.
 */
async function runManageBatch(ctx, settings, overrides, action, sessionIds, { stopActivity = false } = {}) {
  const manage = await loadManage(overrides);
  const results = [];
  let trashedPath;
  for (const sessionId of sessionIds) {
    try {
      if (action === 'archive') {
        await manage.archiveSession(ctx, sessionId, { stopActivity });
      } else if (action === 'unarchive') {
        await manage.unarchiveSession(ctx, sessionId);
      } else {
        const outcome = await manage.deleteSession(
          ctx,
          sessionId,
          settings.trashDir !== undefined ? { trashDir: settings.trashDir } : {},
        );
        if (outcome !== null && typeof outcome === 'object'
          && typeof outcome.trashedPath === 'string' && outcome.trashedPath !== '') {
          trashedPath = outcome.trashedPath;
        }
      }
      results.push({ sessionId, ok: true });
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : undefined;
      results.push({
        sessionId,
        ok: false,
        error: errorText(error),
        ...(code !== undefined ? { code } : {}),
      });
    }
  }
  const archivedSessionIds = await archivedSessionIdsOf(ctx, overrides);
  return {
    results,
    ...(archivedSessionIds !== undefined ? { archivedSessionIds } : {}),
    ...(trashedPath !== undefined ? { trashedPath } : {}),
  };
}

/**
 * `POST /session-kit/{archive,unarchive,delete}` — batch management action.
 *
 * Body: `{ sessionIds: string[], stopActivity?: boolean }`. Delete is a
 * trash move and accepts no `permanent` flag. A fully failed batch answers with
 * the status of its first failure code (404 not-found / 409 active / 500);
 * a partial success answers 200 with one result per id.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {'archive'|'unarchive'|'delete'} action - management action.
 */
async function handleManage(ctx, settings, overrides, req, res, action) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  if (action === 'delete' && payload.permanent === true) {
    throw new SessionPortFormatError(
      'permanent-unsupported',
      '删除只会把会话移入回收站（session-kit-trash），不支持永久删除（permanent）',
    );
  }
  const sessionIds = parseSessionIdList(payload.sessionIds, { allowAll: false });
  if (sessionIds === undefined) {
    throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组）');
  }
  const outcome = await runManageBatch(ctx, settings, overrides, action, sessionIds, {
    stopActivity: payload.stopActivity === true,
  });
  const failed = outcome.results.filter((result) => !result.ok);
  const status = failed.length > 0 && failed.length === outcome.results.length
    ? statusForManageCode(failed[0].code)
    : 200;
  sendJson(res, status, { ok: failed.length === 0, ...outcome });
}

/**
 * Normalize a request-supplied boolean flag.
 * @param {unknown} value - raw JSON value.
 * @param {boolean} fallback - deployment default.
 * @returns {boolean} resolved flag.
 */
function booleanFlag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Normalize a request-supplied workspace exclusion list.
 * @param {unknown} value - raw JSON value.
 * @param {string[]} fallback - deployment default.
 * @returns {string[]} resolved patterns.
 */
function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim());
}

/**
 * `POST /session-kit/export` — build one archive and stream it to the browser.
 * Body: `{ sessionIds: string[] | 'all', mode?, includeAttachments?,
 * includeWorkspaceFiles?, includeSubagents?, workspaceExclude? }`.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleExport(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const requested = payload.sessionIds;
  const includeSubagents = booleanFlag(payload.includeSubagents, settings.includeSubagents);
  let sessionIds;
  if (requested === 'all') {
    const helpers = await loadSessions(overrides);
    sessionIds = (await helpers.listSessionEntries(ctx, { includeSubagents })).map((entry) => entry.id);
  } else if (Array.isArray(requested)) {
    sessionIds = requested.map((value) => String(value));
  } else {
    throw new SessionPortFormatError('missing-sessions', '请求缺少 sessionIds（会话 id 数组，或 "all"）');
  }
  const mode = payload.mode === 'full' || payload.mode === 'compact' ? payload.mode : settings.defaultMode;
  const exported = await buildArchive(ctx, {
    sessionIds,
    mode,
    includeAttachments: booleanFlag(payload.includeAttachments, settings.includeAttachments),
    includeWorkspaceFiles: booleanFlag(payload.includeWorkspaceFiles, settings.includeWorkspaceFiles),
    includeSubagents,
    workspaceExclude: stringList(payload.workspaceExclude, settings.workspaceExclude),
    ...(settings.workspaceMaxBytes !== undefined ? { workspaceMaxBytes: settings.workspaceMaxBytes } : {}),
    maxExportBytes: settings.maxExportBytes,
  });
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': String(exported.data.length),
    'content-disposition': 'attachment; filename="session-kit.zip"',
    'cache-control': 'no-store',
    // Header values are ASCII only, so the UTF-8 name travels percent-encoded.
    'x-session-kit-filename': encodeURIComponent(exported.filename),
    'x-session-kit-warnings': encodeURIComponent(JSON.stringify(exported.warnings ?? [])),
    'x-session-kit-sessions': String(exported.sessionCount),
    'x-session-kit-workspace-files': String(exported.workspaceFileCount ?? 0),
  });
  res.end(exported.data);
}

/**
 * `POST /session-kit/import` — commit one uploaded archive as new sessions.
 * Query carries `cwd`, `workspaceId`, `restoreWorkspaceFiles`, `filename` hints.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {URL} url - parsed request URL.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleImport(ctx, settings, url, req, res) {
  const buffer = await readRequestBody(req, settings.maxImportBytes);
  const rawRestore = url.searchParams.get('restoreWorkspaceFiles');
  const restoreWorkspaceFiles = rawRestore === null || rawRestore === ''
    ? settings.restoreWorkspaceFiles
    : rawRestore === '1' || rawRestore.toLowerCase() === 'true';
  const result = await importArchive(ctx, {
    buffer,
    cwd: url.searchParams.get('cwd') ?? undefined,
    workspaceId: url.searchParams.get('workspaceId') ?? undefined,
    restoreWorkspaceFiles,
    maxImportBytes: settings.maxImportBytes,
  });
  sendJson(res, 200, { ok: true, ...result });
}

/**
 * Read a bounded request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} cap - maximum accepted byte count.
 * @returns {Promise<Buffer>} the complete body.
 */
async function readRequestBody(req, cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) {
      throw new SessionPortFormatError(
        'too-large',
        `请求体超过大小上限（${Math.round(cap / 1024 / 1024)} MiB）`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Read and parse a bounded JSON request body; an empty body is `{}`.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} cap - maximum accepted byte count.
 * @returns {Promise<object>} parsed JSON object.
 */
async function readJsonBody(req, cap) {
  const buffer = await readRequestBody(req, cap);
  if (buffer.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new SessionPortFormatError('invalid-json', `请求体不是合法 JSON：${errorText(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionPortFormatError('invalid-json', '请求体必须是 JSON 对象');
  }
  return parsed;
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** HTTP status for one failure code. */
function statusOf(error) {
  const code = codeOf(error);
  if (code === 'unavailable') return 503;
  if (code === 'not-found' || code === 'file-missing') return 404;
  if (code === 'too-large') return 413;
  if (code === 'active') return 409;
  if (code === 'unsafe-location' || code === 'delete-failed' || code === 'internal') return 500;
  return 400;
}

/** Stable failure code for one thrown value. */
function codeOf(error) {
  return error instanceof SessionPortFormatError ? error.code : 'internal';
}

/**
 * Register the model-facing tool. The tool performs exactly the operations the
 * browser half performs, through the same functions.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 */
function registerTool(ctx, settings, overrides) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.register !== 'function') return;
  ctx.effect(
    () =>
      tools.register({
        name: 'session_kit',
        description: [
          'Manage DSH conversations as session archives.',
          'action=list summarizes workspaces and sessions (archived rows are marked).',
          'action=export writes selected sessions (or all) as ONE ZIP under a plugin-owned folder and returns its path; mode=compact keeps only the conversational spine, mode=full keeps the complete session logs.',
          'Export can optionally pack whole workspace trees (includeWorkspaceFiles) while excluding VCS/build caches and secret files, and can include subagent transcripts (includeSubagents, default false).',
          'action=import creates NEW sessions from an archive produced by this plugin or by DSH\'s built-in session-log export; it never modifies or deletes an existing session, never imports subagent transcripts, and can restore the archive\'s workspace files into the target directory (restoreWorkspaceFiles).',
          'action=archive / action=unarchive toggle a session\'s archived state; action=delete moves sessions into <DSH_HOME>/session-kit-trash (never a permanent erase) and requires confirm:true plus explicit session ids.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'export', 'import', 'archive', 'unarchive', 'delete'],
              description: 'list: summarize sessions. export: save sessions as one ZIP. import: create new sessions from a ZIP or JSONL archive. archive/unarchive: toggle archived state. delete: move sessions to the trash directory.',
            },
            mode: {
              type: 'string',
              enum: ['full', 'compact'],
              description: 'export only: full keeps complete logs; compact keeps only the conversation (default from plugin config).',
            },
            sessionIds: {
              oneOf: [
                { type: 'array', items: { type: 'string' } },
                { type: 'string', enum: ['all'] },
              ],
              description: 'export/archive: session ids, or "all" (archive only). unarchive/delete: explicit session ids ("all" is refused for safety).',
            },
            includeSubagents: {
              type: 'boolean',
              description: 'list/export only: include subagent transcript sessions (default false).',
            },
            includeWorkspaceFiles: {
              type: 'boolean',
              description: 'export only: also pack the selected sessions\' workspace file tree (sensitive files and build caches are excluded).',
            },
            workspaceExclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'export only: extra workspace path patterns/directories to exclude from the packed tree.',
            },
            restoreWorkspaceFiles: {
              type: 'boolean',
              description: 'import only: restore the archive\'s workspace files into the target directory (existing files are never overwritten).',
            },
            confirm: {
              type: 'boolean',
              description: 'delete only: must be true; deletion moves sessions into the trash directory instead of erasing them.',
            },
            stopActivity: {
              type: 'boolean',
              description: 'archive only: stop running activity before archiving (a live session is refused otherwise).',
            },
            path: {
              type: 'string',
              description: 'import only: absolute archive path, or a path relative to the current session directory.',
            },
            cwd: {
              type: 'string',
              description: 'import only: target working directory for the new sessions and any restored workspace files (defaults to the current session directory).',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const action = args !== null && typeof args === 'object' && typeof args.action === 'string'
            ? args.action
            : '';
          const helpers = await loadSessions(overrides);
          const includeSubagents = args.includeSubagents === true ? true : settings.includeSubagents;
          if (action === 'list') {
            const sessions = await helpers.listSessionEntries(ctx, { includeSubagents });
            const workspaces = typeof helpers.listWorkspaceEntries === 'function'
              ? await helpers.listWorkspaceEntries(ctx)
              : [];
            return listToolText(sessions, workspaces);
          }
          if (action === 'export') {
            const requested = args.sessionIds;
            const sessionIds = requested === 'all' || requested === undefined
              ? (await helpers.listSessionEntries(ctx, { includeSubagents })).map((entry) => entry.id)
              : Array.isArray(requested)
                ? requested.map((value) => String(value))
                : [];
            const mode = args.mode === 'full' || args.mode === 'compact' ? args.mode : settings.defaultMode;
            const exported = await buildArchive(ctx, {
              sessionIds,
              mode,
              includeAttachments: settings.includeAttachments,
              includeWorkspaceFiles: booleanFlag(args.includeWorkspaceFiles, settings.includeWorkspaceFiles),
              includeSubagents,
              workspaceExclude: stringList(args.workspaceExclude, settings.workspaceExclude),
              ...(settings.workspaceMaxBytes !== undefined ? { workspaceMaxBytes: settings.workspaceMaxBytes } : {}),
              maxExportBytes: settings.maxExportBytes,
            });
            const directory = defaultExportDirectory();
            await mkdir(directory, { recursive: true });
            const path = join(directory, exported.filename);
            await writeFile(path, exported.data);
            return exportToolText(path, exported);
          }
          if (action === 'import') {
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            if (path === '') {
              throw new Error('session_kit: import 需要 path 参数（会话归档路径）');
            }
            const targetCwd = await cwdOf(ctx, helpers, exec, args.cwd);
            const file = await readImportFile(path, { cwd: targetCwd, maxImportBytes: settings.maxImportBytes });
            const result = await importArchive(ctx, {
              buffer: file.buffer,
              cwd: targetCwd,
              restoreWorkspaceFiles: booleanFlag(args.restoreWorkspaceFiles, settings.restoreWorkspaceFiles),
              maxImportBytes: settings.maxImportBytes,
            });
            return importToolText(result);
          }
          if (action === 'archive' || action === 'unarchive' || action === 'delete') {
            return runManageTool(ctx, settings, overrides, helpers, action, args);
          }
          throw new Error('session_kit: action 必须是 "list"、"export"、"import"、"archive"、"unarchive" 或 "delete"');
        },
      }),
    'session-kit: agent tool',
  );
}

/**
 * Run one management tool action (parse -> batch -> summary text).
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} helpers - resolved sessions helper module.
 * @param {'archive'|'unarchive'|'delete'} action - management action.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runManageTool(ctx, settings, overrides, helpers, action, args) {
  if (action === 'delete' && args.confirm !== true) {
    throw new Error('session_kit: delete 需要 confirm:true（删除只会把会话移入回收站，不会永久删除）');
  }
  const allowAll = action === 'archive';
  let sessionIds = parseSessionIdList(args.sessionIds, { allowAll });
  if (sessionIds === undefined) {
    throw new Error(`session_kit: ${action} 需要 sessionIds 参数（会话 id 数组${allowAll ? '，或 "all"' : ''}）`);
  }
  if (sessionIds === 'all') {
    sessionIds = (await helpers.listSessionEntries(ctx)).map((entry) => entry.id);
    if (sessionIds.length === 0) throw new Error('session_kit: 没有可归档的会话');
    if (sessionIds.length > MAX_MANAGE_BATCH) {
      throw new Error(`session_kit: 一次最多处理 ${MAX_MANAGE_BATCH} 个会话（本次 ${sessionIds.length} 个）`);
    }
  }
  const outcome = await runManageBatch(ctx, settings, overrides, action, sessionIds, {
    stopActivity: args.stopActivity === true,
  });
  return manageToolText(action, outcome);
}

/**
 * The working directory a tool import should record: the explicit argument,
 * then the calling session's directory, then the deployment default.
 * @param {object} ctx - the plugin context.
 * @param {object} helpers - resolved sessions helper module.
 * @param {object | undefined} exec - tool execution context.
 * @param {unknown} requested - explicit `cwd` argument.
 * @returns {Promise<string | undefined>} a directory path, when one resolves.
 */
async function cwdOf(ctx, helpers, exec, requested) {
  if (typeof requested === 'string' && requested.trim() !== '') return requested.trim();
  const headerCwd = exec?.agent?.session?.header?.cwd;
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd;
  const fallback = helpers.servicesOf(ctx).workingDirectory?.defaultDirectory;
  if (typeof fallback === 'string' && fallback !== '') return fallback;
  return undefined;
}

/** Tool result text for the list action. */
function listToolText(sessions, workspaces) {
  const lines = [`工作区 ${workspaces.length} 个，会话 ${sessions.length} 个`];
  for (const workspace of workspaces) {
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : workspace.path;
    lines.push(`- [工作区] ${String(title ?? workspace.workspaceId)}（${workspace.sessionIds?.length ?? 0} 个会话）`);
  }
  const shown = sessions.slice(0, 80);
  for (const session of shown) {
    const parts = [`${session.id}`, session.title ?? '(无标题)'];
    if (typeof session.cwd === 'string' && session.cwd !== '') parts.push(session.cwd);
    if (typeof session.eventCount === 'number' && session.eventCount > 0) parts.push(`${session.eventCount} 事件`);
    if (session.running === true) parts.push('运行中');
    if (session.archived === true) parts.push('已归档');
    lines.push(`- ${parts.join(' | ')}`);
  }
  if (sessions.length > shown.length) lines.push(`…还有 ${sessions.length - shown.length} 个会话未列出`);
  return lines.join('\n');
}

/** Tool result text for the export action. */
function exportToolText(path, exported) {
  const parts = [`${exported.sessionCount} 个会话`, `${exported.eventCount} 条事件`, `${exported.attachmentCount} 个附件`];
  if ((exported.workspaceFileCount ?? 0) > 0) {
    parts.push(`${exported.workspaceFileCount} 个工作区文件（${exported.workspaceBytes} 字节）`);
  }
  const lines = [`已导出到 ${path}（${parts.join('，')}，模式 ${exported.manifest.mode}）`];
  for (const warning of exported.warnings ?? []) lines.push(`注意：${warning}`);
  return lines.join('\n');
}

/** Tool result text for the import action. */
function importToolText(result) {
  const lines = [`已导入 ${result.sessions.length} 个会话：`];
  for (const session of result.sessions) {
    const flags = [`${session.eventCount} 条事件`, `模式 ${session.mode}`];
    if (session.title !== undefined) flags.push(`标题 ${session.title}`);
    if (session.verified === false) flags.push('未能读回校验');
    lines.push(`- ${session.sessionId}（${flags.join('，')}）`);
    for (const warning of session.warnings ?? []) lines.push(`  注意：${warning}`);
  }
  if ((result.restoredFiles ?? 0) > 0 || (result.restoredBytes ?? 0) > 0) {
    lines.push(`恢复工作区文件 ${result.restoredFiles} 个（${result.restoredBytes} 字节），跳过 ${result.skipped ?? 0} 个`);
  }
  for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`);
  return lines.join('\n');
}

/** Human label for one management action. */
const MANAGE_LABELS = Object.freeze({ archive: '归档', unarchive: '恢复', delete: '删除（移入回收站）' });

/**
 * Tool result text for one management action.
 * @param {'archive'|'unarchive'|'delete'} action - management action.
 * @param {{results: Array<object>, trashedPath?: string, archivedSessionIds?: string[]}} outcome - batch outcome.
 * @returns {string} summary text.
 */
function manageToolText(action, outcome) {
  const label = MANAGE_LABELS[action] ?? action;
  const failed = outcome.results.filter((result) => !result.ok);
  const lines = [`${label}：成功 ${outcome.results.length - failed.length} 个${failed.length > 0 ? `，失败 ${failed.length} 个` : ''}`];
  for (const result of failed) lines.push(`- ${result.sessionId}：${result.error ?? '失败'}`);
  if (outcome.trashedPath !== undefined) lines.push(`已移入回收站：${outcome.trashedPath}`);
  return lines.join('\n');
}
