/**
 * Route- and tool-level tests for the workspace move surface
 * (`POST /session-kit/move` and the `move` tool action).
 *
 * `lib/move.js` is injected through the test-only third `apply` argument, so
 * these cases pin the request/response contract (confirm, required workspace,
 * explicit ids, forwarding the configured trash directory) without touching a
 * real session store.
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

/** One canned move result. */
const OUTCOME = {
  target: { workspaceId: 'ws-1', path: '/tmp/ws-1', title: 'Target' },
  moved: [{ sourceId: 'session-a', sessionId: 'session-b', sourceTrashed: true, eventCount: 2, warnings: [] }],
  skipped: [{ id: 'session-c', reason: 'active', message: '仍然是活动会话' }],
  warnings: [],
}

/**
 * Create one Host-half harness with a mocked move module.
 * @param {object} [options] - behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = { route: undefined, tool: undefined, rejection: undefined, calls: [] }
  const move = {
    async moveSessions(ctx, moveOptions) {
      state.calls.push(['move', moveOptions])
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
  if (options.omitMove !== true) modules.move = move
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

test('POST /move requires confirm, workspaceId and explicit session ids', async () => {
  const harness = createHarness({ config: { trashDir: '/custom-trash' } })

  const unconfirmed = await harness.call(
    jsonRequest('POST', '/session-kit/move', { workspaceId: 'ws-1', sessionIds: ['session-a'] }),
  )
  assert.equal(unconfirmed.statusCode, 400)
  assert.equal(jsonBody(unconfirmed).code, 'confirm-required')

  const noWorkspace = await harness.call(
    jsonRequest('POST', '/session-kit/move', { sessionIds: ['session-a'], confirm: true }),
  )
  assert.equal(noWorkspace.statusCode, 400)
  assert.equal(jsonBody(noWorkspace).code, 'invalid-body')

  const noIds = await harness.call(jsonRequest('POST', '/session-kit/move', { workspaceId: 'ws-1', confirm: true }))
  assert.equal(noIds.statusCode, 400)
  assert.equal(jsonBody(noIds).code, 'invalid-argument')

  const allIds = await harness.call(
    jsonRequest('POST', '/session-kit/move', { workspaceId: 'ws-1', sessionIds: 'all', confirm: true }),
  )
  assert.equal(allIds.statusCode, 400)
  assert.equal(jsonBody(allIds).code, 'invalid-sessionIds')

  const res = await harness.call(
    jsonRequest('POST', '/session-kit/move', { workspaceId: 'ws-1', sessionIds: ['session-a'], confirm: true }),
  )
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.moved[0].sessionId, 'session-b')
  assert.deepEqual(harness.state.calls, [
    ['move', { workspaceId: 'ws-1', sessionIds: ['session-a'], trashDir: '/custom-trash' }],
  ])
})

test('/move answers 503 without the module and 403 behind the fence', async () => {
  const missing = createHarness({ omitMove: true })
  const missingRes = await missing.call(
    jsonRequest('POST', '/session-kit/move', { workspaceId: 'ws-1', sessionIds: ['session-a'], confirm: true }),
  )
  assert.equal(missingRes.statusCode, 503)
  assert.equal(jsonBody(missingRes).code, 'unavailable')

  const fenced = createHarness()
  fenced.state.rejection = 403
  const fencedRes = await fenced.call(
    jsonRequest('POST', '/session-kit/move', { workspaceId: 'ws-1', sessionIds: ['session-a'], confirm: true }),
  )
  assert.equal(fencedRes.statusCode, 403)
  assert.equal(jsonBody(fencedRes).code, 'forbidden')
  assert.equal(fenced.state.calls.length, 0)
})

test('the tool exposes move and summarizes moved and skipped sessions', async () => {
  const harness = createHarness()
  const action = harness.state.tool.parameters.properties.action
  assert.ok(action.enum.includes('move'))
  assert.match(action.description, /move: copy sessions into a destination workspace/u)
  assert.match(harness.state.tool.description, /action=move/u)
  assert.match(harness.state.tool.parameters.properties.workspaceId.description, /move: the destination workspace/u)
  assert.match(harness.state.tool.parameters.properties.confirm.description, /move: must be true/u)

  const text = await harness.state.tool.execute(
    { action: 'move', workspaceId: 'ws-1', sessionIds: ['session-a'], confirm: true },
    {},
  )
  assert.match(text, /迁移目标：Target（ws-1）→ \/tmp\/ws-1/u)
  assert.match(text, /成功 1 个，跳过 1 个/u)
  assert.match(text, /session-a → session-b/u)
  assert.match(text, /跳过 session-c：活动会话/u)
})

test('the move tool refuses a missing confirm, workspace or ids', async () => {
  const harness = createHarness()
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'move', workspaceId: 'ws-1', sessionIds: ['session-a'] }, {}),
    /move 需要 confirm:true/u,
  )
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'move', sessionIds: ['session-a'], confirm: true }, {}),
    /move 需要 workspaceId/u,
  )
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'move', workspaceId: 'ws-1', confirm: true }, {}),
    /move 需要 sessionIds/u,
  )
  assert.equal(name, 'dsh-session-kit')
})
