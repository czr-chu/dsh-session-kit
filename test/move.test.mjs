import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { encodeSegment } from '../lib/manage.js'
import { moveSessions } from '../lib/move.js'

const DELIVERY = 'session-log-deepseek/delivery-accepted'

/**
 * Build a composed context whose services are plain in-memory fakes.
 * @param {object} options - fake store and behaviour overrides.
 * @returns {{ctx: object, docs: Map<string, object>, calls: object}} fixture.
 */
function makeContext(options) {
  const docs = options.docs
  const calls = { attached: [], detached: [], archived: [], pinned: [], created: [] }
  const workspaces = options.workspaces.map((workspace) => ({
    ...workspace,
    sessionIds: [],
    async attachSession(id) {
      calls.attached.push({ workspaceId: workspace.id, sessionId: id })
      workspace.sessionIds.push(id)
    },
    async detachSession(id) {
      calls.detached.push({ workspaceId: workspace.id, sessionId: id })
      workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id)
    },
  }))
  const registry = {
    get(id) {
      return workspaces.find((workspace) => String(workspace.id) === String(id))
    },
    async list() {
      return workspaces
    },
    archivedSessionIds: options.archived ?? [],
    pinnedSessionIds: options.pinned ?? [],
    async archiveSession(id) {
      calls.archived.push(id)
    },
    async pinSession(id) {
      calls.pinned.push(id)
    },
    async unpinSession() {},
    async unarchiveSession() {},
  }
  const persistence = {
    async list() {
      return options.listSnapshots === undefined ? options.snapshots : options.listSnapshots()
    },
    async create(header) {
      calls.created.push(header.id)
      const events = []
      docs.set(header.id, { header, events })
      return {
        async append(batch) {
          events.push(...structuredClone(batch))
        },
        async flush() {},
        async close() {},
      }
    },
  }
  const sessionQuery = {
    async listSessions() {
      return [{ header: { version: 4 } }]
    },
    async readSession(id) {
      if (options.readSession !== undefined) {
        const override = options.readSession(id)
        if (override !== undefined) return override
      }
      const doc = docs.get(id)
      if (doc === undefined) throw new Error('session not found: ' + id)
      return { session: doc.header, events: doc.events, inheritedEventCount: 0 }
    },
  }
  const services = new Map([
    ['sessionPersistence', persistence],
    ['sessionQuery', sessionQuery],
    ['sessions', { get: () => options.live ?? undefined, flush: async () => {} }],
    ['agents', { get: () => options.agent }],
    ['workspaceRegistry', registry],
    ['agentPresets', { resolve: async (id) => ({ id }) }],
  ])
  return { ctx: { get: (name) => services.get(name) }, docs, calls }
}

/**
 * Create one on-disk session directory the delete preflight accepts.
 * @param {string} root - temporary root.
 * @param {string} id - session id.
 * @returns {Promise<{sessionDir: string, projectDir: string, logPath: string}>} paths.
 */
async function makeSessionDir(root, id) {
  const projectDir = join(root, '--Users-charleschu-demo--')
  const sessionDir = join(projectDir, encodeSegment(id))
  await mkdir(sessionDir, { recursive: true })
  const logPath = join(sessionDir, 'session.v4.jsonl')
  await writeFile(logPath, '')
  return { sessionDir, projectDir, logPath }
}

test('move copies the log under a new id, attaches it, then trashes the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const sourceId = 'session-source-1'
    const paths = await makeSessionDir(root, sourceId)
    const targetDir = join(root, 'target-workspace')
    await mkdir(targetDir, { recursive: true })
    const trashDir = join(root, 'trash')
    const docs = new Map([
      [
        sourceId,
        {
          header: { version: 4, id: sourceId, cwd: '/old/project', createdAt: 1000, agentPreset: 'default' },
          events: [
            { seq: 0, type: DELIVERY, data: { sessionId: sourceId, sessionFormatVersion: 4 } },
            { seq: 1, type: 'session/title', data: { title: '迁移测试' } },
          ],
        },
      ],
    ])
    const { ctx, calls } = makeContext({
      docs,
      workspaces: [{ id: 'ws-target', path: targetDir, title: 'Target' }],
      snapshots: [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }],
      archived: [sourceId],
      pinned: [sourceId],
    })

    const result = await moveSessions(ctx, { workspaceId: 'ws-target', sessionIds: [sourceId], trashDir })

    assert.equal(result.target.workspaceId, 'ws-target')
    assert.equal(result.target.path, await realpath(targetDir))
    assert.equal(result.moved.length, 1)
    assert.equal(result.skipped.length, 0)
    const entry = result.moved[0]
    assert.equal(entry.sourceId, sourceId)
    assert.equal(entry.sourceTrashed, true)
    assert.equal(entry.title, '迁移测试')
    assert.notEqual(entry.sessionId, sourceId)
    assert.equal(calls.created.length, 1)
    assert.deepEqual(calls.attached, [{ workspaceId: 'ws-target', sessionId: entry.sessionId }])
    assert.deepEqual(calls.archived, [entry.sessionId])
    assert.deepEqual(calls.pinned, [entry.sessionId])

    const copy = docs.get(entry.sessionId)
    assert.equal(copy.header.cwd, await realpath(targetDir))
    assert.equal(copy.header.isSeeded, false)
    assert.equal(copy.header.agentPreset, 'default')
    assert.equal(copy.header.id, entry.sessionId)
    assert.equal(copy.events[0].data.sessionId, entry.sessionId)
    assert.equal(copy.events[1].data.title, '迁移测试')

    await assert.rejects(readFile(paths.logPath))
    const operationDirs = await readdir(trashDir)
    assert.equal(operationDirs.length, 1)
    const manifest = JSON.parse(await readFile(join(trashDir, operationDirs[0], 'operation.json'), 'utf8'))
    assert.equal(manifest.rootSessionId, sourceId)
    assert.equal(manifest.sessions[0].id, sourceId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a seeded source becomes an unseeded standalone copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const sourceId = 'session-fork-1'
    const paths = await makeSessionDir(root, sourceId)
    const targetDir = join(root, 'target')
    await mkdir(targetDir)
    const docs = new Map([
      [
        sourceId,
        {
          header: { version: 4, id: sourceId, cwd: '/old', createdAt: 2000, isSeeded: true },
          events: [
            { seq: 0, type: 'session/end-seed', data: { inherited: true } },
            { seq: 1, type: 'session/title', data: { title: 'fork' } },
          ],
        },
      ],
    ])
    const { ctx } = makeContext({
      docs,
      workspaces: [{ id: 'ws', path: targetDir }],
      snapshots: [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }],
    })
    const result = await moveSessions(ctx, { workspaceId: 'ws', sessionIds: [sourceId], trashDir: join(root, 'trash') })
    const copy = docs.get(result.moved[0].sessionId)
    assert.equal(copy.header.isSeeded, false)
    assert.deepEqual(copy.events[0].data, {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a live source is skipped before any copy is written', async () => {
  const docs = new Map([['session-live', { header: { version: 4, id: 'session-live' }, events: [] }]])
  const { ctx, calls } = makeContext({
    docs,
    workspaces: [{ id: 'ws', path: tmpdir() }],
    snapshots: [],
    live: {},
  })
  const result = await moveSessions(ctx, { workspaceId: 'ws', sessionIds: ['session-live'] })
  assert.equal(result.moved.length, 0)
  assert.equal(result.skipped[0].reason, 'active')
  assert.equal(calls.created.length, 0)
})

test('subagent transcripts and legacy logs are skipped with stable reasons', async () => {
  const docs = new Map([
    ['session-sub', { header: { version: 4, id: 'session-sub', origin: 'subagent' }, events: [] }],
    ['session-old', { header: { version: 3, id: 'session-old' }, events: [] }],
  ])
  const { ctx, calls } = makeContext({
    docs,
    workspaces: [{ id: 'ws', path: tmpdir() }],
    snapshots: [],
  })
  const result = await moveSessions(ctx, {
    workspaceId: 'ws',
    sessionIds: ['session-sub', 'session-old'],
  })
  assert.deepEqual(
    result.skipped.map((entry) => entry.reason),
    ['subagent', 'format-version'],
  )
  assert.equal(calls.created.length, 0)
})

test('a copy that cannot be read back leaves the source untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const sourceId = 'session-verify-1'
    const paths = await makeSessionDir(root, sourceId)
    const targetDir = join(root, 'target')
    await mkdir(targetDir)
    const docs = new Map([
      [
        sourceId,
        { header: { version: 4, id: sourceId, cwd: '/old', createdAt: 3000 }, events: [{ seq: 0, type: 'x' }] },
      ],
    ])
    const { ctx } = makeContext({
      docs,
      workspaces: [{ id: 'ws', path: targetDir }],
      snapshots: [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }],
      readSession: (id) => {
        if (id === sourceId) return { session: docs.get(sourceId).header, events: docs.get(sourceId).events }
        throw new Error('cannot replay')
      },
    })
    const result = await moveSessions(ctx, { workspaceId: 'ws', sessionIds: [sourceId], trashDir: join(root, 'trash') })
    assert.equal(result.moved.length, 0)
    assert.equal(result.skipped[0].reason, 'verify-failed')
    assert.equal((await readFile(paths.logPath)).length, 0)
    await assert.rejects(readdir(join(root, 'trash')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a trash failure keeps the copy and reports sourceTrashed:false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const sourceId = 'session-trash-1'
    const paths = await makeSessionDir(root, sourceId)
    const targetDir = join(root, 'target')
    await mkdir(targetDir)
    const docs = new Map([
      [
        sourceId,
        { header: { version: 4, id: sourceId, cwd: '/old', createdAt: 4000 }, events: [{ seq: 0, type: 'x' }] },
      ],
    ])
    const { ctx } = makeContext({
      docs,
      workspaces: [{ id: 'ws', path: targetDir }],
      snapshots: [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }],
      listSnapshots: () => [],
    })
    const result = await moveSessions(ctx, { workspaceId: 'ws', sessionIds: [sourceId], trashDir: join(root, 'trash') })
    assert.equal(result.moved.length, 1)
    assert.equal(result.moved[0].sourceTrashed, false)
    assert.ok(result.moved[0].warnings.some((warning) => warning.includes('没有移入回收站')))
    assert.equal((await readFile(paths.logPath)).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unknown workspace fails before any session is written', async () => {
  const docs = new Map([['session-a', { header: { version: 4, id: 'session-a' }, events: [] }]])
  const { ctx, calls } = makeContext({ docs, workspaces: [], snapshots: [] })
  await assert.rejects(moveSessions(ctx, { workspaceId: 'missing', sessionIds: ['session-a'] }), (error) => {
    assert.equal(error.code, 'workspace-not-found')
    return true
  })
  assert.equal(calls.created.length, 0)
})

test('invalid argument shapes are rejected', async () => {
  const docs = new Map()
  const { ctx } = makeContext({ docs, workspaces: [], snapshots: [] })
  await assert.rejects(moveSessions(ctx, { workspaceId: 'ws', sessionIds: [] }), (error) => {
    assert.equal(error.code, 'invalid-argument')
    return true
  })
  await assert.rejects(moveSessions(ctx, { workspaceId: '', sessionIds: ['x'] }), (error) => {
    assert.equal(error.code, 'invalid-argument')
    return true
  })
})
