/**
 * Unit tests for the canonical session-log helpers in `lib/format.js`.
 *
 * The point of these cases is header fidelity: export must keep header fields
 * this plugin does not model, while still writing the canonical known fields in
 * a stable order and normalizing the ones it owns (`isSeeded`, `delegationDepth`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { headerLineOf, serializeSessionLog } from '../lib/format.js'

test('headerLineOf keeps unknown header fields after the canonical ones', () => {
  const header = {
    version: 4,
    id: 's1',
    createdAt: 1,
    cwd: '/ws',
    isSeeded: true,
    delegationDepth: 2,
    origin: 'subagent',
    futureField: { nested: true },
    another: 'x',
  }
  const line = headerLineOf(header)
  assert.deepEqual(Object.keys(line), [
    'type',
    'version',
    'id',
    'createdAt',
    'cwd',
    'isSeeded',
    'origin',
    'delegationDepth',
    'futureField',
    'another',
  ])
  assert.deepEqual(line.futureField, { nested: true })
  assert.equal(line.another, 'x')
  assert.equal(line.type, 'session')
})

test('headerLineOf normalizes the fields this plugin owns', () => {
  const line = headerLineOf({ version: 4, id: 's1', createdAt: 1, isSeeded: 'yes', delegationDepth: null })
  assert.equal(line.isSeeded, false)
  assert.equal(line.delegationDepth, 0)
  assert.equal('cwd' in line, false)
})

test('serializeSessionLog preserves an unknown header field on the first line', () => {
  const header = { version: 4, id: 's1', createdAt: 1, futureField: 'keep-me' }
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]
  const text = serializeSessionLog(header, events)
  assert.equal(text.endsWith('\n'), true)
  const first = JSON.parse(text.split('\n')[0])
  assert.equal(first.type, 'session')
  assert.equal(first.futureField, 'keep-me')
  assert.equal(first.isSeeded, false)
})
