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
 *  - the authenticated browser routes the client half calls —
 *    GET /session-kit/{info,list} and
 *    POST /session-kit/{export,export-workspace,import,archive,unarchive,
 *    delete,migrate,session-files,session-detail,import-share,move,
 *    trash,trash-restore,trash-purge} — fenced by the
 *    Connection service exactly like every other plugin-owned route; a fenced
 *    rejection answers `{ok:false, code:'forbidden'|'unauthorized'}` like any
 *    other failure; and
 *  - one agent tool (`session_kit`) with list / export / export_workspace /
 *    import / archive / unarchive / delete / migrate / files / detail /
 *    trash_list / trash_restore / trash_purge / move / attachment_report /
 *    import_share actions.
 *
 * Both faces share one `parseSessionIdList` for scope parsing (`'all'` where
 * meaningful, trimming, de-duplication, batch caps) instead of each handler
 * re-implementing it.
 *
 * Export/import options carried over the routes and the tool:
 * `includeAttachments` (pack referenced attachments), `includeWorkspaceFiles`
 * (pack whole workspace trees), `includeSubagents` (keep subagent transcripts;
 * default false), `workspaceExclude` (extra workspace path patterns) and
 * `restoreWorkspaceFiles` (unpack the archive's workspaces/ tree into the
 * target directory).
 *
 * Management semantics: archive/unarchive go through the workspace registry;
 * delete only moves session directories into `<DSH_HOME>/session-kit-trash`
 * (never a permanent erase) and requires an explicit id list. Batches are
 * capped at {@link MAX_MANAGE_BATCH} sessions and report one result per id; a
 * fully failed batch answers with the first failure's status (404 / 409 / 503 /
 * 500).
 *
 * The plugin imports no DSH package: session-query, persistence, attachments,
 * workspaces, presets and the working directory are read off `ctx` through the
 * Cordis service registry, keeping the bundle dependency-free.
 *
 * @module dsh-session-kit
 */

import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { errorText } from './lib/attachments.js'
// `defaultExportDirectory` is a pure path helper (DSH_HOME + fixed subpath), so
// it stays a static import while the archive builder itself is resolved lazily
// through `loadExport`. Routing the helper through the injection seam would
// force every test double to reimplement a path rule that has no dependencies.
import { defaultExportDirectory } from './lib/export.js'
import { SessionPortFormatError } from './lib/format.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-session-kit'

/** Services the plugin cannot work without. */
export const inject = ['tools', 'sessionQuery', 'sessionPersistence']

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
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'session-kit config must be an object' }] }
      }
      const issues = []
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
      ])
      for (const key of Object.keys(value)) {
        if (!known.has(key)) issues.push({ message: `unknown config key: ${key}`, path: [key] })
      }
      const positiveInteger = (key) => {
        const entry = value[key]
        if (entry === undefined) return
        if (!Number.isSafeInteger(entry) || entry <= 0) {
          issues.push({ message: `${key} must be a positive safe integer`, path: [key] })
        }
      }
      const boolean = (key) => {
        const entry = value[key]
        if (entry !== undefined && typeof entry !== 'boolean') {
          issues.push({ message: `${key} must be a boolean`, path: [key] })
        }
      }
      positiveInteger('maxImportBytes')
      positiveInteger('maxExportBytes')
      positiveInteger('workspaceMaxBytes')
      boolean('includeAttachments')
      boolean('includeWorkspaceFiles')
      boolean('includeSubagents')
      boolean('restoreWorkspaceFiles')
      const exclude = value.workspaceExclude
      if (
        exclude !== undefined &&
        (!Array.isArray(exclude) || exclude.some((entry) => typeof entry !== 'string' || entry.trim() === ''))
      ) {
        issues.push({ message: 'workspaceExclude must be an array of non-empty strings', path: ['workspaceExclude'] })
      }
      const trashDir = value.trashDir
      if (trashDir !== undefined && (typeof trashDir !== 'string' || trashDir.trim() === '')) {
        issues.push({ message: 'trashDir must be a non-empty string', path: ['trashDir'] })
      }
      const mode = value.defaultMode
      if (mode !== undefined && !EXPORT_MODE_VALUES.has(mode)) {
        issues.push({ message: 'defaultMode must be "full", "compact" or "compressed"', path: ['defaultMode'] })
      }
      return issues.length === 0 ? { value } : { issues }
    },
  },
}

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/session-kit'
/** Cap on the JSON export/manage request body. */
const MAX_JSON_BODY_BYTES = 1024 * 1024
/** Upper bound on one archive/unarchive/delete batch. */
export const MAX_MANAGE_BATCH = 500
/** Upper bound on one session-format migration batch. */
export const MAX_MIGRATE_BATCH = 100
/** Upper bound on one related-files preview batch. */
export const MAX_FILE_BATCH = 100
/** Upper bound on one session-detail batch. */
export const MAX_DETAIL_BATCH = 100
/** Upper bound on one workspace-move batch (mirrors `lib/move.js`). */
export const MAX_MOVE_BATCH = 100
/** Upper bound on one multi-workspace backup batch (each workspace is one ZIP). */
export const MAX_WORKSPACE_BATCH = 20
/** Upper bound on one explicit selected-files list. */
export const MAX_SELECTED_FILES = 5000
/** Export modes every route and tool action accepts. */
const EXPORT_MODE_VALUES = new Set(['full', 'compact', 'compressed'])

/** Upper bound on one share-link/input string. */
export const MAX_SHARE_INPUT_LENGTH = 2048
/** Directory name under DSH_HOME that receives deleted session folders. */
const TRASH_DIR_NAME = 'session-kit-trash'

/** Cached helper modules; a failed import is retried on the next call. */
let sessionsModule
let manageModule
let migrateModule
let filesModule
let shareModule
let workspaceBackupModule
let exportModule
let importModule
let trashModule
let moveModule
let attachmentReportModule

/**
 * Normalize the in-process test-only module injection seam.
 *
 * This is **not** Loader row config: it is a separate third argument to
 * `apply` that only tests pass. Production Loader calls `apply(ctx, config)`,
 * so YAML cannot substitute helper modules. When present, a missing member
 * means "that helper is unavailable".
 *
 * Every helper `index.js` resolves itself is injectable: the six session
 * helpers plus `export` (archive builder) and `import` (archive reader).
 * Modules resolved inside another lib module stay outside this seam — notably
 * `lib/workspace-backup.js` imports `lib/export.js` directly, and
 * `lib/deepseek-share.js` imports `lib/import.js` directly.
 * @param {{modules?: unknown} | undefined} internals - test-only apply argument.
 * @returns {{
 *   sessions?: object,
 *   manage?: object,
 *   migrate?: object,
 *   files?: object,
 *   share?: object,
 *   workspaceBackup?: object,
 *   export?: object,
 *   import?: object,
 *   trash?: object,
 *   move?: object,
 *   attachmentReport?: object,
 * } | undefined} override set.
 */
function moduleOverrides(internals) {
  const raw = internals !== null && typeof internals === 'object' ? internals : {}
  const modules = raw.modules
  if (modules === null || typeof modules !== 'object' || Array.isArray(modules)) return undefined
  return {
    sessions: modules.sessions,
    manage: modules.manage,
    migrate: modules.migrate,
    files: modules.files,
    share: modules.share,
    workspaceBackup: modules.workspaceBackup,
    export: modules.export,
    import: modules.import,
    trash: modules.trash,
    move: modules.move,
    attachmentReport: modules.attachmentReport,
  }
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
      throw new SessionPortFormatError('unavailable', '会话服务模块不可用')
    }
    return overrides.sessions
  }
  if (sessionsModule === undefined) {
    try {
      sessionsModule = await import('./lib/sessions.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话服务模块不可用：${errorText(error)}`)
    }
  }
  return sessionsModule
}

/**
 * Resolve the management module lazily (archive/unarchive/delete helpers).
 * @param {{manage?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} management module namespace.
 */
async function loadManage(overrides) {
  if (overrides !== undefined) {
    if (overrides.manage === undefined || overrides.manage === null) {
      throw new SessionPortFormatError('unavailable', '会话管理模块不可用')
    }
    return overrides.manage
  }
  if (manageModule === undefined) {
    try {
      manageModule = await import('./lib/manage.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话管理模块不可用：${errorText(error)}`)
    }
  }
  return manageModule
}

/**
 * Resolve the session-format migration module lazily (official DSH migration).
 * @param {{migrate?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} migration module namespace.
 */
async function loadMigrate(overrides) {
  if (overrides !== undefined) {
    if (overrides.migrate === undefined || overrides.migrate === null) {
      throw new SessionPortFormatError('unavailable', '会话迁移模块不可用')
    }
    return overrides.migrate
  }
  if (migrateModule === undefined) {
    try {
      migrateModule = await import('./lib/migrate.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话迁移模块不可用：${errorText(error)}`)
    }
  }
  return migrateModule
}

/**
 * Resolve the related-files derivation module lazily (delete-with-files preview).
 * @param {{files?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} session-files module namespace.
 */
async function loadSessionFiles(overrides) {
  if (overrides !== undefined) {
    if (overrides.files === undefined || overrides.files === null) {
      throw new SessionPortFormatError('unavailable', '会话文件推导模块不可用')
    }
    return overrides.files
  }
  if (filesModule === undefined) {
    try {
      filesModule = await import('./lib/session-files.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话文件推导模块不可用：${errorText(error)}`)
    }
  }
  return filesModule
}

/**
 * Resolve the DeepSeek share-import module lazily.
 * @param {{share?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} deepseek-share module namespace.
 */
async function loadShare(overrides) {
  if (overrides !== undefined) {
    if (overrides.share === undefined || overrides.share === null) {
      throw new SessionPortFormatError('unavailable', '分享导入模块不可用')
    }
    return overrides.share
  }
  if (shareModule === undefined) {
    try {
      shareModule = await import('./lib/deepseek-share.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `分享导入模块不可用：${errorText(error)}`)
    }
  }
  return shareModule
}

/**
 * Resolve the workspace-level backup module lazily.
 * @param {{workspaceBackup?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} workspace-backup module namespace.
 */
async function loadWorkspaceBackup(overrides) {
  if (overrides !== undefined) {
    if (overrides.workspaceBackup === undefined || overrides.workspaceBackup === null) {
      throw new SessionPortFormatError('unavailable', '工作区备份模块不可用')
    }
    return overrides.workspaceBackup
  }
  if (workspaceBackupModule === undefined) {
    try {
      workspaceBackupModule = await import('./lib/workspace-backup.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `工作区备份模块不可用：${errorText(error)}`)
    }
  }
  return workspaceBackupModule
}

/**
 * Resolve the archive-builder module lazily (`lib/export.js`).
 *
 * `index.js` no longer imports it at module load, so a broken or substituted
 * export module fails only the routes/tool actions that build archives.
 * @param {{export?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} export module namespace.
 */
async function loadExport(overrides) {
  if (overrides !== undefined) {
    if (overrides.export === undefined || overrides.export === null) {
      throw new SessionPortFormatError('unavailable', '会话导出模块不可用')
    }
    return overrides.export
  }
  if (exportModule === undefined) {
    try {
      exportModule = await import('./lib/export.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话导出模块不可用：${errorText(error)}`)
    }
  }
  return exportModule
}

/**
 * Resolve the archive-reader module lazily (`lib/import.js`).
 * @param {{import?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} import module namespace.
 */
async function loadImport(overrides) {
  if (overrides !== undefined) {
    if (overrides.import === undefined || overrides.import === null) {
      throw new SessionPortFormatError('unavailable', '会话导入模块不可用')
    }
    return overrides.import
  }
  if (importModule === undefined) {
    try {
      importModule = await import('./lib/import.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话导入模块不可用：${errorText(error)}`)
    }
  }
  return importModule
}

/**
 * Resolve the trash-operations module lazily (`lib/trash.js`).
 * @param {{trash?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} trash module namespace.
 */
async function loadTrash(overrides) {
  if (overrides !== undefined) {
    if (overrides.trash === undefined || overrides.trash === null) {
      throw new SessionPortFormatError('unavailable', '回收站模块不可用')
    }
    return overrides.trash
  }
  if (trashModule === undefined) {
    try {
      trashModule = await import('./lib/trash.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `回收站模块不可用：${errorText(error)}`)
    }
  }
  return trashModule
}

/**
 * Resolve the workspace-move module lazily (`lib/move.js`).
 * @param {{move?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} move module namespace.
 */
async function loadMove(overrides) {
  if (overrides !== undefined) {
    if (overrides.move === undefined || overrides.move === null) {
      throw new SessionPortFormatError('unavailable', '会话迁移模块不可用')
    }
    return overrides.move
  }
  if (moveModule === undefined) {
    try {
      moveModule = await import('./lib/move.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `会话迁移模块不可用：${errorText(error)}`)
    }
  }
  return moveModule
}

/**
 * Cordis entry point.
 * @param {object} ctx - the plugin context.
 * @param {object} [config] - the Loader row's config (all fields optional).
 * @param {{modules?: unknown}} [internals] - test-only module overrides; never
 *   read from Loader config or YAML.
 */
export function apply(ctx, config, internals) {
  const settings = resolveSettings(config)
  const overrides = moduleOverrides(internals)
  registerRoutes(ctx, settings, overrides)
  registerTool(ctx, settings, overrides)
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
 *   defaultMode: 'full'|'compact'|'compressed',
 * }} resolved settings.
 */
function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    maxImportBytes:
      Number.isSafeInteger(raw.maxImportBytes) && raw.maxImportBytes > 0 ? raw.maxImportBytes : 512 * 1024 * 1024,
    maxExportBytes:
      Number.isSafeInteger(raw.maxExportBytes) && raw.maxExportBytes > 0 ? raw.maxExportBytes : 1024 * 1024 * 1024,
    includeAttachments: raw.includeAttachments !== false,
    includeWorkspaceFiles: raw.includeWorkspaceFiles === true,
    includeSubagents: raw.includeSubagents === true,
    restoreWorkspaceFiles: raw.restoreWorkspaceFiles === true,
    workspaceExclude: Array.isArray(raw.workspaceExclude)
      ? raw.workspaceExclude
          .filter((value) => typeof value === 'string' && value.trim() !== '')
          .map((value) => value.trim())
      : [],
    workspaceMaxBytes:
      Number.isSafeInteger(raw.workspaceMaxBytes) && raw.workspaceMaxBytes > 0 ? raw.workspaceMaxBytes : undefined,
    trashDir: typeof raw.trashDir === 'string' && raw.trashDir.trim() !== '' ? raw.trashDir.trim() : undefined,
    defaultMode: EXPORT_MODE_VALUES.has(raw.defaultMode) ? raw.defaultMode : 'compact',
  }
}

/**
 * The directory deleted session folders are moved into.
 * @param {string | undefined} configured - `trashDir` config override.
 * @returns {string} absolute trash directory.
 */
function trashDirectory(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, TRASH_DIR_NAME)
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
    const webServer = webCtx.get('webServer')
    const connection = webCtx.get('connection')
    if (webServer === undefined || connection === undefined) return
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
                sendJson(res, 500, { ok: false, code: 'internal', message: errorText(error) })
              } catch {
                res.destroy()
              }
            })
          },
        }),
      'session-kit: browser routes',
    )
  })
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
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    // Answer the trust fence with the same JSON envelope as every other failure
    // so clients can branch on `code`; 401 means "not authenticated", any other
    // rejection status means "not allowed".
    const status = Number.isInteger(rejection) ? rejection : 403
    sendJson(res, status, {
      ok: false,
      code: status === 401 ? 'unauthorized' : 'forbidden',
      message: status === 401 ? '未认证：请求缺少有效的连接凭据' : '已拒绝：请求未通过插件的连接信任校验',
    })
    return
  }
  const url = new URL(String(req.url ?? '/'), 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'
  try {
    if (path === `${ROUTE_PREFIX}/info` && method === 'GET') {
      const helpers = await loadSessions(overrides)
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
          workspaceBackup: true,
          trash: true,
          move: true,
          attachmentReport: true,
          attachments: helpers.servicesOf(ctx).attachments !== undefined,
          tool: 'session_kit',
        },
        trash: {
          directory: trashDirectory(settings.trashDir),
          mode: 'move',
          batchLimit: MAX_MANAGE_BATCH,
        },
        move: {
          mode: 'copy-then-trash',
          batchLimit: MAX_MOVE_BATCH,
          note: '迁移会写入一个新 id 的会话（cwd=目标工作区）并读回验证，然后把源会话移入回收站；旧 id 失效，子代理转录不复制，源目录可从回收站恢复。',
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
        workspaceBackup: {
          mode: 'workspace',
          batchLimit: MAX_WORKSPACE_BATCH,
          note: '按工作区备份：一个工作区 = 该工作区全部主会话 + 整棵工作区文件树，只打包一次（敏感文件/构建缓存排除、符号链接不跟随）；可一次选择多个工作区，每个工作区各自生成一个 ZIP；普通 export 仍按选中的会话打包。',
          defaults: {
            mode: settings.defaultMode,
            includeAttachments: settings.includeAttachments,
            includeSubagents: settings.includeSubagents,
          },
        },
        defaults: {
          mode: settings.defaultMode,
          includeAttachments: settings.includeAttachments,
          includeWorkspaceFiles: settings.includeWorkspaceFiles,
          includeSubagents: settings.includeSubagents,
          restoreWorkspaceFiles: settings.restoreWorkspaceFiles,
          ...(settings.workspaceMaxBytes !== undefined ? { workspaceMaxBytes: settings.workspaceMaxBytes } : {}),
        },
      })
      return
    }
    if (path === `${ROUTE_PREFIX}/list` && method === 'GET') {
      const helpers = await loadSessions(overrides)
      const includeSubagents = url.searchParams.get('includeSubagents') === '1'
      const [sessions, workspaces] = await Promise.all([
        helpers.listSessionEntries(ctx, { includeSubagents }),
        typeof helpers.listWorkspaceEntries === 'function' ? helpers.listWorkspaceEntries(ctx) : Promise.resolve([]),
      ])
      sendJson(res, 200, { ok: true, sessions, workspaces })
      return
    }
    if (path === `${ROUTE_PREFIX}/attachment-report` && method === 'GET') {
      await handleAttachmentReport(ctx, overrides, url, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/export` && method === 'POST') {
      await handleExport(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/export-workspace` && method === 'POST') {
      await handleExportWorkspace(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/import` && method === 'POST') {
      await handleImport(ctx, settings, overrides, url, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/archive` && method === 'POST') {
      await handleManage(ctx, settings, overrides, req, res, 'archive')
      return
    }
    if (path === `${ROUTE_PREFIX}/unarchive` && method === 'POST') {
      await handleManage(ctx, settings, overrides, req, res, 'unarchive')
      return
    }
    if (path === `${ROUTE_PREFIX}/delete` && method === 'POST') {
      await handleManage(ctx, settings, overrides, req, res, 'delete')
      return
    }
    if (path === `${ROUTE_PREFIX}/migrate` && method === 'POST') {
      await handleMigrate(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/session-files` && method === 'POST') {
      await handleSessionFiles(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/session-detail` && method === 'POST') {
      await handleSessionDetail(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/import-share` && method === 'POST') {
      await handleImportShare(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/trash` && method === 'GET') {
      await handleTrashList(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/trash-restore` && method === 'POST') {
      await handleTrashRestore(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/trash-purge` && method === 'POST') {
      await handleTrashPurge(ctx, settings, overrides, req, res)
      return
    }
    if (path === `${ROUTE_PREFIX}/move` && method === 'POST') {
      await handleMove(ctx, settings, overrides, req, res)
      return
    }
    sendJson(res, 404, { ok: false, code: 'not-found', message: `没有这个接口：${method} ${path}` })
  } catch (error) {
    sendJson(res, statusOf(error), { ok: false, code: codeOf(error), message: errorText(error) })
  }
}

/**
 * Normalize one export-mode value against the accepted set.
 *
 * Unlike an id list, a wrong mode is not an error on the route side: every
 * caller falls back to the configured default, which keeps older clients
 * working when a new mode ships.
 * @param {unknown} value - raw mode from a body or tool argument.
 * @param {'full'|'compact'|'compressed'} fallback - configured default.
 * @returns {'full'|'compact'|'compressed'} resolved mode.
 */
function exportModeOf(value, fallback) {
  return typeof value === 'string' && EXPORT_MODE_VALUES.has(value) ? value : fallback
}

/**
 * Parse one session-id scope shared by every route and tool action.
 *
 * `'all'` is accepted only where the caller allows it (export and the archive
 * tool action). Arrays are trimmed, de-duplicated in order, and capped at
 * `maxBatch` (pass `Infinity` for export, which has no count cap). An empty
 * array is refused unless the caller opts in with `allowEmpty`, because a
 * destructive or expensive action must never run on an accidental empty list.
 * @param {unknown} value - raw `sessionIds` value.
 * @param {{allowAll?: boolean, maxBatch?: number, allowEmpty?: boolean}} [options] - scope policy.
 * @returns {string[] | 'all' | undefined} normalized list, `'all'`, or undefined when absent.
 * @throws {SessionPortFormatError} `invalid-sessionIds`, `too-many-sessions`.
 */
function parseSessionIdList(value, { allowAll = false, maxBatch = MAX_MANAGE_BATCH, allowEmpty = false } = {}) {
  if (value === undefined || value === null) return undefined
  if (value === 'all') {
    if (allowAll) return 'all'
    throw new SessionPortFormatError('invalid-sessionIds', '这里不允许 "all"，请显式给出会话 id')
  }
  if (!Array.isArray(value)) {
    throw new SessionPortFormatError(
      'invalid-sessionIds',
      allowAll ? 'sessionIds 必须是会话 id 数组或 "all"' : 'sessionIds 必须是会话 id 数组',
    )
  }
  const ids = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new SessionPortFormatError('invalid-sessionIds', 'sessionIds 的每一项都必须是非空字符串')
    }
    const id = entry.trim()
    if (!allowAll && id === 'all') {
      throw new SessionPortFormatError('invalid-sessionIds', '这里不允许 "all"，请显式给出会话 id')
    }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0 && !allowEmpty) {
    throw new SessionPortFormatError('invalid-sessionIds', 'sessionIds 不能为空')
  }
  if (ids.length > maxBatch) {
    throw new SessionPortFormatError('too-many-sessions', `一次最多处理 ${maxBatch} 个会话（本次 ${ids.length} 个）`)
  }
  return ids
}

/**
 * HTTP status for one failed manage result code.
 *
 * Batches report the status of their first failure when every id failed, so
 * this mapping must stay in step with {@link statusOf}; the two differ only
 * because batch results carry a `code` string instead of an `Error`.
 * @param {string | undefined} code - error code reported by `lib/manage.js`.
 * @returns {number} 404 not-found / 409 active / 503 unavailable / 500 otherwise.
 */
function statusForManageCode(code) {
  if (code === 'not-found') return 404
  if (code === 'active') return 409
  if (code === 'unavailable') return 503
  return 500
}

/**
 * The workspace registry's currently archived session ids, when it exposes them.
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @returns {Promise<string[] | undefined>} archived ids or undefined.
 */
async function archivedSessionIdsOf(ctx, overrides) {
  try {
    const helpers = await loadSessions(overrides)
    const registry = helpers.servicesOf(ctx)?.workspaceRegistry
    const ids = registry?.archivedSessionIds
    if (Array.isArray(ids)) return ids.map((id) => String(id))
    if (ids !== undefined && ids !== null && typeof ids === 'object' && typeof ids[Symbol.iterator] === 'function') {
      return [...ids].map((id) => String(id))
    }
    return undefined
  } catch {
    return undefined
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
  const manage = await loadManage(overrides)
  const results = []
  let trashedPath
  let filesMoved = 0
  let filesRemoved = 0
  let filesSkipped = 0
  let filesBytes = 0
  let filesTrashPath
  const fileWarnings = []
  for (const sessionId of sessionIds) {
    try {
      if (action === 'archive') {
        await manage.archiveSession(ctx, sessionId, { stopActivity })
      } else if (action === 'unarchive') {
        await manage.unarchiveSession(ctx, sessionId)
      } else {
        const outcome = await manage.deleteSession(ctx, sessionId, {
          ...(settings.trashDir !== undefined ? { trashDir: settings.trashDir } : {}),
          ...(removeFiles ? { removeFiles: true } : {}),
          ...(removeFiles && Array.isArray(selectedFiles) ? { selectedFiles: [...selectedFiles] } : {}),
          ...(permanent ? { permanent: true } : {}),
        })
        if (outcome !== null && typeof outcome === 'object') {
          if (typeof outcome.trashedPath === 'string' && outcome.trashedPath !== '') {
            trashedPath = outcome.trashedPath
          }
          if (removeFiles) {
            const moved = Number.isSafeInteger(outcome.filesMoved) ? outcome.filesMoved : undefined
            const removed = Number.isSafeInteger(outcome.filesRemoved) ? outcome.filesRemoved : undefined
            const skipped = Number.isSafeInteger(outcome.filesSkipped) ? outcome.filesSkipped : 0
            const bytes = Number.isSafeInteger(outcome.filesBytes) ? outcome.filesBytes : 0
            if (moved !== undefined) filesMoved += moved
            if (removed !== undefined) filesRemoved += removed
            filesSkipped += skipped
            filesBytes += bytes
            if (typeof outcome.filesTrashPath === 'string' && outcome.filesTrashPath !== '') {
              filesTrashPath = outcome.filesTrashPath
            }
            if (Array.isArray(outcome.fileWarnings)) {
              for (const warning of outcome.fileWarnings) fileWarnings.push(String(warning))
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
            })
            continue
          }
        }
      }
      results.push({ sessionId, ok: true, ...(permanent ? { permanent: true } : {}) })
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : undefined
      results.push({
        sessionId,
        ok: false,
        error: errorText(error),
        ...(code !== undefined ? { code } : {}),
      })
    }
  }
  const archivedSessionIds = await archivedSessionIdsOf(ctx, overrides)
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
  }
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
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new SessionPortFormatError('invalid-selection', 'selectedFiles 必须是绝对路径数组')
  }
  const paths = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new SessionPortFormatError('invalid-selection', 'selectedFiles 的每一项都必须是非空字符串')
    }
    const path = entry.trim()
    if (!isAbsolute(path)) {
      throw new SessionPortFormatError('invalid-selection', `selectedFiles 必须是绝对路径：${path}`)
    }
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  if (paths.length === 0) {
    throw new SessionPortFormatError('invalid-selection', 'selectedFiles 不能为空')
  }
  if (paths.length > MAX_SELECTED_FILES) {
    throw new SessionPortFormatError(
      'too-many-files',
      `一次最多勾选 ${MAX_SELECTED_FILES} 个文件（本次 ${paths.length} 个）`,
    )
  }
  return paths
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
 * its first failure code (404 not-found / 409 active / 503 unavailable / 500); a partial success
 * answers 200 with one result per id.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {'archive'|'unarchive'|'delete'} action - management action.
 */
async function handleManage(ctx, settings, overrides, req, res, action) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  const sessionIds = parseSessionIdList(payload.sessionIds, { allowAll: false })
  if (sessionIds === undefined) {
    throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组）')
  }
  const isDelete = action === 'delete'
  const removeFiles = isDelete && payload.removeFiles === true
  const permanent = isDelete && payload.permanent === true
  const selectedFiles = isDelete ? parseSelectedFiles(payload.selectedFiles) : undefined
  if (isDelete) {
    if (permanent && payload.confirm !== true) {
      throw new SessionPortFormatError(
        'confirm-required',
        '永久删除会把会话目录与勾选文件直接擦除（不可恢复），需要 confirm:true',
      )
    }
    if (removeFiles && payload.confirm !== true) {
      throw new SessionPortFormatError(
        'confirm-required',
        '同时处理会话相关文件需要 confirm:true（文件推导是尽力而为的，删除前请先预览）',
      )
    }
    if (removeFiles && selectedFiles === undefined) {
      throw new SessionPortFormatError(
        'invalid-selection',
        'removeFiles:true 需要 selectedFiles 显式文件列表（防止静默搬走全部推导文件）',
      )
    }
    if (!removeFiles && selectedFiles !== undefined) {
      throw new SessionPortFormatError('invalid-selection', 'selectedFiles 只能与 removeFiles:true 一起使用')
    }
  }
  const outcome = await runManageBatch(ctx, settings, overrides, action, sessionIds, {
    stopActivity: payload.stopActivity === true,
    removeFiles,
    selectedFiles,
    permanent,
  })
  const failed = outcome.results.filter((result) => !result.ok)
  const status =
    failed.length > 0 && failed.length === outcome.results.length ? statusForManageCode(failed[0].code) : 200
  sendJson(res, status, { ok: failed.length === 0, ...outcome })
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
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  const sessionIds = parseSessionIdList(payload.sessionIds, { allowAll: false, maxBatch: MAX_FILE_BATCH })
  if (sessionIds === undefined) {
    throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组）')
  }
  const files = await loadSessionFiles(overrides)
  if (typeof files.deriveSessionFilePlan !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话文件推导模块不可用')
  }
  let plan
  try {
    plan = await files.deriveSessionFilePlan(ctx, sessionIds)
  } catch (error) {
    if (error instanceof SessionPortFormatError) throw error
    throw new SessionPortFormatError('files-failed', `推导会话相关文件失败：${errorText(error)}`)
  }
  const filesList = Array.isArray(plan?.files) ? plan.files : []
  const skipped = Array.isArray(plan?.skipped) ? plan.skipped : []
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings.map((warning) => String(warning)) : []
  const totalBytes = Number.isSafeInteger(plan?.totalBytes)
    ? plan.totalBytes
    : filesList.reduce((sum, entry) => sum + (Number.isSafeInteger(entry?.bytes) ? entry.bytes : 0), 0)
  sendJson(res, 200, { ok: true, files: filesList, skipped, warnings, totalBytes })
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
    if (required) throw new SessionPortFormatError('invalid-body', `请求缺少 ${field}（字符串）`)
    return undefined
  }
  if (typeof value !== 'string') {
    throw new SessionPortFormatError('invalid-body', `${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    if (required) throw new SessionPortFormatError('invalid-body', `${field} 不能为空`)
    return undefined
  }
  return trimmed
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
    const registry = helpers.servicesOf(ctx).workspaceRegistry
    if (registry === undefined || registry === null || typeof registry.get !== 'function') {
      throw new SessionPortFormatError('unavailable', '工作区服务不可用，无法按工作区导入')
    }
    let workspace
    try {
      workspace = await registry.get(workspaceId)
    } catch (error) {
      throw new SessionPortFormatError('workspace-not-found', `读取工作区 ${workspaceId} 失败：${errorText(error)}`)
    }
    if (workspace === undefined || workspace === null || typeof workspace.path !== 'string' || workspace.path === '') {
      throw new SessionPortFormatError('workspace-not-found', `找不到工作区 ${workspaceId}`)
    }
    return { workspaceId, workspacePath: workspace.path, cwd: workspace.path }
  }
  if (cwd !== undefined) return { cwd }
  let target
  try {
    target = await helpers.resolveTargetDirectory(ctx, {})
  } catch {
    target = undefined
  }
  return target === undefined ? {} : { cwd: target }
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
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  const input = optionalString(payload.input, 'input', { required: true })
  if (input.length > MAX_SHARE_INPUT_LENGTH) {
    throw new SessionPortFormatError('invalid-share', `分享链接/ID 过长（上限 ${MAX_SHARE_INPUT_LENGTH} 字符）`)
  }
  const workspaceId = optionalString(payload.workspaceId, 'workspaceId')
  const cwd = optionalString(payload.cwd, 'cwd')
  const title = optionalString(payload.title, 'title')
  const share = await loadShare(overrides)
  if (typeof share.importShare !== 'function') {
    throw new SessionPortFormatError('unavailable', '分享导入模块不可用')
  }
  const helpers = await loadSessions(overrides)
  const target = await resolveShareTarget(ctx, helpers, workspaceId, cwd)
  let result
  try {
    result = await share.importShare(ctx, {
      input,
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      ...(target.workspaceId !== undefined ? { workspaceId: target.workspaceId } : {}),
      ...(title !== undefined ? { title } : {}),
    })
  } catch (error) {
    if (error instanceof SessionPortFormatError) throw error
    throw new SessionPortFormatError('import-failed', `导入分享会话失败：${errorText(error)}`)
  }
  if (result === undefined || result === null || typeof result.sessionId !== 'string' || result.sessionId === '') {
    throw new SessionPortFormatError('import-failed', '分享导入没有返回会话 id')
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
  })
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
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  const sessionIds = parseSessionIdList(payload.sessionIds, { allowAll: false, maxBatch: MAX_DETAIL_BATCH })
  if (sessionIds === undefined) {
    throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组）')
  }
  const helpers = await loadSessions(overrides)
  if (typeof helpers.sessionDetail !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话详情模块不可用')
  }
  const sessions = []
  for (const sessionId of sessionIds) {
    try {
      const detail = await helpers.sessionDetail(ctx, sessionId)
      sessions.push({
        id: sessionId,
        ok: true,
        ...(Number.isSafeInteger(detail?.sizeBytes) ? { sizeBytes: detail.sizeBytes } : {}),
        ...(typeof detail?.formatStatus === 'string' ? { formatStatus: detail.formatStatus } : {}),
        legacy: detail?.legacy === true,
        archived: detail?.archived === true,
      })
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'detail-failed'
      sessions.push({ id: sessionId, ok: false, error: errorText(error), code })
    }
  }
  const failed = sessions.filter((entry) => entry.ok !== true)
  const status = failed.length > 0 && failed.length === sessions.length ? statusForManageCode(failed[0].code) : 200
  sendJson(res, status, { ok: failed.length === 0, sessions })
}

/**
 * The ids a migration would still need to upgrade, when the list is readable.
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @returns {Promise<number | undefined>} remaining legacy count, or undefined.
 */
async function legacyRemainingOf(ctx, overrides) {
  try {
    const migrate = await loadMigrate(overrides)
    const ids = await migrate.listLegacySessionIds(ctx)
    return Array.isArray(ids) ? ids.length : undefined
  } catch {
    return undefined
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
  const migrate = await loadMigrate(overrides)
  const results = []
  let migratedCount = 0
  for (const sessionId of sessionIds) {
    try {
      const outcome = await migrate.migrateSession(ctx, sessionId)
      const status =
        outcome !== null && typeof outcome === 'object' && typeof outcome.status === 'string'
          ? outcome.status
          : 'migrated'
      if (status === 'migrated') migratedCount += 1
      results.push({ sessionId, ok: true, status })
    } catch (error) {
      const code = typeof error?.code === 'string' && error.code !== '' ? error.code : undefined
      results.push({
        sessionId,
        ok: false,
        status: 'failed',
        error: errorText(error),
        ...(code !== undefined ? { code } : {}),
      })
    }
  }
  const legacyRemaining = await legacyRemainingOf(ctx, overrides)
  return {
    results,
    migratedCount,
    ...(legacyRemaining !== undefined ? { legacyRemaining } : {}),
  }
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
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  const requested = payload.sessionIds
  let sessionIds
  if (requested === 'all') {
    if (payload.confirm !== true) {
      throw new SessionPortFormatError(
        'confirm-required',
        '迁移全部旧格式会话需要 confirm:true（只执行 DSH 官方迁移，旧代日志保留）',
      )
    }
    const migrate = await loadMigrate(overrides)
    let legacy
    try {
      legacy = await migrate.listLegacySessionIds(ctx)
    } catch (error) {
      throw new SessionPortFormatError('migration-failed', `读取旧格式会话失败：${errorText(error)}`)
    }
    const ids = Array.isArray(legacy) ? legacy.map((id) => String(id)) : []
    if (ids.length > MAX_MIGRATE_BATCH) {
      throw new SessionPortFormatError(
        'too-many-sessions',
        `一次最多迁移 ${MAX_MIGRATE_BATCH} 个会话（当前旧格式 ${ids.length} 个）；请分批迁移`,
      )
    }
    sessionIds = ids
  } else {
    const parsed = parseSessionIdList(requested, { allowAll: false, maxBatch: MAX_MIGRATE_BATCH })
    if (parsed === undefined) {
      throw new SessionPortFormatError('invalid-sessionIds', '请求缺少 sessionIds（会话 id 数组，或 "all"）')
    }
    sessionIds = parsed
  }
  const outcome = await runMigrateBatch(ctx, overrides, sessionIds)
  const failed = outcome.results.filter((result) => !result.ok)
  const status =
    failed.length > 0 && failed.length === outcome.results.length ? statusForManageCode(failed[0].code) : 200
  sendJson(res, status, { ok: failed.length === 0, ...outcome })
}

/**
 * Normalize a request-supplied boolean flag.
 * @param {unknown} value - raw JSON value.
 * @param {boolean} fallback - deployment default.
 * @returns {boolean} resolved flag.
 */
function booleanFlag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize a request-supplied workspace exclusion list.
 * @param {unknown} value - raw JSON value.
 * @param {string[]} fallback - deployment default.
 * @returns {string[]} resolved patterns.
 */
function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
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
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  const includeSubagents = booleanFlag(payload.includeSubagents, settings.includeSubagents)
  // One parser for every surface: `'all'` is meaningful here, an empty array is
  // allowed through so `buildArchive` (not the parser) reports it, and export
  // keeps no session-count cap.
  const scope = parseSessionIdList(payload.sessionIds, {
    allowAll: true,
    allowEmpty: true,
    maxBatch: Number.POSITIVE_INFINITY,
  })
  if (scope === undefined) {
    throw new SessionPortFormatError('missing-sessions', '请求缺少 sessionIds（会话 id 数组，或 "all"）')
  }
  let sessionIds
  if (scope === 'all') {
    const helpers = await loadSessions(overrides)
    sessionIds = (await helpers.listSessionEntries(ctx, { includeSubagents })).map((entry) => entry.id)
  } else {
    sessionIds = scope
  }
  const mode = exportModeOf(payload.mode, settings.defaultMode)
  const exporter = await loadExport(overrides)
  const exported = await exporter.buildArchive(ctx, {
    sessionIds,
    mode,
    includeAttachments: booleanFlag(payload.includeAttachments, settings.includeAttachments),
    includeWorkspaceFiles: booleanFlag(payload.includeWorkspaceFiles, settings.includeWorkspaceFiles),
    includeSubagents,
    workspaceExclude: stringList(payload.workspaceExclude, settings.workspaceExclude),
    ...(settings.workspaceMaxBytes !== undefined ? { workspaceMaxBytes: settings.workspaceMaxBytes } : {}),
    maxExportBytes: settings.maxExportBytes,
  })
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
  })
  res.end(exported.data)
}

/**
 * `GET /session-kit/trash` — inventory of recoverable trash operations.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleTrashList(ctx, settings, overrides, req, res) {
  void req
  const trash = await loadTrash(overrides)
  const listed = await trash.listTrashOperations(ctx, trashOptions(settings))
  sendJson(res, 200, { ok: true, ...listed })
}

/**
 * `POST /session-kit/trash-restore` — move recorded session directories back.
 *
 * Body: `{ operationId: string, sessionIds?: string[] }`. A target that already
 * exists is skipped, never overwritten; a partial restore keeps the operation
 * for a later call.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleTrashRestore(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  const operationId = optionalString(payload.operationId, 'operationId', { required: true })
  const sessionIds = parseSessionIdList(payload.sessionIds, {
    allowAll: false,
    allowEmpty: true,
    maxBatch: MAX_DETAIL_BATCH,
  })
  const trash = await loadTrash(overrides)
  const restored = await trash.restoreTrashOperation(ctx, {
    ...trashOptions(settings),
    operationId,
    ...(sessionIds !== undefined && sessionIds !== 'all' && sessionIds.length > 0 ? { sessionIds } : {}),
  })
  sendJson(res, 200, { ok: true, ...restored })
}

/**
 * `POST /session-kit/trash-purge` — permanently erase trash operations.
 *
 * Body: `{ operationIds: string[] | "all", olderThanDays?: number,
 * confirm: true }`. Without `confirm:true` nothing is erased.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleTrashPurge(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  if (payload.confirm !== true) {
    throw new SessionPortFormatError('confirm-required', '清理回收站不可恢复，需要 confirm:true')
  }
  const operationIds = parseTrashOperationIds(payload.operationIds)
  const olderThanDays =
    payload.olderThanDays === undefined ? undefined : positiveIntegerValue(payload.olderThanDays, 'olderThanDays')
  const trash = await loadTrash(overrides)
  const purged = await trash.purgeTrashOperations(ctx, {
    ...trashOptions(settings),
    operationIds,
    confirm: true,
    ...(olderThanDays !== undefined ? { olderThanDays } : {}),
  })
  sendJson(res, 200, { ok: true, ...purged })
}

/**
 * `POST /session-kit/move` — move sessions into a destination workspace.
 *
 * A move is copy-then-trash: a NEW session (new id, `cwd` = target workspace
 * path) is written and read back first, then the source is moved into the
 * trash directory, so a failed copy never loses the conversation. Each session
 * is preflighted individually; unsafe sources appear in `skipped`.
 * Body: `{ workspaceId: string, sessionIds: string[], confirm: true }`.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleMove(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  if (payload.confirm !== true) {
    throw new SessionPortFormatError(
      'confirm-required',
      '迁移会把源会话移入回收站（可恢复），需要 confirm:true；活动会话、子代理转录和旧格式会话会被跳过',
    )
  }
  const workspaceId = optionalString(payload.workspaceId, 'workspaceId', { required: true })
  const sessionIds = parseSessionIdList(payload.sessionIds, { allowAll: false, maxBatch: MAX_MOVE_BATCH })
  if (sessionIds === undefined) {
    throw new SessionPortFormatError('invalid-argument', 'move 需要 sessionIds 数组（要迁移的会话 id）')
  }
  const move = await loadMove(overrides)
  const moved = await move.moveSessions(ctx, {
    workspaceId,
    sessionIds,
    ...trashOptions(settings),
  })
  sendJson(res, 200, { ok: true, ...moved })
}

/**
 * Trash operations take the configured directory, which may be undefined.
 * @param {object} settings - resolved settings.
 * @returns {{trashDir?: string}} options fragment.
 */
function trashOptions(settings) {
  return settings.trashDir !== undefined ? { trashDir: settings.trashDir } : {}
}

/**
 * Normalize a purge scope: an explicit directory-name list, or `"all"`.
 * @param {unknown} value - raw body value.
 * @returns {string[] | 'all'} scope.
 * @throws {SessionPortFormatError} `invalid-argument` for anything else.
 */
function parseTrashOperationIds(value) {
  if (value === 'all') return 'all'
  if (!Array.isArray(value) || value.length === 0) {
    throw new SessionPortFormatError('invalid-argument', 'operationIds 必须是回收站目录名数组或 "all"')
  }
  const ids = value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new SessionPortFormatError('invalid-argument', 'operationIds 的每一项必须是非空字符串')
    }
    return entry.trim()
  })
  if (ids.length > MAX_MANAGE_BATCH) {
    throw new SessionPortFormatError('too-many-sessions', `一次最多清理 ${MAX_MANAGE_BATCH} 个回收站操作`)
  }
  return ids
}

/**
 * Validate one positive integer body value.
 * @param {unknown} value - raw value.
 * @param {string} field - field name for the error message.
 * @returns {number} the value.
 * @throws {SessionPortFormatError} `invalid-argument` when it is not a positive safe integer.
 */
function positiveIntegerValue(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SessionPortFormatError('invalid-argument', `${field} 必须是正整数`)
  }
  return value
}

/**
 * Never let a backup filename escape the plugin export directory or name a
 * directory entry; a module-provided name is only trusted when it is one plain
 * file name.
 * @param {unknown} filename - module-provided file name.
 * @returns {string} one safe file name.
 */
function safeBackupFilename(filename) {
  const value = typeof filename === 'string' ? filename.trim() : ''
  if (value === '' || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    return 'workspace-backup.zip'
  }
  return value
}

/**
 * `POST /session-kit/export-workspace` — back up one workspace as ONE ZIP.
 *
 * Body: `{ workspaceId: string, mode?: 'full'|'compact', includeAttachments?,
 * includeSubagents?, workspaceExclude? }`. The backup contains every main
 * session of that workspace plus the whole workspace file tree, packed once
 * (sensitive files/build caches excluded, symlinks skipped). Session-scoped
 * `/export` keeps its existing behavior.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleExportWorkspace(ctx, settings, overrides, req, res) {
  const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES)
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : ''
  if (workspaceId === '') {
    throw new SessionPortFormatError('invalid-argument', '请求缺少 workspaceId（工作区 id）')
  }
  if (payload.mode !== undefined && !EXPORT_MODE_VALUES.has(payload.mode)) {
    throw new SessionPortFormatError('invalid-argument', 'mode 必须是 "full"、"compact" 或 "compressed"')
  }
  const backup = await loadWorkspaceBackup(overrides)
  if (typeof backup.buildWorkspaceBackup !== 'function') {
    throw new SessionPortFormatError('unavailable', '工作区备份模块不可用')
  }
  let result
  try {
    result = await backup.buildWorkspaceBackup(ctx, {
      workspaceId,
      mode: exportModeOf(payload.mode, settings.defaultMode),
      includeAttachments: booleanFlag(payload.includeAttachments, settings.includeAttachments),
      includeSubagents: booleanFlag(payload.includeSubagents, settings.includeSubagents),
      workspaceExclude: stringList(payload.workspaceExclude, settings.workspaceExclude),
      ...(settings.workspaceMaxBytes !== undefined ? { workspaceMaxBytes: settings.workspaceMaxBytes } : {}),
      maxExportBytes: settings.maxExportBytes,
    })
  } catch (error) {
    if (error instanceof SessionPortFormatError) throw error
    throw new SessionPortFormatError('workspace-backup-failed', `工作区备份失败：${errorText(error)}`)
  }
  const data = result?.data
  if (!(data instanceof Uint8Array) || typeof result?.filename !== 'string') {
    throw new SessionPortFormatError('workspace-backup-failed', '工作区备份模块没有返回 ZIP 数据或文件名')
  }
  const workspace = result.workspace !== null && typeof result.workspace === 'object' ? result.workspace : {}
  const title = typeof workspace.title === 'string' ? workspace.title : ''
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': String(data.length),
    'content-disposition': 'attachment; filename="workspace-backup.zip"',
    'cache-control': 'no-store',
    'x-session-kit-filename': encodeURIComponent(safeBackupFilename(result.filename)),
    'x-session-kit-warnings': encodeURIComponent(JSON.stringify(result.warnings ?? [])),
    'x-session-kit-sessions': String(result.sessionCount ?? 0),
    'x-session-kit-workspace-files': String(result.workspaceFileCount ?? 0),
    'x-session-kit-workspace': encodeURIComponent(workspaceId),
    'x-session-kit-workspace-title': encodeURIComponent(title),
  })
  res.end(Buffer.from(data))
}

/**
 * Resolve the read-only attachment report module lazily.
 * @param {{attachmentReport?: object} | undefined} overrides - module injection seam.
 * @returns {Promise<object>} report module namespace.
 */
async function loadAttachmentReport(overrides) {
  if (overrides !== undefined) {
    if (overrides.attachmentReport === undefined || overrides.attachmentReport === null) {
      throw new SessionPortFormatError('unavailable', '附件报告模块不可用')
    }
    return overrides.attachmentReport
  }
  if (attachmentReportModule === undefined) {
    try {
      attachmentReportModule = await import('./lib/attachment-report.js')
    } catch (error) {
      throw new SessionPortFormatError('unavailable', `附件报告模块不可用：${errorText(error)}`)
    }
  }
  return attachmentReportModule
}

/**
 * `GET /session-kit/attachment-report` — read-only dangling-reference scan.
 * Query: `limit` (1..300, default 300), `includeSubagents=1`.
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {URL} url - parsed request URL.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handleAttachmentReport(ctx, overrides, url, res) {
  const report = await loadAttachmentReport(overrides)
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null || rawLimit === '' ? undefined : positiveIntegerValue(Number(rawLimit), 'limit')
  const includeSubagents = url.searchParams.get('includeSubagents') === '1'
  const result = await report.reportAttachmentReferences(ctx, {
    ...(limit !== undefined ? { limit } : {}),
    includeSubagents,
  })
  sendJson(res, 200, { ok: true, ...result })
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
async function handleImport(ctx, settings, overrides, url, req, res) {
  const buffer = await readRequestBody(req, settings.maxImportBytes)
  const rawRestore = url.searchParams.get('restoreWorkspaceFiles')
  const restoreWorkspaceFiles =
    rawRestore === null || rawRestore === ''
      ? settings.restoreWorkspaceFiles
      : rawRestore === '1' || rawRestore.toLowerCase() === 'true'
  const rawSkip = url.searchParams.get('skipDuplicates')
  const skipDuplicates = rawSkip === '1' || rawSkip?.toLowerCase() === 'true'
  const streamProgress = url.searchParams.get('progress') === 'ndjson'
  const importer = await loadImport(overrides)
  if (streamProgress) {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    const writeEvent = (event) => {
      res.write(`${JSON.stringify(event)}\n`)
    }
    try {
      const result = await importer.importArchive(ctx, {
        buffer,
        cwd: url.searchParams.get('cwd') ?? undefined,
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
        restoreWorkspaceFiles,
        skipDuplicates,
        maxImportBytes: settings.maxImportBytes,
        onProgress: (entry) => writeEvent({ event: 'session', ...entry }),
      })
      writeEvent({ event: 'done', ok: true, ...result })
    } catch (error) {
      writeEvent({
        event: 'error',
        ok: false,
        code: error instanceof SessionPortFormatError ? error.code : 'import-failed',
        message: errorText(error),
      })
    }
    res.end()
    return
  }
  const result = await importer.importArchive(ctx, {
    buffer,
    cwd: url.searchParams.get('cwd') ?? undefined,
    workspaceId: url.searchParams.get('workspaceId') ?? undefined,
    restoreWorkspaceFiles,
    skipDuplicates,
    maxImportBytes: settings.maxImportBytes,
  })
  sendJson(res, 200, { ok: true, ...result })
}

/**
 * Read a bounded request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} cap - maximum accepted byte count.
 * @returns {Promise<Buffer>} the complete body.
 */
async function readRequestBody(req, cap) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) {
      throw new SessionPortFormatError('too-large', `请求体超过大小上限（${Math.round(cap / 1024 / 1024)} MiB）`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Read and parse a bounded JSON request body; an empty body is `{}`.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} cap - maximum accepted byte count.
 * @returns {Promise<object>} parsed JSON object.
 */
async function readJsonBody(req, cap) {
  const buffer = await readRequestBody(req, cap)
  if (buffer.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw new SessionPortFormatError('invalid-json', `请求体不是合法 JSON：${errorText(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionPortFormatError('invalid-json', '请求体必须是 JSON 对象')
  }
  return parsed
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** HTTP status for one failure code. */
function statusOf(error) {
  const code = codeOf(error)
  if (code === 'unavailable') return 503
  if (code === 'not-found' || code === 'file-missing' || code === 'workspace-not-found') return 404
  if (code === 'too-large') return 413
  if (code === 'active') return 409
  if (code === 'trash-manifest-missing') return 409
  if (code === 'share-fetch' || code === 'share-api' || code === 'timeout') return 502
  if (
    code === 'unsafe-location' ||
    code === 'delete-failed' ||
    code === 'migration-failed' ||
    code === 'files-failed' ||
    code === 'file-plan-failed' ||
    code === 'trash-failed' ||
    code === 'read-failed' ||
    code === 'write-failed' ||
    code === 'verify-failed' ||
    code === 'move-failed' ||
    code === 'compact-failed' ||
    code === 'compress-failed' ||
    code === 'detail-failed' ||
    code === 'import-failed' ||
    code === 'workspace-backup-failed' ||
    code === 'internal'
  )
    return 500
  return 400
}

/** Stable failure code for one thrown value. */
function codeOf(error) {
  return error instanceof SessionPortFormatError ? error.code : 'internal'
}

/**
 * Register the model-facing tool. The tool performs exactly the operations the
 * browser half performs, through the same functions.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 */
function registerTool(ctx, settings, overrides) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') return
  ctx.effect(
    () =>
      tools.register({
        name: 'session_kit',
        description: [
          'Manage DSH conversations as session archives.',
          'action=list summarizes workspaces and sessions (archived rows are marked).',
          'action=export writes selected sessions (or all) as ONE ZIP under a plugin-owned folder and returns its path; mode=compact keeps only the conversational spine, mode=compressed keeps every event and tool call but truncates oversized string payloads and drops streamed deltas, mode=full keeps the complete session logs.',
          'Export can optionally pack whole workspace trees (includeWorkspaceFiles) while excluding VCS/build caches and secret files, and can include subagent transcripts (includeSubagents, default false).',
          "action=import creates NEW sessions from an archive produced by this plugin or by DSH's built-in session-log export; it never modifies or deletes an existing session, never imports subagent transcripts, and can restore the archive's workspace files into the target directory (restoreWorkspaceFiles). Archived/pinned flags in the archive are re-applied best-effort; pass skipDuplicates=true (or ?skipDuplicates=1) to skip source ids that already exist locally, and ?progress=ndjson to stream one JSON line per committed session.",
          "action=archive / action=unarchive toggle a session's archived state; action=delete moves sessions into <DSH_HOME>/session-kit-trash and requires confirm:true plus explicit session ids. The related-files handling is experimental: pass removeFiles:true together with an explicit selectedFiles list to move only those files; permanent:true erases the session directories and selected files irreversibly (also requires confirm:true).",
          'action=migrate upgrades legacy session logs through DSH\'s official migration chain; sessionIds are explicit ids, or "all" (which requires confirm:true). The old generation is kept and a failed session stays unchanged.',
          'action=files previews the workspace files a deletion would move for the selected sessions; the derivation is best effort (shell redirections, PTC scripts and files only mentioned in text cannot be discovered) and shared workspace files may be affected.',
          "action=detail reports each session's storage size, format status and archived state for up to 100 explicit ids; it reads through the same session service as the panel's detail view and writes nothing.",
          'action=trash_list inventories the trash directory (each delete writes an operation manifest); action=trash_restore moves the recorded session directories back to their original project directory, skips a target that already exists and re-registers workspace/archive/pin state, and action=trash_purge permanently erases selected operations (or "all") and requires confirm:true.',
          'action=move copies the selected sessions into a destination workspace as NEW sessions (new ids, header.cwd = target path), reads each copy back, then moves the SOURCE session directories into the trash directory; a source that is live, running, a subagent transcript or an older format is skipped before copying, and a copy that fails verification leaves its source untouched. A move is reversible by restoring the trash operation. It requires confirm:true and workspaceId.',
          'action=delete with removeFiles:true requires selectedFiles (absolute paths from the files preview) and moves only those derived files; preview with action=files first and keep confirm:true. Without permanent:true nothing is erased.',
          'action=import_share imports a DeepSeek share conversation (chat.deepseek.com/share/<id> link or bare share id) as a NEW session; pass workspaceId to choose the target workspace, otherwise cwd or the deployment default directory is used.',
          'action=export_workspace backs up one or more workspaces as separate ZIPs: every main session in each workspace plus its whole file tree (sensitive files/build caches excluded, symlinks not followed). Pass workspaceIds for a batch (max 20) or a single workspaceId; the session-scoped export action keeps its behavior.',
          'action=attachment_report scans up to 300 sessions read-only and reports attachment references whose host file no longer exists; it never deletes anything and returns missing and unverifiable reference counts.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'list',
                'export',
                'export_workspace',
                'import',
                'archive',
                'unarchive',
                'delete',
                'migrate',
                'files',
                'detail',
                'trash_list',
                'trash_restore',
                'trash_purge',
                'move',
                'attachment_report',
                'import_share',
              ],
              description:
                "list: summarize sessions. export: save selected sessions as one ZIP. export_workspace: back up one whole workspace (sessions + file tree) as one ZIP. import: create new sessions from a ZIP or JSONL archive. archive/unarchive: toggle archived state. delete: move sessions to the trash directory. migrate: upgrade legacy session logs through DSH's official migration chain. files: preview the workspace files a deletion would move. detail: report each session's storage size, format status and archived state (bounded by the same 100-id cap as the detail route). trash_list: inventory recoverable trash operations. trash_restore: move recorded session directories back (never overwrites). trash_purge: permanently erase trash operations (requires confirm:true). move: copy sessions into a destination workspace (new ids) then trash the sources (requires confirm:true and workspaceId). attachment_report: read-only scan of attachment references whose host files no longer resolve (limit defaults to 300 sessions; nothing is deleted). import_share: import a DeepSeek share link as a new session.",
            },
            mode: {
              type: 'string',
              enum: ['full', 'compact', 'compressed'],
              description:
                'export/export_workspace only: full keeps complete logs; compact keeps only the conversation (default from plugin config).',
            },
            sessionIds: {
              oneOf: [
                { type: 'array', items: { type: 'string' } },
                { type: 'string', enum: ['all'] },
              ],
              description:
                'export/archive: session ids, or "all" (archive only). unarchive/delete/files/detail/move: explicit session ids ("all" is refused for safety). migrate: explicit ids, or "all" (requires confirm:true).',
            },
            input: {
              type: 'string',
              description: 'import_share only: a chat.deepseek.com/share/<id> link or a bare share id.',
            },
            workspaceId: {
              type: 'string',
              description:
                'import_share: target workspace id (resolved through the workspace registry); otherwise cwd or the deployment default directory is used. export_workspace: one workspace to back up (required unless workspaceIds is given). move: the destination workspace (required).',
            },
            workspaceIds: {
              type: 'array',
              items: { type: 'string' },
              description:
                'export_workspace only: several workspace ids to back up as separate ZIPs (max 20, de-duplicated). Takes precedence over workspaceId. The HTTP route still produces one ZIP per request.',
            },
            title: {
              type: 'string',
              description: 'import_share only: optional title override for the imported session.',
            },
            includeSubagents: {
              type: 'boolean',
              description: 'list/export/export_workspace only: include subagent transcript sessions (default false).',
            },
            includeAttachments: {
              type: 'boolean',
              description:
                'export/export_workspace only: pack referenced attachment bytes (default from plugin config).',
            },
            includeWorkspaceFiles: {
              type: 'boolean',
              description:
                "export only: also pack the selected sessions' workspace file tree (sensitive files and build caches are excluded).",
            },
            workspaceExclude: {
              type: 'array',
              items: { type: 'string' },
              description:
                'export/export_workspace only: extra workspace path patterns/directories to exclude from the packed tree.',
            },
            restoreWorkspaceFiles: {
              type: 'boolean',
              description:
                "import only: restore the archive's workspace files into the target directory (existing files are never overwritten).",
            },
            skipDuplicates: {
              type: 'boolean',
              description:
                'import only: skip archive sessions whose source id already exists locally instead of importing another copy. Without it, duplicates are reported as warnings. The HTTP route also accepts ?skipDuplicates=1 and ?progress=ndjson.',
            },
            confirm: {
              type: 'boolean',
              description:
                'delete: must be true (and a second confirmation is required for permanent:true). migrate with sessionIds="all": must be true. move: must be true (the source sessions are moved into the trash directory).',
            },
            stopActivity: {
              type: 'boolean',
              description:
                'archive only: stop running activity before archiving (a live session is refused otherwise).',
            },
            removeFiles: {
              type: 'boolean',
              description:
                'delete only: also handle the derived session-related workspace files (experimental; requires selectedFiles; preview with action=files first).',
            },
            selectedFiles: {
              type: 'array',
              items: { type: 'string' },
              description:
                'delete only: absolute paths from the files preview to move (or permanently delete) together with the sessions; required when removeFiles is true.',
            },
            operationId: {
              type: 'string',
              description: 'trash_restore only: the trash operation directory name (from trash_list).',
            },
            operationIds: {
              oneOf: [
                { type: 'array', items: { type: 'string' } },
                { type: 'string', enum: ['all'] },
              ],
              description: 'trash_purge only: operation names, or "all". Requires confirm:true.',
            },
            olderThanDays: {
              type: 'integer',
              description: 'trash_purge only: with operationIds:"all", keep operations newer than this many days.',
            },
            limit: {
              type: 'integer',
              description: 'attachment_report only: how many sessions to scan (default and maximum 300, newest first).',
            },
            permanent: {
              type: 'boolean',
              description:
                'delete only: erase the session directories and selected files irreversibly instead of moving them to the trash directory; requires confirm:true.',
            },
            path: {
              type: 'string',
              description: 'import only: absolute archive path, or a path relative to the current session directory.',
            },
            cwd: {
              type: 'string',
              description:
                'import only: target working directory for the new sessions and any restored workspace files (defaults to the current session directory).',
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
          const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : ''
          const helpers = await loadSessions(overrides)
          const includeSubagents = args.includeSubagents === true ? true : settings.includeSubagents
          if (action === 'list') {
            const sessions = await helpers.listSessionEntries(ctx, { includeSubagents })
            const workspaces =
              typeof helpers.listWorkspaceEntries === 'function' ? await helpers.listWorkspaceEntries(ctx) : []
            return listToolText(sessions, workspaces)
          }
          if (action === 'export') {
            // An omitted sessionIds still means "all" for the tool (an agent call
            // without ids exports the whole list); anything explicit goes through
            // the same parser as every other surface and is never silently
            // coerced or de-duplicated differently.
            const scope = parseSessionIdList(args.sessionIds, {
              allowAll: true,
              allowEmpty: true,
              maxBatch: Number.POSITIVE_INFINITY,
            })
            const sessionIds =
              scope === undefined || scope === 'all'
                ? (await helpers.listSessionEntries(ctx, { includeSubagents })).map((entry) => entry.id)
                : scope
            const mode = exportModeOf(args.mode, settings.defaultMode)
            const exporter = await loadExport(overrides)
            const exported = await exporter.buildArchive(ctx, {
              sessionIds,
              mode,
              includeAttachments: booleanFlag(args.includeAttachments, settings.includeAttachments),
              includeWorkspaceFiles: booleanFlag(args.includeWorkspaceFiles, settings.includeWorkspaceFiles),
              includeSubagents,
              workspaceExclude: stringList(args.workspaceExclude, settings.workspaceExclude),
              ...(settings.workspaceMaxBytes !== undefined ? { workspaceMaxBytes: settings.workspaceMaxBytes } : {}),
              maxExportBytes: settings.maxExportBytes,
            })
            const directory = defaultExportDirectory()
            await mkdir(directory, { recursive: true })
            const path = join(directory, exported.filename)
            await writeFile(path, exported.data)
            return exportToolText(path, exported)
          }
          if (action === 'import') {
            const path = typeof args.path === 'string' ? args.path.trim() : ''
            if (path === '') {
              throw new Error('session_kit: import 需要 path 参数（会话归档路径）')
            }
            const importer = await loadImport(overrides)
            const targetCwd = await cwdOf(ctx, helpers, exec, args.cwd)
            const file = await importer.readImportFile(path, {
              cwd: targetCwd,
              maxImportBytes: settings.maxImportBytes,
            })
            const result = await importer.importArchive(ctx, {
              buffer: file.buffer,
              cwd: targetCwd,
              restoreWorkspaceFiles: booleanFlag(args.restoreWorkspaceFiles, settings.restoreWorkspaceFiles),
              skipDuplicates: booleanFlag(args.skipDuplicates, false),
              maxImportBytes: settings.maxImportBytes,
            })
            return importToolText(result)
          }
          if (action === 'archive' || action === 'unarchive' || action === 'delete') {
            return runManageTool(ctx, settings, overrides, helpers, action, args)
          }
          if (action === 'migrate') {
            return runMigrateTool(ctx, overrides, args)
          }
          if (action === 'files') {
            return runFilesTool(ctx, overrides, args)
          }
          if (action === 'detail') {
            return runDetailTool(ctx, overrides, args)
          }
          if (action === 'trash_list') {
            return runTrashListTool(ctx, settings, overrides)
          }
          if (action === 'trash_restore') {
            return runTrashRestoreTool(ctx, settings, overrides, args)
          }
          if (action === 'trash_purge') {
            return runTrashPurgeTool(ctx, settings, overrides, args)
          }
          if (action === 'move') {
            return runMoveTool(ctx, settings, overrides, args)
          }
          if (action === 'attachment_report') {
            return runAttachmentReportTool(ctx, overrides, args)
          }
          if (action === 'import_share') {
            return runImportShareTool(ctx, overrides, helpers, args)
          }
          if (action === 'export_workspace') {
            return runWorkspaceExportTool(ctx, settings, overrides, args)
          }
          throw new Error(
            'session_kit: action 必须是 "list"、"export"、"export_workspace"、"import"、"archive"、"unarchive"、"delete"、"migrate"、"files"、"detail"、"trash_list"、"trash_restore"、"trash_purge"、"move"、"attachment_report" 或 "import_share"',
          )
        },
      }),
    'session-kit: agent tool',
  )
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
  const isDelete = action === 'delete'
  const removeFiles = isDelete && args.removeFiles === true
  const permanent = isDelete && args.permanent === true
  const selectedFiles = isDelete ? parseSelectedFiles(args.selectedFiles) : undefined
  if (isDelete) {
    if (args.confirm !== true) {
      throw new Error(
        permanent
          ? 'session_kit: delete permanent:true 需要 confirm:true（永久删除不可恢复）'
          : 'session_kit: delete 需要 confirm:true（删除只会把会话移入回收站，不会永久删除）',
      )
    }
    if (removeFiles && selectedFiles === undefined) {
      throw new Error('session_kit: delete removeFiles 需要 selectedFiles 显式文件列表（防止静默搬走全部推导文件）')
    }
    if (!removeFiles && selectedFiles !== undefined) {
      throw new Error('session_kit: selectedFiles 只能与 removeFiles:true 一起使用')
    }
  }
  const allowAll = action === 'archive'
  let sessionIds = parseSessionIdList(args.sessionIds, { allowAll })
  if (sessionIds === undefined) {
    throw new Error(`session_kit: ${action} 需要 sessionIds 参数（会话 id 数组${allowAll ? '，或 "all"' : ''}）`)
  }
  if (sessionIds === 'all') {
    sessionIds = (await helpers.listSessionEntries(ctx)).map((entry) => entry.id)
    if (sessionIds.length === 0) throw new Error('session_kit: 没有可归档的会话')
    if (sessionIds.length > MAX_MANAGE_BATCH) {
      throw new Error(`session_kit: 一次最多处理 ${MAX_MANAGE_BATCH} 个会话（本次 ${sessionIds.length} 个）`)
    }
  }
  const outcome = await runManageBatch(ctx, settings, overrides, action, sessionIds, {
    stopActivity: args.stopActivity === true,
    removeFiles,
    selectedFiles,
    permanent,
  })
  return manageToolText(action, outcome)
}

/**
 * Run the migrate tool action (parse -> confirm/expand -> batch -> summary).
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runMigrateTool(ctx, overrides, args) {
  let sessionIds = parseSessionIdList(args.sessionIds, { allowAll: true, maxBatch: MAX_MIGRATE_BATCH })
  if (sessionIds === undefined) {
    throw new Error('session_kit: migrate 需要 sessionIds 参数（会话 id 数组，或 "all"）')
  }
  if (sessionIds === 'all') {
    if (args.confirm !== true) {
      throw new Error('session_kit: migrate "all" 需要 confirm:true（只执行 DSH 官方迁移，旧代日志保留）')
    }
    const migrate = await loadMigrate(overrides)
    let legacy
    try {
      legacy = await migrate.listLegacySessionIds(ctx)
    } catch (error) {
      throw new Error(`session_kit: 读取旧格式会话失败：${errorText(error)}`)
    }
    sessionIds = (Array.isArray(legacy) ? legacy : []).map((id) => String(id))
    if (sessionIds.length === 0) return '没有需要升级的旧格式会话'
    if (sessionIds.length > MAX_MIGRATE_BATCH) {
      throw new Error(`session_kit: 一次最多迁移 ${MAX_MIGRATE_BATCH} 个会话（当前旧格式 ${sessionIds.length} 个）`)
    }
  }
  const outcome = await runMigrateBatch(ctx, overrides, sessionIds)
  return migrateToolText(outcome)
}

/**
 * Tool result text for the migrate action.
 * @param {{results: Array<object>, migratedCount: number, legacyRemaining?: number}} outcome - batch outcome.
 * @returns {string} summary text.
 */
function migrateToolText(outcome) {
  const failed = outcome.results.filter((result) => !result.ok)
  const current = outcome.results.filter((result) => result.ok && result.status === 'current').length
  const lines = [
    `升级格式：成功 ${outcome.results.length - failed.length} 个（实际迁移 ${outcome.migratedCount} 个${current > 0 ? `，已是当前格式 ${current} 个` : ''}），失败 ${failed.length} 个`,
  ]
  if (outcome.legacyRemaining !== undefined) lines.push(`剩余旧格式会话：${outcome.legacyRemaining} 个`)
  for (const result of failed) lines.push(`- ${result.sessionId}：${result.error ?? '失败'}`)
  return lines.join('\n')
}

/**
 * Run the files preview tool action (parse ids -> derive plan -> summary text).
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runFilesTool(ctx, overrides, args) {
  const sessionIds = parseSessionIdList(args.sessionIds, { allowAll: false, maxBatch: MAX_FILE_BATCH })
  if (sessionIds === undefined) {
    throw new Error('session_kit: files 需要 sessionIds 参数（会话 id 数组）')
  }
  const files = await loadSessionFiles(overrides)
  if (typeof files.deriveSessionFilePlan !== 'function') {
    throw new Error('session_kit: 会话文件推导模块不可用')
  }
  let plan
  try {
    plan = await files.deriveSessionFilePlan(ctx, sessionIds)
  } catch (error) {
    throw new Error(`session_kit: 推导会话相关文件失败：${errorText(error)}`)
  }
  return filesToolText(plan)
}

/**
 * Tool result text for a related-files preview.
 * @param {{files?: Array<object>, skipped?: Array<object>, warnings?: string[], totalBytes?: number}} plan - derived plan.
 * @returns {string} summary text.
 */
function filesToolText(plan) {
  const files = Array.isArray(plan?.files) ? plan.files : []
  const skipped = Array.isArray(plan?.skipped) ? plan.skipped : []
  const warnings = Array.isArray(plan?.warnings) ? plan.warnings.map((warning) => String(warning)) : []
  const totalBytes = Number.isSafeInteger(plan?.totalBytes)
    ? plan.totalBytes
    : files.reduce((sum, entry) => sum + (Number.isSafeInteger(entry?.bytes) ? entry.bytes : 0), 0)
  const lines = [
    `会话相关文件：${files.length} 个（${totalBytes} 字节），跳过 ${skipped.length} 个`,
    '风险提示：推导是尽力而为的（shell 重定向、PTC 脚本、仅文本提到的文件无法发现）；工作区共享文件可能被一并移走；文件只会移入 <DSH_HOME>/session-kit-trash；删除前必须二次确认。',
  ]
  for (const entry of files.slice(0, 20)) {
    const relative =
      typeof entry?.relative === 'string' && entry.relative !== '' ? entry.relative : String(entry?.path ?? '')
    const size = Number.isSafeInteger(entry?.bytes) ? `${entry.bytes} 字节` : '大小未知'
    lines.push(`- ${relative}（${size}${entry?.weak === true ? '，弱证据' : ''}）`)
  }
  if (files.length > 20) lines.push(`…还有 ${files.length - 20} 个文件未列出`)
  for (const warning of warnings) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/**
 * Run the detail tool action (parse ids -> per-session detail -> summary text).
 *
 * Mirrors `POST /session-kit/session-detail`: same parser, same per-id error
 * tolerance, same 100-id cap. No client-only state is touched and nothing is
 * written, so this action is safe to call without `confirm`.
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runDetailTool(ctx, overrides, args) {
  const sessionIds = parseSessionIdList(args.sessionIds, { allowAll: false, maxBatch: MAX_DETAIL_BATCH })
  if (sessionIds === undefined) {
    throw new Error('session_kit: detail 需要 sessionIds 参数（会话 id 数组）')
  }
  const helpers = await loadSessions(overrides)
  if (typeof helpers.sessionDetail !== 'function') {
    throw new Error('session_kit: 会话详情模块不可用')
  }
  const results = []
  for (const sessionId of sessionIds) {
    try {
      results.push({ id: sessionId, ok: true, detail: await helpers.sessionDetail(ctx, sessionId) })
    } catch (error) {
      results.push({
        id: sessionId,
        ok: false,
        error: errorText(error),
        code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'detail-failed',
      })
    }
  }
  return detailToolText(results)
}

/**
 * Render a byte count compactly while keeping the exact value visible.
 * @param {number} bytes - non-negative byte count.
 * @returns {string} e.g. `1.2 MiB（1258291 字节）`, or 大小未知.
 */
function formatByteSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '大小未知'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 ? String(value) : value.toFixed(1)
  return unit === 0 ? `${bytes} 字节` : `${shown} ${units[unit]}（${bytes} 字节）`
}

/**
 * Tool result text for the detail action.
 * @param {Array<{id: string, ok: boolean, detail?: object, error?: string, code?: string}>} results - per-id results.
 * @returns {string} summary text.
 */
function detailToolText(results) {
  const failed = results.filter((result) => result.ok !== true)
  const lines = [`会话详情：成功 ${results.length - failed.length} 个，失败 ${failed.length} 个`]
  for (const result of results) {
    if (result.ok !== true) {
      lines.push(`- ${result.id}：${result.error ?? '读取失败'}（${result.code ?? 'detail-failed'}）`)
      continue
    }
    const detail = result.detail !== null && typeof result.detail === 'object' ? result.detail : {}
    const parts = []
    if (Number.isSafeInteger(detail.sizeBytes)) parts.push(`存储 ${formatByteSize(detail.sizeBytes)}`)
    if (typeof detail.formatStatus === 'string' && detail.formatStatus !== '') {
      parts.push(`格式 ${detail.formatStatus}`)
    }
    if (detail.legacy === true) parts.push('旧格式')
    parts.push(detail.archived === true ? '已归档' : '未归档')
    lines.push(`- ${result.id}：${parts.join('，')}`)
  }
  return lines.join('\n')
}

/**
 * Run the trash_list tool action.
 *
 * The inventory is read-only: it reports each operation's manifest, size and
 * whether it can be restored, and never moves or deletes anything.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @returns {Promise<string>} inventory text.
 */
async function runTrashListTool(ctx, settings, overrides) {
  const trash = await loadTrash(overrides)
  const listed = await trash.listTrashOperations(ctx, trashOptions(settings))
  return trashListText(listed)
}

/**
 * Run the trash_restore tool action.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runTrashRestoreTool(ctx, settings, overrides, args) {
  const operationId = typeof args.operationId === 'string' ? args.operationId.trim() : ''
  if (operationId === '') {
    throw new Error('session_kit: trash_restore 需要 operationId（回收站操作目录名，先用 trash_list 查看）')
  }
  const sessionIds = parseSessionIdList(args.sessionIds, {
    allowAll: false,
    allowEmpty: true,
    maxBatch: MAX_DETAIL_BATCH,
  })
  const trash = await loadTrash(overrides)
  const restored = await trash.restoreTrashOperation(ctx, {
    ...trashOptions(settings),
    operationId,
    ...(Array.isArray(sessionIds) && sessionIds.length > 0 ? { sessionIds } : {}),
  })
  return trashRestoreText(restored)
}

/**
 * Run the trash_purge tool action (irreversible; requires `confirm: true`).
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runTrashPurgeTool(ctx, settings, overrides, args) {
  if (args.confirm !== true) {
    throw new Error('session_kit: trash_purge 需要 confirm:true（清理回收站不可恢复）')
  }
  const operationIds = parseTrashOperationIds(args.operationIds)
  const olderThanDays =
    args.olderThanDays === undefined ? undefined : positiveIntegerValue(args.olderThanDays, 'olderThanDays')
  const trash = await loadTrash(overrides)
  const purged = await trash.purgeTrashOperations(ctx, {
    ...trashOptions(settings),
    operationIds,
    confirm: true,
    ...(olderThanDays !== undefined ? { olderThanDays } : {}),
  })
  return trashPurgeText(purged)
}

/**
 * Tool result text for the trash_list action.
 * @param {{trashRoot?: string, operations?: Array<object>, warnings?: string[]}} listed - inventory.
 * @returns {string} summary text.
 */
function trashListText(listed) {
  const operations = Array.isArray(listed.operations) ? listed.operations : []
  if (operations.length === 0) return '回收站是空的'
  const total = operations.reduce(
    (sum, operation) => sum + (Number.isSafeInteger(operation.bytes) ? operation.bytes : 0),
    0,
  )
  const lines = [`回收站：${operations.length} 个操作，共 ${formatByteSize(total)}`]
  for (const operation of operations.slice(0, 20)) {
    const when =
      typeof operation.createdAt === 'string' ? operation.createdAt.replace('T', ' ').slice(0, 19) : '时间未知'
    const state = operation.restorable === true ? '可恢复' : '缺清单，只能人工检查'
    lines.push(
      `- ${operation.operationId}（${when}，${operation.sessionCount ?? 0} 个会话，` +
        `${formatByteSize(operation.bytes ?? 0)}，${state}${operation.hasFiles === true ? '，含相关文件' : ''}）`,
    )
  }
  if (operations.length > 20) lines.push(`…还有 ${operations.length - 20} 个操作未列出`)
  for (const warning of listed.warnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/**
 * Tool result text for the trash_restore action.
 * @param {{operationId?: string, restored?: Array<object>, skipped?: Array<object>, warnings?: string[]}} result - restore outcome.
 * @returns {string} summary text.
 */
function trashRestoreText(result) {
  const restored = Array.isArray(result.restored) ? result.restored : []
  const skipped = Array.isArray(result.skipped) ? result.skipped : []
  const lines = [`回收站恢复：成功 ${restored.length} 个会话，跳过 ${skipped.length} 个`]
  for (const entry of restored) lines.push(`- 已恢复到 ${entry.path}`)
  for (const entry of skipped) {
    const reason =
      entry.reason === 'target-exists'
        ? '目标已存在（未覆盖）'
        : entry.reason === 'missing'
          ? '回收站里找不到目录'
          : entry.reason === 'no-original-location'
            ? '清单没有记录原位置'
            : entry.reason === 'unsafe-location'
              ? '原位置不安全'
              : `移动失败：${entry.error ?? '未知原因'}`
    lines.push(`- ${entry.id}：${reason}`)
  }
  for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/**
 * Tool result text for the trash_purge action.
 * @param {{removed?: string[], freedBytes?: number, warnings?: string[]}} result - purge outcome.
 * @returns {string} summary text.
 */
function trashPurgeText(result) {
  const removed = Array.isArray(result.removed) ? result.removed : []
  const lines = [`回收站清理：已永久删除 ${removed.length} 个操作，释放 ${formatByteSize(result.freedBytes ?? 0)}`]
  for (const operationId of removed) lines.push(`- ${operationId}`)
  for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/**
 * Run the move tool action (parse -> copy-then-trash -> summary).
 *
 * The route and the tool share `lib/move.js`; `confirm:true` is required because
 * the source sessions are moved into the trash directory.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runMoveTool(ctx, settings, overrides, args) {
  if (args.confirm !== true) {
    throw new Error('session_kit: move 需要 confirm:true（源会话会移入回收站，可从回收站恢复）')
  }
  const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
  if (workspaceId === '') {
    throw new Error('session_kit: move 需要 workspaceId（目标工作区 id，先用 action=list 查看）')
  }
  const sessionIds = parseSessionIdList(args.sessionIds, { allowAll: false, maxBatch: MAX_MOVE_BATCH })
  if (sessionIds === undefined) {
    throw new Error('session_kit: move 需要 sessionIds 参数（要迁移的会话 id 数组）')
  }
  const move = await loadMove(overrides)
  if (typeof move.moveSessions !== 'function') {
    throw new Error('session_kit: 会话迁移模块不可用')
  }
  const outcome = await move.moveSessions(ctx, {
    workspaceId,
    sessionIds,
    ...trashOptions(settings),
  })
  return moveToolText(outcome)
}

/**
 * Tool result text for the move action.
 * @param {{target?: object, moved?: Array<object>, skipped?: Array<object>, warnings?: string[]}} outcome - move result.
 * @returns {string} summary text.
 */
function moveToolText(outcome) {
  const moved = Array.isArray(outcome?.moved) ? outcome.moved : []
  const skipped = Array.isArray(outcome?.skipped) ? outcome.skipped : []
  const target = outcome?.target ?? {}
  const label =
    typeof target.title === 'string' && target.title !== '' ? target.title : String(target.workspaceId ?? '')
  const lines = [
    `迁移目标：${label}（${String(target.workspaceId ?? '')}）→ ${String(target.path ?? '')}`,
    `迁移：成功 ${moved.length} 个，跳过 ${skipped.length} 个`,
  ]
  for (const entry of moved) {
    const state = entry.sourceTrashed === true ? '源会话已移入回收站' : '源会话仍在原位置（见警告）'
    lines.push(`- ${entry.sourceId} → ${entry.sessionId}（${entry.eventCount ?? 0} 个事件，${state}）`)
  }
  const reasons = {
    active: '活动会话',
    subagent: '子代理转录',
    'format-version': '旧格式',
    'read-failed': '读取失败',
    'write-failed': '写入失败',
    'verify-failed': '读回验证失败',
    'move-failed': '迁移失败',
  }
  for (const entry of skipped) {
    const reason = reasons[entry.reason] ?? entry.reason
    lines.push(`- 跳过 ${entry.id}：${reason}（${entry.message}）`)
  }
  for (const warning of outcome?.warnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
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
  const input = typeof args.input === 'string' ? args.input.trim() : ''
  if (input === '') {
    throw new Error('session_kit: import_share 需要 input 参数（DeepSeek 分享链接或分享 id）')
  }
  if (input.length > MAX_SHARE_INPUT_LENGTH) {
    throw new Error(`session_kit: 分享链接/ID 过长（上限 ${MAX_SHARE_INPUT_LENGTH} 字符）`)
  }
  const workspaceId =
    typeof args.workspaceId === 'string' && args.workspaceId.trim() !== '' ? args.workspaceId.trim() : undefined
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : undefined
  const title = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : undefined
  const share = await loadShare(overrides)
  if (typeof share.importShare !== 'function') {
    throw new Error('session_kit: 分享导入模块不可用')
  }
  const target = await resolveShareTarget(ctx, helpers, workspaceId, cwd)
  let result
  try {
    result = await share.importShare(ctx, {
      input,
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      ...(target.workspaceId !== undefined ? { workspaceId: target.workspaceId } : {}),
      ...(title !== undefined ? { title } : {}),
    })
  } catch (error) {
    throw new Error(`session_kit: 导入分享会话失败：${errorText(error)}`)
  }
  return shareToolText(result, target)
}

/**
 * Tool result text for the import_share action.
 * @param {object} result - share import outcome ({sessionId, title, eventCount, warnings}).
 * @param {{workspaceId?: string, workspacePath?: string, cwd?: string}} target - resolved target.
 * @returns {string} summary text.
 */
function shareToolText(result, target) {
  const flags = []
  if (typeof result?.title === 'string' && result.title !== '') flags.push(`标题 ${result.title}`)
  if (Number.isSafeInteger(result?.eventCount)) flags.push(`${result.eventCount} 条事件`)
  const lines = [
    `已导入分享会话：${String(result?.sessionId ?? '')}${flags.length > 0 ? `（${flags.join('，')}）` : ''}`,
  ]
  if (target.workspaceId !== undefined) lines.push(`工作区：${target.workspaceId}（${target.workspacePath}）`)
  else if (target.cwd !== undefined) lines.push(`目标目录：${target.cwd}`)
  for (const warning of Array.isArray(result?.warnings) ? result.warnings : []) {
    lines.push(`注意：${String(warning)}`)
  }
  return lines.join('\n')
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
  if (typeof requested === 'string' && requested.trim() !== '') return requested.trim()
  const headerCwd = exec?.agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  const fallback = helpers.servicesOf(ctx).workingDirectory?.defaultDirectory
  if (typeof fallback === 'string' && fallback !== '') return fallback
  return undefined
}

/** Tool result text for the list action. */
function listToolText(sessions, workspaces) {
  const lines = [`工作区 ${workspaces.length} 个，会话 ${sessions.length} 个`]
  for (const workspace of workspaces) {
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : workspace.path
    lines.push(`- [工作区] ${String(title ?? workspace.workspaceId)}（${workspace.sessionIds?.length ?? 0} 个会话）`)
  }
  const shown = sessions.slice(0, 80)
  for (const session of shown) {
    const parts = [`${session.id}`, session.title ?? '(无标题)']
    if (typeof session.cwd === 'string' && session.cwd !== '') parts.push(session.cwd)
    if (typeof session.eventCount === 'number' && session.eventCount > 0) parts.push(`${session.eventCount} 事件`)
    if (session.running === true) parts.push('运行中')
    if (session.archived === true) parts.push('已归档')
    lines.push(`- ${parts.join(' | ')}`)
  }
  if (sessions.length > shown.length) lines.push(`…还有 ${sessions.length - shown.length} 个会话未列出`)
  return lines.join('\n')
}

/** Tool result text for the export action. */
function exportToolText(path, exported) {
  const parts = [
    `${exported.sessionCount} 个会话`,
    `${exported.eventCount} 条事件`,
    `${exported.attachmentCount} 个附件`,
  ]
  if ((exported.workspaceFileCount ?? 0) > 0) {
    parts.push(`${exported.workspaceFileCount} 个工作区文件（${exported.workspaceBytes} 字节）`)
  }
  const lines = [`已导出到 ${path}（${parts.join('，')}，模式 ${exported.manifest.mode}）`]
  for (const warning of exported.warnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/**
 * Run the export_workspace tool action (build one workspace backup, write it to
 * the plugin export directory, summarise the result).
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
/**
 * Read the requested workspace ids from tool arguments.
 * `workspaceIds` wins when it is a non-empty array; a bare `workspaceId` is the
 * single-workspace form. Values are trimmed, de-duplicated and capped.
 * @param {object} args - model arguments.
 * @returns {string[]} workspace ids.
 * @throws {Error} empty list, non-string entries or over the batch limit.
 */
function requestedWorkspaceIds(args) {
  const requested = []
  const list = Array.isArray(args.workspaceIds) ? args.workspaceIds : []
  if (list.length > 0) {
    for (const value of list) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('session_kit: workspaceIds 必须是非空字符串数组')
      }
      requested.push(value.trim())
    }
  } else if (typeof args.workspaceId === 'string' && args.workspaceId.trim() !== '') {
    requested.push(args.workspaceId.trim())
  }
  const workspaceIds = [...new Set(requested)]
  if (workspaceIds.length === 0) {
    throw new Error('session_kit: export_workspace 需要 workspaceId 或 workspaceIds 参数（工作区 id）')
  }
  if (workspaceIds.length > MAX_WORKSPACE_BATCH) {
    throw new Error(
      `session_kit: 一次最多备份 ${MAX_WORKSPACE_BATCH} 个工作区（本次 ${workspaceIds.length} 个）；请分批导出`,
    )
  }
  return workspaceIds
}

/**
 * Run the export_workspace tool action (build one ZIP per workspace, write each
 * to the plugin export directory, summarise every result). A failure for one
 * workspace does not abort the batch; every ZIP is a separate file.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - resolved settings.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - model arguments.
 * @returns {Promise<string>} summary text.
 */
async function runWorkspaceExportTool(ctx, settings, overrides, args) {
  const workspaceIds = requestedWorkspaceIds(args)
  if (args.mode !== undefined && !EXPORT_MODE_VALUES.has(args.mode)) {
    throw new Error('session_kit: mode 必须是 "full"、"compact" 或 "compressed"')
  }
  const backup = await loadWorkspaceBackup(overrides)
  if (typeof backup.buildWorkspaceBackup !== 'function') {
    throw new Error('session_kit: 工作区备份模块不可用')
  }
  const directory = defaultExportDirectory()
  const exported = []
  const failed = []
  const usedNames = new Set()
  for (const workspaceId of workspaceIds) {
    try {
      const result = await backup.buildWorkspaceBackup(ctx, {
        workspaceId,
        mode: exportModeOf(args.mode, settings.defaultMode),
        includeAttachments: booleanFlag(args.includeAttachments, settings.includeAttachments),
        includeSubagents: booleanFlag(args.includeSubagents, settings.includeSubagents),
        workspaceExclude: stringList(args.workspaceExclude, settings.workspaceExclude),
        ...(settings.workspaceMaxBytes !== undefined ? { workspaceMaxBytes: settings.workspaceMaxBytes } : {}),
        maxExportBytes: settings.maxExportBytes,
      })
      const data = result?.data
      if (!(data instanceof Uint8Array) || typeof result?.filename !== 'string') {
        throw new Error('工作区备份模块没有返回 ZIP 数据或文件名')
      }
      await mkdir(directory, { recursive: true })
      const path = uniqueWorkspaceArchivePath(directory, result.filename, workspaceId, usedNames)
      await writeFile(path, Buffer.from(data))
      exported.push({ workspaceId, path, result })
    } catch (error) {
      failed.push({ workspaceId, message: errorText(error) })
    }
  }
  if (exported.length === 0) {
    const reasons =
      failed.length === 1
        ? failed[0].message
        : failed.map((entry) => `${entry.workspaceId}：${entry.message}`).join('；')
    throw new Error(`session_kit: 工作区备份失败：${reasons}`)
  }
  if (exported.length === 1 && failed.length === 0) {
    return workspaceExportToolText(exported[0].path, exported[0].result)
  }
  return workspaceExportBatchToolText(exported, failed)
}

/**
 * Keep two workspaces with the same title from overwriting each other in one
 * batch by appending the workspace id before `.zip`.
 * @param {string} directory - export directory.
 * @param {string} filename - archive filename from the builder.
 * @param {string} workspaceId - workspace id.
 * @param {Set<string>} used - names already claimed by this batch.
 * @returns {string} absolute archive path.
 */
function uniqueWorkspaceArchivePath(directory, filename, workspaceId, used) {
  let name = safeBackupFilename(filename)
  if (used.has(name)) {
    const suffix = '-' + safeBackupFilename(workspaceId).replace(/\.zip$/iu, '')
    name = /\.zip$/iu.test(name) ? name.slice(0, -4) + suffix + '.zip' : name + suffix
  }
  used.add(name)
  return join(directory, name)
}

/**
 * Tool result text for the export_workspace action.
 * @param {string} path - written archive path.
 * @param {object} result - workspace backup outcome (archive fields + workspace metadata).
 * @returns {string} summary text.
 */
function workspaceExportToolText(path, result) {
  const workspace = result.workspace !== null && typeof result.workspace === 'object' ? result.workspace : {}
  const title =
    typeof workspace.title === 'string' && workspace.title !== ''
      ? workspace.title
      : String(workspace.workspaceId ?? '')
  const parts = [
    `${result.sessionCount ?? 0} 个会话`,
    `${result.workspaceFileCount ?? 0} 个工作区文件（${result.workspaceBytes ?? 0} 字节）`,
  ]
  if (Number.isSafeInteger(result.attachmentCount) && result.attachmentCount > 0) {
    parts.push(`${result.attachmentCount} 个附件`)
  }
  const mode = result.manifest?.mode ?? result.mode ?? 'full'
  const lines = [`已备份工作区「${title}」到 ${path}（${parts.join('，')}，模式 ${mode}）`]
  for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/**
 * Tool result text for a multi-workspace export batch.
 * @param {Array<{workspaceId: string, path: string, result: object}>} exported - successes.
 * @param {Array<{workspaceId: string, message: string}>} failed - per-workspace failures.
 * @returns {string} summary text with one line per workspace.
 */
function workspaceExportBatchToolText(exported, failed) {
  const mode = exported[0]?.result?.manifest?.mode ?? 'full'
  const lines = [`已备份 ${exported.length} 个工作区（模式 ${mode}），每个工作区一个 ZIP：`]
  for (const entry of exported) {
    const workspace =
      entry.result.workspace !== null && typeof entry.result.workspace === 'object' ? entry.result.workspace : {}
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : entry.workspaceId
    lines.push(
      `- 「${title}」→ ${entry.path}（${entry.result.sessionCount ?? 0} 个会话，${entry.result.workspaceFileCount ?? 0} 个工作区文件）`,
    )
    for (const warning of entry.result.warnings ?? []) lines.push(`  注意：${warning}`)
  }
  if (failed.length > 0) {
    lines.push(`失败 ${failed.length} 个：`)
    for (const entry of failed) lines.push(`- ${entry.workspaceId}：${entry.message}`)
  }
  return lines.join('\n')
}

/** Tool result text for the import action. */
/**
 * Run the read-only attachment reference report.
 * @param {object} ctx - plugin context.
 * @param {object | undefined} overrides - module injection seam.
 * @param {object} args - tool arguments.
 * @returns {Promise<string>} human-readable report.
 */
async function runAttachmentReportTool(ctx, overrides, args) {
  const report = await loadAttachmentReport(overrides)
  const limit = args.limit === undefined ? undefined : positiveIntegerValue(args.limit, 'limit')
  const result = await report.reportAttachmentReferences(ctx, limit === undefined ? {} : { limit })
  return attachmentReportToolText(result)
}

/** Format an attachment-reference report for the agent tool. */
function attachmentReportToolText(report) {
  const lines = [
    `附件引用检查：扫描 ${String(report.scannedSessions)} / ${String(report.sessionTotal)} 个会话，共 ${String(report.totalReferences)} 个引用；缺失 ${String(report.missing.length)} 个，无法验证 ${String(report.unverifiable)} 个`,
  ]
  if (report.truncated) lines.push(`本次只检查前 ${String(report.limit)} 个会话（可用 limit 调整，最大 300）`)
  if (report.missing.length > 0) {
    lines.push('缺失引用：')
    for (const item of report.missing.slice(0, 50)) {
      const label = item.kind === 'image' ? `图片 ${item.attachmentId}` : `文件 ${item.name ?? item.attachmentId}`
      lines.push(`- 会话 ${item.sessionId}：${label}（not-found）`)
    }
    if (report.missing.length > 50) lines.push(`- …以及另外 ${String(report.missing.length - 50)} 个`)
  } else {
    lines.push('没有发现无法解析的附件引用。')
  }
  if (report.warnings.length > 0) {
    lines.push('注意：')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
  }
  return lines.join('\n')
}

function importToolText(result) {
  const lines = [`已导入 ${result.sessions.length} 个会话：`]
  for (const session of result.sessions) {
    const flags = [`${session.eventCount} 条事件`, `模式 ${session.mode}`]
    if (session.title !== undefined) flags.push(`标题 ${session.title}`)
    if (session.verified === false) flags.push('未能读回校验')
    lines.push(`- ${session.sessionId}（${flags.join('，')}）`)
    for (const warning of session.warnings ?? []) lines.push(`  注意：${warning}`)
  }
  if ((result.restoredFiles ?? 0) > 0 || (result.restoredBytes ?? 0) > 0) {
    lines.push(
      `恢复工作区文件 ${result.restoredFiles} 个（${result.restoredBytes} 字节），跳过 ${result.skipped ?? 0} 个`,
    )
  }
  for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/** Human label for one management action. */
const MANAGE_LABELS = Object.freeze({ archive: '归档', unarchive: '恢复', delete: '删除（移入回收站）' })

/**
 * Tool result text for one management action.
 * @param {'archive'|'unarchive'|'delete'} action - management action.
 * @param {{results: Array<object>, trashedPath?: string, archivedSessionIds?: string[]}} outcome - batch outcome.
 * @returns {string} summary text.
 */
function manageToolText(action, outcome) {
  const label = MANAGE_LABELS[action] ?? action
  const failed = outcome.results.filter((result) => !result.ok)
  const lines = [
    `${label}：成功 ${outcome.results.length - failed.length} 个${failed.length > 0 ? `，失败 ${failed.length} 个` : ''}`,
  ]
  for (const result of failed) lines.push(`- ${result.sessionId}：${result.error ?? '失败'}`)
  if (outcome.permanent === true) lines.push('已永久删除所选会话与文件（不可恢复）')
  if (outcome.trashedPath !== undefined) lines.push(`已移入回收站：${outcome.trashedPath}`)
  if (Number.isSafeInteger(outcome.filesRemoved)) {
    lines.push(
      `永久删除文件 ${outcome.filesRemoved} 个（${outcome.filesBytes ?? 0} 字节），跳过 ${outcome.filesSkipped ?? 0} 个`,
    )
  } else if (Number.isSafeInteger(outcome.filesMoved)) {
    lines.push(
      `同时移走文件 ${outcome.filesMoved} 个（${outcome.filesBytes ?? 0} 字节），跳过 ${outcome.filesSkipped ?? 0} 个`,
    )
    if (outcome.filesTrashPath !== undefined) lines.push(`文件回收站：${outcome.filesTrashPath}`)
  }
  for (const warning of outcome.fileWarnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
}
