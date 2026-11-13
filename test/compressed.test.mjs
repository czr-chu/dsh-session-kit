/**
 * Unit tests for `lib/compressed.js`.
 *
 * Compressed mode must be a *lossy but structurally faithful* transform: the
 * event count, order and seq stay exactly as in the source, the header is
 * cloned verbatim, streamed deltas become empty and oversized strings are
 * truncated with an explicit marker. These cases pin those invariants and the
 * budget-tightening fallback.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { COMPRESSED_DEFAULTS, compressSession } from '../lib/compressed.js'

const HEADER = {
  version: 4,
  id: 's1',
  createdAt: 1,
  cwd: '/ws',
  parentSession: 's0',
  isSeeded: false,
  delegationDepth: 1,
}

test('compressSession keeps every event, seq and type', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: { turn: 1, step: 1, stream: [{ type: 'text', text: 'delta' }], message: { content: [] } },
    },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const result = compressSession({ header: HEADER, events })
  assert.deepEqual(
    result.events.map((event) => event.type),
    events.map((event) => event.type),
  )
  assert.deepEqual(
    result.events.map((event) => event.seq),
    [0, 1, 2],
  )
  assert.deepEqual(result.events[1].data.stream, [], 'the delta stream is emptied, not dropped')
  assert.deepEqual(result.events[1].data.message, { content: [] }, 'structure around the stream stays')
})

test('compressSession clones the header verbatim, lineage included', () => {
  const result = compressSession({ header: HEADER, events: [] })
  assert.deepEqual(result.header, HEADER)
  assert.notEqual(result.header, HEADER, 'the header is cloned, not shared')
})

test('compressSession leaves small payloads content-identical', () => {
  const events = [
    {
      type: 'tool/result',
      seq: 0,
      time: 1,
      data: { toolCallId: 't1', content: [{ type: 'text', text: 'short output' }] },
    },
  ]
  const result = compressSession({ header: HEADER, events })
  assert.deepEqual(result.events[0].data, events[0].data)
})

test('compressSession truncates oversized strings and records the original length', () => {
  const long = 'x'.repeat(COMPRESSED_DEFAULTS.maxStringBytes + 500)
  const events = [{ type: 'tool/result', seq: 0, time: 1, data: { content: [{ type: 'text', text: long }] } }]
  const result = compressSession({ header: HEADER, events })
  const text = result.events[0].data.content[0].text
  assert.ok(text.length < long.length)
  assert.match(text, /dsh-session-kit compressed/u)
  assert.match(text, new RegExp(`原长 ${long.length} 字符`, 'u'))
})

test('compressSession tightens the string budget until the event fits maxEventBytes', () => {
  const events = [
    {
      type: 'tool/result',
      seq: 0,
      time: 1,
      data: {
        content: [
          { type: 'text', text: 'a'.repeat(4000) },
          { type: 'text', text: 'b'.repeat(4000) },
        ],
      },
    },
  ]
  const result = compressSession({ header: HEADER, events }, { maxStringBytes: 4096, maxEventBytes: 1024 })
  const size = Buffer.byteLength(JSON.stringify(result.events[0]), 'utf8')
  assert.ok(size <= 1024, `event should fit the budget, got ${size}`)
  assert.equal(result.events[0].data.content.length, 2, 'array shape survives budget tightening')
})

test('compressSession rejects an invalid log and invalid budgets', () => {
  assert.throws(() => compressSession({ header: {}, events: [] }), TypeError)
  assert.throws(() => compressSession({ header: HEADER, events: 'nope' }), TypeError)
  assert.throws(() => compressSession({ header: HEADER, events: [] }, { maxStringBytes: 0 }), TypeError)
  assert.throws(() => compressSession({ header: HEADER, events: [] }, { maxEventBytes: -1 }), TypeError)
})
