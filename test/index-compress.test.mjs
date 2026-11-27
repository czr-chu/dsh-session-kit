/**
 * Route- and tool-level tests for the session compression surface
 * (`POST /session-kit/compress` and the `compress` tool action).
 *
 * `lib/compress.js` is injected through the test-only third `apply` argument,
 * so these cases pin the request/response contract (confirm, mode default and
 * validation, explicit ids, forwarding the configured trash directory, error
 * mapping, tool schema and summary text) without touching a real session store.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, MAX_COMPRESS_BATCH } from '../index.js'
import { SessionPortFormatError } from '../lib/format.js'

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

/** One canned compressed-mode result. */
const OUTCOME = {
  mode: 'compressed',
  compressed: [{ sourceId: 'session-a', sessionId: 'session-b', sourceTrashed: true, eventCount: 2, warnings: [] }],
  skipped: [{ id: 'session-c', reason: 'active', message: '仍然是活动会话' }],
  warnings: ['源会话已移入回收站，可从回收站恢复'],
}

/** One canned compact-mode result. */
const COMPACT_OUTCOME = {
  mode: 'compact',
  compressed: [{ sourceId: 'session-a', sessionId: 'session-d', sourceTrashed: true, eventCount: 1 }],
  skipped: [],
  warnings: [],
}

/**
 * Create one Host-half harness with a mocked compress module.
 * @param {object} [options] - behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = { route: undefined, tool: undefined, rejection: undefined, calls: [] }
  const compress = {
    async compressSessions(ctx, compressOptions) {
      state.calls.push(['compress', compressOptions])
      if (options.failure !== undefined) throw options.failure
      return options.outcome ?? OUTCOME
    },
  }
  const webServer = {
    register(route) {
      state.route = route
      return () => {}
    },
  }
  const tools = {
    register(definition) {
      state.tool = definition
      return () => {}
    },
  }
  const connection = { requestRejection: () => state.rejection }
  const sessions = {
    async detectFormatVersion() {
      return 4
    },
    servicesOf() {
      return {}
    },
  }
  const services = new Map([
    ['tools', tools],
    ['webServer', webServer],
    ['connection', connection],
  ])
  const ctx = {
    get: (service) => services.get(service),
    inject(deps, callback) {
      if (deps.every((dep) => services.has(dep))) {
        callback({ get: (service) => services.get(service), effect: (fn) => fn() })
      }
      return () => {}
    },
    effect: (fn) => fn(),
  }
  const modules = { sessions }
  if (options.omitCompress !== true) modules.compress = compress
  apply(ctx, options.config ?? {}, { modules })
  return {
    state,
    async call(req) {
      const res = makeResponse()
      state.route.handler(req, res)
      await res.done
      return res
    },
  }
}

/** Build one JSON request accepted by the prefix handler. */
function jsonRequest(method, path, payload) {
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      yield body
    },
  }
}

/** Decode a JSON response body. */
function jsonBody(res) {
  return JSON.parse(Buffer.from(res.body).toString('utf8'))
}

test('POST /compress requires confirm and an explicit id list', async () => {
  const harness = createHarness({ config: { trashDir: '/custom-trash' } })

  const unconfirmed = await harness.call(
    jsonRequest('POST', '/session-kit/compress', { sessionIds: ['session-a'], mode: 'compressed' }),
  )
  assert.equal(unconfirmed.statusCode, 400)
  assert.equal(jsonBody(unconfirmed).code, 'confirm-required')

  const noIds = await harness.call(jsonRequest('POST', '/session-kit/compress', { confirm: true }))
  assert.equal(noIds.statusCode, 400)
  assert.equal(jsonBody(noIds).code, 'invalid-argument')

  const allIds = await harness.call(jsonRequest('POST', '/session-kit/compress', { sessionIds: 'all', confirm: true }))
  assert.equal(allIds.statusCode, 400)
  assert.equal(jsonBody(allIds).code, 'invalid-sessionIds')

  const emptyIds = await harness.call(jsonRequest('POST', '/session-kit/compress', { sessionIds: [], confirm: true }))
  assert.equal(emptyIds.statusCode, 400)
  assert.equal(jsonBody(emptyIds).code, 'invalid-sessionIds')

  assert.equal(harness.state.calls.length, 0)
})

test('POST /compress defaults to compressed and forwards the batch', async () => {
  const harness = createHarness({ config: { trashDir: '/custom-trash' } })
  const res = await harness.call(
    jsonRequest('POST', '/session-kit/compress', { sessionIds: ['session-a'], confirm: true }),
  )
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.mode, 'compressed')
  assert.deepEqual(body.compressed, OUTCOME.compressed)
  assert.deepEqual(body.skipped, OUTCOME.skipped)
  assert.deepEqual(body.warnings, OUTCOME.warnings)
  assert.deepEqual(harness.state.calls, [
    ['compress', { sessionIds: ['session-a'], mode: 'compressed', trashDir: '/custom-trash' }],
  ])
})

test('POST /compress accepts compact and reports the core mode', async () => {
  const harness = createHarness({ outcome: COMPACT_OUTCOME })
  const res = await harness.call(
    jsonRequest('POST', '/session-kit/compress', {
      sessionIds: ['session-a'],
      mode: 'compact',
      confirm: true,
    }),
  )
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.mode, 'compact')
  assert.equal(body.compressed[0].sessionId, 'session-d')
  assert.deepEqual(harness.state.calls, [['compress', { sessionIds: ['session-a'], mode: 'compact' }]])
})

test('POST /compress refuses an invalid mode', async () => {
  const harness = createHarness()
  for (const mode of ['full', 'detailed', 42]) {
    const res = await harness.call(
      jsonRequest('POST', '/session-kit/compress', { sessionIds: ['session-a'], mode, confirm: true }),
    )
    assert.equal(res.statusCode, 400, String(mode))
    assert.equal(jsonBody(res).code, 'invalid-argument')
  }
  assert.equal(harness.state.calls.length, 0)
})

test('POST /compress caps the batch', async () => {
  const harness = createHarness()
  const ids = Array.from({ length: MAX_COMPRESS_BATCH + 1 }, (_, index) => `session-${index}`)
  const res = await harness.call(jsonRequest('POST', '/session-kit/compress', { sessionIds: ids, confirm: true }))
  assert.equal(res.statusCode, 400)
  assert.equal(jsonBody(res).code, 'too-many-sessions')
  assert.equal(harness.state.calls.length, 0)
})

test('POST /compress maps core failures to stable statuses', async () => {
  const cases = [
    ['invalid-argument', 400],
    ['compress-failed', 500],
    ['unavailable', 503],
  ]
  for (const [code, status] of cases) {
    const harness = createHarness({ failure: new SessionPortFormatError(code, `core says ${code}`) })
    const res = await harness.call(
      jsonRequest('POST', '/session-kit/compress', { sessionIds: ['session-a'], confirm: true }),
    )
    assert.equal(res.statusCode, status, code)
    assert.equal(jsonBody(res).code, code)
  }
})

test('/compress answers 503 without the module and 403 behind the fence', async () => {
  const missing = createHarness({ omitCompress: true })
  const missingRes = await missing.call(
    jsonRequest('POST', '/session-kit/compress', { sessionIds: ['session-a'], confirm: true }),
  )
  assert.equal(missingRes.statusCode, 503)
  assert.equal(jsonBody(missingRes).code, 'unavailable')

  const fenced = createHarness()
  fenced.state.rejection = 403
  const fencedRes = await fenced.call(
    jsonRequest('POST', '/session-kit/compress', { sessionIds: ['session-a'], confirm: true }),
  )
  assert.equal(fencedRes.statusCode, 403)
  assert.equal(jsonBody(fencedRes).code, 'forbidden')
  assert.equal(fenced.state.calls.length, 0)
})

test('the tool exposes compress with mode and confirm documentation', async () => {
  const harness = createHarness()
  const tool = harness.state.tool
  assert.match(tool.description, /action=compress/u)
  assert.match(tool.description, /NEW session ids/u)
  assert.match(tool.description, /trash/u)
  assert.match(tool.description, /mode=compact keeps only user messages and final answers/u)
  assert.match(tool.description, /mode=compressed keeps every event and tool-call structure/u)
  assert.match(tool.description, /Live\/running sessions, subagent transcripts and older-format logs are skipped/u)

  const action = tool.parameters.properties.action
  assert.ok(action.enum.includes('compress'))
  assert.match(action.description, /compress: create compact\/compressed copies under new ids/u)
  assert.deepEqual(tool.parameters.properties.mode.enum, ['full', 'compact', 'compressed'])
  assert.match(tool.parameters.properties.mode.description, /compress: compact keeps only user messages/u)
  assert.match(tool.parameters.properties.confirm.description, /compress: must be true/u)
  assert.match(tool.parameters.properties.sessionIds.description, /move\/compress/u)
})

test('the compress tool defaults to compressed and summarizes the batch', async () => {
  const harness = createHarness({ config: { trashDir: '/custom-trash' } })
  const text = await harness.state.tool.execute({ action: 'compress', sessionIds: ['session-a'], confirm: true }, {})
  assert.match(text, /压缩模式：compressed（保留全部事件与工具结构/u)
  assert.match(text, /压缩：成功 1 个，跳过 1 个/u)
  assert.match(text, /session-a → session-b（2 个事件，源会话已移入回收站）/u)
  assert.match(text, /跳过 session-c：活动会话/u)
  assert.match(text, /注意：源会话已移入回收站/u)
  assert.deepEqual(harness.state.calls, [
    ['compress', { sessionIds: ['session-a'], mode: 'compressed', trashDir: '/custom-trash' }],
  ])
})

test('the compress tool forwards compact and reports a kept source', async () => {
  const harness = createHarness({
    outcome: {
      mode: 'compact',
      compressed: [{ sourceId: 'session-a', sessionId: 'session-d', sourceTrashed: false, eventCount: 1 }],
      skipped: [],
      warnings: ['源会话没有移入回收站：权限不足'],
    },
  })
  const text = await harness.state.tool.execute(
    { action: 'compress', sessionIds: ['session-a'], mode: 'compact', confirm: true },
    {},
  )
  assert.match(text, /压缩模式：compact（仅保留用户消息与最终回答/u)
  assert.match(text, /session-a → session-d（1 个事件，源会话仍在原位置（见警告））/u)
  assert.match(text, /注意：源会话没有移入回收站/u)
  assert.deepEqual(harness.state.calls, [['compress', { sessionIds: ['session-a'], mode: 'compact' }]])
})

test('the compress tool refuses confirm, mode and id problems', async () => {
  const harness = createHarness()
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'compress', sessionIds: ['session-a'] }, {}),
    /compress 需要 confirm:true/u,
  )
  await assert.rejects(
    () =>
      harness.state.tool.execute({ action: 'compress', sessionIds: ['session-a'], mode: 'full', confirm: true }, {}),
    /mode 必须是 "compact" 或 "compressed"/u,
  )
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'compress', confirm: true }, {}),
    /compress 需要 sessionIds/u,
  )
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'compress', sessionIds: 'all', confirm: true }, {}),
    /不允许 "all"/u,
  )
  const ids = Array.from({ length: MAX_COMPRESS_BATCH + 1 }, (_, index) => `session-${index}`)
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'compress', sessionIds: ids, confirm: true }, {}),
    /一次最多处理 100 个会话/u,
  )
  assert.equal(harness.state.calls.length, 0)
})
