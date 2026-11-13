/**
 * Route- and tool-level tests for the read-only attachment report
 * (`GET /session-kit/attachment-report` and the `attachment_report` action).
 *
 * The report module is injected through the test-only third `apply` argument,
 * so these cases pin request parsing, response shape and the tool text without
 * scanning a real store.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name } from '../index.js'

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

/** One canned report. */
const REPORT = {
  scannedSessions: 2,
  sessionTotal: 5,
  limit: 300,
  truncated: true,
  totalReferences: 4,
  missing: [
    {
      sessionId: 'session-a',
      kind: 'image',
      attachmentId: 'img-gone',
      reason: 'not-found',
    },
    {
      sessionId: 'session-b',
      kind: 'file',
      attachmentId: 'sha256:abc',
      name: 'gone.txt',
      reason: 'not-found',
    },
  ],
  unverifiable: 1,
  warnings: ['示例警告'],
}

/**
 * Create one Host-half harness with a mocked attachment-report module.
 * @param {object} [options] - behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = { route: undefined, tool: undefined, rejection: undefined, calls: [] }
  const attachmentReport = {
    async reportAttachmentReferences(ctx, reportOptions) {
      state.calls.push(reportOptions)
      return options.report ?? REPORT
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
    async listSessionEntries() {
      return []
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
  if (options.omitReport !== true) modules.attachmentReport = attachmentReport
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

/** Build one request accepted by the prefix handler. */
function request(method, path) {
  return {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(0)
    },
  }
}

/** Decode a JSON response body. */
function jsonBody(res) {
  return JSON.parse(Buffer.from(res.body).toString('utf8'))
}

test('GET /attachment-report forwards limit and includeSubagents', async () => {
  const harness = createHarness()
  const res = await harness.call(request('GET', '/session-kit/attachment-report?limit=5&includeSubagents=1'))
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.scannedSessions, 2)
  assert.equal(body.missing.length, 2)
  assert.deepEqual(harness.state.calls[0], { limit: 5, includeSubagents: true })

  const defaults = createHarness()
  await defaults.call(request('GET', '/session-kit/attachment-report'))
  assert.deepEqual(defaults.state.calls[0], { includeSubagents: false })
})

test('GET /attachment-report rejects a non-positive limit', async () => {
  const harness = createHarness()
  const res = await harness.call(request('GET', '/session-kit/attachment-report?limit=0'))
  assert.equal(res.statusCode, 400)
  assert.equal(jsonBody(res).code, 'invalid-argument')
})

test('/attachment-report answers 503 without the module and 403 behind the fence', async () => {
  const missing = createHarness({ omitReport: true })
  const missingRes = await missing.call(request('GET', '/session-kit/attachment-report'))
  assert.equal(missingRes.statusCode, 503)
  assert.equal(jsonBody(missingRes).code, 'unavailable')

  const fenced = createHarness()
  fenced.state.rejection = 403
  const fencedRes = await fenced.call(request('GET', '/session-kit/attachment-report'))
  assert.equal(fencedRes.statusCode, 403)
  assert.equal(jsonBody(fencedRes).code, 'forbidden')
  assert.equal(fenced.state.calls.length, 0)
})

test('the tool exposes attachment_report and renders the report', async () => {
  const harness = createHarness()
  const action = harness.state.tool.parameters.properties.action
  assert.ok(action.enum.includes('attachment_report'))
  assert.match(harness.state.tool.description, /action=attachment_report/u)
  assert.equal(harness.state.tool.parameters.properties.limit.type, 'integer')

  const text = await harness.state.tool.execute({ action: 'attachment_report', limit: 2 }, {})
  assert.match(text, /扫描 2 \/ 5 个会话/u)
  assert.match(text, /缺失 2 个，无法验证 1 个/u)
  assert.match(text, /会话 session-a：图片 img-gone/u)
  assert.match(text, /会话 session-b：文件 gone.txt/u)
  assert.match(text, /示例警告/u)
  assert.deepEqual(harness.state.calls.at(-1), { limit: 2 })
})

test('the attachment_report tool rejects an invalid limit', async () => {
  const harness = createHarness()
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'attachment_report', limit: 0 }, {}),
    /limit 必须是正整数/u,
  )
  assert.equal(name, 'dsh-session-kit')
})
