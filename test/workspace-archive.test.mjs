import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  WORKSPACE_ARCHIVE_KIND,
  WORKSPACE_ARCHIVE_RECORD,
  archiveWorkspace,
  listWorkspaceArchives,
  restoreWorkspace,
} from '../lib/workspace-archive.js'

function makeWorkspace(options) {
  const workspace = {
    id: options.id,
    path: options.path,
    title: options.title ?? 'Demo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: options.sessionIds ?? [],
    async setTitle(title) {
      workspace.title = title
    },
    async attachSession(id) {
      if (options.attachError?.[id] !== undefined) throw new Error(options.attachError[id])
      if (!workspace.sessionIds.includes(id)) workspace.sessionIds.unshift(id)
    },
    async detachSession(id) {
      workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id)
    },
  }
  return workspace
}

function makeContext(options = {}) {
  const workspaces = options.workspaces ?? []
  const archived = new Set(options.archived ?? [])
  const pinned = new Set(options.pinned ?? [])
  const calls = []
  const registry = {
    get(id) {
      return workspaces.find((workspace) => workspace.id === id)
    },
    async list() {
      return [...workspaces]
    },
    async create(path, title) {
      const workspace = makeWorkspace({
        id: `restored-${workspaces.length + 1}`,
        path,
        title,
        sessionIds: [],
        attachError: options.attachError,
      })
      workspaces.unshift(workspace)
      calls.push(['create', workspace.id, path, title])
      return workspace
    },
    async delete(id) {
      const index = workspaces.findIndex((workspace) => workspace.id === id)
      if (index < 0) return false
      workspaces.splice(index, 1)
      calls.push(['delete', id])
      return true
    },
    async archiveSession(id) {
      calls.push(['archive', id])
      if (options.active?.includes(id)) {
        const error = new Error(`cannot archive session '${id}': the session is active (turn)`)
        error.name = 'WorkspaceActiveSessionError'
        throw error
      }
      archived.add(id)
      pinned.delete(id)
    },
    async unarchiveSession(id) {
      calls.push(['unarchive', id])
      archived.delete(id)
    },
    async pinSession(id) {
      calls.push(['pin', id])
      if (archived.has(id)) throw new Error('cannot pin an archived session')
      pinned.add(id)
    },
    async resolveByPath(path) {
      return workspaces.find((workspace) => workspace.path === path)
    },
    async insertBefore(id, beforeId) {
      calls.push(['insertBefore', id, beforeId])
    },
    get archivedSessionIds() {
      return [...archived]
    },
    get pinnedSessionIds() {
      return [...pinned]
    },
  }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  return { ctx, registry, workspaces, archived, pinned, calls }
}

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaceDir = join(root, 'project')
  await mkdir(workspaceDir, { recursive: true })
  await writeFile(join(workspaceDir, 'README.md'), 'keep me\n')
  const archiveRoot = join(root, 'archives')
  return { root, workspaceDir, archiveRoot }
}

test('archives every attached session, records the workspace, and removes only the registration', async (t) => {
  const { workspaceDir, archiveRoot } = await makeRoot(t)
  const workspace = makeWorkspace({
    id: 'ws-a',
    path: workspaceDir,
    title: 'Project A',
    sessionIds: ['s1', 's2'],
  })
  const { ctx, workspaces, archived, pinned, calls } = makeContext({
    workspaces: [workspace],
    archived: ['s2'],
    pinned: ['s1'],
  })

  const result = await archiveWorkspace(ctx, {
    workspaceId: 'ws-a',
    confirm: true,
    archiveRoot,
  })

  assert.equal(result.workspaceRemoved, true)
  assert.equal(result.archivedCount, 1)
  assert.equal(result.alreadyArchivedCount, 1)
  assert.match(result.archive.archiveId, /^.*-ws-a-/)
  assert.equal(workspaces.length, 0)
  assert.deepEqual([...archived].sort(), ['s1', 's2'])
  assert.deepEqual([...pinned], [])
  assert.deepEqual(
    calls.filter((call) => call[0] === 'delete'),
    [['delete', 'ws-a']],
  )
  assert.deepEqual((await readdir(archiveRoot)).length, 1)

  const dirs = await readdir(archiveRoot)
  const record = JSON.parse(await readFile(join(archiveRoot, dirs[0], WORKSPACE_ARCHIVE_RECORD), 'utf8'))
  assert.equal(record.kind, WORKSPACE_ARCHIVE_KIND)
  assert.equal(record.workspace.path, workspaceDir)
  assert.deepEqual(
    record.sessions.map((entry) => [entry.id, entry.archived, entry.pinned]),
    [
      ['s1', false, true],
      ['s2', true, false],
    ],
  )
  assert.equal(await readFile(join(workspaceDir, 'README.md'), 'utf8'), 'keep me\n')
})

test('an active session aborts the archive, rolls back earlier sessions, and keeps the workspace', async (t) => {
  const { workspaceDir, archiveRoot } = await makeRoot(t)
  const workspace = makeWorkspace({
    id: 'ws-active',
    path: workspaceDir,
    sessionIds: ['idle', 'busy'],
  })
  const { ctx, workspaces, archived, calls } = makeContext({
    workspaces: [workspace],
    active: ['busy'],
  })

  await assert.rejects(
    archiveWorkspace(ctx, { workspaceId: 'ws-active', confirm: true, archiveRoot }),
    (error) => error.code === 'active' && /活动会话/.test(error.message),
  )

  assert.equal(workspaces.length, 1)
  assert.deepEqual([...archived], [])
  assert.deepEqual(
    calls.filter((call) => call[0] === 'archive'),
    [
      ['archive', 'idle'],
      ['archive', 'busy'],
    ],
  )
  assert.deepEqual(
    calls.filter((call) => call[0] === 'unarchive'),
    [['unarchive', 'idle']],
  )
  assert.equal((await readdir(archiveRoot).catch(() => [])).length, 0)
})

test('restore recreates the workspace, reattaches sessions, unpins only what it archived, and clears the record', async (t) => {
  const { workspaceDir, archiveRoot } = await makeRoot(t)
  const workspace = makeWorkspace({
    id: 'ws-restore',
    path: workspaceDir,
    title: 'Restore Me',
    sessionIds: ['plain', 'already', 'pinned'],
  })
  const archivedSetup = makeContext({
    workspaces: [workspace],
    archived: ['already'],
    pinned: ['pinned'],
  })
  await archiveWorkspace(archivedSetup.ctx, {
    workspaceId: 'ws-restore',
    confirm: true,
    archiveRoot,
  })
  const archiveId = (await readdir(archiveRoot))[0]

  const restored = makeContext({ workspaces: [], archived: ['already'] })
  const result = await restoreWorkspace(restored.ctx, { archiveId, archiveRoot })

  assert.equal(result.completed, true)
  assert.equal(result.workspace.reused, false)
  assert.equal(result.workspace.path, workspaceDir)
  assert.equal(restored.workspaces.length, 1)
  assert.equal(restored.workspaces[0].title, 'Restore Me')
  assert.deepEqual([...restored.archived], ['already'])
  assert.deepEqual([...restored.pinned], ['pinned'])
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(
    restored.calls.filter((call) => call[0] === 'unarchive').map((call) => call[1]),
    ['plain', 'pinned'],
  )
  assert.deepEqual(
    restored.calls.filter((call) => call[0] === 'pin').map((call) => call[1]),
    ['pinned'],
  )
  assert.equal((await readdir(archiveRoot).catch(() => [])).length, 0)
})

test('restore keeps the record when the project directory is missing', async (t) => {
  const { workspaceDir, archiveRoot } = await makeRoot(t)
  const workspace = makeWorkspace({ id: 'ws-missing', path: workspaceDir, sessionIds: [] })
  const setup = makeContext({ workspaces: [workspace] })
  await archiveWorkspace(setup.ctx, { workspaceId: 'ws-missing', confirm: true, archiveRoot })
  const archiveId = (await readdir(archiveRoot))[0]
  await rm(workspaceDir, { recursive: true, force: true })

  await assert.rejects(
    restoreWorkspace(makeContext().ctx, { archiveId, archiveRoot }),
    (error) => error.code === 'workspace-not-found' && /目录不存在/.test(error.message),
  )
  assert.equal((await readdir(archiveRoot)).length, 1)
})

test('a partial restore keeps the record with pending sessions', async (t) => {
  const { workspaceDir, archiveRoot } = await makeRoot(t)
  const workspace = makeWorkspace({ id: 'ws-partial', path: workspaceDir, sessionIds: ['ok', 'bad'] })
  const setup = makeContext({ workspaces: [workspace] })
  await archiveWorkspace(setup.ctx, { workspaceId: 'ws-partial', confirm: true, archiveRoot })
  const archiveId = (await readdir(archiveRoot))[0]

  const restored = makeContext({ attachError: { bad: 'cwd does not resolve' } })
  const result = await restoreWorkspace(restored.ctx, { archiveId, archiveRoot })

  assert.equal(result.completed, false)
  assert.deepEqual(result.pendingSessionIds, ['bad'])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].reason, 'attach-failed')
  const record = JSON.parse(await readFile(join(archiveRoot, archiveId, WORKSPACE_ARCHIVE_RECORD), 'utf8'))
  assert.deepEqual(record.pendingSessionIds, ['bad'])
  assert.equal(typeof record.restoredAt, 'string')
})

test('lists archives newest first and reports malformed records', async (t) => {
  const { workspaceDir, archiveRoot } = await makeRoot(t)
  const workspace = makeWorkspace({ id: 'ws-list', path: workspaceDir, sessionIds: [] })
  const setup = makeContext({ workspaces: [workspace] })
  await archiveWorkspace(setup.ctx, { workspaceId: 'ws-list', confirm: true, archiveRoot })
  await mkdir(join(archiveRoot, 'broken'), { recursive: true })

  const listed = await listWorkspaceArchives(setup.ctx, { archiveRoot })
  assert.equal(listed.archives.length, 1)
  assert.equal(listed.archives[0].workspace.title, 'Demo')
  assert.equal(listed.archives[0].sessionCount, 0)
  assert.equal(listed.warnings.length, 1)
})
