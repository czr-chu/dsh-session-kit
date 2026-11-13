/**
 * Unit tests for index.js workspace-level backup (route + tool action).
 *
 * The workspace-backup module is injected through the test-only third `apply`
 * argument, so the route/tool contract (options, ZIP headers, error mapping,
 * safe file names, summary text) is exercised without a real workspace or
 * session store.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, name } from '../index.js'
import { SessionPortFormatError } from '../lib/format.js'
import * as importModule from '../lib/import.js'

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

const DEFAULT_BACKUP = {
  filename: 'workspace-demo-2-sessions-20261108-021500.zip',
  data: Buffer.from('PK\u0003\u0004workspace-backup'),
  sessionCount: 2,
  eventCount: 7,
  attachmentCount: 1,
  workspaceFileCount: 3,
  workspaceBytes: 42,
  warnings: ['跳过 1 个工作区外文件'],
  manifest: { mode: 'full' },
  workspace: { workspaceId: 'ws-1', title: 'Demo Workspace', path: '/workspace/demo' },
}

/**
 * Create one Host-half harness with a mocked workspace-backup module.
 * @param {object} [options] - config/backup behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = {
    route: undefined,
    tool: undefined,
    rejection: undefined,
    backupCalls: [],
  }
  const sessions = {
    async detectFormatVersion() {
      return 4
    },
    servicesOf() {
      return { attachments: options.attachments }
    },
    async listSessionEntries() {
      return []
    },
    async listWorkspaceEntries() {
      return []
    },
  }
  const workspaceBackup = {
    async buildWorkspaceBackup(ctx, request) {
      state.backupCalls.push(request)
      if (options.backupError !== undefined) throw options.backupError
      if (typeof options.backupResult === 'function') return options.backupResult(request)
      return options.backupResult ?? DEFAULT_BACKUP
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
  const modules = { sessions }
  if (options.omitWorkspaceBackup !== true) modules.workspaceBackup = workspaceBackup
  // The archive reader is only needed by the empty-body /import case at the end
  // of this file; it runs before any service call, so injecting the real module
  // keeps the route contract honest without a session store.
  modules.import = importModule
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

test('/info advertises workspaceBackup and its semantics', async () => {
  const harness = createHarness()
  const res = await harness.call({ method: 'GET', url: '/session-kit/info', headers: {} })
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.plugin, name)
  assert.equal(body.capabilities.workspaceBackup, true)
  assert.equal(body.workspaceBackup.mode, 'workspace')
  assert.match(body.workspaceBackup.note, /工作区/u)
  assert.deepEqual(body.workspaceBackup.defaults, {
    mode: 'compact',
    includeAttachments: true,
    includeSubagents: false,
  })
})

test('/export-workspace streams a workspace ZIP with the expected headers', async () => {
  const harness = createHarness()
  const res = await harness.call(jsonRequest('/session-kit/export-workspace', { workspaceId: '  ws-1  ' }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/zip')
  assert.equal(res.headers['content-length'], String(DEFAULT_BACKUP.data.length))
  assert.equal(res.headers['content-disposition'], 'attachment; filename="workspace-backup.zip"')
  assert.equal(res.headers['x-session-kit-workspace'], encodeURIComponent('ws-1'))
  assert.equal(res.headers['x-session-kit-workspace-title'], encodeURIComponent('Demo Workspace'))
  assert.equal(res.headers['x-session-kit-filename'], encodeURIComponent(DEFAULT_BACKUP.filename))
  assert.equal(res.headers['x-session-kit-sessions'], '2')
  assert.equal(res.headers['x-session-kit-workspace-files'], '3')
  assert.deepEqual(JSON.parse(decodeURIComponent(res.headers['x-session-kit-warnings'])), ['跳过 1 个工作区外文件'])
  assert.deepEqual(Buffer.from(res.body), DEFAULT_BACKUP.data)
  assert.equal(harness.state.backupCalls.length, 1)
  assert.deepEqual(harness.state.backupCalls[0], {
    workspaceId: 'ws-1',
    mode: 'compact',
    includeAttachments: true,
    includeSubagents: false,
    workspaceExclude: [],
    maxExportBytes: 1024 * 1024 * 1024,
  })
})

test('/export-workspace forwards body overrides and configured limits', async () => {
  const harness = createHarness({
    config: {
      defaultMode: 'compact',
      includeAttachments: true,
      includeSubagents: true,
      workspaceExclude: ['node_modules'],
      workspaceMaxBytes: 1234,
      maxExportBytes: 9999,
    },
  })
  const res = await harness.call(
    jsonRequest('/session-kit/export-workspace', {
      workspaceId: 'ws-1',
      mode: 'full',
      includeAttachments: false,
      includeSubagents: false,
      workspaceExclude: ['*.log', ' .tmp '],
    }),
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(harness.state.backupCalls[0], {
    workspaceId: 'ws-1',
    mode: 'full',
    includeAttachments: false,
    includeSubagents: false,
    workspaceExclude: ['*.log', '.tmp'],
    workspaceMaxBytes: 1234,
    maxExportBytes: 9999,
  })
})

test('/export-workspace defaults mode to the configured default', async () => {
  const compact = createHarness()
  await compact.call(jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1' }))
  assert.equal(compact.state.backupCalls[0].mode, 'compact')

  const full = createHarness({ config: { defaultMode: 'full' } })
  await full.call(jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1' }))
  assert.equal(full.state.backupCalls[0].mode, 'full')
})

test('/export-workspace rejects a missing/blank/non-string workspaceId', async () => {
  const harness = createHarness()
  for (const payload of [{}, { workspaceId: '' }, { workspaceId: '   ' }, { workspaceId: 42 }]) {
    const res = await harness.call(jsonRequest('/session-kit/export-workspace', payload))
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)}`)
    assert.equal(jsonBody(res).code, 'invalid-argument')
  }
  assert.equal(harness.state.backupCalls.length, 0)
})

test('/export-workspace rejects an invalid mode and malformed JSON', async () => {
  const harness = createHarness()
  const badMode = await harness.call(
    jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1', mode: 'tiny' }),
  )
  assert.equal(badMode.statusCode, 400)
  assert.equal(jsonBody(badMode).code, 'invalid-argument')

  const badJson = await harness.call(rawRequest('/session-kit/export-workspace', '{not json'))
  assert.equal(badJson.statusCode, 400)
  assert.equal(jsonBody(badJson).code, 'invalid-json')
  assert.equal(harness.state.backupCalls.length, 0)
})

test('/export-workspace maps module failures and unknown errors', async () => {
  const cases = [
    ['workspace-not-found', 404],
    ['invalid-argument', 400],
    ['missing-sessions', 400],
    ['too-large', 413],
    ['unavailable', 503],
  ]
  for (const [code, expected] of cases) {
    const harness = createHarness({ backupError: new SessionPortFormatError(code, `mock ${code}`) })
    const res = await harness.call(jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1' }))
    assert.equal(res.statusCode, expected, code)
    assert.equal(jsonBody(res).code, code)
  }
  const unknown = createHarness({ backupError: new Error('disk full') })
  const unknownRes = await unknown.call(jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1' }))
  assert.equal(unknownRes.statusCode, 500)
  assert.equal(jsonBody(unknownRes).code, 'workspace-backup-failed')
})

test('/export-workspace rejects an invalid module result and sanitizes the filename', async () => {
  const missingData = createHarness({ backupResult: { filename: 'workspace.zip' } })
  const missingDataRes = await missingData.call(jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1' }))
  assert.equal(missingDataRes.statusCode, 500)
  assert.equal(jsonBody(missingDataRes).code, 'workspace-backup-failed')

  const unsafe = createHarness({
    backupResult: { ...DEFAULT_BACKUP, filename: '../escape.zip' },
  })
  const unsafeRes = await unsafe.call(jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1' }))
  assert.equal(unsafeRes.statusCode, 200)
  assert.equal(unsafeRes.headers['x-session-kit-filename'], encodeURIComponent('workspace-backup.zip'))
})

test('/export-workspace answers 503 without the module and 403 behind the fence', async () => {
  const missing = createHarness({ omitWorkspaceBackup: true })
  const missingRes = await missing.call(jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1' }))
  assert.equal(missingRes.statusCode, 503)
  assert.equal(jsonBody(missingRes).code, 'unavailable')

  const fenced = createHarness()
  fenced.state.rejection = 403
  const fencedRes = await fenced.call(jsonRequest('/session-kit/export-workspace', { workspaceId: 'ws-1' }))
  assert.equal(fencedRes.statusCode, 403)
  assert.equal(jsonBody(fencedRes).code, 'forbidden')
  assert.equal(fenced.state.backupCalls.length, 0)
})

test('the export_workspace tool writes the archive and summarises the workspace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-kit-ws-tool-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const harness = createHarness()
    const text = await harness.state.tool.execute({ action: 'export_workspace', workspaceId: 'ws-1' }, {})
    assert.match(text, /已备份工作区「Demo Workspace」/u)
    assert.match(text, /2 个会话/u)
    assert.match(text, /3 个工作区文件（42 字节）/u)
    assert.match(text, /1 个附件/u)
    assert.match(text, /模式 full/u)
    assert.match(text, /跳过 1 个工作区外文件/u)
    const path = join(home, 'session-kit', 'exports', DEFAULT_BACKUP.filename)
    assert.deepEqual(await readFile(path), DEFAULT_BACKUP.data)
    assert.deepEqual(harness.state.backupCalls[0], {
      workspaceId: 'ws-1',
      mode: 'compact',
      includeAttachments: true,
      includeSubagents: false,
      workspaceExclude: [],
      maxExportBytes: 1024 * 1024 * 1024,
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the export_workspace tool writes one ZIP per workspace and reports per-item results', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-kit-ws-batch-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const harness = createHarness({
      backupResult: (request) => ({
        ...DEFAULT_BACKUP,
        filename: `workspace-${request.workspaceId}-2-sessions-20261108-021500.zip`,
        data: Buffer.from(`PK-workspace-${request.workspaceId}`),
        workspace: {
          workspaceId: request.workspaceId,
          title: request.workspaceId === 'ws-1' ? 'Demo Workspace' : 'Second Workspace',
        },
      }),
    })
    const text = await harness.state.tool.execute(
      { action: 'export_workspace', workspaceIds: ['ws-1', ' ws-2 ', 'ws-1'], workspaceId: 'ignored' },
      {},
    )
    assert.match(text, /已备份 2 个工作区/u)
    assert.match(text, /「Demo Workspace」/u)
    assert.match(text, /「Second Workspace」/u)
    assert.deepEqual(
      harness.state.backupCalls.map((call) => call.workspaceId),
      ['ws-1', 'ws-2'],
    )
    assert.deepEqual(
      await readFile(join(home, 'session-kit', 'exports', 'workspace-ws-1-2-sessions-20261108-021500.zip')),
      Buffer.from('PK-workspace-ws-1'),
    )
    assert.deepEqual(
      await readFile(join(home, 'session-kit', 'exports', 'workspace-ws-2-2-sessions-20261108-021500.zip')),
      Buffer.from('PK-workspace-ws-2'),
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the export_workspace tool validates workspaceIds and keeps the single-id form', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-kit-ws-batch-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const harness = createHarness()
    await assert.rejects(
      () => harness.state.tool.execute({ action: 'export_workspace', workspaceIds: [''] }, {}),
      /workspaceIds/u,
    )
    const tooMany = Array.from({ length: 21 }, (_, index) => `ws-${index}`)
    await assert.rejects(
      () => harness.state.tool.execute({ action: 'export_workspace', workspaceIds: tooMany }, {}),
      /最多备份 20 个工作区/u,
    )
    assert.equal(harness.state.backupCalls.length, 0)
    const text = await harness.state.tool.execute(
      { action: 'export_workspace', workspaceIds: [], workspaceId: 'ws-1' },
      {},
    )
    assert.match(text, /已备份工作区「Demo Workspace」/u)
    assert.equal(harness.state.backupCalls.length, 1)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the export_workspace tool requires workspaceId, validates mode, and sanitizes the file name', async () => {
  const harness = createHarness()
  await assert.rejects(() => harness.state.tool.execute({ action: 'export_workspace' }, {}), /workspaceId/u)
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'export_workspace', workspaceId: 'ws-1', mode: 'tiny' }, {}),
    /mode 必须是/u,
  )
  assert.equal(harness.state.backupCalls.length, 0)

  const home = await mkdtemp(join(tmpdir(), 'session-kit-ws-safe-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const unsafe = createHarness({
      backupResult: { ...DEFAULT_BACKUP, filename: '../escape.zip' },
    })
    const text = await unsafe.state.tool.execute({ action: 'export_workspace', workspaceId: 'ws-1' }, {})
    assert.match(text, /workspace-backup\.zip/u)
    await stat(join(home, 'session-kit', 'exports', 'workspace-backup.zip'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the export_workspace tool surfaces module failures and a missing module', async () => {
  const failing = createHarness({ backupError: new SessionPortFormatError('workspace-not-found', '找不到工作区') })
  await assert.rejects(
    () => failing.state.tool.execute({ action: 'export_workspace', workspaceId: 'missing' }, {}),
    /工作区备份失败：找不到工作区/u,
  )
  const missing = createHarness({ omitWorkspaceBackup: true })
  await assert.rejects(
    () => missing.state.tool.execute({ action: 'export_workspace', workspaceId: 'ws-1' }, {}),
    /模块不可用/u,
  )
})

test('the tool schema exposes export_workspace and its options', async () => {
  const harness = createHarness()
  const schema = harness.state.tool.parameters
  assert.ok(schema.properties.action.enum.includes('export_workspace'))
  assert.equal(schema.properties.workspaceId.type, 'string')
  assert.equal(schema.properties.workspaceIds.type, 'array')
  assert.equal(schema.properties.workspaceIds.items.type, 'string')
  assert.equal(schema.properties.mode.type, 'string')
  assert.equal(schema.properties.includeAttachments.type, 'boolean')
  assert.equal(schema.properties.includeSubagents.type, 'boolean')
  assert.equal(schema.properties.workspaceExclude.type, 'array')
  assert.match(harness.state.tool.description, /action=export_workspace/u)
})

test('session-scoped export/import routes keep their existing behavior', async () => {
  const harness = createHarness()
  const missingSessions = await harness.call(jsonRequest('/session-kit/export', {}))
  assert.equal(missingSessions.statusCode, 400)
  assert.equal(jsonBody(missingSessions).code, 'missing-sessions')

  const emptyImport = await harness.call(rawRequest('/session-kit/import', ''))
  assert.equal(emptyImport.statusCode, 400)
  assert.equal(jsonBody(emptyImport).code, 'empty-file')

  const notFound = await harness.call(jsonRequest('/session-kit/unknown', {}))
  assert.equal(notFound.statusCode, 404)
})
