/**
 * dsh-session-kit — safe compression copies (compact / compressed).
 *
 * A DSH session log generation is immutable: an existing session id can never
 * be rewritten in place, so "compress this session" means "replace it with a
 * smaller copy that has a NEW id". This module performs that replacement with
 * the same two-phase safety as `lib/move.js`:
 *
 *   1. preflight the source (live or running, subagent transcript, non-current
 *      format) before anything is written;
 *   2. transform the full log with `compactSession` (conversation spine only)
 *      or `compressSession` (every event, bounded payloads);
 *   3. rebuild the header as a fresh unseeded root, rewrite the delivery
 *      identity and seed markers, write the copy, then read it back through
 *      the query service;
 *   4. only after the copy reads back successfully, move the SOURCE session
 *      directory into the trash operation, so the replacement stays reversible.
 *
 * Consequences that are part of the contract:
 *  - the compressed session has a new id; links and bookmarks to the old id
 *    stop working (restoring the trash copy brings the old id back);
 *  - subagent transcripts are not copied (a subagent has no standalone agent
 *    composition here); they travel with the source directory into the trash;
 *  - the copy keeps the source `cwd`, so it rejoins the same workspace;
 *  - archived/pinned state is replayed best effort and a failure is reported as
 *    a warning, never as a failed compression;
 *  - any copy or verification failure leaves the source in place; a trash
 *    failure keeps both the copy and the source and reports
 *    `sourceTrashed: false` with a warning.
 *
 * @module dsh-session-kit/compress
 */

import { compactSession } from './compact.js'
import { compressSession } from './compressed.js'
import { SessionPortFormatError, rewriteDeliveryIdentity, rewriteSeedMarkers } from './format.js'
import { deleteSession } from './manage.js'
import {
  attachToWorkspace,
  detectFormatVersion,
  foldTitle,
  mintSessionId,
  readSessionDoc,
  servicesOf,
  writeNewSession,
} from './sessions.js'

/** Compression modes accepted by {@link compressSessions}. */
export const COMPRESS_MODES = Object.freeze(['compact', 'compressed'])

/** Upper bound on sessions compressed by one request. */
export const MAX_COMPRESS_SESSIONS = 100

/** One-line message of an arbitrary thrown value. */
function errorText(error) {
  if (error instanceof Error) return error.message.split('\n')[0]
  return String(error)
}

/** True for a plain JSON object (never an array or null). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The transform each mode runs, plus the diagnostics it reports with.
 * @type {Readonly<Record<string, {transform: Function, label: string, code: string}>>}
 */
const MODE_PLANS = Object.freeze({
  compact: { transform: compactSession, label: '精简', code: 'compact-failed' },
  compressed: { transform: compressSession, label: '压缩', code: 'compress-failed' },
})

/**
 * Refuse a source that is still live or running, before any copy exists.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - source session id.
 * @throws {SessionPortFormatError} `active`.
 */
function assertSourceIdle(ctx, sessionId) {
  const { sessions } = servicesOf(ctx)
  const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  if (live !== undefined && live !== null) {
    throw new SessionPortFormatError('active', `会话 ${sessionId} 仍然是活动会话，压缩前请先关闭它`)
  }
  const agents = ctx.get('agents')
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  if (agent !== null && agent !== undefined && (agent.status === 'running' || agent.running === true)) {
    throw new SessionPortFormatError('active', `会话 ${sessionId} 有正在运行的代理，压缩前请先停止它`)
  }
}

/**
 * Read one registry membership set without letting an accessor failure abort a compression.
 * @param {object | undefined} registry - workspace registry.
 * @param {string} name - getter name (`archivedSessionIds` / `pinnedSessionIds`).
 * @returns {Set<string>} string ids.
 */
function registrySet(registry, name) {
  try {
    const value = registry?.[name]
    return new Set(Array.isArray(value) ? value.map(String) : [])
  } catch {
    return new Set()
  }
}

/**
 * Resolve the source's agent preset on this machine. A preset that no longer
 * exists is dropped with a warning, matching move/import: keeping a dangling
 * id would leave the replacement unable to compose an agent.
 * @param {object} ctx - the plugin context.
 * @param {unknown} requested - preset id from the source header.
 * @returns {Promise<{preset?: string, warning?: string}>} resolvable preset.
 */
async function resolveAgentPreset(ctx, requested) {
  if (typeof requested !== 'string' || requested.trim() === '') return {}
  const presets = servicesOf(ctx).agentPresets
  if (presets === undefined || presets === null || typeof presets.resolve !== 'function') {
    return { warning: `会话预设 ${requested} 在本机不可校验，已丢弃` }
  }
  try {
    const resolved = await presets.resolve(requested)
    const id = resolved?.id
    return { preset: typeof id === 'string' && id !== '' ? id : requested }
  } catch {
    return { warning: `会话预设 ${requested} 在本机不存在，已丢弃` }
  }
}

/**
 * Build the header of the replacement session: same immutable origin facts as
 * the source (`createdAt`, `cwd`, `agentPreset`) under a fresh id and the
 * current format generation. The copy is a standalone root conversation, so
 * lineage fields and `isSeeded` describe a new session, not a fork.
 * @param {object} sourceHeader - the source session header.
 * @param {string} newId - id minted for the copy.
 * @param {number} currentVersion - current DSH session format version.
 * @param {string | undefined} agentPreset - resolved preset id, if usable.
 * @returns {object} header for `writeNewSession`.
 */
function buildHeader(sourceHeader, newId, currentVersion, agentPreset) {
  const createdAt = Number.isSafeInteger(sourceHeader.createdAt) && sourceHeader.createdAt >= 0
    ? sourceHeader.createdAt
    : 0
  return {
    version: currentVersion,
    id: newId,
    createdAt,
    ...(typeof sourceHeader.cwd === 'string' && sourceHeader.cwd !== '' ? { cwd: sourceHeader.cwd } : {}),
    isSeeded: false,
    delegationDepth: 0,
    ...(typeof agentPreset === 'string' && agentPreset !== '' ? { agentPreset } : {}),
  }
}

/**
 * Re-open one freshly written session through the query service.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the new session id.
 * @returns {Promise<{ok: boolean, detail?: string}>} verification result.
 */
async function verifyCopy(ctx, sessionId) {
  const { sessionQuery } = servicesOf(ctx)
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') {
    return { ok: true }
  }
  try {
    const snapshot = await sessionQuery.readSession(sessionId)
    if (snapshot === undefined || snapshot === null || snapshot.session === undefined || snapshot.session === null) {
      return { ok: false, detail: '读回的会话没有存储头信息' }
    }
    if (String(snapshot.session.id) !== String(sessionId)) {
      return { ok: false, detail: `读回的会话 id 是 ${String(snapshot.session.id)}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: errorText(error) }
  }
}

/**
 * Replay the source's archived/pinned membership on the new session.
 * Never throws: state replay is a convenience, and the copy already exists.
 * @param {object} ctx - the plugin context.
 * @param {string} newId - new session id.
 * @param {{archived: boolean, pinned: boolean}} state - source state.
 * @returns {Promise<string[]>} warnings.
 */
async function replayRegistryState(ctx, newId, state) {
  const warnings = []
  const registry = servicesOf(ctx).workspaceRegistry
  if (registry === undefined || registry === null) return warnings
  if (state.archived && typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(newId, { stopActivity: false })
    } catch (error) {
      warnings.push(`新会话已写入，但没能保留归档状态：${errorText(error)}`)
    }
  }
  if (state.pinned && typeof registry.pinSession === 'function') {
    try {
      await registry.pinSession(newId)
    } catch (error) {
      warnings.push(`新会话已写入，但没能保留置顶状态：${errorText(error)}`)
    }
  }
  return warnings
}

/**
 * Compress one source session into a new id, then trash the source.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - source session id.
 * @param {string} mode - `compact` or `compressed`.
 * @param {number} currentVersion - current DSH session format version.
 * @param {{trashDir?: string}} options - trash root override.
 * @returns {Promise<object>} compressed entry.
 * @throws {SessionPortFormatError} `active`, `unavailable`, `read-failed`,
 *   `subagent`, `format-version`, `compact-failed`, `compress-failed`,
 *   `write-failed` or `verify-failed`.
 */
async function compressOne(ctx, sessionId, mode, currentVersion, options) {
  assertSourceIdle(ctx, sessionId)
  const persistence = servicesOf(ctx).sessionPersistence
  if (persistence === undefined || persistence === null || typeof persistence.create !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法压缩会话')
  }
  let doc
  try {
    doc = await readSessionDoc(ctx, sessionId)
  } catch (error) {
    throw new SessionPortFormatError('read-failed', `读取会话 ${sessionId} 失败：${errorText(error)}`)
  }
  if (doc.header.origin === 'subagent') {
    throw new SessionPortFormatError('subagent', `会话 ${sessionId} 是子代理转录，不能单独压缩`)
  }
  if (doc.header.version !== currentVersion) {
    throw new SessionPortFormatError(
      'format-version',
      `会话 ${sessionId} 是格式 v${String(doc.header.version)}，当前 DSH 使用 v${currentVersion}；请先用 DSH 打开并升级它`,
    )
  }
  const registry = servicesOf(ctx).workspaceRegistry
  const state = {
    archived: registrySet(registry, 'archivedSessionIds').has(sessionId),
    pinned: registrySet(registry, 'pinnedSessionIds').has(sessionId),
  }
  const plan = MODE_PLANS[mode]
  let transformed
  try {
    transformed = await plan.transform({ header: doc.header, events: doc.events })
  } catch (error) {
    throw new SessionPortFormatError(plan.code, `会话 ${sessionId} ${plan.label}失败：${errorText(error)}`)
  }
  if (!isRecord(transformed?.header) || !Array.isArray(transformed?.events)) {
    throw new SessionPortFormatError(plan.code, `会话 ${sessionId} ${plan.label}结果没有返回 { header, events }`)
  }
  const warnings = []
  const preset = await resolveAgentPreset(ctx, doc.header.agentPreset)
  if (preset.warning !== undefined) warnings.push(preset.warning)
  const newId = await mintSessionId(persistence)
  const header = buildHeader(doc.header, newId, currentVersion, preset.preset)
  let events = rewriteDeliveryIdentity(transformed.events, newId, currentVersion)
  events = rewriteSeedMarkers(events)
  try {
    await writeNewSession(persistence, header, events, 0)
  } catch (error) {
    throw new SessionPortFormatError('write-failed', `会话 ${sessionId} 的${plan.label}副本写入失败：${errorText(error)}`)
  }
  const verified = await verifyCopy(ctx, newId)
  if (!verified.ok) {
    throw new SessionPortFormatError(
      'verify-failed',
      `新会话 ${newId} 已写入，但读回失败：${verified.detail ?? '未知原因'}；源会话未移入回收站`,
    )
  }
  if (typeof doc.header.cwd === 'string' && doc.header.cwd !== '') {
    const joined = await attachToWorkspace(ctx, { sessionId: newId, cwd: doc.header.cwd })
    if (joined?.warning !== undefined) warnings.push(joined.warning)
  }
  warnings.push(...(await replayRegistryState(ctx, newId, state)))
  let sourceTrashed = false
  let trashedPath
  try {
    const deleted = await deleteSession(ctx, sessionId, {
      ...(options.trashDir !== undefined ? { trashDir: options.trashDir } : {}),
    })
    sourceTrashed = true
    if (typeof deleted?.trashedPath === 'string') trashedPath = deleted.trashedPath
  } catch (error) {
    warnings.push(`新会话 ${newId} 已写入，但源会话没有移入回收站：${errorText(error)}`)
  }
  const title = foldTitle(events)
  return {
    sourceId: sessionId,
    sessionId: newId,
    sourceTrashed,
    eventCount: events.length,
    ...(title !== undefined ? { title } : {}),
    ...(trashedPath !== undefined ? { trashedPath } : {}),
    warnings,
  }
}

/**
 * Compress sessions into new, smaller sessions and trash the sources.
 *
 * Every session is preflighted individually; one that cannot be replaced
 * safely is reported in `skipped` and leaves the source untouched. The source
 * is trashed only after the copy reads back successfully, so a failure never
 * loses the original conversation. A batch is not atomic: earlier sessions can
 * be compressed even when a later one is skipped.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - compression request.
 * @param {string[]} options.sessionIds - source session ids.
 * @param {'compact'|'compressed'} [options.mode] - transform to apply (default `compressed`).
 * @param {string} [options.trashDir] - trash root override (same as delete).
 * @returns {Promise<{mode: string, compressed: Array<object>, skipped: Array<{id: string, reason: string, message: string}>, warnings: string[]}>} compression result.
 * @throws {SessionPortFormatError} `invalid-argument`, `too-many-sessions` or `unavailable`.
 */
export async function compressSessions(ctx, options = {}) {
  const sessionIds = Array.isArray(options.sessionIds) ? options.sessionIds.map((id) => String(id)) : []
  if (sessionIds.length === 0) {
    throw new SessionPortFormatError('invalid-argument', 'compress 需要至少一个 sessionIds 项（会话 id 数组）')
  }
  if (sessionIds.length > MAX_COMPRESS_SESSIONS) {
    throw new SessionPortFormatError(
      'too-many-sessions',
      `一次最多压缩 ${MAX_COMPRESS_SESSIONS} 个会话（本次 ${sessionIds.length} 个）`,
    )
  }
  const mode = options.mode === undefined ? 'compressed' : String(options.mode)
  if (!COMPRESS_MODES.includes(mode)) {
    throw new SessionPortFormatError(
      'invalid-argument',
      `不支持的压缩模式 ${mode}；可用：${COMPRESS_MODES.join(' / ')}`,
    )
  }
  let currentVersion
  try {
    currentVersion = await detectFormatVersion(ctx, undefined)
  } catch (error) {
    throw new SessionPortFormatError(
      'unavailable',
      `无法确定当前会话格式版本：${errorText(error)}`,
    )
  }
  const compressed = []
  const skipped = []
  for (const sessionId of sessionIds) {
    try {
      compressed.push(await compressOne(ctx, sessionId, mode, currentVersion, options))
    } catch (error) {
      skipped.push({
        id: sessionId,
        reason: error instanceof SessionPortFormatError ? error.code : 'compress-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    mode,
    compressed,
    skipped,
    warnings: [
      '压缩会创建新会话 id（旧 id 的链接失效），并把源会话移入回收站；子代理转录不会复制，随源目录留在回收站。',
    ],
  }
}
