/**
 * Route- and tool-level tests for the trash surface (`/session-kit/trash*` and
 * the `trash_*` tool actions).
 *
 * The trash module is injected through the test-only third `apply` argument, so
 * these cases pin the request/response contract (validate, confirm, forward the
 * configured directory) without touching a real trash directory.
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

/** One canned inventory. */
const INVENTORY = {
  trashRoot: '/trash',
  operations: [
    {
      operationId: '2026-11-13T00-00-00-000Z',
      createdAt: '2026-11-13T00:00:00.000Z',
      restorable: true,
      sessionCount: 2,
      sessions: [{ id: 'session-a', trashedName: 'session-a', originalDir: '/sessions/--w--' }],
      archived: [],
      pinned: [],
      bytes: 4096,
      hasFiles: false,
    },
  ],
  warnings: [],
}

/**
 * Create one Host-half harness with a mocked trash module.
 * @param {object} [options] - behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = { route: undefined, tool: undefined, rejection: undefined, calls: [] }
  const trash = {
    async listTrashOperations(ctx, listOptions) {
      state.calls.push(['list', listOptions])
      return options.inventory ?? INVENTORY
    },
    async restoreTrashOperation(ctx, restoreOptions) {
      state.calls.push(['restore', restoreOptions])
      return {
        operationId: restoreOptions.operationId,
        restored: [{ id: 'session-a', path: '/sessions/--w--/session-a' }],
        skipped: [],
        warnings: [],
      }
    },
    async purgeTrashOperations(ctx, purgeOptions) {
      state.calls.push(['purge', purgeOptions])
      return { trashRoot: '/trash', removed: ['2026-11-13T00-00-00-000Z'], freedBytes: 4096, warnings: [] }
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
    async listWorkspaceEntries() {
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
  if (options.omitTrash !== true) modules.trash = trash
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

test('GET /trash returns the inventory and forwards the configured directory', async () => {
  const harness = createHarness({ config: { trashDir: '/custom-trash' } })
  const res = await harness.call(jsonRequest('GET', '/session-kit/trash'))
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.operations.length, 1)
  assert.deepEqual(harness.state.calls[0], ['list', { trashDir: '/custom-trash' }])
})

test('/trash-restore requires an operationId and forwards an explicit id subset', async () => {
  const harness = createHarness()
  const missing = await harness.call(jsonRequest('POST', '/session-kit/trash-restore', {}))
  assert.equal(missing.statusCode, 400)
  assert.equal(jsonBody(missing).code, 'invalid-body')

  const rejectedAll = await harness.call(
    jsonRequest('POST', '/session-kit/trash-restore', { operationId: 'op-1', sessionIds: 'all' }),
  )
  assert.equal(rejectedAll.statusCode, 400)
  assert.equal(jsonBody(rejectedAll).code, 'invalid-sessionIds')

  const res = await harness.call(
    jsonRequest('POST', '/session-kit/trash-restore', { operationId: 'op-1', sessionIds: ['session-a'] }),
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(jsonBody(res).restored, [{ id: 'session-a', path: '/sessions/--w--/session-a' }])
  assert.deepEqual(harness.state.calls.at(-1), ['restore', { operationId: 'op-1', sessionIds: ['session-a'] }])
})

test('/trash-purge requires confirm and a valid scope', async () => {
  const harness = createHarness()
  const unconfirmed = await harness.call(jsonRequest('POST', '/session-kit/trash-purge', { operationIds: 'all' }))
  assert.equal(unconfirmed.statusCode, 400)
  assert.equal(jsonBody(unconfirmed).code, 'confirm-required')

  const invalid = await harness.call(
    jsonRequest('POST', '/session-kit/trash-purge', { operationIds: [], confirm: true }),
  )
  assert.equal(invalid.statusCode, 400)
  assert.equal(jsonBody(invalid).code, 'invalid-argument')

  const res = await harness.call(
    jsonRequest('POST', '/session-kit/trash-purge', {
      operationIds: 'all',
      olderThanDays: 7,
      confirm: true,
    }),
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(jsonBody(res).removed, ['2026-11-13T00-00-00-000Z'])
  assert.deepEqual(harness.state.calls.at(-1), ['purge', { operationIds: 'all', confirm: true, olderThanDays: 7 }])
})

test('/trash answers 503 without the module and 403 behind the fence', async () => {
  const missing = createHarness({ omitTrash: true })
  const missingRes = await missing.call(jsonRequest('GET', '/session-kit/trash'))
  assert.equal(missingRes.statusCode, 503)
  assert.equal(jsonBody(missingRes).code, 'unavailable')

  const fenced = createHarness()
  fenced.state.rejection = 403
  const fencedRes = await fenced.call(jsonRequest('GET', '/session-kit/trash'))
  assert.equal(fencedRes.statusCode, 403)
  assert.equal(jsonBody(fencedRes).code, 'forbidden')
  assert.equal(fenced.state.calls.length, 0)
})

test('the tool exposes trash_list, trash_restore and trash_purge', async () => {
  const harness = createHarness()
  assert.ok(harness.state.tool.parameters.properties.action.enum.includes('trash_list'))
  assert.ok(harness.state.tool.parameters.properties.action.enum.includes('trash_restore'))
  assert.ok(harness.state.tool.parameters.properties.action.enum.includes('trash_purge'))
  assert.match(harness.state.tool.description, /action=trash_list/u)
  assert.match(harness.state.tool.description, /action=trash_purge/u)

  const listed = await harness.state.tool.execute({ action: 'trash_list' }, {})
  assert.match(listed, /回收站：1 个操作/u)
  assert.match(listed, /2026-11-13T00-00-00-000Z/u)

  const restored = await harness.state.tool.execute({ action: 'trash_restore', operationId: 'op-1' }, {})
  assert.match(restored, /成功 1 个会话/u)

  const purged = await harness.state.tool.execute({ action: 'trash_purge', operationIds: 'all', confirm: true }, {})
  assert.match(purged, /已永久删除 1 个操作/u)
})

test('the trash tool refuses a restore without operationId and a purge without confirm', async () => {
  const harness = createHarness()
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'trash_restore' }, {}),
    /trash_restore 需要 operationId/u,
  )
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'trash_purge', operationIds: 'all' }, {}),
    /需要 confirm:true/u,
  )
  assert.equal(name, 'dsh-session-kit')
})
