/**
 * Behavior tests for the official session-format migration seam.
 *
 * The unit cases drive migrateSession/listLegacySessionIds through fake
 * persistence snapshots. One guarded case copies a real released v3 artifact
 * from this repository into a throwaway JSONL backend root, migrates it through
 * persistence.open(id, 'write') + close(), and proves the v4 generation is
 * published while the v3 source file is byte-identical. That case needs the
 * repository sources (node --import tsx/esm) and is skipped otherwise.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { listLegacySessionIds, migrateSession, storedVersionOf } from '../lib/migrate.js'

/** A composed-context stand-in exposing only ctx.get(name) and ctx.logger. */
function fakeContext(services = {}) {
  return {
    get: (name) => services[name],
    logger: { warn() {} },
  }
}

/** One persistence snapshot shaped like the JSONL backend's stat/list result. */
function snapshotOf(id, options = {}) {
  const snapshot = {
    header: {
      version: Number.isSafeInteger(options.version) ? options.version : 4,
      id,
      createdAt: 1_700_000_000_000,
      cwd: '/work/demo',
      isSeeded: false,
      delegationDepth: 0,
    },
    revision: 'revision-1',
  }
  if (options.formatStatus !== undefined) snapshot.formatStatus = options.formatStatus
  if (options.path !== undefined) snapshot.location = { kind: 'jsonl', path: options.path }
  return snapshot
}

/** One fake persistence seam recording list/stat/open/close calls. */
function persistenceMock(options = {}) {
  const calls = { list: 0, stat: [], open: [], close: 0 }
  return {
    calls,
    async list() {
      calls.list += 1
      return options.snapshots === undefined ? [] : options.snapshots
    },
    async stat(id) {
      calls.stat.push(id)
      return typeof options.stat === 'function' ? options.stat(id, calls) : undefined
    },
    async open(id, mode) {
      calls.open.push([id, mode])
      if (typeof options.open === 'function') return options.open(id, mode)
      return {
        async close() {
          calls.close += 1
        },
      }
    },
  }
}

test('storedVersionOf reads the physical generation from an artifact name', () => {
  assert.equal(storedVersionOf('/root/--p--/session-a/session.v3.jsonl'), 3)
  assert.equal(storedVersionOf('/root/--p--/session-a/session.v4.jsonl.zstd'), 4)
  assert.equal(storedVersionOf('/root/--p--/session-a/session.jsonl'), 0)
  assert.equal(storedVersionOf('C:\\\\root\\\\--p--\\\\session-a\\\\session.v2.jsonl'), 2)
  assert.equal(storedVersionOf('/root/session-a/notes.jsonl'), undefined)
  assert.equal(storedVersionOf('/root/session-a/session.vX.jsonl'), undefined)
  assert.equal(storedVersionOf(undefined), undefined)
  assert.equal(storedVersionOf(''), undefined)
})

test('listLegacySessionIds filters migration-required snapshots and reports failures', async () => {
  const persistence = persistenceMock({
    snapshots: [
      snapshotOf('session-b', { formatStatus: 'migration-required' }),
      snapshotOf('session-a', { formatStatus: 'migration-required' }),
      snapshotOf('session-c', { formatStatus: 'current' }),
      snapshotOf('session-d'),
      { header: null },
      null,
    ],
  })
  assert.deepEqual(await listLegacySessionIds(fakeContext({ sessionPersistence: persistence })), [
    'session-a',
    'session-b',
  ])
  await assert.rejects(listLegacySessionIds(fakeContext()), (error) => error.code === 'unavailable')
  const broken = persistenceMock()
  broken.list = async () => {
    throw new Error('storage offline')
  }
  await assert.rejects(
    listLegacySessionIds(fakeContext({ sessionPersistence: broken })),
    (error) => error.code === 'migration-failed' && /storage offline/u.test(error.message),
  )
})

test('migrateSession reports a current session without opening a write handle', async () => {
  const current = snapshotOf('session-a', { formatStatus: 'current', path: '/root/--p--/session-a/session.v4.jsonl' })
  const persistence = persistenceMock({ stat: () => current })
  const result = await migrateSession(fakeContext({ sessionPersistence: persistence }), 'session-a')
  assert.deepEqual(result, { sessionId: 'session-a', status: 'current', toVersion: 4 })
  assert.deepEqual(persistence.calls.open, [])
  assert.equal(persistence.calls.close, 0)
  // A snapshot with no reported format status is treated as current too.
  const unreported = persistenceMock({ stat: () => snapshotOf('session-b') })
  assert.deepEqual(await migrateSession(fakeContext({ sessionPersistence: unreported }), 'session-b'), {
    sessionId: 'session-b',
    status: 'current',
    toVersion: 4,
  })
  assert.deepEqual(unreported.calls.open, [])
})

test('migrateSession publishes through open(write) + close and verifies the result', async () => {
  const legacy = snapshotOf('session-a', {
    version: 4,
    formatStatus: 'migration-required',
    path: '/root/--p--/session-a/session.v3.jsonl',
  })
  const current = snapshotOf('session-a', {
    version: 4,
    formatStatus: 'current',
    path: '/root/--p--/session-a/session.v4.jsonl',
  })
  let stats = 0
  const persistence = persistenceMock({
    stat: () => {
      stats += 1
      return stats === 1 ? legacy : current
    },
  })
  const result = await migrateSession(fakeContext({ sessionPersistence: persistence }), ' session-a ')
  assert.deepEqual(result, { sessionId: 'session-a', status: 'migrated', fromVersion: 3, toVersion: 4 })
  assert.deepEqual(persistence.calls.open, [['session-a', 'write']])
  assert.equal(persistence.calls.close, 1, 'the write handle is always closed')
  assert.deepEqual(persistence.calls.stat, ['session-a', 'session-a'])
})

test('migrateSession falls back to the logical header version when the name has none', async () => {
  const legacy = snapshotOf('session-a', {
    version: 3,
    formatStatus: 'migration-required',
    path: '/root/--p--/session-a/session.artifact',
  })
  let stats = 0
  const persistence = persistenceMock({
    stat: () => {
      stats += 1
      return stats === 1 ? legacy : snapshotOf('session-a', { version: 4, formatStatus: 'current' })
    },
  })
  assert.deepEqual(await migrateSession(fakeContext({ sessionPersistence: persistence }), 'session-a'), {
    sessionId: 'session-a',
    status: 'migrated',
    fromVersion: 3,
    toVersion: 4,
  })
})

test('migrateSession refuses missing, live, and running sessions', async () => {
  const missing = persistenceMock({ stat: () => undefined })
  await assert.rejects(
    migrateSession(fakeContext({ sessionPersistence: missing }), 'session-a'),
    (error) => error.code === 'not-found',
  )
  const noPersistence = fakeContext()
  await assert.rejects(migrateSession(noPersistence, 'session-a'), (error) => error.code === 'unavailable')
  await assert.rejects(
    migrateSession(fakeContext({ sessionPersistence: missing }), '  '),
    (error) => error.code === 'invalid-argument',
  )

  const legacyPersistence = persistenceMock({
    stat: () =>
      snapshotOf('session-a', { formatStatus: 'migration-required', path: '/root/--p--/session-a/session.v3.jsonl' }),
  })
  const liveCtx = fakeContext({
    sessionPersistence: legacyPersistence,
    sessions: { get: (id) => (id === 'session-a' ? { id } : undefined) },
  })
  await assert.rejects(migrateSession(liveCtx, 'session-a'), (error) => {
    assert.equal(error.code, 'active')
    assert.match(error.message, /活动会话/u)
    return true
  })
  assert.deepEqual(legacyPersistence.calls.open, [], 'no write open for a live session')

  const runningCtx = fakeContext({
    sessionPersistence: legacyPersistence,
    agents: { get: (id) => (id === 'session-a' ? { status: 'running' } : undefined) },
  })
  await assert.rejects(migrateSession(runningCtx, 'session-a'), (error) => {
    assert.equal(error.code, 'active')
    assert.match(error.message, /正在运行的代理/u)
    return true
  })
  assert.deepEqual(legacyPersistence.calls.open, [])
})

test('migrateSession maps official refusals to active or migration-failed', async () => {
  const legacy = () =>
    snapshotOf('session-a', { formatStatus: 'migration-required', path: '/root/--p--/session-a/session.v3.jsonl' })

  const owned = persistenceMock({
    stat: legacy,
    open: async () => {
      throw Object.assign(new Error('already owned by another handle'), { name: 'SessionAlreadyOwnedError' })
    },
  })
  await assert.rejects(
    migrateSession(fakeContext({ sessionPersistence: owned }), 'session-a'),
    (error) => error.code === 'active' && /写操作占用/u.test(error.message),
  )

  const refused = persistenceMock({
    stat: legacy,
    open: async () => {
      throw Object.assign(
        new Error(
          'format v4 cannot migrate; source v3 artifact remains unchanged (raw log: /root/--p--/session-a/session.v3.jsonl)',
        ),
        { name: 'SessionFormatUnsupportedError' },
      )
    },
  })
  await assert.rejects(migrateSession(fakeContext({ sessionPersistence: refused }), 'session-a'), (error) => {
    assert.equal(error.code, 'migration-failed')
    assert.match(error.message, /原始日志保持不变/u)
    assert.match(error.message, /source v3 artifact remains unchanged/u, 'the official reason is preserved')
    return true
  })
  assert.equal(refused.calls.close, 0, 'a refused open grants no handle to close')

  const corrupt = persistenceMock({
    stat: legacy,
    open: async () => {
      throw Object.assign(new Error('stored log is corrupt'), { name: 'SessionPersistenceCorruptionError' })
    },
  })
  await assert.rejects(
    migrateSession(fakeContext({ sessionPersistence: corrupt }), 'session-a'),
    (error) => error.code === 'migration-failed' && /官方格式迁移拒绝/u.test(error.message),
  )
})

test('migrateSession fails loudly when the published generation cannot be verified', async () => {
  const legacy = snapshotOf('session-a', {
    formatStatus: 'migration-required',
    path: '/root/--p--/session-a/session.v3.jsonl',
  })
  let stats = 0
  const stillLegacy = persistenceMock({
    stat: () => {
      stats += 1
      return stats === 1
        ? legacy
        : snapshotOf('session-a', {
            formatStatus: 'migration-required',
            path: '/root/--p--/session-a/session.v3.jsonl',
          })
    },
  })
  await assert.rejects(
    migrateSession(fakeContext({ sessionPersistence: stillLegacy }), 'session-a'),
    (error) => error.code === 'migration-failed' && /未把会话 session-a 发布为当前代际/u.test(error.message),
  )
  assert.equal(stillLegacy.calls.close, 1)

  let vanishedStats = 0
  const vanishes = persistenceMock({
    stat: () => {
      vanishedStats += 1
      return vanishedStats === 1 ? legacy : undefined
    },
  })
  await assert.rejects(
    migrateSession(fakeContext({ sessionPersistence: vanishes }), 'session-a'),
    (error) => error.code === 'migration-failed' && /在存储中消失/u.test(error.message),
  )

  let throwingStats = 0
  const throwing = persistenceMock({
    stat: () => {
      throwingStats += 1
      if (throwingStats === 1) return legacy
      throw new Error('verification read failed')
    },
  })
  await assert.rejects(
    migrateSession(fakeContext({ sessionPersistence: throwing }), 'session-a'),
    (error) => error.code === 'migration-failed' && /验证会话 session-a/u.test(error.message),
  )

  const closeFails = persistenceMock({
    stat: () => legacy,
    open: async () => ({
      async close() {
        throw new Error('lease release failed')
      },
    }),
  })
  await assert.rejects(
    migrateSession(fakeContext({ sessionPersistence: closeFails }), 'session-a'),
    (error) => error.code === 'migration-failed' && /释放写句柄失败/u.test(error.message),
  )
  assert.deepEqual(closeFails.calls.stat, ['session-a'], 'verification is skipped after a failed close')
})

/** Load the repository's real Cordis + JSONL persistence sources, or undefined outside the repo. */
async function loadRealBackend() {
  try {
    const { Context } = await import('@deepseek-ai/cordis')
    const jsonl = await import(
      new URL('../../packages/session/session-persistence-jsonl/src/index.ts', import.meta.url).href
    )
    if (typeof Context !== 'function' || typeof jsonl.apply !== 'function') return undefined
    return { Context, apply: jsonl.apply }
  } catch {
    return undefined
  }
}

/** The JSONL backend's human-navigable project directory name for one cwd. */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (const char of String(cwd)) {
    const code = char.charCodeAt(0)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/u.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return '--' + (readable.replace(/^-+/u, '') || 'root').slice(0, 251) + '--'
}

test('real released v3 fixture migrates through the official backend (guarded)', async (t) => {
  const backend = await loadRealBackend()
  if (backend === undefined) {
    t.skip('repository sources unavailable (run from the DSH repo with node --import tsx/esm)')
    return
  }
  const fixtureUrl = new URL(
    '../../packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-showcase/session.v3.jsonl',
    import.meta.url,
  )
  if (!existsSync(fixtureUrl)) {
    t.skip('released v3 fixture not found in this checkout')
    return
  }
  const raw = readFileSync(fixtureUrl, 'utf8')
  const lines = raw.trim().split('\n')
  const header = JSON.parse(lines[0])
  assert.equal(header.version, 3, 'fixture is a released v3 artifact')
  const project = projectKey(header.cwd)
  const goodId = String(header.id)
  const corruptId = 'corrupt-showcase'

  const root = mkdtempSync(join(tmpdir(), 'dsk-migrate-'))
  let ctx
  try {
    const goodDir = join(root, project, goodId)
    mkdirSync(goodDir, { recursive: true })
    writeFileSync(join(goodDir, 'session.v3.jsonl'), raw)
    const corruptHeader = { ...header, id: corruptId }
    const corruptLines = [...lines]
    corruptLines[0] = JSON.stringify(corruptHeader)
    corruptLines[Math.floor(corruptLines.length / 2)] = '{"broken":'
    const corruptDir = join(root, project, corruptId)
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'session.v3.jsonl'), corruptLines.join('\n') + '\n')

    ctx = new backend.Context({})
    await backend.apply(ctx, { root, compression: 'none', listConcurrency: 1 })
    const persistence = ctx.get('sessionPersistence')
    assert.equal(typeof persistence?.open, 'function', 'real persistence service mounted')
    const pluginContext = {
      get: (name) => (name === 'sessionPersistence' ? persistence : undefined),
      logger: { warn() {} },
    }

    assert.deepEqual(await listLegacySessionIds(pluginContext), [corruptId, goodId].sort())

    const migrated = await migrateSession(pluginContext, goodId)
    assert.deepEqual(migrated, { sessionId: goodId, status: 'migrated', fromVersion: 3, toVersion: 4 })
    const after = await persistence.stat(goodId)
    assert.equal(after?.formatStatus, 'current')
    assert.equal(after?.header?.version, 4)
    const files = readdirSync(goodDir).sort()
    assert.ok(files.includes('session.v3.jsonl'), 'the released source generation is kept')
    assert.ok(files.includes('session.v4.jsonl'), 'the current generation was published')
    assert.equal(readFileSync(join(goodDir, 'session.v3.jsonl'), 'utf8'), raw, 'the v3 artifact is byte-identical')
    // Migrating again is a no-op that reports current and opens nothing.
    assert.deepEqual(await migrateSession(pluginContext, goodId), {
      sessionId: goodId,
      status: 'current',
      toVersion: 4,
    })

    // A refused migration keeps the source artifact and leaves the session legacy.
    await assert.rejects(migrateSession(pluginContext, corruptId), (error) => {
      assert.equal(error.code, 'migration-failed')
      assert.match(error.message, /原始日志保持不变/u)
      return true
    })
    const corruptAfter = await persistence.stat(corruptId)
    assert.equal(corruptAfter?.formatStatus, 'migration-required')
    const corruptFiles = readdirSync(corruptDir).sort()
    assert.equal(corruptFiles.includes('session.v4.jsonl'), false, 'a refused migration publishes nothing')
    assert.equal(
      readFileSync(join(corruptDir, 'session.v3.jsonl'), 'utf8'),
      corruptLines.join('\n') + '\n',
      'the corrupt source is untouched',
    )
  } finally {
    try {
      await ctx?.dispose?.()
    } catch {
      // Test-only context disposal is best-effort.
    }
    rmSync(root, { recursive: true, force: true })
  }
})
