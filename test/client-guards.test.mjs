import assert from 'node:assert/strict'
import test from 'node:test'

import { dangerBlocks } from '../src/client/guards.js'

test('archive and delete block running or open sessions', () => {
  const sessions = [{ running: true }, { live: true }, { running: false }, { legacy: true }]
  assert.deepEqual(dangerBlocks(sessions, 'archive'), [{ reason: 'active', count: 2 }])
  assert.deepEqual(dangerBlocks(sessions, 'delete'), [{ reason: 'active', count: 2 }])
})

test('move adds a legacy block on top of running', () => {
  const sessions = [{ running: true }, { legacy: true }, { legacy: true }]
  assert.deepEqual(dangerBlocks(sessions, 'move'), [
    { reason: 'active', count: 1 },
    { reason: 'legacy', count: 2 },
  ])
})

test('compress blocks active sessions and legacy formats', () => {
  const sessions = [{ running: true }, { live: true }, { legacy: true }, { legacy: false }]
  assert.deepEqual(dangerBlocks(sessions, 'compress'), [
    { reason: 'active', count: 2 },
    { reason: 'legacy', count: 1 },
  ])
})

test('legacy alone only blocks move and compress, not archive or delete', () => {
  const sessions = [{ legacy: true }]
  assert.deepEqual(dangerBlocks(sessions, 'archive'), [])
  assert.deepEqual(dangerBlocks(sessions, 'delete'), [])
  assert.deepEqual(dangerBlocks(sessions, 'move'), [{ reason: 'legacy', count: 1 }])
  assert.deepEqual(dangerBlocks(sessions, 'compress'), [{ reason: 'legacy', count: 1 }])
})

test('safe sessions and malformed input produce no blocks', () => {
  assert.deepEqual(dangerBlocks([{ running: false, live: false, legacy: false }], 'move'), [])
  assert.deepEqual(dangerBlocks([{ running: false, live: false, legacy: false }], 'compress'), [])
  assert.deepEqual(dangerBlocks([], 'workspace-archive'), [])
  assert.deepEqual(dangerBlocks(null, 'delete'), [])
  assert.deepEqual(dangerBlocks([null, 1, 'x'], 'delete'), [])
})
