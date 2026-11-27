import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  const calls = {
    attached: [],
    detached: [],
    archived: [],
    pinned: [],
    created: [],
    createdWorkspaces: [],
    deletedWorkspaces: [],
  }
  const workspaces = []
  const addWorkspace = (spec) => {
    const workspace = {
      ...spec,
      sessionIds: [],
      async attachSession(id) {
        calls.attached.push({ workspaceId: workspace.id, sessionId: id })
        workspace.sessionIds.push(id)
      },
      async detachSession(id) {
        calls.detached.push({ workspaceId: workspace.id, sessionId: id })
        workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id)
      },
    }
    workspaces.push(workspace)
    return workspace
  }
  for (const spec of options.workspaces) addWorkspace(spec)
  const registry = {
    get(id) {
      return workspaces.find((workspace) => String(workspace.id) === String(id))
    },
    async list() {
      return workspaces
    },
    ...(options.noResolveByPath === true
      ? {}
      : {
          async resolveByPath(path) {
            const canonical = await realpath(path)
            for (const workspace of workspaces) {
              let known
              try {
                known = await realpath(workspace.path)
              } catch {
                known = resolve(workspace.path)
              }
              if (known === canonical) return workspace
            }
            return undefined
          },
        }),
    ...(options.noCreate === true
      ? {}
      : {
          async create(path, title) {
            if (options.createError !== undefined) throw options.createError
            const workspace = addWorkspace({
              id: `ws-created-${workspaces.length + 1}`,
              path,
              ...(title !== undefined ? { title } : {}),
            })
            calls.createdWorkspaces.push({ path, title })
            return workspace
          },
        }),
    ...(options.noDelete === true
      ? {}
      : {
          async delete(id) {
            if (options.deleteError !== undefined) throw options.deleteError
            calls.deletedWorkspaces.push(String(id))
            const index = workspaces.findIndex((workspace) => String(workspace.id) === String(id))
            if (index === -1) return false
            workspaces.splice(index, 1)
            return true
          },
        }),
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
    assert.equal(result.target.created, false)
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
  await assert.rejects(moveSessions(ctx, { newWorkspace: 'not-a-plan', sessionIds: ['x'] }), (error) => {
    assert.equal(error.code, 'invalid-argument')
    return true
  })
  await assert.rejects(
    moveSessions(ctx, { newWorkspace: { path: tmpdir(), title: 5 }, sessionIds: ['x'] }),
    (error) => {
      assert.equal(error.code, 'invalid-argument')
      return true
    },
  )
})

test('newWorkspace creates the destination and moves every copy into it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const sourceIds = ['session-new-a', 'session-new-b']
    const docs = new Map()
    const snapshots = []
    const logPaths = []
    for (const [index, sourceId] of sourceIds.entries()) {
      const paths = await makeSessionDir(root, sourceId)
      logPaths.push(paths.logPath)
      docs.set(sourceId, {
        header: { version: 4, id: sourceId, cwd: '/old/project', createdAt: 5000 + index },
        events: [{ seq: 0, type: 'session/title', data: { title: sourceId } }],
      })
      snapshots.push({ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } })
    }
    // One unsafe source makes the batch mixed: the registration the call
    // created must survive because at least one session moved into it.
    const subagentId = 'session-new-sub'
    docs.set(subagentId, {
      header: { version: 4, id: subagentId, origin: 'subagent', cwd: '/old/project', createdAt: 5002 },
      events: [],
    })
    const targetDir = join(root, 'fresh-workspace')
    await mkdir(targetDir)
    const notePath = join(targetDir, 'note.txt')
    await writeFile(notePath, 'untouched')
    const trashDir = join(root, 'trash')
    const { ctx, calls } = makeContext({ docs, workspaces: [], snapshots })

    const result = await moveSessions(ctx, {
      newWorkspace: { path: targetDir, title: 'Fresh Target' },
      sessionIds: [...sourceIds, subagentId],
      trashDir,
    })

    assert.equal(result.target.created, true)
    assert.equal(result.target.title, 'Fresh Target')
    assert.equal(result.target.path, await realpath(targetDir))
    assert.equal(result.moved.length, 2)
    assert.deepEqual(
      result.skipped.map((entry) => ({ id: entry.id, reason: entry.reason })),
      [{ id: subagentId, reason: 'subagent' }],
    )
    assert.equal(calls.created.length, 2)
    assert.equal(calls.createdWorkspaces.length, 1)
    assert.equal(calls.createdWorkspaces[0].path, await realpath(targetDir))
    assert.deepEqual(calls.deletedWorkspaces, [])
    for (const entry of result.moved) {
      const copy = docs.get(entry.sessionId)
      assert.equal(copy.header.cwd, await realpath(targetDir))
      assert.equal(copy.header.isSeeded, false)
    }
    assert.deepEqual(
      calls.attached.map((entry) => entry.workspaceId),
      [result.target.workspaceId, result.target.workspaceId],
    )
    const listed = await ctx.get('workspaceRegistry').list()
    assert.equal(listed.length, 1)
    assert.deepEqual(
      listed[0].sessionIds,
      result.moved.map((entry) => entry.sessionId),
    )
    assert.equal(await readFile(notePath, 'utf8'), 'untouched')
    assert.equal((await readdir(trashDir)).length, 2)
    for (const logPath of logPaths) {
      await assert.rejects(readFile(logPath))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('newWorkspace rejects a relative, missing or non-directory path before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const docs = new Map([
      ['session-a', { header: { version: 4, id: 'session-a', cwd: '/old', createdAt: 1 }, events: [] }],
    ])
    const filePath = join(root, 'plain.txt')
    await writeFile(filePath, 'not a directory')
    const { ctx, calls } = makeContext({ docs, workspaces: [], snapshots: [] })

    await assert.rejects(
      moveSessions(ctx, { newWorkspace: { path: 'relative/dir' }, sessionIds: ['session-a'] }),
      (error) => {
        assert.equal(error.code, 'invalid-argument')
        return true
      },
    )
    await assert.rejects(
      moveSessions(ctx, { newWorkspace: { path: join(root, 'missing') }, sessionIds: ['session-a'] }),
      (error) => {
        assert.equal(error.code, 'workspace-not-found')
        return true
      },
    )
    await assert.rejects(
      moveSessions(ctx, { newWorkspace: { path: filePath }, sessionIds: ['session-a'] }),
      (error) => {
        assert.equal(error.code, 'workspace-not-found')
        return true
      },
    )
    assert.equal(calls.created.length, 0)
    assert.equal(calls.createdWorkspaces.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('newWorkspace refuses a directory that already owns a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const docs = new Map([
      ['session-a', { header: { version: 4, id: 'session-a', cwd: '/old', createdAt: 1 }, events: [] }],
    ])
    const targetDir = join(root, 'registered')
    await mkdir(targetDir)
    // The first pass resolves through resolveByPath, the second through the
    // registry list comparison (a registry without resolveByPath).
    for (const variant of [{}, { noResolveByPath: true }]) {
      const { ctx, calls } = makeContext({
        docs,
        workspaces: [{ id: 'ws-1', path: targetDir }],
        snapshots: [],
        ...variant,
      })
      await assert.rejects(
        moveSessions(ctx, { newWorkspace: { path: targetDir }, sessionIds: ['session-a'] }),
        (error) => {
          assert.equal(error.code, 'workspace-exists')
          return true
        },
      )
      assert.equal(calls.createdWorkspaces.length, 0)
      assert.equal(calls.created.length, 0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed workspace creation writes no session copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const sourceId = 'session-create-fail'
    const paths = await makeSessionDir(root, sourceId)
    const targetDir = join(root, 'fresh')
    await mkdir(targetDir)
    const docs = new Map([
      [sourceId, { header: { version: 4, id: sourceId, cwd: '/old', createdAt: 1 }, events: [{ seq: 0, type: 'x' }] }],
    ])
    const snapshots = [{ header: docs.get(sourceId).header, location: { kind: 'jsonl', path: paths.logPath } }]

    const throwing = makeContext({ docs, workspaces: [], snapshots, createError: new Error('registry write failed') })
    await assert.rejects(
      moveSessions(throwing.ctx, { newWorkspace: { path: targetDir }, sessionIds: [sourceId] }),
      (error) => {
        assert.equal(error.code, 'workspace-create-failed')
        return true
      },
    )
    assert.equal(throwing.calls.created.length, 0)
    assert.equal((await readFile(paths.logPath)).length, 0)

    const unavailable = makeContext({ docs, workspaces: [], snapshots, noCreate: true })
    await assert.rejects(
      moveSessions(unavailable.ctx, { newWorkspace: { path: targetDir }, sessionIds: [sourceId] }),
      (error) => {
        assert.equal(error.code, 'unavailable')
        return true
      },
    )
    assert.equal(unavailable.calls.created.length, 0)
    assert.equal((await readFile(paths.logPath)).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a batch that moves nothing removes the freshly created registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const targetDir = join(root, 'fresh')
    await mkdir(targetDir)
    const docs = new Map([
      ['session-sub', { header: { version: 4, id: 'session-sub', origin: 'subagent' }, events: [] }],
      ['session-old', { header: { version: 3, id: 'session-old' }, events: [] }],
    ])
    const { ctx, calls } = makeContext({ docs, workspaces: [], snapshots: [] })

    const result = await moveSessions(ctx, {
      newWorkspace: { path: targetDir },
      sessionIds: ['session-sub', 'session-old'],
    })

    assert.equal(result.target.created, true)
    assert.equal(result.moved.length, 0)
    assert.deepEqual(
      result.skipped.map((entry) => entry.reason),
      ['subagent', 'format-version'],
    )
    assert.deepEqual(calls.deletedWorkspaces, [result.target.workspaceId])
    assert.equal((await ctx.get('workspaceRegistry').list()).length, 0)
    assert.ok(result.warnings.some((warning) => warning.includes('没有迁入任何会话')))
    assert.ok(result.warnings.some((warning) => warning.includes('已移除空注册')))
    assert.ok((await stat(targetDir)).isDirectory())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a cleanup failure stays a warning and keeps the registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const targetDir = join(root, 'fresh')
    await mkdir(targetDir)
    const docs = new Map([
      ['session-sub', { header: { version: 4, id: 'session-sub', origin: 'subagent' }, events: [] }],
    ])
    const { ctx } = makeContext({
      docs,
      workspaces: [],
      snapshots: [],
      deleteError: new Error('registry is locked'),
    })

    const result = await moveSessions(ctx, {
      newWorkspace: { path: targetDir },
      sessionIds: ['session-sub'],
    })

    assert.equal(result.target.created, true)
    assert.equal(result.moved.length, 0)
    assert.ok(result.warnings.some((warning) => warning.includes('移除空注册失败')))
    assert.equal((await ctx.get('workspaceRegistry').list()).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a registry without delete keeps the empty registration and says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-'))
  try {
    const targetDir = join(root, 'fresh')
    await mkdir(targetDir)
    const docs = new Map([
      ['session-sub', { header: { version: 4, id: 'session-sub', origin: 'subagent' }, events: [] }],
    ])
    const { ctx } = makeContext({ docs, workspaces: [], snapshots: [], noDelete: true })

    const result = await moveSessions(ctx, {
      newWorkspace: { path: targetDir },
      sessionIds: ['session-sub'],
    })

    assert.equal(result.target.created, true)
    assert.equal(result.moved.length, 0)
    assert.ok(result.warnings.some((warning) => warning.includes('不支持删除')))
    assert.equal((await ctx.get('workspaceRegistry').list()).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('move requires exactly one of workspaceId and newWorkspace', async () => {
  const docs = new Map()
  const { ctx } = makeContext({ docs, workspaces: [], snapshots: [] })
  await assert.rejects(
    moveSessions(ctx, { workspaceId: 'ws', newWorkspace: { path: tmpdir() }, sessionIds: ['x'] }),
    (error) => {
      assert.equal(error.code, 'invalid-argument')
      return true
    },
  )
  await assert.rejects(moveSessions(ctx, { sessionIds: ['x'] }), (error) => {
    assert.equal(error.code, 'invalid-argument')
    return true
  })
})
