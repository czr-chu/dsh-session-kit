/**
 * dsh-session-kit -- official session-format migration.
 *
 * DSH reads released historical generations through its own migration chain and
 * publishes the current generation lazily. The only supported way to persist
 * that upgrade is the persistence seam: open(id, 'write') runs the official
 * prepare + publish migration before granting the write handle, and the
 * released source generation is left untouched on disk. This module therefore
 * never decodes, re-encodes, decompresses, or rewrites a session artifact
 * itself; it asks DSH to do the migration and verifies the result.
 *
 * @module dsh-session-kit/migrate
 */

import { errorText } from './attachments.js';
import { SessionPortFormatError } from './format.js';

/** Resolve one optional composed service without throwing on a missing context. */
function serviceOf(ctx, name) {
  return ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
}

/** Require a non-empty session id argument. */
function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new SessionPortFormatError('invalid-argument', '需要一个非空的会话 id');
  }
  return sessionId.trim();
}

/**
 * Recover the stored generation version from one JSONL artifact path.
 *
 * The persistence snapshot header is already translated to the current logical
 * version, so the physical generation only survives in the artifact filename
 * (session.v3.jsonl / session.v3.jsonl.zstd; session.jsonl is v0).
 * @param {string | undefined} locationPath - persistence location path.
 * @returns {number | undefined} the stored generation, when the name carries one.
 */
export function storedVersionOf(locationPath) {
  if (typeof locationPath !== 'string' || locationPath === '') return undefined;
  const name = locationPath.split(/[\\/]/u).pop() ?? '';
  const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/u.exec(name);
  if (match === null) return undefined;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/** Require the session persistence seam, optionally including the write open. */
function requirePersistence(ctx, { open = false } = {}) {
  const persistence = serviceOf(ctx, 'sessionPersistence');
  const usable = persistence !== null && persistence !== undefined
    && typeof persistence.list === 'function'
    && typeof persistence.stat === 'function'
    && (!open || typeof persistence.open === 'function');
  if (!usable) {
    throw new SessionPortFormatError(
      'unavailable',
      '会话存储服务不可用，无法' + (open ? '迁移' : '列出') + '旧格式会话',
    );
  }
  return persistence;
}

/**
 * List the sessions whose stored generation still needs an official migration.
 *
 * Only snapshots the persistence backend marks migration-required qualify;
 * current logs (and snapshots that report no format status) are skipped. The
 * order is stable (lexicographic by id) so a batch plan does not depend on
 * backend listing order.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<string[]>} legacy session ids.
 * @throws {SessionPortFormatError} code 'unavailable' when persistence is missing, 'migration-failed' when listing fails.
 */
export async function listLegacySessionIds(ctx) {
  const persistence = requirePersistence(ctx);
  let snapshots;
  try {
    snapshots = await persistence.list();
  } catch (error) {
    throw new SessionPortFormatError('migration-failed', '读取会话存储列表失败：' + errorText(error));
  }
  const ids = new Set();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (snapshot === null || typeof snapshot !== 'object') continue;
    if (snapshot.formatStatus !== 'migration-required') continue;
    const id = snapshot.header !== null && typeof snapshot.header === 'object' ? snapshot.header.id : undefined;
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return [...ids].sort();
}

/** Translate one write-open refusal into the management error vocabulary. */
function translateOpenError(error, id) {
  const name = error !== null && typeof error === 'object' ? error.name : undefined;
  if (name === 'SessionAlreadyOwnedError') {
    return new SessionPortFormatError('active', '会话 ' + id + ' 正被另一个写操作占用，迁移前请先关闭它');
  }
  if (name === 'SessionPersistenceNotFoundError') {
    return new SessionPortFormatError('not-found', '会话存储里找不到会话 ' + id);
  }
  if (name === 'SessionFormatUnsupportedError' || name === 'SessionPersistenceCorruptionError') {
    return new SessionPortFormatError(
      'migration-failed',
      '官方格式迁移拒绝了会话 ' + id + '，原始日志保持不变：' + errorText(error),
    );
  }
  return new SessionPortFormatError(
    'migration-failed',
    '会话 ' + id + ' 格式迁移失败，原始日志保持不变：' + errorText(error),
  );
}

/**
 * Migrate one session to the current format through DSH's official path.
 *
 * The write open is the entire migration: DSH prepares the historical
 * generation, publishes the current one alongside it, and leaves the released
 * source file in place. The handle is closed immediately (a write handle must be
 * released), then a second stat proves the published generation is current.
 * The function refuses live/running sessions before opening anything and never
 * writes the log itself.
 * @param {object} ctx - the plugin context.
 * @param {string} sessionId - the session to migrate.
 * @returns {Promise<{sessionId: string, status: 'migrated' | 'current', fromVersion?: number, toVersion: number}>} migration outcome.
 * @throws {SessionPortFormatError} code 'invalid-argument' | 'unavailable' | 'not-found' | 'active' | 'migration-failed'.
 */
export async function migrateSession(ctx, sessionId) {
  const id = requireSessionId(sessionId);
  const sessions = serviceOf(ctx, 'sessions');
  const agents = serviceOf(ctx, 'agents');
  if (typeof sessions?.get === 'function') {
    const live = sessions.get(id);
    if (live !== undefined && live !== null) {
      throw new SessionPortFormatError('active', '会话 ' + id + ' 仍然是活动会话，迁移前请先关闭它');
    }
  }
  const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined;
  if (agent !== null && agent !== undefined && (agent.status === 'running' || agent.running === true)) {
    throw new SessionPortFormatError('active', '会话 ' + id + ' 有正在运行的代理，迁移前请先停止它');
  }

  const persistence = requirePersistence(ctx, { open: true });
  let snapshot;
  try {
    snapshot = await persistence.stat(id);
  } catch (error) {
    throw new SessionPortFormatError('migration-failed', '读取会话 ' + id + ' 的存储信息失败：' + errorText(error));
  }
  if (snapshot === null || snapshot === undefined
    || snapshot.header === null || snapshot.header === undefined) {
    throw new SessionPortFormatError('not-found', '会话存储里找不到会话 ' + id);
  }
  const snapshotVersion = Number.isSafeInteger(snapshot.header.version) ? snapshot.header.version : 4;
  if (snapshot.formatStatus !== 'migration-required') {
    // Current (or unreported) formats need no write open: report, never rewrite.
    return { sessionId: id, status: 'current', toVersion: snapshotVersion };
  }

  const sourceVersion = storedVersionOf(snapshot.location !== null && typeof snapshot.location === 'object'
    ? snapshot.location.path
    : undefined);
  let handle;
  try {
    handle = await persistence.open(id, 'write');
  } catch (error) {
    throw translateOpenError(error, id);
  }
  let closeFailure;
  try {
    // The publish already happened before open resolved; this module appends
    // nothing and rewrites nothing.
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeFailure = error;
    }
  }
  if (closeFailure !== undefined) {
    throw new SessionPortFormatError('migration-failed', '会话 ' + id + ' 已迁移但释放写句柄失败：' + errorText(closeFailure));
  }

  let verification;
  try {
    verification = await persistence.stat(id);
  } catch (error) {
    throw new SessionPortFormatError('migration-failed', '迁移后无法验证会话 ' + id + '：' + errorText(error));
  }
  if (verification === null || verification === undefined
    || verification.header === null || verification.header === undefined) {
    throw new SessionPortFormatError('migration-failed', '迁移后会话 ' + id + ' 在存储中消失；原始日志保持不变');
  }
  if (verification.formatStatus !== 'current') {
    throw new SessionPortFormatError(
      'migration-failed',
      '官方迁移未把会话 ' + id + ' 发布为当前代际（' + String(verification.formatStatus) + '）；原始日志保持不变',
    );
  }
  return {
    sessionId: id,
    status: 'migrated',
    fromVersion: sourceVersion === undefined ? snapshotVersion : sourceVersion,
    toVersion: Number.isSafeInteger(verification.header.version) ? verification.header.version : snapshotVersion,
  };
}
