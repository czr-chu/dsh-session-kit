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
import { isAbsolute, join } from 'node:path';

import { errorText } from './lib/attachments.js';
import { buildArchive, defaultExportDirectory } from './lib/export.js';
import { SessionPortFormatError } from './lib/format.js';
import { importArchive, readImportFile } from './lib/import.js';

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-session-kit';

/** Services the plugin cannot work without. */
export const inject = ['tools', 'sessionQuery', 'sessionPersistence'];

/**
 * Standard-schema config validation for the Loader row. Unknown keys and
 * wrong types fail the plugin at startup instead of being silently defaulted;
 * defaults are applied by {@link resolveSettings}. The internal `modules` test
 * seam is deliberately absent, so YAML cannot inject modules.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-session-kit',
    /**
     * @param {unknown} value - raw row config.
     * @returns {{value: object} | {issues: Array<{message: string, path?: string[]}>}} validated config.
     */
    validate(value) {
      if (value === undefined || value === null) return { value: {} };
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'session-kit config must be an object' }] };
      }
      const issues = [];
      const known = new Set([
        'maxImportBytes',
        'maxExportBytes',
        'includeAttachments',
        'includeWorkspaceFiles',
        'includeSubagents',
        'restoreWorkspaceFiles',
        'workspaceExclude',
        'workspaceMaxBytes',
        'trashDir',
        'defaultMode',
      ]);
      for (const key of Object.keys(value)) {
        if (!known.has(key)) issues.push({ message: `unknown config key: ${key}`, path: [key] });
      }
      const positiveInteger = (key) => {
        const entry = value[key];
        if (entry === undefined) return;
        if (!Number.isSafeInteger(entry) || entry <= 0) {
          issues.push({ message: `${key} must be a positive safe integer`, path: [key] });
        }
      };
      const boolean = (key) => {
        const entry = value[key];
        if (entry !== undefined && typeof entry !== 'boolean') {
          issues.push({ message: `${key} must be a boolean`, path: [key] });
        }
      };
      positiveInteger('maxImportBytes');
      positiveInteger('maxExportBytes');
      positiveInteger('workspaceMaxBytes');
      boolean('includeAttachments');
      boolean('includeWorkspaceFiles');
      boolean('includeSubagents');
      boolean('restoreWorkspaceFiles');
      const exclude = value.workspaceExclude;
      if (exclude !== undefined && (!Array.isArray(exclude)
        || exclude.some((entry) => typeof entry !== 'string' || entry.trim() === ''))) {
        issues.push({ message: 'workspaceExclude must be an array of non-empty strings', path: ['workspaceExclude'] });
      }
      const trashDir = value.trashDir;
      if (trashDir !== undefined && (typeof trashDir !== 'string' || trashDir.trim() === '')) {
        issues.push({ message: 'trashDir must be a non-empty string', path: ['trashDir'] });
      }
      const mode = value.defaultMode;
      if (mode !== undefined && mode !== 'full' && mode !== 'compact') {
        issues.push({ message: 'defaultMode must be "full" or "compact"', path: ['defaultMode'] });
      }
      return issues.length === 0 ? { value } : { issues };
    },
  },
};

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/session-kit';
/** Cap on the JSON export/manage request body. */
const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** Upper bound on one archive/unarchive/delete batch. */
export const MAX_MANAGE_BATCH = 500;
/** Upper bound on one session-format migration batch. */
export const MAX_MIGRATE_BATCH = 100;
/** Upper bound on one related-files preview batch. */
export const MAX_FILE_BATCH = 100;
/** Upper bound on one session-detail batch. */
export const MAX_DETAIL_BATCH = 100;
/** Upper bound on one explicit selected-files list. */
export const MAX_SELECTED_FILES = 5000;
/** Upper bound on one share-link/input string. */
export const MAX_SHARE_INPUT_LENGTH = 2048;
/** Directory name under DSH_HOME that receives deleted session folders. */
const TRASH_DIR_NAME = 'session-kit-trash';

/** Cached helper modules; a failed import is retried on the next call. */
let sessionsModule;
let manageModule;
let migrateModule;
let filesModule;
let shareModule;

/**
 * Normalize the test-only module injection seam.
 *
 * A Loader YAML cannot express object values, so `modules` is inert in
 * production and exists so tests can drive the routes without a real
 * `lib/deepseek-share.js` / `lib/manage.js` / `lib/migrate.js` /
 * `lib/session-files.js` / `lib/sessions.js` (and so a composition can
 * substitute them). When present, a missing member means "that helper is
 * unavailable".
 * @param {unknown} config - raw Loader row config.
 * @returns {{sessions?: object, manage?: object, migrate?: object, files?: object, share?: object} | undefined} override set.
 */
function moduleOverrides(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const modules = raw.modules;
  if (modules === null || typeof modules !== 'object' || Array.isArray(modules)) return undefined;
  return {
    sessions: modules.sessions,
    manage: modules.manage,
    migrate: modules.migrate,
    files: modules.files,
    share: modules.share,
  };
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
 * Resolve the session-format migration module lazily (official DSH migration).
 * @param {{migrate?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} migration module namespace.
 */
async function loadMigrate(overrides) {
  if (overrides !== undefined) {
    if (overrides.migrate === undefined || overrides.migrate === null) {
      throw new SessionPortFormatError('unavailable', '会话迁移模块不可用');
    }
    return overrides.migrate;
  }
  if (migrateModule === undefined) {
    try {
      migrateModule = await import('./lib/migrate.js');
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话迁移模块不可用：${errorText(error)}`);
    }
  }
  return migrateModule;
}

/**
 * Resolve the related-files derivation module lazily (delete-with-files preview).
 * @param {{files?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} session-files module namespace.
 */
async function loadSessionFiles(overrides) {
  if (overrides !== undefined) {
    if (overrides.files === undefined || overrides.files === null) {
      throw new SessionPortFormatError('unavailable', '会话文件推导模块不可用');
    }
    return overrides.files;
  }
  if (filesModule === undefined) {
    try {
      filesModule = await import('./lib/session-files.js');
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话文件推导模块不可用：${errorText(error)}`);
    }
  }
  return filesModule;
}

/**
 * Resolve the DeepSeek share-import module lazily.
 * @param {{share?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} deepseek-share module namespace.
 */
async function loadShare(overrides) {
  if (overrides !== undefined) {
    if (overrides.share === undefined || overrides.share === null) {
      throw new SessionPortFormatError('unavailable', '分享导入模块不可用');
    }
    return overrides.share;
  }
  if (shareModule === undefined) {
    try {
      shareModule = await import('./lib/deepseek-share.js');
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `分享导入模块不可用：${errorText(error)}`);
    }
  }
  return shareModule;
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
          migrate: true,
          filePreview: true,
          deleteFiles: true,
          detail: true,
          deletePermanent: true,
          deleteSelectedFiles: true,
          shareImport: true,
          attachments: helpers.servicesOf(ctx).attachments !== undefined,
          tool: 'session_kit',
        },
        trash: {
          directory: trashDirectory(settings.trashDir),
          mode: 'move',
          batchLimit: MAX_MANAGE_BATCH,
        },
        migration: {
          official: true,
          batchLimit: MAX_MIGRATE_BATCH,
          note: '旧格式会话通过 DSH 官方迁移链升级（persistence.open(id, "write") 触发 prepare/publish），旧代日志保留，失败的会话保持原样',
        },
        files: {
          previewBatchLimit: MAX_FILE_BATCH,
          detailBatchLimit: MAX_DETAIL_BATCH,
          selectedFilesLimit: MAX_SELECTED_FILES,
          mode: 'move',
          experimental: true,
          permanent: true,
          note: '会话相关文件只能尽力推导（deliverables/工具参数/结果 meta/工作目录线索）：shell 重定向、PTC 脚本、仅文本提到的文件无法发现；共享文件可能被一并移走；删除前需要二次确认；默认只移入回收站，permanent:true 才会永久删除且不可恢复',
        },
        share: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          endpoint: 'https://chat.deepseek.com/api/v0/share/content',
          inputMaxLength: MAX_SHARE_INPUT_LENGTH,
          note: '仅接受 chat.deepseek.com/share/<id> 链接或裸分享 id；可选 workspaceId 指定目标工作区，否则使用 cwd 或部署默认目录',
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
    if (path === `${ROUTE_PREFIX}/migrate` && method === 'POST') {
      await handleMigrate(ctx, settings, overrides, req, res);
      return;
    }
    if (path === `${ROUTE_PREFIX}/session-files` && method === 'POST') {
      await handleSessionFiles(ctx, settings, overrides, req, res);
      return;
    }
    if (path === `${ROUTE_PREFIX}/session-detail` && method === 'POST') {
      await handleSessionDetail(ctx, settings, overrides, req, res);
      return;
    }
    if (path === `${ROUTE_PREFIX}/import-share` && method === 'POST') {
      await handleImportShare(ctx, settings, overrides, req, res);
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
 * @param {{allowAll?: boolean, maxBatch?: number}} [options] - whether `'all'` is meaningful and the batch cap.
 * @returns {string[] | 'all' | undefined} normalized list, `'all'`, or undefined when absent.
 * @throws {SessionPortFormatError} `invalid-sessionIds`, `too-many-sessions`.
 */
function parseSessionIdList(value, { allowAll = false, maxBatch = MAX_MANAGE_BATCH } = {}) {
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
  if (ids.length > maxBatch) {
    throw new SessionPortFormatError('too-many-sessions', `一次最多处理 ${maxBatch} 个会话（本次 ${ids.length} 个）`);
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
 * @param {{stopActivity?: boolean, removeFiles?: boolean, selectedFiles?: string[], permanent?: boolean}} [options] -
 *   archive-only activity stop plus delete-only related-file selection and permanent erase.
 * @returns {Promise<{results: Array<object>, archivedSessionIds?: string[], trashedPath?: string, permanent?: boolean,
 *   filesMoved?: number, filesRemoved?: number, filesSkipped?: number, filesBytes?: number,
 *   filesTrashPath?: string, fileWarnings?: string[]}>} batch outcome.
 * @throws {SessionPortFormatError} `unavailable` when the management module is absent.
 */
async function runManageBatch(
  ctx,
  settings,
  overrides,
  action,
  sessionIds,
  { stopActivity = false, removeFiles = false, selectedFiles, permanent = false } = {},
) {
  const manage = await loadManage(overrides);
  const results = [];
  let trashedPath;
  let filesMoved = 0;
  let filesRemoved = 0;
  let filesSkipped = 0;
  let filesBytes = 0;
  let filesTrashPath;
  const fileWarnings = [];
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
          {
            ...(settings.trashDir !== undefined ? { trashDir: settings.trashDir } : {}),
            ...(removeFiles ? { removeFiles: true } : {}),
            ...(removeFiles && Array.isArray(selectedFiles) ? { selectedFiles: [...selectedFiles] } : {}),
            ...(permanent ? { permanent: true } : {}),
          },
        );
        if (outcome !== null && typeof outcome === 'object') {
          if (typeof outcome.trashedPath === 'string' && outcome.trashedPath !== '') {
            trashedPath = outcome.trashedPath;
          }
          if (removeFiles) {
            const moved = Number.isSafeInteger(outcome.filesMoved) ? outcome.filesMoved : undefined;
            const removed = Number.isSafeInteger(outcome.filesRemoved) ? outcome.filesRemoved : undefined;
            const skipped = Number.isSafeInteger(outcome.filesSkipped) ? outcome.filesSkipped : 0;
            const bytes = Number.isSafeInteger(outcome.filesBytes) ? outcome.filesBytes : 0;
            if (moved !== undefined) filesMoved += moved;
            if (removed !== undefined) filesRemoved += removed;
            filesSkipped += skipped;
            filesBytes += bytes;
            if (typeof outcome.filesTrashPath === 'string' && outcome.filesTrashPath !== '') {
              filesTrashPath = outcome.filesTrashPath;
            }
            if (Array.isArray(outcome.fileWarnings)) {
              for (const warning of outcome.fileWarnings) fileWarnings.push(String(warning));
            }
            results.push({
              sessionId,
              ok: true,
              ...(permanent ? { permanent: true } : {}),
              files: {
                ...(moved !== undefined ? { moved } : permanent ? {} : { moved: 0 }),
                ...(removed !== undefined ? { removed } : permanent ? { removed: 0 } : {}),
                skipped,
                bytes,
                ...(typeof outcome.filesTrashPath === 'string' && outcome.filesTrashPath !== ''
                  ? { trashPath: outcome.filesTrashPath }
                  : {}),
                ...(Array.isArray(outcome.fileWarnings) && outcome.fileWarnings.length > 0
                  ? { warnings: outcome.fileWarnings.map(String) }
                  : {}),
              },
            });
            continue;
          }
        }
      }
      results.push({ sessionId, ok: true, ...(permanent ? { permanent: true } : {}) });
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
    ...(removeFiles
      ? {
          filesMoved,
          ...(filesRemoved > 0 || permanent ? { filesRemoved } : {}),
          filesSkipped,
          filesBytes,
          ...(filesTrashPath !== undefined ? { filesTrashPath } : {}),
          ...(fileWarnings.length > 0 ? { fileWarnings } : {}),
        }
      : {}),
    ...(permanent ? { permanent: true } : {}),
  };
}

/**
 * Parse one explicit selected-files list for a delete-with-files request.
 *
 * The list must contain absolute paths; duplicates collapse in request order
 * and the count is bounded by {@link MAX_SELECTED_FILES}. The management module
 * still intersects it with the freshly derived plan, so a stale or foreign path
 * is skipped with a warning instead of touching an unrelated file.
 * @param {unknown} value - raw `selectedFiles` value.
 * @returns {string[] | undefined} normalized paths, or undefined when absent.
 * @throws {SessionPortFormatError} `invalid-selection`, `too-many-files`.
 */
function parseSelectedFiles(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new SessionPortFormatError('invalid-selection', 'selectedFiles 必须是绝对路径数组');
  }
  const paths = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new SessionPortFormatError('invalid-selection', 'selectedFiles 的每一项都必须是非空字符串');
    }
    const path = entry.trim();
    if (!isAbsolute(path)) {
      throw new SessionPortFormatError('invalid-selection', `selectedFiles 必须是绝对路径：${path}`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  if (paths.length === 0) {
    throw new SessionPortFormatError('invalid-selection', 'selectedFiles 不能为空');
  }
  if (paths.length > MAX_SELECTED_FILES) {
    throw new SessionPortFormatError('too-many-files', `一次最多勾选 ${MAX_SELECTED_FILES} 个文件（本次 ${paths.length} 个）`);
  }
  return paths;
}

/**
 * `POST /session-kit/{archive,unarchive,delete}` — batch management action.
 *
 * Body: `{ sessionIds: string[], stopActivity?: boolean }` for archive/unarchive;
 * delete additionally accepts `removeFiles?: boolean`, `selectedFiles?: string[]`
 * and `permanent?: boolean`. `removeFiles:true` requires an explicit
 * `selectedFiles` list (`400 invalid-selection` otherwise) so no client can move
 * every derived file silently; `permanent:true` erases instead of trashing and
 * also requires `confirm:true`. A fully failed batch answers with the status of
 * its first failure code (404 not-found / 409 active / 500); a partial success
 * answers 200 with one result per id.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {'archive'|'unarchive'|'delete'} action - management action.
 */
async function handleManage(ctx, settings, overrides, req, res, action) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const sessionIds = parseSessionIdList(payload.sessionIds, { allowAll: false });
  if (sessionIds === undefined) {
    throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组）');
  }
  const isDelete = action === 'delete';
  const removeFiles = isDelete && payload.removeFiles === true;
  const permanent = isDelete && payload.permanent === true;
  const selectedFiles = isDelete ? parseSelectedFiles(payload.selectedFiles) : undefined;
  if (isDelete) {
    if (permanent && payload.confirm !== true) {
      throw new SessionPortFormatError(
        'confirm-required',
        '永久删除会把会话目录与勾选文件直接擦除（不可恢复），需要 confirm:true',
      );
    }
    if (removeFiles && payload.confirm !== true) {
      throw new SessionPortFormatError(
        'confirm-required',
        '同时处理会话相关文件需要 confirm:true（文件推导是尽力而为的，删除前请先预览）',
      );
    }
    if (removeFiles && selectedFiles === undefined) {
      throw new SessionPortFormatError(
        'invalid-selection',
        'removeFiles:true 需要 selectedFiles 显式文件列表（防止静默搬走全部推导文件）',
      );
    }
    if (!removeFiles && selectedFiles !== undefined) {
      throw new SessionPortFormatError(
        'invalid-selection',
        'selectedFiles 只能与 removeFiles:true 一起使用',
      );
    }
  }
  const outcome = await runManageBatch(ctx, settings, overrides, action, sessionIds, {
    stopActivity: payload.stopActivity === true,
    removeFiles,
    selectedFiles,
    permanent,
  });
  const failed = outcome.results.filter((result) => !result.ok);
  const status = failed.length > 0 && failed.length === outcome.results.length
    ? statusForManageCode(failed[0].code)
    : 200;
  sendJson(res, status, { ok: failed.length === 0, ...outcome });
}

/**
 * `POST /session-kit/session-files` — preview the workspace files a delete
 * would move alongside the selected sessions.
 *
 * Body: `{ sessionIds: string[] }` (explicit ids, trimmed/de-duplicated, capped
 * at {@link MAX_FILE_BATCH}). The derivation is best effort by design: it reads
 * the sessions (and their subagent descendants) and reports what it can prove,
 * marking weak evidence. Nothing is moved here; the client shows this plan and
 * asks for a second confirmation before calling `/delete` with `removeFiles`.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleSessionFiles(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const sessionIds = parseSessionIdList(payload.sessionIds, { allowAll: false, maxBatch: MAX_FILE_BATCH });
  if (sessionIds === undefined) {
    throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组）');
  }
  const files = await loadSessionFiles(overrides);
  if (typeof files.deriveSessionFilePlan !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话文件推导模块不可用');
  }
  let plan;
  try {
    plan = await files.deriveSessionFilePlan(ctx, sessionIds);
  } catch (error) {
    if (error instanceof SessionPortFormatError) throw error;
    throw new SessionPortFormatError('files-failed', `推导会话相关文件失败：${errorText(error)}`);
  }
  const filesList = Array.isArray(plan?.files) ? plan.files : [];
  const skipped = Array.isArray(plan?.skipped) ? plan.skipped : [];
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings.map((warning) => String(warning)) : [];
  const totalBytes = Number.isSafeInteger(plan?.totalBytes)
    ? plan.totalBytes
    : filesList.reduce((sum, entry) => sum + (Number.isSafeInteger(entry?.bytes) ? entry.bytes : 0), 0);
  sendJson(res, 200, { ok: true, files: filesList, skipped, warnings, totalBytes });
}

/**
 * Read one optional string field from a JSON body.
 * @param {unknown} value - raw value.
 * @param {string} field - field name for the diagnostic.
 * @param {{required?: boolean}} [options] - whether an absent/blank value is an error.
 * @returns {string | undefined} trimmed string, or undefined when optional and absent.
 * @throws {SessionPortFormatError} `invalid-body` for a wrong type or a missing required field.
 */
function optionalString(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new SessionPortFormatError('invalid-body', `请求缺少 ${field}（字符串）`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new SessionPortFormatError('invalid-body', `${field} 必须是字符串`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    if (required) throw new SessionPortFormatError('invalid-body', `${field} 不能为空`);
    return undefined;
  }
  return trimmed;
}

/**
 * Resolve where an imported share conversation should land.
 *
 * An explicit `workspaceId` wins and resolves the workspace path through the
 * registry (a missing/unknown workspace is `404 workspace-not-found`); otherwise
 * the request `cwd` wins, then the deployment's resolved target directory.
 * @param {object} ctx - the plugin context.
 * @param {object} helpers - resolved sessions helper module.
 * @param {string | undefined} workspaceId - requested workspace id.
 * @param {string | undefined} cwd - requested working directory.
 * @returns {Promise<{cwd?: string, workspaceId?: string, workspacePath?: string}>} resolved target.
 * @throws {SessionPortFormatError} `workspace-not-found`, `unavailable`.
 */
async function resolveShareTarget(ctx, helpers, workspaceId, cwd) {
  if (workspaceId !== undefined) {
    const registry = helpers.servicesOf(ctx).workspaceRegistry;
    if (registry === undefined || registry === null || typeof registry.get !== 'function') {
      throw new SessionPortFormatError('unavailable', '工作区服务不可用，无法按工作区导入');
    }
    let workspace;
    try {
      workspace = await registry.get(workspaceId);
    } catch (error) {
      throw new SessionPortFormatError('workspace-not-found', `读取工作区 ${workspaceId} 失败：${errorText(error)}`);
    }
    if (workspace === undefined || workspace === null
      || typeof workspace.path !== 'string' || workspace.path === '') {
      throw new SessionPortFormatError('workspace-not-found', `找不到工作区 ${workspaceId}`);
    }
    return { workspaceId, workspacePath: workspace.path, cwd: workspace.path };
  }
  if (cwd !== undefined) return { cwd };
  let target;
  try {
    target = await helpers.resolveTargetDirectory(ctx, {});
  } catch {
    target = undefined;
  }
  return target === undefined ? {} : { cwd: target };
}

/**
 * `POST /session-kit/import-share` — import one DeepSeek share conversation as
 * a NEW session.
 *
 * Body: `{ input: string, workspaceId?: string, cwd?: string, title?: string }`.
 * `input` accepts only `chat.deepseek.com/share/<id>` links or a bare share id
 * (arbitrary URL fetching is refused by the share module); `workspaceId`
 * chooses the target workspace and otherwise `cwd`/the deployment default is
 * used. Errors: 400 invalid-body/invalid-share, 404 workspace-not-found,
 * 502 share-fetch/share-api/timeout, 503 module unavailable,
 * 500 import-failed.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleImportShare(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const input = optionalString(payload.input, 'input', { required: true });
  if (input.length > MAX_SHARE_INPUT_LENGTH) {
    throw new SessionPortFormatError(
      'invalid-share',
      `分享链接/ID 过长（上限 ${MAX_SHARE_INPUT_LENGTH} 字符）`,
    );
  }
  const workspaceId = optionalString(payload.workspaceId, 'workspaceId');
  const cwd = optionalString(payload.cwd, 'cwd');
  const title = optionalString(payload.title, 'title');
  const share = await loadShare(overrides);
  if (typeof share.importShare !== 'function') {
    throw new SessionPortFormatError('unavailable', '分享导入模块不可用');
  }
  const helpers = await loadSessions(overrides);
  const target = await resolveShareTarget(ctx, helpers, workspaceId, cwd);
  let result;
  try {
    result = await share.importShare(ctx, {
      input,
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      ...(target.workspaceId !== undefined ? { workspaceId: target.workspaceId } : {}),
      ...(title !== undefined ? { title } : {}),
    });
  } catch (error) {
    if (error instanceof SessionPortFormatError) throw error;
    throw new SessionPortFormatError('import-failed', `导入分享会话失败：${errorText(error)}`);
  }
  if (result === undefined || result === null
    || typeof result.sessionId !== 'string' || result.sessionId === '') {
    throw new SessionPortFormatError('import-failed', '分享导入没有返回会话 id');
  }
  sendJson(res, 200, {
    ok: true,
    session: {
      sessionId: result.sessionId,
      ...(typeof result.title === 'string' ? { title: result.title } : {}),
      ...(Number.isSafeInteger(result.eventCount) ? { eventCount: result.eventCount } : {}),
    },
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
    ...(target.workspaceId !== undefined
      ? { workspace: { workspaceId: target.workspaceId, path: target.workspacePath } }
      : {}),
  });
}

/**
 * `POST /session-kit/session-detail` — storage detail (size) for the selected
 * sessions.
 *
 * Body: `{ sessionIds: string[] }` (explicit ids, trimmed/de-duplicated, capped
 * at {@link MAX_DETAIL_BATCH}). The list endpoint stays cheap; the panel asks
 * for detail only for rows the user actually selects. Per-id failures stay in
 * `sessions` (with `ok:false`); a fully failed batch maps its first code.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleSessionDetail(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const sessionIds = parseSessionIdList(payload.sessionIds, { allowAll: false, maxBatch: MAX_DETAIL_BATCH });
  if (sessionIds === undefined) {
    throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组）');
  }
  const helpers = await loadSessions(overrides);
  if (typeof helpers.sessionDetail !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话详情模块不可用');
  }
  const sessions = [];
  for (const sessionId of sessionIds) {
    try {
      const detail = await helpers.sessionDetail(ctx, sessionId);
      sessions.push({
        id: sessionId,
        ok: true,
        ...(Number.isSafeInteger(detail?.sizeBytes) ? { sizeBytes: detail.sizeBytes } : {}),
        ...(typeof detail?.formatStatus === 'string' ? { formatStatus: detail.formatStatus } : {}),
        legacy: detail?.legacy === true,
        archived: detail?.archived === true,
      });
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'detail-failed';
      sessions.push({ id: sessionId, ok: false, error: errorText(error), code });
    }
  }
  const failed = sessions.filter((entry) => entry.ok !== true);
  const status = failed.length > 0 && failed.length === sessions.length
    ? statusForManageCode(failed[0].code)
    : 200;
  sendJson(res, status, { ok: failed.length === 0, sessions });
}

/**
 * The ids a migration would still need to upgrade, when the list is readable.
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @returns {Promise<number | undefined>} remaining legacy count, or undefined.
 */
async function legacyRemainingOf(ctx, overrides) {
  try {
    const migrate = await loadMigrate(overrides);
    const ids = await migrate.listLegacySessionIds(ctx);
    return Array.isArray(ids) ? ids.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one DSH-official migration over a batch, one result per requested id.
 *
 * Each id goes through `lib/migrate.js` (which delegates to the official
 * `SessionPersistence.open(id, 'write')` prepare/publish path). The source
 * generation is never deleted; a refusal (live session, unreadable log) stays a
 * per-id failure. After the batch the legacy list is re-read for the remaining
 * count.
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {string[]} sessionIds - explicit ids (already expanded and capped).
 * @returns {Promise<{results: Array<object>, migratedCount: number, legacyRemaining?: number}>} batch outcome.
 * @throws {SessionPortFormatError} `unavailable` when the migration module is absent.
 */
async function runMigrateBatch(ctx, overrides, sessionIds) {
  const migrate = await loadMigrate(overrides);
  const results = [];
  let migratedCount = 0;
  for (const sessionId of sessionIds) {
    try {
      const outcome = await migrate.migrateSession(ctx, sessionId);
      const status = outcome !== null && typeof outcome === 'object' && typeof outcome.status === 'string'
        ? outcome.status
        : 'migrated';
      if (status === 'migrated') migratedCount += 1;
      results.push({ sessionId, ok: true, status });
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : undefined;
      results.push({
        sessionId,
        ok: false,
        status: 'failed',
        error: errorText(error),
        ...(code !== undefined ? { code } : {}),
      });
    }
  }
  const legacyRemaining = await legacyRemainingOf(ctx, overrides);
  return {
    results,
    migratedCount,
    ...(legacyRemaining !== undefined ? { legacyRemaining } : {}),
  };
}

/**
 * `POST /session-kit/migrate` — upgrade legacy session logs through DSH's own
 * migration chain.
 *
 * Body: `{ sessionIds: string[] | 'all', confirm?: true }`. Explicit ids are
 * trimmed, de-duplicated and capped at {@link MAX_MIGRATE_BATCH}; `'all'`
 * expands the legacy ids from `lib/migrate.js` and requires `confirm: true`
 * (`400 confirm-required` otherwise). With no legacy sessions `'all'` answers
 * 200 with empty results. Per-id failures stay in `results`; a fully failed
 * batch maps its first code to 404/409/500.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleMigrate(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  const requested = payload.sessionIds;
  let sessionIds;
  if (requested === 'all') {
    if (payload.confirm !== true) {
      throw new SessionPortFormatError(
        'confirm-required',
        '迁移全部旧格式会话需要 confirm:true（只执行 DSH 官方迁移，旧代日志保留）',
      );
    }
    const migrate = await loadMigrate(overrides);
    let legacy;
    try {
      legacy = await migrate.listLegacySessionIds(ctx);
    } catch (error) {
      throw new SessionPortFormatError('migration-failed', `读取旧格式会话失败：${errorText(error)}`);
    }
    const ids = Array.isArray(legacy) ? legacy.map((id) => String(id)) : [];
    if (ids.length > MAX_MIGRATE_BATCH) {
      throw new SessionPortFormatError(
        'too-many-sessions',
        `一次最多迁移 ${MAX_MIGRATE_BATCH} 个会话（当前旧格式 ${ids.length} 个）；请分批迁移`,
      );
    }
    sessionIds = ids;
  } else {
    const parsed = parseSessionIdList(requested, { allowAll: false, maxBatch: MAX_MIGRATE_BATCH });
    if (parsed === undefined) {
      throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组，或 "all"）');
    }
    sessionIds = parsed;
  }
  const outcome = await runMigrateBatch(ctx, overrides, sessionIds);
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
  if (code === 'not-found' || code === 'file-missing' || code === 'workspace-not-found') return 404;
  if (code === 'too-large') return 413;
  if (code === 'active') return 409;
  if (code === 'share-fetch' || code === 'share-api' || code === 'timeout') return 502;
  if (code === 'unsafe-location' || code === 'delete-failed' || code === 'migration-failed'
    || code === 'files-failed' || code === 'file-plan-failed' || code === 'detail-failed'
    || code === 'import-failed' || code === 'internal') return 500;
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
          'action=archive / action=unarchive toggle a session\'s archived state; action=delete moves sessions into <DSH_HOME>/session-kit-trash and requires confirm:true plus explicit session ids. The related-files handling is experimental: pass removeFiles:true together with an explicit selectedFiles list to move only those files; permanent:true erases the session directories and selected files irreversibly (also requires confirm:true).',
          'action=migrate upgrades legacy session logs through DSH\'s official migration chain; sessionIds are explicit ids, or "all" (which requires confirm:true). The old generation is kept and a failed session stays unchanged.',
          'action=files previews the workspace files a deletion would move for the selected sessions; the derivation is best effort (shell redirections, PTC scripts and files only mentioned in text cannot be discovered) and shared workspace files may be affected.',
          'action=delete with removeFiles:true requires selectedFiles (absolute paths from the files preview) and moves only those derived files; preview with action=files first and keep confirm:true. Without permanent:true nothing is erased.',
          'action=import_share imports a DeepSeek share conversation (chat.deepseek.com/share/<id> link or bare share id) as a NEW session; pass workspaceId to choose the target workspace, otherwise cwd or the deployment default directory is used.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'export', 'import', 'archive', 'unarchive', 'delete', 'migrate', 'files', 'import_share'],
              description: 'list: summarize sessions. export: save sessions as one ZIP. import: create new sessions from a ZIP or JSONL archive. archive/unarchive: toggle archived state. delete: move sessions to the trash directory. migrate: upgrade legacy session logs through DSH\'s official migration chain. files: preview the workspace files a deletion would move. import_share: import a DeepSeek share link as a new session.',
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
              description: 'export/archive: session ids, or "all" (archive only). unarchive/delete/files: explicit session ids ("all" is refused for safety). migrate: explicit ids, or "all" (requires confirm:true).',
            },
            input: {
              type: 'string',
              description: 'import_share only: a chat.deepseek.com/share/<id> link or a bare share id.',
            },
            workspaceId: {
              type: 'string',
              description: 'import_share only: target workspace id (resolved through the workspace registry); otherwise cwd or the deployment default directory is used.',
            },
            title: {
              type: 'string',
              description: 'import_share only: optional title override for the imported session.',
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
              description: 'delete: must be true (and a second confirmation is required for permanent:true). migrate with sessionIds="all": must be true.',
            },
            stopActivity: {
              type: 'boolean',
              description: 'archive only: stop running activity before archiving (a live session is refused otherwise).',
            },
            removeFiles: {
              type: 'boolean',
              description: 'delete only: also handle the derived session-related workspace files (experimental; requires selectedFiles; preview with action=files first).',
            },
            selectedFiles: {
              type: 'array',
              items: { type: 'string' },
              description: 'delete only: absolute paths from the files preview to move (or permanently delete) together with the sessions; required when removeFiles is true.',
            },
            permanent: {
              type: 'boolean',
              description: 'delete only: erase the session directories and selected files irreversibly instead of moving them to the trash directory; requires confirm:true.',
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
          if (action === 'migrate') {
            return runMigrateTool(ctx, overrides, args);
          }
          if (action === 'files') {
            return runFilesTool(ctx, overrides, args);
          }
          if (action === 'import_share') {
            return runImportShareTool(ctx, overrides, helpers, args);
          }
          throw new Error('session_kit: action 必须是 "list"、"export"、"import"、"archive"、"unarchive"、"delete"、"migrate"、"files" 或 "import_share"');
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
  const isDelete = action === 'delete';
  const removeFiles = isDelete && args.removeFiles === true;
  const permanent = isDelete && args.permanent === true;
  const selectedFiles = isDelete ? parseSelectedFiles(args.selectedFiles) : undefined;
  if (isDelete) {
    if (args.confirm !== true) {
      throw new Error(permanent
        ? 'session_kit: delete permanent:true 需要 confirm:true（永久删除不可恢复）'
        : 'session_kit: delete 需要 confirm:true（删除只会把会话移入回收站，不会永久删除）');
    }
    if (removeFiles && selectedFiles === undefined) {
      throw new Error('session_kit: delete removeFiles 需要 selectedFiles 显式文件列表（防止静默搬走全部推导文件）');
    }
    if (!removeFiles && selectedFiles !== undefined) {
      throw new Error('session_kit: selectedFiles 只能与 removeFiles:true 一起使用');
    }
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
    removeFiles,
    selectedFiles,
    permanent,
  });
  return manageToolText(action, outcome);
}

/**
 * Run the migrate tool action (parse -> confirm/expand -> batch -> summary).
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runMigrateTool(ctx, overrides, args) {
  let sessionIds = parseSessionIdList(args.sessionIds, { allowAll: true, maxBatch: MAX_MIGRATE_BATCH });
  if (sessionIds === undefined) {
    throw new Error('session_kit: migrate 需要 sessionIds 参数（会话 id 数组，或 "all"）');
  }
  if (sessionIds === 'all') {
    if (args.confirm !== true) {
      throw new Error('session_kit: migrate "all" 需要 confirm:true（只执行 DSH 官方迁移，旧代日志保留）');
    }
    const migrate = await loadMigrate(overrides);
    let legacy;
    try {
      legacy = await migrate.listLegacySessionIds(ctx);
    } catch (error) {
      throw new Error(`session_kit: 读取旧格式会话失败：${errorText(error)}`);
    }
    sessionIds = (Array.isArray(legacy) ? legacy : []).map((id) => String(id));
    if (sessionIds.length === 0) return '没有需要升级的旧格式会话';
    if (sessionIds.length > MAX_MIGRATE_BATCH) {
      throw new Error(`session_kit: 一次最多迁移 ${MAX_MIGRATE_BATCH} 个会话（当前旧格式 ${sessionIds.length} 个）`);
    }
  }
  const outcome = await runMigrateBatch(ctx, overrides, sessionIds);
  return migrateToolText(outcome);
}

/**
 * Tool result text for the migrate action.
 * @param {{results: Array<object>, migratedCount: number, legacyRemaining?: number}} outcome - batch outcome.
 * @returns {string} summary text.
 */
function migrateToolText(outcome) {
  const failed = outcome.results.filter((result) => !result.ok);
  const current = outcome.results.filter((result) => result.ok && result.status === 'current').length;
  const lines = [
    `升级格式：成功 ${outcome.results.length - failed.length} 个（实际迁移 ${outcome.migratedCount} 个${current > 0 ? `，已是当前格式 ${current} 个` : ''}），失败 ${failed.length} 个`,
  ];
  if (outcome.legacyRemaining !== undefined) lines.push(`剩余旧格式会话：${outcome.legacyRemaining} 个`);
  for (const result of failed) lines.push(`- ${result.sessionId}：${result.error ?? '失败'}`);
  return lines.join('\n');
}

/**
 * Run the files preview tool action (parse ids -> derive plan -> summary text).
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runFilesTool(ctx, overrides, args) {
  const sessionIds = parseSessionIdList(args.sessionIds, { allowAll: false, maxBatch: MAX_FILE_BATCH });
  if (sessionIds === undefined) {
    throw new Error('session_kit: files 需要 sessionIds 参数（会话 id 数组）');
  }
  const files = await loadSessionFiles(overrides);
  if (typeof files.deriveSessionFilePlan !== 'function') {
    throw new Error('session_kit: 会话文件推导模块不可用');
  }
  let plan;
  try {
    plan = await files.deriveSessionFilePlan(ctx, sessionIds);
  } catch (error) {
    throw new Error(`session_kit: 推导会话相关文件失败：${errorText(error)}`);
  }
  return filesToolText(plan);
}

/**
 * Tool result text for a related-files preview.
 * @param {{files?: Array<object>, skipped?: Array<object>, warnings?: string[], totalBytes?: number}} plan - derived plan.
 * @returns {string} summary text.
 */
function filesToolText(plan) {
  const files = Array.isArray(plan?.files) ? plan.files : [];
  const skipped = Array.isArray(plan?.skipped) ? plan.skipped : [];
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings.map((warning) => String(warning)) : [];
  const totalBytes = Number.isSafeInteger(plan?.totalBytes)
    ? plan.totalBytes
    : files.reduce((sum, entry) => sum + (Number.isSafeInteger(entry?.bytes) ? entry.bytes : 0), 0);
  const lines = [
    `会话相关文件：${files.length} 个（${totalBytes} 字节），跳过 ${skipped.length} 个`,
    '风险提示：推导是尽力而为的（shell 重定向、PTC 脚本、仅文本提到的文件无法发现）；工作区共享文件可能被一并移走；文件只会移入 <DSH_HOME>/session-kit-trash；删除前必须二次确认。',
  ];
  for (const entry of files.slice(0, 20)) {
    const relative = typeof entry?.relative === 'string' && entry.relative !== ''
      ? entry.relative
      : String(entry?.path ?? '');
    const size = Number.isSafeInteger(entry?.bytes) ? `${entry.bytes} 字节` : '大小未知';
    lines.push(`- ${relative}（${size}${entry?.weak === true ? '，弱证据' : ''}）`);
  }
  if (files.length > 20) lines.push(`…还有 ${files.length - 20} 个文件未列出`);
  for (const warning of warnings) lines.push(`注意：${warning}`);
  return lines.join('\n');
}

/**
 * Run the import_share tool action (resolve target -> share import -> summary).
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} helpers - resolved sessions helper module.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runImportShareTool(ctx, overrides, helpers, args) {
  const input = typeof args.input === 'string' ? args.input.trim() : '';
  if (input === '') {
    throw new Error('session_kit: import_share 需要 input 参数（DeepSeek 分享链接或分享 id）');
  }
  if (input.length > MAX_SHARE_INPUT_LENGTH) {
    throw new Error(`session_kit: 分享链接/ID 过长（上限 ${MAX_SHARE_INPUT_LENGTH} 字符）`);
  }
  const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId.trim() !== ''
    ? args.workspaceId.trim()
    : undefined;
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : undefined;
  const title = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : undefined;
  const share = await loadShare(overrides);
  if (typeof share.importShare !== 'function') {
    throw new Error('session_kit: 分享导入模块不可用');
  }
  const target = await resolveShareTarget(ctx, helpers, workspaceId, cwd);
  let result;
  try {
    result = await share.importShare(ctx, {
      input,
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      ...(target.workspaceId !== undefined ? { workspaceId: target.workspaceId } : {}),
      ...(title !== undefined ? { title } : {}),
    });
  } catch (error) {
    throw new Error(`session_kit: 导入分享会话失败：${errorText(error)}`);
  }
  return shareToolText(result, target);
}

/**
 * Tool result text for the import_share action.
 * @param {object} result - share import outcome ({sessionId, title, eventCount, warnings}).
 * @param {{workspaceId?: string, workspacePath?: string, cwd?: string}} target - resolved target.
 * @returns {string} summary text.
 */
function shareToolText(result, target) {
  const flags = [];
  if (typeof result?.title === 'string' && result.title !== '') flags.push(`标题 ${result.title}`);
  if (Number.isSafeInteger(result?.eventCount)) flags.push(`${result.eventCount} 条事件`);
  const lines = [
    `已导入分享会话：${String(result?.sessionId ?? '')}${flags.length > 0 ? `（${flags.join('，')}）` : ''}`,
  ];
  if (target.workspaceId !== undefined) lines.push(`工作区：${target.workspaceId}（${target.workspacePath}）`);
  else if (target.cwd !== undefined) lines.push(`目标目录：${target.cwd}`);
  for (const warning of Array.isArray(result?.warnings) ? result.warnings : []) {
    lines.push(`注意：${String(warning)}`);
  }
  return lines.join('\n');
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
  if (outcome.permanent === true) lines.push('已永久删除所选会话与文件（不可恢复）');
  if (outcome.trashedPath !== undefined) lines.push(`已移入回收站：${outcome.trashedPath}`);
  if (Number.isSafeInteger(outcome.filesRemoved)) {
    lines.push(`永久删除文件 ${outcome.filesRemoved} 个（${outcome.filesBytes ?? 0} 字节），跳过 ${outcome.filesSkipped ?? 0} 个`);
  } else if (Number.isSafeInteger(outcome.filesMoved)) {
    lines.push(`同时移走文件 ${outcome.filesMoved} 个（${outcome.filesBytes ?? 0} 字节），跳过 ${outcome.filesSkipped ?? 0} 个`);
    if (outcome.filesTrashPath !== undefined) lines.push(`文件回收站：${outcome.filesTrashPath}`);
  }
  for (const warning of outcome.fileWarnings ?? []) lines.push(`注意：${warning}`);
  return lines.join('\n');
}
