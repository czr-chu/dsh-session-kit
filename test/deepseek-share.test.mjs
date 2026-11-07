/**
 * Behavior tests for DeepSeek share-link import.
 *
 * Network is always mocked. The build output is validated structurally, parsed
 * back as canonical JSONL, and (guarded) written to the real JSONL backend so
 * the produced log is proven to be an importable v4 session.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildShareSession, fetchShare, importShare, parseShareInput } from '../lib/deepseek-share.js'
import { parseSessionLog, validateEvents } from '../lib/format.js'
import { createRealBackend, replayValidate, writeAndReadBack } from './support/real-backend.mjs'

/** One public share payload with every fragment type the importer maps. */
function sharePayload() {
  return {
    code: 0,
    msg: '',
    data: {
      biz_data: {
        title: '演示分享',
        model_type: 'deepseek_v3',
        messages: [
          {
            message_id: 1,
            role: 'USER',
            inserted_at: 1_700_000_001,
            fragments: [{ id: 'u1', type: 'REQUEST', content: '你好 [reference:0]' }],
          },
          {
            message_id: 2,
            role: 'ASSISTANT',
            inserted_at: 1_700_000_002,
            fragments: [
              { id: 't1', type: 'THINK', content: '思考中' },
              {
                id: 's1',
                type: 'TOOL_SEARCH',
                content: '搜索',
                queries: [{ query: 'dsh' }],
                results: [{ url: 'https://e.com', title: 'E', snippet: 'snip', site_name: 'E', published_at: null }],
              },
              {
                id: 'o1',
                type: 'TOOL_OPEN',
                result: { url: 'https://example.com/a', title: 'A', snippet: 's', site_name: 'A', published_at: null },
              },
              {
                id: 'r1',
                type: 'RESPONSE',
                content: '回答 [reference:0]',
                references: [{ id: 'o1', type: 'TOOL_OPEN' }],
              },
            ],
          },
          {
            message_id: 3,
            role: 'USER',
            inserted_at: 1_700_000_003,
            fragments: [{ id: 'u2', type: 'REQUEST', content: '第二个问题' }],
          },
        ],
      },
    },
  }
}

/** A fetch mock returning one JSON payload. */
function jsonResponse(payload, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status ?? 200,
    headers: options.headers ?? { get: () => null },
    async arrayBuffer() {
      const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
      if (typeof options.mangle === 'function') return options.mangle(bytes)
      return bytes
    },
  }
}

/** Record one fetch call and return the responder's response. */
function fetchMock(responder) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, options })
    return responder(url, options, calls)
  }
  impl.calls = calls
  return impl
}

/** Normalized messages equivalent to the share payload above. */
function normalizedMessages() {
  return [
    {
      role: 'user',
      content: '你好 [reference:0]',
      reasoning: null,
      timestamp: 1_700_000_001,
      citation_map: [{ marker: '[reference:0]', url: 'https://example.com/a' }],
    },
    {
      role: 'assistant',
      content: '回答 [reference:0]',
      reasoning: '思考中',
      timestamp: 1_700_000_002,
      citation_map: [{ marker: '[reference:0]', url: 'https://example.com/a' }],
    },
    { role: 'user', content: '第二个问题', reasoning: null, timestamp: 1_700_000_003, citation_map: [] },
  ]
}

test('parseShareInput accepts share links and bare ids only', () => {
  assert.deepEqual(parseShareInput('https://chat.deepseek.com/share/abc_123'), {
    shareId: 'abc_123',
    url: 'https://chat.deepseek.com/share/abc_123',
  })
  assert.deepEqual(parseShareInput('  https://chat.deepseek.com/share/AbC-9/?from=app#x '), {
    shareId: 'AbC-9',
    url: 'https://chat.deepseek.com/share/AbC-9',
  })
  assert.deepEqual(parseShareInput('AbC-9_x'), {
    shareId: 'AbC-9_x',
    url: 'https://chat.deepseek.com/share/AbC-9_x',
  })
  for (const rejected of [
    '',
    '   ',
    'https://evil.example/share/abc',
    'http://chat.deepseek.com/share/abc',
    'https://chat.deepseek.com/chat/abc',
    'https://chat.deepseek.com/share/',
    'https://chat.deepseek.com/share/abc/extra',
    'abc!',
    'share id with spaces',
    undefined,
    42,
  ]) {
    assert.throws(
      () => parseShareInput(rejected),
      (error) => error.code === 'invalid-share',
      'rejects ' + String(rejected),
    )
  }
})

test('fetchShare normalizes fragments from the public API', async () => {
  const fetchImpl = fetchMock(() => jsonResponse(sharePayload()))
  const share = await fetchShare('abc_123', { fetchImpl })
  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0].url, /^https:\/\/chat\.deepseek\.com\/api\/v0\/share\/content\?share_id=abc_123$/u)
  assert.deepEqual(fetchImpl.calls[0].options.headers, { Accept: 'application/json' })
  assert.equal(share.shareId, 'abc_123')
  assert.equal(share.title, '演示分享')
  assert.equal(share.modelType, 'deepseek_v3')
  assert.equal(share.messages.length, 3)
  const [user, assistant, secondUser] = share.messages
  assert.equal(user.role, 'user')
  assert.equal(user.content, '你好 [reference:0]')
  assert.equal(user.reasoning, null)
  assert.equal(user.timestamp, 1_700_000_001)
  assert.deepEqual(user.citation_map, [], 'only assistant RESPONSE fragments carry references')
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.content, '回答 [reference:0]')
  assert.equal(assistant.reasoning, '思考中')
  assert.deepEqual(assistant.citation_map, [
    {
      marker: '[reference:0]',
      ref_type: 'TOOL_OPEN',
      fragment_id: 'o1',
      url: 'https://example.com/a',
      title: 'A',
      snippet: 's',
    },
  ])
  assert.deepEqual(assistant.searches, [
    {
      content: '搜索',
      queries: ['dsh'],
      results: [{ url: 'https://e.com', title: 'E', snippet: 'snip', site_name: 'E', published_at: null }],
    },
  ])
  assert.deepEqual(assistant.sources, [
    {
      fragment_id: 'o1',
      url: 'https://example.com/a',
      title: 'A',
      snippet: 's',
      site_name: 'A',
      published_at: null,
    },
  ])
  assert.equal(secondUser.role, 'user')
  assert.equal(secondUser.content, '第二个问题')
})

test('fetchShare reports HTTP, API, JSON, size, and timeout failures', async () => {
  await assert.rejects(
    fetchShare('abc', { fetchImpl: fetchMock(() => jsonResponse({}, { ok: false, status: 503 })) }),
    (error) => error.code === 'share-fetch' && /HTTP 503/u.test(error.message),
  )
  await assert.rejects(
    fetchShare('abc', { fetchImpl: fetchMock(() => jsonResponse({ code: 40003, msg: 'INVALID_TOKEN' })) }),
    (error) => error.code === 'share-api' && /40003/u.test(error.message) && /INVALID_TOKEN/u.test(error.message),
  )
  await assert.rejects(
    fetchShare('abc', { fetchImpl: fetchMock(() => jsonResponse('not json')) }),
    (error) => error.code === 'share-fetch' && /JSON/u.test(error.message),
  )
  await assert.rejects(
    fetchShare('abc', { fetchImpl: fetchMock(() => jsonResponse(sharePayload())), maxBytes: 10 }),
    (error) => error.code === 'share-fetch' && /大小上限/u.test(error.message),
  )
  await assert.rejects(
    fetchShare('abc', {
      fetchImpl: fetchMock(() => jsonResponse(sharePayload(), { headers: { get: () => '999999' } })),
      maxBytes: 1024,
    }),
    (error) => error.code === 'share-fetch' && /大小上限/u.test(error.message),
  )
  await assert.rejects(
    fetchShare('abc', {
      fetchImpl: fetchMock(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
      timeoutMs: 20,
    }),
    (error) => error.code === 'share-fetch' && /超时/u.test(error.message),
  )
  assert.throws(
    () => parseShareInput('bad id'),
    (error) => error.code === 'invalid-share',
  )
  await assert.rejects(
    fetchShare('bad id', { fetchImpl: fetchMock(() => jsonResponse(sharePayload())) }),
    (error) => error.code === 'invalid-share',
  )
})

test('buildShareSession produces a valid v4 conversation log', () => {
  const built = buildShareSession(normalizedMessages(), { cwd: '/work/demo' })
  assert.equal(built.header.version, 4)
  assert.equal(built.header.cwd, '/work/demo')
  assert.equal(built.header.isSeeded, false)
  assert.equal(built.header.delegationDepth, 0)
  assert.equal(built.header.agentPreset, 'standard')
  assert.equal(built.turns, 2)
  assert.equal(built.title, '你好 [reference:0]')
  // Dense seq from 0 and a valid event vocabulary.
  built.events.forEach((event, index) => assert.equal(event.seq, index))
  assert.doesNotThrow(() => validateEvents(built.events))
  // Config block first, in the documented order.
  assert.deepEqual(
    built.events.slice(0, 4).map((event) => event.type),
    ['permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection'],
  )
  const turns = built.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
  assert.deepEqual(turns, [1, 2])
  // Closed turn/step pairs.
  let openTurn
  let openStep
  for (const event of built.events) {
    switch (event.type) {
      case 'turn/start':
        assert.equal(openTurn, undefined)
        openTurn = event.data.turn
        break
      case 'step/start':
        assert.equal(openStep, undefined)
        assert.equal(event.data.turn, openTurn)
        openStep = event.data.step
        break
      case 'step/end':
        assert.equal(event.data.step, openStep)
        openStep = undefined
        break
      case 'turn/end':
        assert.equal(event.data.turn, openTurn)
        assert.equal(openStep, undefined)
        openTurn = undefined
        break
      default:
        break
    }
  }
  assert.equal(openTurn, undefined)
  // Messages carry surfaceOp append; citations become markdown links.
  const users = built.events.filter((event) => event.type === 'user/message')
  assert.deepEqual(
    users.map((event) => event.surfaceOp),
    ['append', 'append'],
  )
  assert.deepEqual(
    users.map((event) => event.data.content[0].text),
    ['你好 [[0]](https://example.com/a)', '第二个问题'],
  )
  const assistants = built.events.filter((event) => event.type === 'assistant/message')
  assert.equal(assistants.length, 1)
  assert.deepEqual(
    assistants[0].data.message.content.map((block) => block.type),
    ['reasoning', 'text'],
  )
  assert.deepEqual(
    assistants[0].data.message.content.map((block) => block.text),
    ['思考中', '回答 [[0]](https://example.com/a)'],
  )
  assert.deepEqual(assistants[0].data.stream, [])
  assert.equal(assistants[0].surfaceOp, 'append')
  assert.deepEqual(assistants[0].data.message.source, {
    kind: 'model',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
  })
  // One request header/context, plus a title citing the first user message.
  assert.equal(built.events.filter((event) => event.type === 'request/header').length, 1)
  assert.equal(built.events.filter((event) => event.type === 'request/context').length, 1)
  const title = built.events.find((event) => event.type === 'session/title')
  assert.equal(title.data.title, '你好 [reference:0]')
  assert.deepEqual(title.data.source, { kind: 'fallback' })
  assert.equal(title.data.messageSeqs.length, 1)
  const cited = built.events[title.data.messageSeqs[0]]
  assert.equal(cited.type, 'user/message')
  assert.ok(cited.seq < title.seq)
  // The canonical JSONL parses back to the same header and events.
  const parsed = parseSessionLog(built.jsonl)
  assert.equal(parsed.header.version, 4)
  assert.equal(parsed.header.id, built.header.id)
  assert.deepEqual(parsed.events, built.events)
  // The default build has no system message.
  assert.equal(
    built.events.some((event) => event.type === 'system/message'),
    false,
  )
})

test('buildShareSession honours reasoning/title options and rejects bad input', () => {
  const noReasoning = buildShareSession(normalizedMessages(), {
    cwd: '/work/demo',
    includeReasoning: false,
    title: ' 自定义标题 ',
  })
  const assistant = noReasoning.events.find((event) => event.type === 'assistant/message')
  assert.deepEqual(
    assistant.data.message.content.map((block) => block.type),
    ['text'],
  )
  const title = noReasoning.events.find((event) => event.type === 'session/title')
  assert.equal(title.data.title, '自定义标题')
  assert.equal(noReasoning.title, '自定义标题')
  // A trailing user-only turn still closes its boundaries.
  const userOnly = normalizedMessages().slice(2)
  const built = buildShareSession(userOnly, { cwd: '/work/demo' })
  assert.equal(built.turns, 1)
  assert.equal(
    built.events.some((event) => event.type === 'assistant/message'),
    false,
  )
  assert.equal(
    built.events.some((event) => event.type === 'session/title'),
    true,
  )
  assert.doesNotThrow(() => parseSessionLog(built.jsonl))
  // A conversation without any user message has no valid title reference.
  const assistantOnly = buildShareSession([normalizedMessages()[1]], { cwd: '/work/demo' })
  assert.equal(
    assistantOnly.events.some((event) => event.type === 'session/title'),
    false,
  )
  assert.throws(
    () => buildShareSession([], { cwd: '/work/demo' }),
    (error) => error.code === 'invalid-argument',
  )
  assert.throws(
    () => buildShareSession(normalizedMessages(), { cwd: 'relative/dir' }),
    (error) => error.code === 'invalid-argument',
  )
})

test('importShare maps parse -> fetch -> build -> importArchive', async () => {
  const fetched = fetchMock(() => jsonResponse(sharePayload()))
  const imports = []
  const importArchiveImpl = async (ctx, options) => {
    imports.push(options)
    const text = Buffer.from(options.buffer).toString('utf8')
    const parsed = parseSessionLog(text)
    assert.equal(parsed.header.version, 4)
    assert.equal(parsed.events.length > 0, true)
    return {
      sessions: [
        {
          sessionId: 'session-new',
          title: '演示分享',
          eventCount: parsed.events.length,
          mode: 'full',
          verified: true,
          warnings: [],
        },
      ],
      warnings: [],
      restoredFiles: 0,
      restoredBytes: 0,
      skipped: 0,
    }
  }
  const registry = { get: (id) => (id === 'workspace-1' ? { id, path: '/work/ws' } : undefined) }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  const result = await importShare(
    ctx,
    {
      input: 'https://chat.deepseek.com/share/abc_123',
      workspaceId: 'workspace-1',
    },
    { fetchImpl: fetched, importArchiveImpl },
  )
  assert.equal(fetched.calls.length, 1)
  assert.equal(imports.length, 1)
  assert.equal(imports[0].cwd, '/work/ws')
  assert.equal(imports[0].workspaceId, 'workspace-1')
  assert.equal(result.sessionId, 'session-new')
  assert.equal(result.title, '演示分享')
  assert.equal(result.eventCount > 0, true)
  assert.equal(result.workspaceId, 'workspace-1')
  assert.deepEqual(result.warnings, [])
  // An explicit cwd wins over the workspace path.
  const direct = await importShare(
    ctx,
    {
      input: 'abc_123',
      cwd: '/work/explicit',
      workspaceId: 'workspace-1',
    },
    { fetchImpl: fetchMock(() => jsonResponse(sharePayload())), importArchiveImpl },
  )
  assert.equal(imports[1].cwd, '/work/explicit')
  assert.equal(direct.sessionId, 'session-new')
})

test('importShare validates the workspace and the share input before importing', async () => {
  let fetched = 0
  const fetchImpl = async () => {
    fetched += 1
    return jsonResponse(sharePayload())
  }
  const importArchiveImpl = async () => {
    throw new Error('must not import')
  }
  const registry = { get: () => undefined }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  await assert.rejects(
    importShare(ctx, { input: 'abc', workspaceId: 'missing-ws' }, { fetchImpl, importArchiveImpl }),
    (error) => error.code === 'workspace-not-found',
  )
  assert.equal(fetched, 0, 'workspace resolution happens before any network call')
  await assert.rejects(
    importShare(ctx, { input: 'https://evil.example/share/abc' }, { fetchImpl, importArchiveImpl }),
    (error) => error.code === 'invalid-share',
  )
  assert.equal(fetched, 0)
})

test('importShare reports attachment warnings and omits the workspace when the join failed', async () => {
  const importArchiveImpl = async () => ({
    sessions: [
      {
        sessionId: 'session-new',
        title: 'T',
        eventCount: 1,
        mode: 'full',
        verified: true,
        warnings: ['会话已写入，但没能加入工作区 w'],
      },
    ],
    warnings: ['压缩包警告'],
    restoredFiles: 0,
    restoredBytes: 0,
    skipped: 0,
  })
  const registry = { get: (id) => ({ id, path: '/work/ws' }) }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  const result = await importShare(
    ctx,
    { input: 'abc', workspaceId: 'w' },
    {
      fetchImpl: fetchMock(() => jsonResponse(sharePayload())),
      importArchiveImpl,
    },
  )
  assert.equal(result.workspaceId, undefined)
  assert.ok(result.warnings.some((warning) => warning.includes('没能加入工作区')))
  assert.ok(result.warnings.some((warning) => warning.includes('压缩包警告')))
})

test('built JSONL imports through the real persistence backend (guarded)', async (t) => {
  const backend = await createRealBackend()
  if (!backend.ok) {
    t.skip('real JSONL backend unavailable (run from the DSH repo with node --import tsx/esm): ' + backend.error)
    return
  }
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'dsk-share-'))
  try {
    const built = buildShareSession(normalizedMessages(), { cwd: workspaceRoot })
    const replay = await replayValidate(built.header, built.events)
    assert.deepEqual(replay, { ok: true }, 'the product replay accepts the built log')
    const written = await writeAndReadBack(backend.persistence, built.header, built.events)
    assert.equal(written.events.length, built.events.length)
    assert.equal(written.header.version, 4)
    assert.equal(written.header.id, built.header.id)
    // End-to-end through the real importer (read-back verification included).
    const ctx = {
      get(name) {
        if (name === 'sessionPersistence') return backend.persistence
        if (name === 'workingDirectory') return { defaultDirectory: workspaceRoot }
        return undefined
      },
      logger: { warn() {} },
    }
    const result = await importShare(
      ctx,
      {
        input: 'abc',
        cwd: workspaceRoot,
        title: '真实导入',
      },
      { fetchImpl: fetchMock(() => jsonResponse(sharePayload())) },
    )
    assert.match(result.sessionId, /^session-/u)
    assert.equal(result.title, '真实导入')
    assert.equal(result.eventCount, built.events.length)
    const listed = await backend.persistence.list()
    assert.equal(
      listed.some((snapshot) => snapshot.header.id === result.sessionId),
      true,
    )
    const opened = await backend.persistence.open(result.sessionId, 'read')
    try {
      const slice = await opened.read(0, Number.MAX_SAFE_INTEGER)
      assert.equal(slice.events.length, built.events.length)
      const replayed = await replayValidate(opened.header, slice.events)
      assert.deepEqual(replayed, { ok: true }, 'the imported session re-opens through the product replay')
    } finally {
      await opened.close()
    }
  } finally {
    backend.cleanup()
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})
