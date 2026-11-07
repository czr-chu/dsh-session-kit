/**
 * Unit tests for lib/workspace-backup.js and the buildArchive backup metadata.
 *
 * Most cases use the documented helper-module seam (same mock shape as
 * test/export.test.mjs) so no DSH process is needed. One guarded case writes two
 * real sessions through the JSONL persistence backend and packs the real
 * workspace tree.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildArchive } from '../lib/export.js'
import { readZipEntries } from '../lib/zip.js'
import { buildWorkspaceBackup } from '../lib/workspace-backup.js'
import { createRealBackend, writeAndReadBack } from './support/real-backend.mjs'

/** One valid-ish V4 event list; exports never re-derive these in tests. */
function makeEvents(sessionId) {
  return [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 11,
      data: { content: [{ type: 'text', text: 'hello ' + sessionId }], source: { kind: 'user' } },
    },
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** One stored session document as lib/sessions.js readSessionDoc returns it. */
function makeDoc(id, cwd) {
  return {
    header: { version: 4, id, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0 },
    events: makeEvents(id),
    inheritedEventCount: 0,
  }
}

/** A collector stand-in that reports one deterministic file per workspace. */
function makeWorkspaceFiles({ calls = [] } = {}) {
  return {
    calls,
    workspaceArchiveKey() {
      return 'workspaces/ws-key'
    },
    deriveTouchedFiles() {
      return { paths: new Set(), presented: new Set(), toolTargets: new Set(), cwdHints: new Set() }
    },
    async collectWorkspaceTree(root, options) {
      calls.push({ root, options })
      return {
        files: [
          { absPath: join(root, 'a.txt'), relPath: 'a.txt', size: 3, archivePath: 'workspaces/ws-key/a.txt' },
          {
            absPath: join(root, 'sub/b.txt'),
            relPath: 'sub/b.txt',
            size: 2,
            archivePath: 'workspaces/ws-key/sub/b.txt',
          },
        ],
        totalBytes: 5,
        warnings: [],
        skipped: [],
      }
    },
  }
}

/** Helper-module mock matching the lib/sessions.js shape used by export.js. */
function makeDeps({ docs, entries, workspaces, workspaceFiles, sessionEntryOptions = [] }) {
  const services = {
    workspaceRegistry: {
      async list() {
        return workspaces
      },
    },
    attachments: {
      imageHostPath: () => undefined,
      fileHostPath: () => undefined,
      async readImage() {
        return { data: new Uint8Array([1, 2, 3]) }
      },
      async *readFileStream() {
        yield new Uint8Array([4, 5, 6])
      },
    },
  }
  return {
    async detectFormatVersion() {
      return 4
    },
    async readSessionDoc(ctx, id) {
      const doc = docs[id]
      if (doc === undefined) throw new Error('session not found: ' + id)
      return structuredClone(doc)
    },
    async listSessionEntries(ctx, options) {
      sessionEntryOptions.push(options)
      return entries
    },
    async listWorkspaceEntries() {
      return workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessionIds: workspace.sessionIds,
      }))
    },
    foldTitle(events) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === 'session/title' && typeof events[index].data?.title === 'string') {
          return events[index].data.title
        }
      }
      return undefined
    },
    servicesOf() {
      return services
    },
    workspaceFiles,
  }
}

/** Build an entry-name -> data map from one archive buffer. */
function entryMap(data) {
  return new Map(readZipEntries(Buffer.from(data)).map((entry) => [entry.name, Buffer.from(entry.data)]))
}

/** Parse the manifest of one archive. */
function manifestOf(built) {
  return JSON.parse(entryMap(built.data).get('manifest.json').toString('utf8'))
}

test('workspace backup packs every workspace session and one file tree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsk-ws-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'abc')
  await writeFile(join(root, 'sub/b.txt'), 'de')
  const calls = []
  const docs = { s1: makeDoc('s1', root), s2: makeDoc('s2', root) }
  const entries = [
    { id: 's1', title: 'one', cwd: root, createdAt: 1, updatedAt: 2, formatVersion: 4, eventCount: 3 },
    { id: 's2', title: 'two', cwd: root, createdAt: 1, updatedAt: 2, formatVersion: 4, eventCount: 3 },
  ]
  const workspaces = [{ id: 'ws1', title: 'Demo', path: root, sessionIds: ['s1', 's2', 'ghost'] }]
  const deps = makeDeps({ docs, entries, workspaces, workspaceFiles: makeWorkspaceFiles({ calls }) })
  const built = await buildWorkspaceBackup(
    {},
    {
      workspaceId: 'ws1',
      deps,
      includeAttachments: false,
      now: 1_730_000_000_000,
    },
  )
  assert.match(built.filename, /^workspace-Demo-2-sessions-\d{8}-\d{6}\.zip$/u)
  assert.deepEqual(built.workspace, { workspaceId: 'ws1', title: 'Demo', path: root })
  assert.equal(built.sessionCount, 2)
  assert.ok(
    built.warnings.some((warning) => warning.includes('ghost')),
    'missing registry ids become warnings',
  )
  const manifest = manifestOf(built)
  assert.deepEqual(manifest.backup, { kind: 'workspace', workspaceId: 'ws1', title: 'Demo', path: root })
  assert.equal(manifest.mode, 'full')
  assert.equal(manifest.sessions.length, 2)
  assert.deepEqual(manifest.sessions.map((session) => session.id).sort(), ['s1', 's2'])
  assert.equal(manifest.workspaces.length, 1, 'exactly one workspace fact')
  assert.equal(manifest.workspaces[0].path, root)
  assert.deepEqual(manifest.workspaces[0].sessionIds, ['s1', 's2'])
  assert.equal(calls.length, 1, 'the workspace tree is collected once')
  assert.equal(calls[0].root, root)
  const names = [...entryMap(built.data).keys()]
  assert.equal(names.filter((name) => name.startsWith('workspaces/ws-key/')).length, 2)
  assert.ok(names.includes('sessions/s1/session.v4.jsonl'))
  assert.ok(names.includes('sessions/s2/session.v4.jsonl'))
})

test('buildArchive without backup metadata keeps the old manifest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsk-ws-nobackup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const docs = { s1: makeDoc('s1', root) }
  const entries = [{ id: 's1', title: 'one', cwd: root, createdAt: 1, updatedAt: 2, formatVersion: 4, eventCount: 3 }]
  const workspaces = [{ id: 'ws1', title: 'Demo', path: root, sessionIds: ['s1'] }]
  const deps = makeDeps({ docs, entries, workspaces, workspaceFiles: makeWorkspaceFiles() })
  const built = await buildArchive(
    {},
    {
      sessionIds: ['s1'],
      deps,
      includeAttachments: false,
      includeWorkspaceFiles: true,
      now: 1_730_000_000_000,
    },
  )
  const manifest = manifestOf(built)
  assert.equal(Object.hasOwn(manifest, 'backup'), false, 'ordinary exports never gain a backup field')
  assert.equal(manifest.workspaces.length, 1)
})

test('buildArchive writes backup metadata only when provided and validates it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsk-ws-meta-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const docs = { s1: makeDoc('s1', root) }
  const entries = [{ id: 's1', title: 'one', cwd: root, createdAt: 1, updatedAt: 2, formatVersion: 4, eventCount: 3 }]
  const workspaces = [{ id: 'ws1', path: root, sessionIds: ['s1'] }]
  const deps = makeDeps({ docs, entries, workspaces, workspaceFiles: makeWorkspaceFiles() })
  const metadata = { kind: 'workspace', workspaceId: 'ws1', title: 'Demo', path: root, extra: { note: 1 } }
  const built = await buildArchive(
    {},
    {
      sessionIds: ['s1'],
      deps,
      includeAttachments: false,
      includeWorkspaceFiles: false,
      backup: metadata,
      now: 1_730_000_000_000,
    },
  )
  const manifest = manifestOf(built)
  assert.deepEqual(manifest.backup, metadata)
  assert.equal(Object.hasOwn(manifest, 'workspaces'), false)
  // The manifest copy is isolated from the caller's object.
  metadata.extra.note = 2
  assert.equal(manifestOf(built).backup.extra.note, 1)
  for (const invalid of [null, 'workspace', ['workspace'], 42]) {
    await assert.rejects(
      buildArchive({}, { sessionIds: ['s1'], deps, includeAttachments: false, backup: invalid }),
      (error) => error.code === 'invalid-argument',
    )
  }
  const circular = { kind: 'workspace' }
  circular.self = circular
  await assert.rejects(
    buildArchive({}, { sessionIds: ['s1'], deps, includeAttachments: false, backup: circular }),
    (error) => error.code === 'invalid-argument',
  )
})

test('a workspace backup pins file collection to the workspace root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsk-ws-pin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const docs = { s1: makeDoc('s1', '/tmp/somewhere-else') }
  const entries = [
    { id: 's1', title: 'one', cwd: '/tmp/somewhere-else', createdAt: 1, updatedAt: 2, formatVersion: 4, eventCount: 3 },
  ]
  const workspaces = [{ id: 'ws1', title: 'Pinned', path: root, sessionIds: ['s1'] }]
  const deps = makeDeps({ docs, entries, workspaces, workspaceFiles: makeWorkspaceFiles({ calls }) })
  const built = await buildWorkspaceBackup(
    {},
    {
      workspaceId: 'ws1',
      deps,
      includeAttachments: false,
      now: 1_730_000_000_000,
    },
  )
  assert.ok(built.warnings.some((warning) => warning.includes('不在备份工作区内')))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].root, root)
  const manifest = manifestOf(built)
  assert.deepEqual(
    manifest.workspaces.map((fact) => fact.path),
    [root],
  )
})

test('workspace backup validates the workspace, path, and session list', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsk-ws-errors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const docs = { s1: makeDoc('s1', root) }
  const entries = [{ id: 's1', title: 'one', cwd: root, createdAt: 1, updatedAt: 2, formatVersion: 4, eventCount: 3 }]
  const base = () =>
    makeDeps({
      docs,
      entries,
      workspaces: [{ id: 'ws1', title: 'Demo', path: root, sessionIds: ['s1'] }],
      workspaceFiles: makeWorkspaceFiles(),
    })
  await assert.rejects(
    buildWorkspaceBackup({}, { deps: base(), workspaceId: '   ' }),
    (error) => error.code === 'invalid-argument',
  )
  await assert.rejects(
    buildWorkspaceBackup({}, { deps: base(), workspaceId: 'missing' }),
    (error) => error.code === 'workspace-not-found',
  )
  const wrongPathDeps = makeDeps({
    docs,
    entries,
    workspaces: [{ id: 'ws1', path: join(root, 'missing'), sessionIds: ['s1'] }],
    workspaceFiles: makeWorkspaceFiles(),
  })
  await assert.rejects(
    buildWorkspaceBackup({}, { deps: wrongPathDeps, workspaceId: 'ws1' }),
    (error) => error.code === 'invalid-argument',
  )
  const emptyDeps = makeDeps({
    docs,
    entries,
    workspaces: [{ id: 'ws1', path: root, sessionIds: ['ghost-1', 'ghost-2'] }],
    workspaceFiles: makeWorkspaceFiles(),
  })
  await assert.rejects(
    buildWorkspaceBackup({}, { deps: emptyDeps, workspaceId: 'ws1' }),
    (error) => error.code === 'missing-sessions',
  )
  const noIdsDeps = makeDeps({
    docs,
    entries,
    workspaces: [{ id: 'ws1', path: root }],
    workspaceFiles: makeWorkspaceFiles(),
  })
  await assert.rejects(
    buildWorkspaceBackup({}, { deps: noIdsDeps, workspaceId: 'ws1' }),
    (error) => error.code === 'missing-sessions',
  )
  const unavailableDeps = {
    servicesOf() {
      return {}
    },
  }
  await assert.rejects(
    buildWorkspaceBackup({}, { deps: unavailableDeps, workspaceId: 'ws1' }),
    (error) => error.code === 'unavailable',
  )
  const brokenRegistry = makeDeps({ docs, entries, workspaces: [], workspaceFiles: makeWorkspaceFiles() })
  brokenRegistry.servicesOf = () => ({
    workspaceRegistry: {
      async list() {
        throw new Error('registry offline')
      },
    },
  })
  await assert.rejects(
    buildWorkspaceBackup({}, { deps: brokenRegistry, workspaceId: 'ws1' }),
    (error) => error.code === 'unavailable',
  )
})

test('workspace backup forwards mode, filters, subagent option, and dshVersion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsk-ws-options-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const entryOptions = []
  const docs = { s1: makeDoc('s1', root) }
  const entries = [{ id: 's1', title: 'one', cwd: root, createdAt: 1, updatedAt: 2, formatVersion: 4, eventCount: 3 }]
  const workspaces = [{ id: 'ws1', title: 'My/Project * 1', path: root, sessionIds: ['s1'] }]
  const deps = makeDeps({
    docs,
    entries,
    workspaces,
    workspaceFiles: makeWorkspaceFiles({ calls }),
    sessionEntryOptions: entryOptions,
  })
  const built = await buildWorkspaceBackup(
    {},
    {
      workspaceId: 'ws1',
      deps,
      mode: 'full',
      includeAttachments: false,
      includeSubagents: true,
      workspaceExclude: ['vendor'],
      dshVersion: '0.8.0-test',
      now: 1_730_000_000_000,
    },
  )
  assert.equal(entryOptions[0].includeSubagents, true)
  assert.deepEqual(calls[0].options.excludePatterns, ['vendor'])
  assert.equal(built.manifest.source.dshVersion, '0.8.0-test')
  assert.equal(built.filename.startsWith('workspace-My-Project-1-1-sessions-'), true)
  await assert.rejects(
    buildWorkspaceBackup({}, { workspaceId: 'ws1', deps, mode: 'tiny', includeAttachments: false }),
    (error) => error.code === 'invalid-mode',
  )
  await assert.rejects(
    buildWorkspaceBackup({}, { workspaceId: 'ws1', deps, includeAttachments: false, maxExportBytes: 10 }),
    (error) => error.code === 'too-large',
  )
})

test('workspace backup reads two real sessions and packs the real workspace tree (guarded)', async (t) => {
  const backend = await createRealBackend()
  if (!backend.ok) {
    t.skip('real JSONL backend unavailable (run from the DSH repo with node --import tsx/esm): ' + backend.error)
    return
  }
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsk-ws-real-'))
  t.after(() => {
    backend.cleanup()
    return rm(workspaceRoot, { recursive: true, force: true })
  })
  try {
    await mkdir(join(workspaceRoot, 'sub'), { recursive: true })
    await writeFile(join(workspaceRoot, 'a.txt'), 'abc')
    await writeFile(join(workspaceRoot, 'sub/b.txt'), 'de')
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      {
        type: 'user/message',
        seq: 2,
        time: 3,
        data: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
        surfaceOp: 'append',
      },
      { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const ids = ['session-ws-a', 'session-ws-b']
    for (const [index, id] of ids.entries()) {
      await writeAndReadBack(
        backend.persistence,
        {
          version: 4,
          id,
          createdAt: 1_700_000_000_000 + index,
          cwd: workspaceRoot,
          isSeeded: false,
          delegationDepth: 0,
        },
        events,
      )
    }
    const registry = {
      async list() {
        return [{ id: 'ws-real', title: 'Real workspace', path: workspaceRoot, sessionIds: [...ids, 'session-gone'] }]
      },
    }
    const sessionQuery = {
      async listSessions() {
        const snapshots = await backend.persistence.list()
        return snapshots.map((snapshot) => ({
          header: snapshot.header,
          live: false,
          persisted: true,
          formatStatus: 'current',
        }))
      },
      async readTitle() {
        return undefined
      },
      async readSession(id) {
        const handle = await backend.persistence.open(id, 'read')
        try {
          const slice = await handle.read(0, Number.MAX_SAFE_INTEGER)
          return { session: handle.header, events: slice.events, inheritedEventCount: 0 }
        } finally {
          await handle.close()
        }
      },
    }
    const ctx = {
      get(name) {
        if (name === 'sessionPersistence') return backend.persistence
        if (name === 'workspaceRegistry') return registry
        if (name === 'sessionQuery') return sessionQuery
        return undefined
      },
    }
    const built = await buildWorkspaceBackup(ctx, {
      workspaceId: 'ws-real',
      includeAttachments: false,
      now: 1_730_000_000_000,
    })
    assert.equal(built.sessionCount, 2)
    assert.equal(built.workspace.path, workspaceRoot)
    assert.ok(built.warnings.some((warning) => warning.includes('session-gone')))
    const manifest = manifestOf(built)
    assert.deepEqual(manifest.backup, {
      kind: 'workspace',
      workspaceId: 'ws-real',
      title: 'Real workspace',
      path: workspaceRoot,
    })
    assert.equal(manifest.sessions.length, 2)
    assert.equal(manifest.workspaces.length, 1)
    assert.equal(manifest.workspaces[0].path, workspaceRoot)
    const entries = entryMap(built.data)
    const workspaceNames = [...entries.keys()].filter((name) => name.startsWith('workspaces/'))
    assert.equal(workspaceNames.length, 2, 'the whole tree is packed once')
    const bySuffix = new Map(workspaceNames.map((name) => [name.split('/').pop(), name]))
    assert.equal(entries.get(bySuffix.get('a.txt')).toString('utf8'), 'abc')
    assert.equal(entries.get(bySuffix.get('b.txt')).toString('utf8'), 'de')
    assert.match(built.filename, /^workspace-Real-workspace-2-sessions-\d{8}-\d{6}\.zip$/u)
  } finally {
    backend.cleanup()
  }
})
