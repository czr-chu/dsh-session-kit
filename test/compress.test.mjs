/**
 * Behaviour tests for `lib/compress.js`.
 *
 * Compression never rewrites a session in place (DSH generations are
 * immutable): it writes a smaller copy under a new id, reads it back, and only
 * then moves the source into the trash directory. These cases pin that
 * replace-then-trash contract, the two transforms' observable differences, the
 * preflight skips, and the failure directions that must never lose a source.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { COMPRESS_MODES, MAX_COMPRESS_SESSIONS, compressSessions } from '../lib/compress.js'
import { encodeSegment } from '../lib/manage.js'

const DELIVERY = 'session-log-deepseek/delivery-accepted'

/**
 * Build a composed context whose services are plain in-memory fakes.
 * @param {object} options - fake store and behaviour overrides.
 * @returns {{ctx: object, docs: Map<string, object>, calls: object}} fixture.
 */
function makeContext(options) {
  const docs = options.docs
  const calls = { attached: [], created: [], archived: [], pinned: [] }
  const workspaces = (options.workspaces ?? []).map((workspace) => ({
    ...workspace,
    sessionIds: [],
    async attachSession(id) {
      calls.attached.push({ workspaceId: workspace.id, sessionId: id })
      workspace.sessionIds.push(id)
    },
    async detachSession(id) {
      workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id)
    },
  }))
  const live = (id) => (typeof options.live === 'function' ? options.live(id) : options.live)
  const registry = {
    get(id) {
      return workspaces.find((workspace) => String(workspace.id) === String(id))
    },
    async list() {
      return workspaces
    },
    async resolveByPath(path) {
      return workspaces.find((workspace) => workspace.path === path)
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
      return options.listSnapshots === undefined ? (options.snapshots ?? []) : options.listSnapshots()
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
      return [{ header: { version: options.currentVersion ?? 4 } }]
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
    ['sessions', { get: live, flush: async () => {} }],
    ['agents', { get: () => options.agent }],
    ['workspaceRegistry', registry],
    ['agentPresets', { resolve: async (id) => ({ id }) }],
  ])
  return { ctx: { get: (name) => services.get(name) }, docs, calls, workspaces }
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

/** The smallest log that both transforms accept as a conversation. */
function conversationEvents() {
  return [
    { seq: 0, type: 'turn/start', time: 10, data: { turn: 1 } },
    { seq: 1, type: 'step/start', time: 11, data: { turn: 1, step: 1 } },
    {
      seq: 2,
      type: 'user/message',
      time: 12,
      data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
    },
    {
      seq: 3,
      type: 'assistant/message',
      time: 13,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        stream: [],
      },
    },
    { seq: 4, type: 'step/end', time: 14, data: { turn: 1, step: 1 } },
    { seq: 5, type: 'turn/end', time: 15, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('compact replaces the session with a conversation-only copy under a new id and trashes the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compress-'))
  try {
    const sourceId = 'session-source-compact'
    const paths = await makeSessionDir(root, sourceId)
    const workspaceDir = join(root, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const workspacePath = await realpath(workspaceDir)
    const events = [
      { seq: 0, type: 'permission/preset', time: 10, data: { preset: 'standard' } },
      { seq: 1, type: 'turn/start', time: 20, data: { turn: 1 } },
      { seq: 2, type: 'step/start', time: 21, data: { turn: 1, step: 1 } },
      {
        seq: 3,
        type: 'user/message',
        time: 22,
        data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
      },
      {
        seq: 4,
        type: 'assistant/message',
        time: 23,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'm2',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            content: [{ type: 'text', text: '先看看' }],
          },
          stream: [{ type: 'text', text: '…' }],
        },
      },
      { seq: 5, type: 'tool/call', time: 24, data: { id: 'c1', tool: 'bash', args: { command: 'ls' } } },
      { seq: 6, type: 'tool/result', time: 25, data: { id: 'c1', content: [{ type: 'text', text: 'a.txt' }] } },
      {
        seq: 7,
        type: 'assistant/message',
        time: 26,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'm3',
            role: 'assistant',
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            content: [{ type: 'text', text: '最终回答' }],
          },
          stream: [{ type: 'text', text: '最终' }],
        },
      },
      { seq: 8, type: 'step/end', time: 27, data: { turn: 1, step: 1 } },
      { seq: 9, type: 'turn/end', time: 28, data: { turn: 1, reason: { kind: 'completed' } } },
      {
        seq: 10,
        type: 'session/title',
        time: 30,
        data: { title: '压缩测试', source: { kind: 'user' }, messageSeqs: [] },
      },
    ]
    const docs = new Map([
      [
        sourceId,
        {
          header: { version: 4, id: sourceId, cwd: workspacePath, createdAt: 1000, agentPreset: 'standard' },
          events,
        },
      ],
    ])
    const trashDir = join(root, 'trash')
    const { ctx, calls } = makeContext({
      docs,
      workspaces: [{ id: 'ws-home', path: workspacePath }],
      snapshots: [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }],
      archived: [sourceId],
      pinned: [sourceId],
    })

    const result = await compressSessions(ctx, { sessionIds: [sourceId], mode: 'compact', trashDir })

    assert.equal(result.mode, 'compact')
    assert.equal(result.skipped.length, 0)
    assert.equal(result.compressed.length, 1)
    const entry = result.compressed[0]
    assert.equal(entry.sourceId, sourceId)
    assert.notEqual(entry.sessionId, sourceId)
    assert.equal(entry.sourceTrashed, true)
    assert.equal(entry.title, '压缩测试')
    assert.ok(entry.eventCount < events.length)
    assert.ok(typeof entry.trashedPath === 'string' && entry.trashedPath.includes('trash'))
    assert.deepEqual(calls.created, [entry.sessionId])
    assert.deepEqual(calls.attached, [{ workspaceId: 'ws-home', sessionId: entry.sessionId }])
    assert.deepEqual(calls.archived, [entry.sessionId])
    assert.deepEqual(calls.pinned, [entry.sessionId])

    const copy = docs.get(entry.sessionId)
    assert.equal(copy.header.id, entry.sessionId)
    assert.equal(copy.header.version, 4)
    assert.equal(copy.header.cwd, workspacePath)
    assert.equal(copy.header.isSeeded, false)
    assert.equal(copy.header.agentPreset, 'standard')
    const types = copy.events.map((event) => event.type)
    const allowed = new Set([
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
      'model/selection',
      'session/title',
      'request/header',
      'request/context',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    assert.deepEqual(
      types.filter((type) => !allowed.has(type)),
      [],
    )
    assert.ok(!types.includes('tool/call'))
    assert.ok(!types.includes('tool/result'))
    const users = copy.events.filter((event) => event.type === 'user/message')
    assert.equal(users.length, 1)
    assert.deepEqual(users[0].data.content, [{ type: 'text', text: '你好' }])
    const assistants = copy.events.filter((event) => event.type === 'assistant/message')
    assert.equal(assistants.length, 1)
    assert.deepEqual(assistants[0].data.message.content, [{ type: 'text', text: '最终回答' }])
    assert.deepEqual(assistants[0].data.stream, [])
    assert.deepEqual(
      copy.events.map((event) => event.seq),
      copy.events.map((_, index) => index),
    )

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

test('compressed keeps every event and tool structure while emptying deltas and truncating long strings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compress-'))
  try {
    const sourceId = 'session-source-compressed'
    const paths = await makeSessionDir(root, sourceId)
    const workspaceDir = join(root, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const workspacePath = await realpath(workspaceDir)
    const longText = 'x'.repeat(20000)
    const events = [
      { seq: 0, type: 'session/end-seed', data: { inherited: true } },
      { seq: 1, type: 'turn/start', time: 10, data: { turn: 1 } },
      {
        seq: 2,
        type: 'user/message',
        time: 11,
        data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: longText }] },
      },
      {
        seq: 3,
        type: 'tool/call',
        time: 12,
        data: { id: 'c1', tool: 'bash', args: { command: 'echo hi' }, chunks: [{ type: 'text', text: 'chunk' }] },
      },
      {
        seq: 4,
        type: 'tool/result',
        time: 13,
        data: { id: 'c1', content: [{ type: 'text', text: longText }], deltas: [{ type: 'text', text: 'delta' }] },
      },
      {
        seq: 5,
        type: 'assistant/message',
        time: 14,
        data: {
          turn: 1,
          step: 1,
          message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          stream: [{ type: 'text', text: 'delta' }],
        },
      },
      { seq: 6, type: DELIVERY, data: { sessionId: sourceId, sessionFormatVersion: 4 } },
      { seq: 7, type: 'turn/end', time: 15, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const docs = new Map([
      [sourceId, { header: { version: 4, id: sourceId, cwd: workspacePath, createdAt: 2000, isSeeded: true }, events }],
    ])
    const trashDir = join(root, 'trash')
    const { ctx } = makeContext({
      docs,
      workspaces: [{ id: 'ws', path: workspacePath }],
      snapshots: [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }],
    })

    const result = await compressSessions(ctx, { sessionIds: [sourceId], mode: 'compressed', trashDir })

    assert.equal(result.mode, 'compressed')
    assert.equal(result.skipped.length, 0)
    assert.equal(result.compressed.length, 1)
    const entry = result.compressed[0]
    assert.equal(entry.eventCount, events.length)
    assert.notEqual(entry.sessionId, sourceId)

    const copy = docs.get(entry.sessionId)
    assert.deepEqual(
      copy.events.map((event) => event.type),
      events.map((event) => event.type),
    )
    assert.deepEqual(
      copy.events.map((event) => event.seq),
      events.map((event) => event.seq),
    )
    const toolCall = copy.events.find((event) => event.type === 'tool/call')
    assert.equal(toolCall.data.tool, 'bash')
    assert.deepEqual(toolCall.data.args, { command: 'echo hi' })
    assert.deepEqual(toolCall.data.chunks, [])
    const toolResult = copy.events.find((event) => event.type === 'tool/result')
    assert.deepEqual(toolResult.data.deltas, [])
    assert.ok(toolResult.data.content[0].text.length < longText.length)
    assert.ok(toolResult.data.content[0].text.includes('已截断'))
    assert.deepEqual(copy.events.find((event) => event.type === 'assistant/message').data.stream, [])
    assert.equal(copy.events.find((event) => event.type === DELIVERY).data.sessionId, entry.sessionId)
    assert.deepEqual(copy.events[0].data, {})
    assert.equal(copy.header.id, entry.sessionId)
    assert.equal(copy.header.version, 4)
    assert.equal(copy.header.cwd, workspacePath)
    assert.equal(copy.header.isSeeded, false)
    assert.equal(entry.sourceTrashed, true)

    await assert.rejects(readFile(paths.logPath))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('live, subagent and legacy sources are skipped before any copy is written', async () => {
  const docs = new Map([
    ['session-live', { header: { version: 4, id: 'session-live', cwd: '/tmp' }, events: [] }],
    ['session-sub', { header: { version: 4, id: 'session-sub', origin: 'subagent', cwd: '/tmp' }, events: [] }],
    ['session-old', { header: { version: 3, id: 'session-old', cwd: '/tmp' }, events: [] }],
  ])
  const { ctx, calls } = makeContext({
    docs,
    workspaces: [],
    snapshots: [],
    live: (id) => (id === 'session-live' ? {} : undefined),
  })

  const result = await compressSessions(ctx, { sessionIds: ['session-live', 'session-sub', 'session-old'] })

  assert.deepEqual(
    result.skipped.map((entry) => entry.reason),
    ['active', 'subagent', 'format-version'],
  )
  assert.equal(result.compressed.length, 0)
  assert.equal(calls.created.length, 0)
  assert.equal(calls.attached.length, 0)
  assert.equal(docs.size, 3)
})

test('empty, oversized and unknown-mode requests are rejected before any read', async () => {
  const { ctx, calls } = makeContext({ docs: new Map(), workspaces: [], snapshots: [] })

  await assert.rejects(compressSessions(ctx, { sessionIds: [] }), (error) => {
    assert.equal(error.code, 'invalid-argument')
    return true
  })
  const tooMany = Array.from({ length: MAX_COMPRESS_SESSIONS + 1 }, (_, index) => 'session-' + index)
  await assert.rejects(compressSessions(ctx, { sessionIds: tooMany }), (error) => {
    assert.equal(error.code, 'too-many-sessions')
    return true
  })
  await assert.rejects(compressSessions(ctx, { sessionIds: ['session-a'], mode: 'full' }), (error) => {
    assert.equal(error.code, 'invalid-argument')
    return true
  })
  assert.equal(calls.created.length, 0)
  assert.deepEqual(COMPRESS_MODES, ['compact', 'compressed'])
})

test('a copy that cannot be read back leaves the source untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compress-'))
  try {
    const sourceId = 'session-verify'
    const paths = await makeSessionDir(root, sourceId)
    const workspaceDir = join(root, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const workspacePath = await realpath(workspaceDir)
    const docs = new Map([
      [
        sourceId,
        { header: { version: 4, id: sourceId, cwd: workspacePath, createdAt: 3000 }, events: conversationEvents() },
      ],
    ])
    const trashDir = join(root, 'trash')
    const { ctx } = makeContext({
      docs,
      workspaces: [{ id: 'ws', path: workspacePath }],
      snapshots: [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }],
      readSession: (id) => {
        if (id === sourceId) return undefined
        throw new Error('cannot replay')
      },
    })

    const result = await compressSessions(ctx, { sessionIds: [sourceId], mode: 'compressed', trashDir })

    assert.equal(result.compressed.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'verify-failed')
    assert.equal((await readFile(paths.logPath)).length, 0)
    await assert.rejects(readdir(trashDir))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a trash failure keeps the copy and reports sourceTrashed:false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compress-'))
  try {
    const sourceId = 'session-trash'
    const paths = await makeSessionDir(root, sourceId)
    const workspaceDir = join(root, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const workspacePath = await realpath(workspaceDir)
    const docs = new Map([
      [
        sourceId,
        { header: { version: 4, id: sourceId, cwd: workspacePath, createdAt: 4000 }, events: conversationEvents() },
      ],
    ])
    const trashDir = join(root, 'trash')
    const { ctx } = makeContext({
      docs,
      workspaces: [{ id: 'ws', path: workspacePath }],
      snapshots: [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }],
      listSnapshots: () => [],
    })

    const result = await compressSessions(ctx, { sessionIds: [sourceId], mode: 'compressed', trashDir })

    assert.equal(result.compressed.length, 1)
    const entry = result.compressed[0]
    assert.equal(entry.sourceTrashed, false)
    assert.ok(entry.warnings.some((warning) => warning.includes('没有移入回收站')))
    assert.ok(docs.has(entry.sessionId))
    assert.equal((await readFile(paths.logPath)).length, 0)
    await assert.rejects(readdir(trashDir))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a batch keeps compressing after a session is skipped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compress-'))
  try {
    const goodId = 'session-good'
    const busyId = 'session-busy'
    const paths = await makeSessionDir(root, goodId)
    const workspaceDir = join(root, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const workspacePath = await realpath(workspaceDir)
    const docs = new Map([
      [
        goodId,
        { header: { version: 4, id: goodId, cwd: workspacePath, createdAt: 5000 }, events: conversationEvents() },
      ],
      [busyId, { header: { version: 4, id: busyId, cwd: workspacePath }, events: [] }],
    ])
    const trashDir = join(root, 'trash')
    const { ctx } = makeContext({
      docs,
      workspaces: [{ id: 'ws', path: workspacePath }],
      snapshots: [{ header: docs.get(goodId).header, location: { kind: 'jsonl', path: paths.logPath } }],
      live: (id) => (id === busyId ? {} : undefined),
    })

    const result = await compressSessions(ctx, {
      sessionIds: [busyId, goodId],
      mode: 'compact',
      trashDir,
    })

    assert.equal(result.compressed.length, 1)
    assert.equal(result.compressed[0].sourceId, goodId)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].id, busyId)
    assert.equal(result.skipped[0].reason, 'active')
    assert.equal(result.warnings.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
