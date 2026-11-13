/**
 * Route-level tests for `POST /session-kit/export`.
 *
 * The archive builder is injected through the test-only third `apply` argument,
 * so the route contract (id scope, option merging, ZIP headers, error mapping,
 * trust fence) is exercised without building a real ZIP or reading a session
 * log. The real archive pipeline keeps its own coverage in `test/export.test.mjs`
 * and `test/workspace-files.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const ARCHIVE = Object.freeze({
  filename: 'session-kit-2-sessions-20261113.zip',
  data: Buffer.from('PK\u0003\u0004export-demo'),
  sessionCount: 2,
  eventCount: 5,
  attachmentCount: 1,
  workspaceFileCount: 3,
  workspaceBytes: 42,
  warnings: ['跳过 1 个敏感文件'],
  manifest: { mode: 'full' },
})

/**
 * Create one Host-half harness with a mocked export module.
 * @param {object} [options] - behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = {
    route: undefined,
    tool: undefined,
    rejection: undefined,
    buildCalls: [],
    listCalls: 0,
  }
  const entries = options.entries ?? [{ id: 's1' }, { id: 's2' }]
  const sessions = {
    async detectFormatVersion() {
      return 4
    },
    servicesOf() {
      return {}
    },
    async listSessionEntries() {
      state.listCalls += 1
      return entries
    },
    async listWorkspaceEntries() {
      return []
    },
  }
  const exporter = {
    async buildArchive(ctx, buildOptions) {
      state.buildCalls.push(buildOptions)
      if (typeof options.buildError === 'function') {
        const error = options.buildError(buildOptions)
        if (error !== undefined) throw error
      }
      return options.archive ?? ARCHIVE
    },
    defaultExportDirectory() {
      return '/tmp/session-kit-exports'
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
  const tools = {
    register(definition) {
      state.tool = definition
      return () => {}
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
  const modules = { sessions }
  if (options.omitExport !== true) modules.export = exporter
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
function jsonRequest(path, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return {
    method: 'POST',
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

test('/export expands "all" and streams the ZIP with its metadata headers', async () => {
  const harness = createHarness()
  const res = await harness.call(jsonRequest('/session-kit/export', { sessionIds: 'all' }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/zip')
  assert.equal(res.headers['content-length'], String(ARCHIVE.data.length))
  assert.equal(res.headers['x-session-kit-filename'], encodeURIComponent(ARCHIVE.filename))
  assert.equal(res.headers['x-session-kit-sessions'], '2')
  assert.equal(res.headers['x-session-kit-workspace-files'], '3')
  assert.deepEqual(JSON.parse(decodeURIComponent(res.headers['x-session-kit-warnings'])), ARCHIVE.warnings)
  assert.deepEqual(res.body, ARCHIVE.data)
  assert.deepEqual(harness.state.buildCalls[0].sessionIds, ['s1', 's2'])
})

test('/export trims, de-duplicates, and never coerces an explicit id list', async () => {
  const harness = createHarness()
  const res = await harness.call(jsonRequest('/session-kit/export', { sessionIds: [' s1 ', 's1', 's2'] }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(harness.state.buildCalls[0].sessionIds, ['s1', 's2'])

  const coerced = await harness.call(jsonRequest('/session-kit/export', { sessionIds: [123] }))
  assert.equal(coerced.statusCode, 400)
  assert.equal(jsonBody(coerced).code, 'invalid-sessionIds')
  assert.equal(harness.state.buildCalls.length, 1)
})

test('/export merges body options over the resolved settings', async () => {
  const harness = createHarness({ config: { defaultMode: 'full', maxExportBytes: 2048 } })
  const res = await harness.call(
    jsonRequest('/session-kit/export', {
      sessionIds: ['s1'],
      mode: 'compact',
      includeAttachments: false,
      includeWorkspaceFiles: true,
      includeSubagents: true,
      workspaceExclude: ['dist', 7],
    }),
  )
  assert.equal(res.statusCode, 200)
  const options = harness.state.buildCalls[0]
  assert.equal(options.mode, 'compact')
  assert.equal(options.includeAttachments, false)
  assert.equal(options.includeWorkspaceFiles, true)
  assert.equal(options.includeSubagents, true)
  assert.equal(options.maxExportBytes, 2048)
  assert.deepEqual(options.workspaceExclude, ['dist'])
})

test('/export accepts the compressed mode and the tool exposes all three', async () => {
  const harness = createHarness()
  const res = await harness.call(jsonRequest('/session-kit/export', { sessionIds: ['s1'], mode: 'compressed' }))
  assert.equal(res.statusCode, 200)
  assert.equal(harness.state.buildCalls[0].mode, 'compressed')
  assert.deepEqual(harness.state.tool.parameters.properties.mode.enum, ['full', 'compact', 'compressed'])
})

test('/export falls back to the configured mode and rejects a missing scope', async () => {
  const harness = createHarness({ config: { defaultMode: 'full' } })
  const res = await harness.call(jsonRequest('/session-kit/export', { sessionIds: ['s1'], mode: 'tiny' }))
  assert.equal(res.statusCode, 200)
  assert.equal(harness.state.buildCalls[0].mode, 'full')

  const missing = await harness.call(jsonRequest('/session-kit/export', {}))
  assert.equal(missing.statusCode, 400)
  assert.equal(jsonBody(missing).code, 'missing-sessions')
})

test('/export answers 503 without the export module and 403 behind the fence', async () => {
  const missing = createHarness({ omitExport: true })
  const missingRes = await missing.call(jsonRequest('/session-kit/export', { sessionIds: ['s1'] }))
  assert.equal(missingRes.statusCode, 503)
  assert.equal(jsonBody(missingRes).code, 'unavailable')

  const fenced = createHarness()
  fenced.state.rejection = 403
  const fencedRes = await fenced.call(jsonRequest('/session-kit/export', { sessionIds: ['s1'] }))
  assert.equal(fencedRes.statusCode, 403)
  assert.equal(jsonBody(fencedRes).code, 'forbidden')
  assert.equal(fenced.state.buildCalls.length, 0)

  const unauthenticated = createHarness()
  unauthenticated.state.rejection = 401
  const unauthenticatedRes = await unauthenticated.call(jsonRequest('/session-kit/export', { sessionIds: ['s1'] }))
  assert.equal(unauthenticatedRes.statusCode, 401)
  assert.equal(jsonBody(unauthenticatedRes).code, 'unauthorized')
})

test('/export reports malformed JSON as 400 and keeps the plugin name', async () => {
  const harness = createHarness()
  const res = await harness.call({
    method: 'POST',
    url: '/session-kit/export',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{not json', 'utf8')
    },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(jsonBody(res).code, 'invalid-json')
  assert.equal(name, 'dsh-session-kit')
})

test('the export tool honors includeAttachments, scope, and writes under DSH_HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-kit-export-tool-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const harness = createHarness()
    const text = await harness.state.tool.execute(
      { action: 'export', sessionIds: [' s1 '], includeAttachments: false, mode: 'full' },
      {},
    )
    const options = harness.state.buildCalls[0]
    assert.equal(options.includeAttachments, false)
    assert.deepEqual(options.sessionIds, ['s1'])
    assert.equal(options.mode, 'full')
    assert.match(text, /已导出到/u)
    const written = await stat(join(home, 'session-kit', 'exports', ARCHIVE.filename))
    assert.equal(written.isFile(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
