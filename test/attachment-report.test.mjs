/**
 * Behavior tests for the read-only attachment reference report.
 *
 * The report runs against a fake composed context (sessionQuery + attachments),
 * so no Harness process and no real attachment store are needed. Every path
 * check uses a real temporary file to exercise the stat() classification.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_REPORT_SESSIONS, reportAttachmentReferences } from '../lib/attachment-report.js'

/** One V4-looking event list with image/file references. */
function makeEvents() {
  return [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 11,
      data: {
        content: [
          {
            type: 'image',
            attachment: { attachmentId: 'img-ok', mediaType: 'image/png', bytes: 3, width: 2, height: 2 },
          },
          {
            type: 'image',
            attachment: { attachmentId: 'img-unknown', mediaType: 'image/png', bytes: 3, width: 2, height: 2 },
          },
          { type: 'file', attachment: { attachmentId: 'file-missing', name: 'gone.txt', bytes: 3 } },
        ],
        source: { kind: 'user' },
      },
    },
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Fake context exposing the two services the report consumes. */
function fakeContext(docs, attachments) {
  const byId = new Map(Object.entries(docs))
  const services = {
    sessionQuery: {
      async listSessions() {
        return [...byId.keys()].map((id) => ({
          header: { version: 4, id, createdAt: 1000, cwd: '/work/ws' },
        }))
      },
      async readSession(id) {
        const doc = byId.get(id)
        if (doc === undefined) throw new Error(`missing ${id}`)
        return { session: { version: 4, id, createdAt: 1000, cwd: '/work/ws' }, events: doc.events }
      },
    },
    attachments,
  }
  return { get: (service) => services[service] }
}

test('classifies resolvable, missing and unverifiable references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-kit-report-'))
  try {
    const okPath = join(root, 'ok.bin')
    await writeFile(okPath, Buffer.from([1, 2, 3]))
    const attachments = {
      imageHostPath(ref) {
        if (ref.attachmentId === 'img-ok') return okPath
        return undefined
      },
      fileHostPath() {
        return join(root, 'does-not-exist.bin')
      },
    }
    const ctx = fakeContext(
      {
        'session-one': { events: makeEvents() },
      },
      attachments,
    )

    const report = await reportAttachmentReferences(ctx, {})
    assert.equal(report.scannedSessions, 1)
    assert.equal(report.sessionTotal, 1)
    assert.equal(report.limit, MAX_REPORT_SESSIONS)
    assert.equal(report.totalReferences, 3)
    assert.equal(report.unverifiable, 1)
    assert.deepEqual(report.missing, [
      {
        sessionId: 'session-one',
        kind: 'file',
        attachmentId: 'file-missing',
        name: 'gone.txt',
        reason: 'not-found',
      },
    ])
    assert.deepEqual(report.warnings, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('truncates the scan at limit and reports it', async () => {
  const attachments = { imageHostPath: () => undefined, fileHostPath: () => undefined }
  const ctx = fakeContext(
    {
      'session-a': { events: makeEvents() },
      'session-b': { events: makeEvents() },
    },
    attachments,
  )
  const report = await reportAttachmentReferences(ctx, { limit: 1 })
  assert.equal(report.scannedSessions, 1)
  assert.equal(report.sessionTotal, 2)
  assert.equal(report.truncated, true)
  assert.equal(report.missing.length, 0)
})

test('rejects a non-positive limit with a TypeError', async () => {
  const ctx = fakeContext({}, {})
  await assert.rejects(() => reportAttachmentReferences(ctx, { limit: 0 }), TypeError)
  await assert.rejects(() => reportAttachmentReferences(ctx, { limit: -1 }), TypeError)
  await assert.rejects(() => reportAttachmentReferences(ctx, { limit: 1.5 }), TypeError)
})
