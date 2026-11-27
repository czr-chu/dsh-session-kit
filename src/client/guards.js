/**
 * Pure dangerous-action policy shared by the browser panel and its tests.
 *
 * The panel reads `running`, `live` and `legacy` from `GET /session-kit/list`.
 * A running agent or an open (live) conversation counts as active: the backend
 * refuses archive/delete for both (`assertNotActive` in lib/manage.js) and the
 * move path skips active or legacy sessions. These blocks only keep the
 * controls honest before a request is sent; no block ever stops an agent.
 */

/** @typedef {{ reason: 'active' | 'legacy', count: number }} DangerBlock */

/**
 * @param {Array<{running?: boolean, live?: boolean, legacy?: boolean}>} sessions
 * @param {'archive' | 'delete' | 'move' | 'compress' | 'workspace-archive'} action
 * @returns {DangerBlock[]}
 */
export function dangerBlocks(sessions, action) {
  const list = Array.isArray(sessions) ? sessions : []
  const active = list.filter(
    (session) => session !== null && typeof session === 'object' && (session.running === true || session.live === true),
  ).length
  const legacy = list.filter(
    (session) => session !== null && typeof session === 'object' && session.legacy === true,
  ).length
  const blocks = []
  if (active > 0) blocks.push({ reason: 'active', count: active })
  if ((action === 'move' || action === 'compress') && legacy > 0) blocks.push({ reason: 'legacy', count: legacy })
  return blocks
}
