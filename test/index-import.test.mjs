/**
 * Route-level tests for `POST /session-kit/import`.
 *
 * Most cases inject a fake archive reader through the test-only third `apply`
 * argument and assert what the route passes it (body bounds, query parsing,
 * restore flag, response envelope). The last case uploads a real, minimal
 * plugin archive and runs the real `lib/import.js` against a fake persistence
 * backend, so the route→importer wiring is proven end to end without a DSH
 * process or a real session store.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { apply, name } from '../index.js'
import { SessionPortFormatError, serializeSessionLog } from '../lib/format.js'
import { writeZipEntries } from '../lib/zip.js'

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
  res.chunks = []
  res.write = (chunk) => {
    res.chunks.push(Buffer.from(chunk).toString('utf8'))
    return true
  }
  res.end = (body) => {
    res.body = body
    resolveDone()
  }
  return res
}

/** sha256 hex of a Buffer. */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Create one Host-half harness with a mocked import module and fake services.
 * @param {object} [options] - behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = {
    route: undefined,
    rejection: undefined,
    importCalls: [],
    written: [],
  }
  const persistence = {
    async list() {
      return state.written.map((record) => ({ id: record.header.id, header: record.header }))
    },
    async stat() {
      return undefined
    },
    async create(header) {
      const record = { header, events: [] }
      state.written.push(record)
      return {
        id: header.id,
        header,
        async append(events) {
          record.events.push(...events)
        },
        async flush() {},
        async close() {},
      }
    },
  }
  const sessionQuery = {
    async listSessions() {
      return []
    },
    async readSession(id) {
      return { session: { id }, events: [] }
    },
  }
  const sessions = {
    async detectFormatVersion() {
      return 4
    },
    servicesOf() {
      return {
        sessionPersistence: persistence,
        sessionQuery,
        workingDirectory: { defaultDirectory: tmpdir() },
      }
    },
  }
  const importer = {
    async importArchive(ctx, importOptions) {
      state.importCalls.push(importOptions)
      if (typeof importOptions.onProgress === 'function' && Array.isArray(options.progressEvents)) {
        for (const entry of options.progressEvents) await importOptions.onProgress(entry)
      }
      if (options.importError !== undefined) throw options.importError
      return (
        options.importResult ?? {
          sessions: [{ sessionId: 'session-new' }],
          warnings: [],
          restoredFiles: 0,
          restoredBytes: 0,
          skipped: 0,
        }
      )
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
    ['tools', { register: () => () => {} }],
    ['webServer', webServer],
    ['connection', connection],
    ['sessionQuery', sessionQuery],
    ['sessionPersistence', persistence],
    ['sessions', {}],
    ['workingDirectory', { defaultDirectory: tmpdir() }],
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
  if (options.omitImport !== true) modules.import = importer
  if (options.realModules === true) {
    // No injection seam at all: the Host resolves the real lib/sessions.js and
    // lib/import.js against the fake Cordis services above.
    apply(ctx, options.config ?? {})
  } else {
    apply(ctx, options.config ?? {}, { modules })
  }
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

/** Build one raw upload request. */
function uploadRequest(path, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
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

test('/import forwards the upload, query target, and restore flag', async () => {
  const harness = createHarness({ config: { maxImportBytes: 4096 } })
  const res = await harness.call(
    uploadRequest('/session-kit/import?filename=a.zip&cwd=/ws&workspaceId=ws-1&restoreWorkspaceFiles=1', 'PK-demo'),
  )
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.sessions.length, 1)
  assert.equal(body.sessions[0].sessionId, 'session-new')

  const options = harness.state.importCalls[0]
  assert.equal(Buffer.from(options.buffer).toString('utf8'), 'PK-demo')
  assert.equal(options.cwd, '/ws')
  assert.equal(options.workspaceId, 'ws-1')
  assert.equal(options.restoreWorkspaceFiles, true)
  assert.equal(options.maxImportBytes, 4096)
})

test('/import parses the restore flag like the panel does', async () => {
  const cases = [
    ['', false],
    ['0', false],
    ['false', false],
    ['1', true],
    ['true', true],
    ['TRUE', true],
  ]
  for (const [raw, expected] of cases) {
    const harness = createHarness()
    const query = raw === '' ? '?filename=a.zip' : `?filename=a.zip&restoreWorkspaceFiles=${raw}`
    await harness.call(uploadRequest(`/session-kit/import${query}`, 'PK-demo'))
    assert.equal(
      harness.state.importCalls[0].restoreWorkspaceFiles,
      expected,
      `restoreWorkspaceFiles=${JSON.stringify(raw)}`,
    )
  }

  const configured = createHarness({ config: { restoreWorkspaceFiles: true } })
  await configured.call(uploadRequest('/session-kit/import?filename=a.zip', 'PK-demo'))
  assert.equal(configured.state.importCalls[0].restoreWorkspaceFiles, true)
})

test('/import streams NDJSON progress and forwards skipDuplicates', async () => {
  const harness = createHarness({
    progressEvents: [{ index: 1, total: 1, sessionId: 'session-new', mode: 'full', verified: true, warnings: [] }],
  })
  const res = await harness.call(
    uploadRequest('/session-kit/import?filename=a.zip&skipDuplicates=1&progress=ndjson', 'PK-demo'),
  )
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /application\/x-ndjson/u)
  const events = res.chunks
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(events.length, 2)
  assert.deepEqual(events[0], {
    event: 'session',
    index: 1,
    total: 1,
    sessionId: 'session-new',
    mode: 'full',
    verified: true,
    warnings: [],
  })
  assert.equal(events[1].event, 'done')
  assert.equal(events[1].ok, true)
  assert.equal(harness.state.importCalls[0].skipDuplicates, true)
})

test('/import reports a streaming failure as a final NDJSON error event', async () => {
  const harness = createHarness({
    importError: new SessionPortFormatError('no-session', '压缩包里的会话都已存在，且已选择跳过重复项'),
  })
  const res = await harness.call(uploadRequest('/session-kit/import?progress=ndjson', 'PK-demo'))
  assert.equal(res.statusCode, 200)
  const events = res.chunks
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'error')
  assert.equal(events[0].ok, false)
  assert.equal(events[0].code, 'no-session')
})

test('/import rejects an oversized upload with 413 before reading the archive', async () => {
  const harness = createHarness({ config: { maxImportBytes: 8 } })
  const res = await harness.call(uploadRequest('/session-kit/import?filename=a.zip', 'PK-way-too-large'))
  assert.equal(res.statusCode, 413)
  assert.equal(jsonBody(res).code, 'too-large')
  assert.equal(harness.state.importCalls.length, 0)
})

test('/import answers 503 without the import module and 403 behind the fence', async () => {
  const missing = createHarness({ omitImport: true })
  const missingRes = await missing.call(uploadRequest('/session-kit/import?filename=a.zip', 'PK-demo'))
  assert.equal(missingRes.statusCode, 503)
  assert.equal(jsonBody(missingRes).code, 'unavailable')

  const fenced = createHarness()
  fenced.state.rejection = 403
  const fencedRes = await fenced.call(uploadRequest('/session-kit/import?filename=a.zip', 'PK-demo'))
  assert.equal(fencedRes.statusCode, 403)
  assert.equal(jsonBody(fencedRes).code, 'forbidden')
  assert.equal(fenced.state.importCalls.length, 0)
})

/**
 * Build one minimal but valid plugin archive (manifest + one full log).
 * @param {string} id - source session id.
 * @returns {Buffer} ZIP bytes.
 */
function buildMinimalArchive(id = 'src-1') {
  const header = { version: 4, id, createdAt: 1000, cwd: '/source/ws', isSeeded: false, delegationDepth: 0 }
  const events = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 11,
      data: { id: 'msg-1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
    },
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const logName = `sessions/${id}/session.v4.jsonl`
  const logData = Buffer.from(serializeSessionLog(header, events), 'utf8')
  const manifest = {
    manifestVersion: 1,
    kind: 'dsh-session-kit',
    createdAt: '2026-11-13T00:00:00.000Z',
    source: { sessionFormatVersion: 4, compression: 'deflate' },
    mode: 'full',
    sessions: [
      {
        id,
        title: 'demo',
        cwd: '/source/ws',
        createdAt: 1000,
        updatedAt: 1000,
        formatVersion: 4,
        mode: 'full',
        eventCount: events.length,
        log: logName,
        logSha256: sha256(logData),
        attachments: [],
      },
    ],
    attachments: [],
    checksums: { algorithm: 'sha256', files: { [logName]: sha256(logData) } },
  }
  return writeZipEntries([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: logName, data: logData },
  ])
}

test('/import creates a real session from a real archive through the route', async () => {
  const harness = createHarness({ realModules: true })
  const archive = buildMinimalArchive('src-1')
  const res = await harness.call(uploadRequest(`/session-kit/import?filename=demo.zip&cwd=${tmpdir()}`, archive))
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.sessions.length, 1)
  assert.equal(typeof body.sessions[0].sessionId, 'string')

  assert.equal(harness.state.written.length, 1)
  const written = harness.state.written[0]
  assert.equal(written.header.cwd, tmpdir())
  assert.notEqual(written.header.id, 'src-1', 'the imported session gets a fresh id')
  assert.equal(written.events.length, 3)
  assert.equal(name, 'dsh-session-kit')
})
