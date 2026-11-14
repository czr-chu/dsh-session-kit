/**
 * Route- and tool-level tests for whole-workspace archive/restore
 * (`GET/POST /session-kit/workspace-*` and the matching tool actions).
 *
 * The archive module is injected through the test-only third `apply` argument,
 * so these cases pin the request contract (confirm, required workspace,
 * archiveId forwarding) and the Chinese summaries; the file/manifest behavior
 * itself is covered by `test/workspace-archive.test.mjs`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

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

const ARCHIVE_OUTCOME = {
  archive: {
    archiveId: '20261114-ws-1-abc12345',
    archivedAt: '2026-11-14T00:00:00.000Z',
    workspace: { workspaceId: 'ws-1', title: 'Demo', path: '/tmp/demo' },
    sessionCount: 2,
    preArchivedCount: 1,
    pinnedCount: 0,
    status: 'ready',
  },
  archivedCount: 1,
  alreadyArchivedCount: 1,
  workspaceRemoved: true,
}

const LIST_OUTCOME = {
  archiveRoot: '/tmp/archives',
  archives: [ARCHIVE_OUTCOME.archive],
  warnings: [],
}

const RESTORE_OUTCOME = {
  archiveId: ARCHIVE_OUTCOME.archive.archiveId,
  workspace: { workspaceId: 'ws-new', title: 'Demo', path: '/tmp/demo', reused: false },
  restored: ['s1', 's2'],
  skipped: [],
  warnings: [],
  completed: true,
}

function createHarness(options = {}) {
  const state = { route: undefined, tool: undefined, rejection: undefined, calls: [] }
  const workspaceArchive = {
    async listWorkspaceArchives() {
      state.calls.push(['list'])
      return options.list ?? LIST_OUTCOME
    },
    async archiveWorkspace(ctx, archiveOptions) {
      state.calls.push(['archive', archiveOptions])
      return options.archive ?? ARCHIVE_OUTCOME
    },
    async restoreWorkspace(ctx, restoreOptions) {
      state.calls.push(['restore', restoreOptions])
      return options.restore ?? RESTORE_OUTCOME
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
  if (options.omitArchive !== true) modules.workspaceArchive = workspaceArchive
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

function jsonBody(res) {
  return JSON.parse(Buffer.from(res.body).toString('utf8'))
}

test('GET /workspace-archives lists records and forwards the module result', async () => {
  const harness = createHarness()
  const res = await harness.call(jsonRequest('GET', '/session-kit/workspace-archives'))
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.archiveRoot, '/tmp/archives')
  assert.equal(body.archives[0].status, 'ready')
  assert.deepEqual(harness.state.calls, [['list']])
})

test('POST /workspace-archive requires confirm and workspaceId, then forwards the archive', async () => {
  const harness = createHarness()

  const unconfirmed = await harness.call(jsonRequest('POST', '/session-kit/workspace-archive', { workspaceId: 'ws-1' }))
  assert.equal(unconfirmed.statusCode, 400)
  assert.equal(jsonBody(unconfirmed).code, 'confirm-required')

  const noWorkspace = await harness.call(jsonRequest('POST', '/session-kit/workspace-archive', { confirm: true }))
  assert.equal(noWorkspace.statusCode, 400)
  assert.equal(jsonBody(noWorkspace).code, 'invalid-body')

  const res = await harness.call(
    jsonRequest('POST', '/session-kit/workspace-archive', { workspaceId: 'ws-1', confirm: true }),
  )
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.ok, true)
  assert.equal(body.archive.archiveId, '20261114-ws-1-abc12345')
  assert.deepEqual(harness.state.calls, [['archive', { workspaceId: 'ws-1', confirm: true }]])
})

test('POST /workspace-restore forwards archiveId and rejects an empty one', async () => {
  const harness = createHarness()
  const missing = await harness.call(jsonRequest('POST', '/session-kit/workspace-restore', {}))
  assert.equal(missing.statusCode, 400)
  assert.equal(jsonBody(missing).code, 'invalid-body')

  const res = await harness.call(
    jsonRequest('POST', '/session-kit/workspace-restore', { archiveId: '20261114-ws-1-abc12345' }),
  )
  assert.equal(res.statusCode, 200)
  assert.equal(jsonBody(res).workspace.reused, false)
  assert.deepEqual(harness.state.calls, [['restore', { archiveId: '20261114-ws-1-abc12345' }]])
})

test('workspace archive routes answer 503 without the module and 403 behind the fence', async () => {
  const missing = createHarness({ omitArchive: true })
  const missingList = await missing.call(jsonRequest('GET', '/session-kit/workspace-archives'))
  assert.equal(missingList.statusCode, 503)
  assert.equal(jsonBody(missingList).code, 'unavailable')

  const fenced = createHarness()
  fenced.state.rejection = 403
  const fencedArchive = await fenced.call(
    jsonRequest('POST', '/session-kit/workspace-archive', { workspaceId: 'ws-1', confirm: true }),
  )
  assert.equal(fencedArchive.statusCode, 403)
  assert.equal(jsonBody(fencedArchive).code, 'forbidden')
  assert.equal(fenced.state.calls.length, 0)
})

test('the tool exposes all three actions and summarizes the Chinese results', async () => {
  const harness = createHarness()
  const action = harness.state.tool.parameters.properties.action
  assert.ok(action.enum.includes('workspace_archive_list'))
  assert.ok(action.enum.includes('workspace_archive'))
  assert.ok(action.enum.includes('workspace_restore'))
  assert.match(action.description, /workspace_archive: archive all sessions of one workspace/u)
  assert.match(harness.state.tool.description, /action=workspace_archive_list/u)
  assert.match(harness.state.tool.parameters.properties.archiveId.description, /workspace_restore/u)
  assert.match(harness.state.tool.parameters.properties.confirm.description, /workspace_archive: must be true/u)

  const listed = await harness.state.tool.execute({ action: 'workspace_archive_list' }, {})
  assert.match(listed, /工作区归档：1 个/u)
  assert.match(listed, /「Demo」/u)

  const archived = await harness.state.tool.execute(
    { action: 'workspace_archive', workspaceId: 'ws-1', confirm: true },
    {},
  )
  assert.match(archived, /已归档整个工作区「Demo」/u)
  assert.match(archived, /workspace_restore archiveId=20261114-ws-1-abc12345/u)

  const restored = await harness.state.tool.execute(
    { action: 'workspace_restore', archiveId: '20261114-ws-1-abc12345' },
    {},
  )
  assert.match(restored, /已重建工作区「Demo」/u)
  assert.match(restored, /attach 2 个会话/u)
  assert.match(restored, /归档记录已清理/u)
})

test('the tool refuses missing confirm, workspace and archiveId', async () => {
  const harness = createHarness()
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'workspace_archive', workspaceId: 'ws-1' }, {}),
    /workspace_archive 需要 confirm:true/u,
  )
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'workspace_archive', confirm: true }, {}),
    /workspace_archive 需要 workspaceId/u,
  )
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'workspace_restore' }, {}),
    /workspace_restore 需要 archiveId/u,
  )
})
