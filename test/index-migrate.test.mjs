/**
 * Unit tests for index.js session-format migration (route + tool action).
 *
 * The Host half is driven through the test-only third `apply` argument, so the
 * route/tool branches (id parsing, all+confirm, batch cap, per-id status/error
 * results, legacyRemaining) run without a real `lib/migrate.js` and without ever
 * touching a real session log.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, MAX_MIGRATE_BATCH, name } from '../index.js'

/** Build a response object whose end() settles a promise. */
function makeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers ?? {})
    },
  }
  let resolveDone
  res.done = new Promise((resolve) => {
    resolveDone = resolve
  })
  res.end = (body) => {
    res.body = body
    resolveDone()
  }
  return res
}

/**
 * Create one Host-half harness with fake helper modules.
 * @param {object} [options] - migrate behavior and config overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const legacyResponses = options.legacyResponses ?? [[], []]
  const statuses = options.statuses ?? {}
  const state = {
    route: undefined,
    tool: undefined,
    rejection: undefined,
    legacyCalls: 0,
    migrateCalls: [],
  }
  const sessions = options.sessions ?? {
    async detectFormatVersion() {
      return 4
    },
    servicesOf() {
      return {}
    },
    async listSessionEntries() {
      return []
    },
    async listWorkspaceEntries() {
      return []
    },
  }
  const migrate = options.migrate ?? {
    async listLegacySessionIds() {
      const index = Math.min(state.legacyCalls, legacyResponses.length - 1)
      state.legacyCalls += 1
      return [...(legacyResponses[index] ?? [])]
    },
    async migrateSession(ctx, sessionId) {
      state.migrateCalls.push(sessionId)
      return { sessionId, status: statuses[sessionId] ?? 'migrated', toVersion: 4 }
    },
  }
  const tools = {
    register(definition) {
      state.tool = definition
      return () => {}
    },
  }
  const webServer = {
    register(route) {
      state.route = route
      return () => {}
    },
  }
  const connection = {
    requestRejection() {
      return state.rejection
    },
  }
  const services = new Map([
    ['tools', tools],
    ['webServer', webServer],
    ['connection', connection],
  ])
  const ctx = {
    get(service) {
      return services.get(service)
    },
    inject(deps, callback) {
      if (deps.every((dep) => services.has(dep))) {
        callback({ get: (service) => services.get(service), effect: (fn) => fn() })
      }
      return () => {}
    },
    effect(fn) {
      return fn()
    },
  }
  apply(ctx, options.config ?? {}, {
    modules: options.omitMigrate === true ? { sessions } : { sessions, migrate },
  })
  return {
    state,
    migrate,
    async call(req) {
      const res = makeResponse()
      state.route.handler(req, res)
      await res.done
      return res
    },
  }
}

/** A POST request carrying a JSON body. */
function jsonRequest(url, payload) {
  const buffer = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    method: 'POST',
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield buffer
    },
  }
}

/** A raw request body. */
function rawRequest(url, text) {
  const buffer = Buffer.from(text, 'utf8')
  return {
    method: 'POST',
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield buffer
    },
  }
}

/** Parse a JSON response body. */
function jsonBody(res) {
  return JSON.parse(Buffer.from(res.body).toString('utf8'))
}

test('/info advertises migrate and explains the official migration path', async () => {
  const harness = createHarness()
  const res = await harness.call({ method: 'GET', url: '/session-kit/info', headers: {} })
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.plugin, name)
  assert.equal(body.capabilities.migrate, true)
  assert.equal(body.migration.official, true)
  assert.equal(body.migration.batchLimit, MAX_MIGRATE_BATCH)
  assert.match(body.migration.note, /官方/u)
})

test('/migrate upgrades explicit ids and reports both counters', async () => {
  const harness = createHarness({ legacyResponses: [['b']] })
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: ['a', 'b'] }))
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.deepEqual(body.results, [
    { sessionId: 'a', ok: true, status: 'migrated' },
    { sessionId: 'b', ok: true, status: 'migrated' },
  ])
  assert.equal(body.migratedCount, 2)
  assert.equal(body.legacyRemaining, 1, 'the re-read legacy list is reported')
  assert.deepEqual(harness.state.migrateCalls, ['a', 'b'])
  assert.equal(harness.state.legacyCalls, 1, 'explicit ids list the corpus exactly once (after the batch)')
})

test('/migrate de-duplicates ids in request order and never needs confirm for explicit ids', async () => {
  const harness = createHarness()
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: ['b', 'a', 'b', ' a '] }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(harness.state.migrateCalls, ['b', 'a'])
})

test('/migrate counts only real upgrades in migratedCount (current sessions are reported as current)', async () => {
  const harness = createHarness({ statuses: { a: 'migrated', b: 'current' } })
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: ['a', 'b'] }))
  const body = jsonBody(res)
  assert.equal(body.migratedCount, 1)
  assert.deepEqual(
    body.results.map((result) => result.status),
    ['migrated', 'current'],
  )
})

test('/migrate sessionIds="all" requires confirm:true', async () => {
  const harness = createHarness({ legacyResponses: [['a'], []] })
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: 'all' }))
  assert.equal(res.statusCode, 400)
  assert.equal(jsonBody(res).code, 'confirm-required')
  assert.deepEqual(harness.state.migrateCalls, [])
  assert.equal(harness.state.legacyCalls, 0, 'confirm is checked before reading the legacy list')
})

test('/migrate all+confirm expands the legacy list and re-reads the remainder', async () => {
  const harness = createHarness({ legacyResponses: [['a', 'b'], []] })
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: 'all', confirm: true }))
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.deepEqual(harness.state.migrateCalls, ['a', 'b'])
  assert.equal(body.migratedCount, 2)
  assert.equal(body.legacyRemaining, 0)
  assert.equal(harness.state.legacyCalls, 2)
})

test('/migrate all with no legacy sessions answers 200 with empty results', async () => {
  const harness = createHarness({ legacyResponses: [[], []] })
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: 'all', confirm: true }))
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.deepEqual(body.results, [])
  assert.equal(body.migratedCount, 0)
  assert.equal(body.legacyRemaining, 0)
  assert.deepEqual(harness.state.migrateCalls, [])
})

test('/migrate enforces the 100-session cap for explicit ids and for all', async () => {
  const ids = Array.from({ length: MAX_MIGRATE_BATCH + 1 }, (_, index) => `session-${index}`)
  const explicit = createHarness()
  const explicitRes = await explicit.call(jsonRequest('/session-kit/migrate', { sessionIds: ids }))
  assert.equal(explicitRes.statusCode, 400)
  assert.equal(jsonBody(explicitRes).code, 'too-many-sessions')
  assert.deepEqual(explicit.state.migrateCalls, [])

  const expanded = createHarness({ legacyResponses: [ids, ids] })
  const expandedRes = await expanded.call(jsonRequest('/session-kit/migrate', { sessionIds: 'all', confirm: true }))
  assert.equal(expandedRes.statusCode, 400)
  assert.equal(jsonBody(expandedRes).code, 'too-many-sessions')
  assert.deepEqual(expanded.state.migrateCalls, [])
})

test('/migrate rejects malformed bodies and invalid ids', async () => {
  const harness = createHarness()
  for (const payload of [{}, { sessionIds: [] }, { sessionIds: ['a', ''] }, { sessionIds: ['a', 7] }]) {
    const res = await harness.call(jsonRequest('/session-kit/migrate', payload))
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)}`)
    assert.equal(jsonBody(res).code, 'invalid-sessionIds')
  }
  assert.equal(jsonBody(await harness.call(rawRequest('/session-kit/migrate', '{bad'))).code, 'invalid-json')
  assert.deepEqual(harness.state.migrateCalls, [])
})

test('/migrate keeps per-id failures in results and maps a fully failed batch', async () => {
  const partial = createHarness({
    migrate: {
      async listLegacySessionIds() {
        return []
      },
      async migrateSession(ctx, sessionId) {
        if (sessionId === 'b') {
          const error = new Error('会话正在运行')
          error.code = 'active'
          throw error
        }
        return { sessionId, status: 'migrated', toVersion: 4 }
      },
    },
  })
  const partialRes = await partial.call(jsonRequest('/session-kit/migrate', { sessionIds: ['a', 'b'] }))
  assert.equal(partialRes.statusCode, 200)
  const partialBody = jsonBody(partialRes)
  assert.equal(partialBody.ok, false)
  assert.deepEqual(partialBody.results[0], { sessionId: 'a', ok: true, status: 'migrated' })
  assert.equal(partialBody.results[1].ok, false)
  assert.equal(partialBody.results[1].status, 'failed')
  assert.equal(partialBody.results[1].code, 'active')
  assert.match(partialBody.results[1].error, /正在运行/u)
  assert.equal(partialBody.migratedCount, 1)

  const forbidden = createHarness({
    migrate: {
      async listLegacySessionIds() {
        return []
      },
      async migrateSession(ctx, sessionId) {
        const error = new Error('会话不存在')
        error.code = 'not-found'
        throw error
      },
    },
  })
  assert.equal((await forbidden.call(jsonRequest('/session-kit/migrate', { sessionIds: ['x'] }))).statusCode, 404)

  const refusal = createHarness({
    migrate: {
      async listLegacySessionIds() {
        return []
      },
      async migrateSession() {
        const error = new Error('官方迁移拒绝：格式损坏')
        error.code = 'migration-failed'
        throw error
      },
    },
  })
  assert.equal((await refusal.call(jsonRequest('/session-kit/migrate', { sessionIds: ['x'] }))).statusCode, 500)
})

test('/migrate omits legacyRemaining when the corpus cannot be re-read', async () => {
  const harness = createHarness({
    migrate: {
      async listLegacySessionIds() {
        throw new Error('corpus offline')
      },
      async migrateSession(ctx, sessionId) {
        return { sessionId, status: 'migrated', toVersion: 4 }
      },
    },
  })
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: ['a'] }))
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.legacyRemaining, undefined)
})

test('/migrate all reports a legacy-list read failure as migration-failed', async () => {
  const harness = createHarness({
    migrate: {
      async listLegacySessionIds() {
        throw new Error('corpus offline')
      },
      async migrateSession() {
        return { status: 'migrated' }
      },
    },
  })
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: 'all', confirm: true }))
  assert.equal(res.statusCode, 500)
  assert.equal(jsonBody(res).code, 'migration-failed')
})

test('/migrate answers 503 when the migration module is unavailable', async () => {
  const harness = createHarness({ omitMigrate: true })
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: ['a'] }))
  assert.equal(res.statusCode, 503)
  assert.equal(jsonBody(res).code, 'unavailable')
})

test('the trust fence rejects migrate requests before parsing the body', async () => {
  const harness = createHarness()
  harness.state.rejection = 403
  const res = await harness.call(jsonRequest('/session-kit/migrate', { sessionIds: ['a'] }))
  assert.equal(res.statusCode, 403)
  assert.equal(res.body, undefined)
  assert.deepEqual(harness.state.migrateCalls, [])
})

test('the session_kit migrate tool upgrades explicit ids and summarises the remainder', async () => {
  const harness = createHarness({ legacyResponses: [['b']] })
  const text = await harness.state.tool.execute({ action: 'migrate', sessionIds: ['a', 'b'] }, {})
  assert.match(text, /升级格式/u)
  assert.match(text, /成功 2 个/u)
  assert.match(text, /实际迁移 2 个/u)
  assert.match(text, /剩余旧格式会话：1 个/u)
  assert.deepEqual(harness.state.migrateCalls, ['a', 'b'])
})

test('the session_kit migrate tool requires confirm for "all" and handles an empty legacy list', async () => {
  const guarded = createHarness({ legacyResponses: [['a'], []] })
  await assert.rejects(() => guarded.state.tool.execute({ action: 'migrate', sessionIds: 'all' }, {}), /confirm/u)
  assert.deepEqual(guarded.state.migrateCalls, [])

  const empty = createHarness({ legacyResponses: [[], []] })
  const text = await empty.state.tool.execute({ action: 'migrate', sessionIds: 'all', confirm: true }, {})
  assert.equal(text, '没有需要升级的旧格式会话')

  const expanded = createHarness({ legacyResponses: [['a'], []] })
  const expandedText = await expanded.state.tool.execute({ action: 'migrate', sessionIds: 'all', confirm: true }, {})
  assert.match(expandedText, /实际迁移 1 个/u)
})

test('the session_kit migrate tool reports per-id failures and rejects oversized batches', async () => {
  const harness = createHarness({
    migrate: {
      async listLegacySessionIds() {
        return []
      },
      async migrateSession(ctx, sessionId) {
        if (sessionId === 'b') throw new Error('官方迁移拒绝：格式损坏')
        return { sessionId, status: 'migrated', toVersion: 4 }
      },
    },
  })
  const text = await harness.state.tool.execute({ action: 'migrate', sessionIds: ['a', 'b'] }, {})
  assert.match(text, /失败 1 个/u)
  assert.match(text, /b：官方迁移拒绝/u)

  const ids = Array.from({ length: MAX_MIGRATE_BATCH + 1 }, (_, index) => `session-${index}`)
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'migrate', sessionIds: ids }, {}),
    /最多处理 100 个会话/u,
  )
  await assert.rejects(() => harness.state.tool.execute({ action: 'upgrade', sessionIds: ['a'] }, {}), /action 必须是/u)
})
