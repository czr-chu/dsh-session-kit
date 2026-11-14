/**
 * Pure dangerous-action policy shared by the browser panel and its tests.
 *
 * The panel reads `running` and `legacy` from `GET /session-kit/list`. The
 * backend (`assertNotActive` in lib/manage.js and the move skip list) remains
 * the final authority; these blocks only keep the controls honest before a
 * request is sent. No block ever stops an agent automatically.
 */

/** @typedef {{ reason: 'running' | 'legacy', count: number }} DangerBlock */

/**
 * @param {Array<{running?: boolean, legacy?: boolean}>} sessions
 * @param {'archive' | 'delete' | 'move' | 'workspace-archive'} action
 * @returns {DangerBlock[]}
 */
export function dangerBlocks(sessions, action) {
  const list = Array.isArray(sessions) ? sessions : []
  const running = list.filter(
    (session) => session !== null && typeof session === 'object' && session.running === true,
  ).length
  const legacy = list.filter(
    (session) => session !== null && typeof session === 'object' && session.legacy === true,
  ).length
  const blocks = []
  if (running > 0) blocks.push({ reason: 'running', count: running })
  if (action === 'move' && legacy > 0) blocks.push({ reason: 'legacy', count: legacy })
  return blocks
}
