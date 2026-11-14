import assert from 'node:assert/strict'
import test from 'node:test'

import { dangerBlocks } from '../src/client/guards.js'

test('archive and delete block running sessions', () => {
  const sessions = [{ running: true }, { running: false }, { legacy: true }]
  assert.deepEqual(dangerBlocks(sessions, 'archive'), [{ reason: 'running', count: 1 }])
  assert.deepEqual(dangerBlocks(sessions, 'delete'), [{ reason: 'running', count: 1 }])
})

test('move adds a legacy block on top of running', () => {
  const sessions = [{ running: true }, { legacy: true }, { legacy: true }]
  assert.deepEqual(dangerBlocks(sessions, 'move'), [
    { reason: 'running', count: 1 },
    { reason: 'legacy', count: 2 },
  ])
})

test('legacy alone only blocks move, not archive or delete', () => {
  const sessions = [{ legacy: true }]
  assert.deepEqual(dangerBlocks(sessions, 'archive'), [])
  assert.deepEqual(dangerBlocks(sessions, 'delete'), [])
  assert.deepEqual(dangerBlocks(sessions, 'move'), [{ reason: 'legacy', count: 1 }])
})

test('safe sessions and malformed input produce no blocks', () => {
  assert.deepEqual(dangerBlocks([{ running: false, legacy: false }], 'move'), [])
  assert.deepEqual(dangerBlocks([], 'workspace-archive'), [])
  assert.deepEqual(dangerBlocks(null, 'delete'), [])
  assert.deepEqual(dangerBlocks([null, 1, 'x'], 'delete'), [])
})
