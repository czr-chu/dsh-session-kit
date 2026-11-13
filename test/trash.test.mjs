/**
 * Behavior tests for the trash inventory/restore/purge surface.
 *
 * The round-trip case runs the real delete path first, so the manifest layout,
 * the recorded session/sessions-root facts and the restore reattachment are all
 * exercised together. Every filesystem write stays under a temp directory.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { deleteSession, encodeSegment } from '../lib/manage.js'
import { listTrashOperations, purgeTrashOperations, restoreTrashOperation } from '../lib/trash.js'

/** One temp directory with cleanup registered on the test context. */
function tempDir(t, label) {
  const dir = mkdtempSync(join(tmpdir(), 'dsk-trash-' + label + '-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Create one session directory with a minimal log and return its facts. */
function writeSessionDir(sessionsRoot, projectName, id) {
  const sessionDir = join(sessionsRoot, projectName, encodeSegment(id))
  mkdirSync(sessionDir, { recursive: true })
  const logPath = join(sessionDir, 'session.v4.jsonl')
  writeFileSync(logPath, '{"type":"session"}\n')
  return { sessionDir, logPath }
}

/** A fake composed context exposing ctx.get(name). */
function fakeContext(services = {}) {
  return {
    get: (name) => services[name],
    logger: { warn: () => {} },
  }
}

/** A recording workspace registry with resolveByPath. */
function registryMock({ workspaces = [], archived = [], pinned = [] } = {}) {
  const calls = { archive: [], pin: [], attach: [] }
  return {
    calls,
    get archivedSessionIds() {
      return archived
    },
    get pinnedSessionIds() {
      return pinned
    },
    async resolveByPath(path) {
      return workspaces.find((workspace) => workspace.path === path)
    },
    async archiveSession(id) {
      calls.archive.push(id)
    },
    async pinSession(id) {
      calls.pin.push(id)
    },
  }
}

/**
 * Build one deletable session fixture plus its fake services.
 * @param {object} t - test context.
 * @returns {object} fixture.
 */
function fixture(t, { archived = [], pinned = [] } = {}) {
  const home = tempDir(t, 'home')
  const sessionsRoot = join(home, 'sessions')
  const session = writeSessionDir(sessionsRoot, '--work-demo--', 'session-a')
  const trashDir = join(home, 'trash')
  const workspace = {
    id: 'workspace-1',
    path: session.sessionDir.slice(0, session.sessionDir.lastIndexOf('/')),
    sessionIds: [],
    async attachSession(id) {
      workspace.sessionIds = [...workspace.sessionIds, id]
    },
  }
  const pinnedIds = [...pinned]
  const registry = registryMock({ workspaces: [workspace], archived, pinned: pinnedIds })
  const persistence = {
    async list() {
      return [
        {
          header: {
            version: 4,
            id: 'session-a',
            createdAt: 1_700_000_000_000,
            cwd: workspace.path,
            isSeeded: false,
            delegationDepth: 0,
          },
          formatStatus: 'current',
          location: { kind: 'jsonl', path: session.logPath },
        },
      ]
    },
    async stat(id) {
      if (id !== 'session-a') return undefined
      return {
        header: {
          version: 4,
          id: 'session-a',
          createdAt: 1_700_000_000_000,
          cwd: workspace.path,
          isSeeded: false,
          delegationDepth: 0,
        },
        formatStatus: 'current',
        location: { kind: 'jsonl', path: session.logPath },
      }
    },
  }
  const ctx = fakeContext({
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    sessionPersistence: persistence,
    workspaceRegistry: registry,
  })
  return { home, sessionsRoot, session, trashDir, workspace, registry, ctx }
}

test('a delete records a manifest that list reports and restore undoes', async (t) => {
  const facts = fixture(t, { archived: ['session-a'] })
  const deleted = await deleteSession(facts.ctx, 'session-a', { trashDir: facts.trashDir })
  assert.equal(existsSync(facts.session.sessionDir), false)

  const operationId = basename(deleted.trashedPath)
  const manifest = JSON.parse(readFileSync(join(deleted.trashedPath, 'operation.json'), 'utf8'))
  assert.equal(manifest.kind, 'dsh-session-kit-trash')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.rootSessionId, 'session-a')
  assert.equal(manifest.sessions[0].id, 'session-a')
  assert.equal(manifest.sessions[0].originalDir, facts.workspace.path)
  assert.equal(manifest.sessionsRoot, facts.sessionsRoot)
  assert.deepEqual(manifest.archived, ['session-a'])

  const listed = await listTrashOperations(facts.ctx, { trashDir: facts.trashDir })
  assert.equal(listed.operations.length, 1)
  assert.equal(listed.operations[0].operationId, operationId)
  assert.equal(listed.operations[0].restorable, true)
  assert.equal(listed.operations[0].sessionCount, 1)
  assert.ok(listed.operations[0].bytes > 0)

  const restored = await restoreTrashOperation(facts.ctx, { trashDir: facts.trashDir, operationId })
  assert.equal(restored.restored.length, 1)
  assert.equal(restored.skipped.length, 0)
  assert.equal(existsSync(join(facts.session.sessionDir, 'session.v4.jsonl')), true)
  assert.deepEqual(facts.workspace.sessionIds, ['session-a'])
  assert.deepEqual(facts.registry.calls.archive, ['session-a'], 'archived state is restored')
  assert.equal(existsSync(deleted.trashedPath), false, 'an empty operation directory is removed')
})

test('restore never overwrites an existing target directory', async (t) => {
  const facts = fixture(t)
  const deleted = await deleteSession(facts.ctx, 'session-a', { trashDir: facts.trashDir })
  mkdirSync(facts.session.sessionDir, { recursive: true })
  writeFileSync(join(facts.session.sessionDir, 'kept.txt'), 'do not touch\n')

  const restored = await restoreTrashOperation(facts.ctx, {
    trashDir: facts.trashDir,
    operationId: basename(deleted.trashedPath),
  })
  assert.equal(restored.restored.length, 0)
  assert.deepEqual(
    restored.skipped.map((entry) => entry.reason),
    ['target-exists'],
  )
  assert.equal(existsSync(join(facts.session.sessionDir, 'kept.txt')), true)
  assert.equal(existsSync(join(deleted.trashedPath, encodeSegment('session-a'))), true, 'source stays in the trash')
})

test('restore refuses an operation without a manifest', async (t) => {
  const trashDir = tempDir(t, 'legacy')
  mkdirSync(join(trashDir, '2026-11-13T00-00-00-000Z'), { recursive: true })
  const listed = await listTrashOperations(null, { trashDir })
  assert.equal(listed.operations.length, 1)
  assert.equal(listed.operations[0].restorable, false)
  assert.match(listed.warnings.join('\n'), /缺少清单/u)

  await assert.rejects(
    restoreTrashOperation(null, { trashDir, operationId: '2026-11-13T00-00-00-000Z' }),
    (error) => error.code === 'trash-manifest-missing',
  )
})

test('restore rejects an operation path outside the trash root', async (t) => {
  const trashDir = tempDir(t, 'escape')
  await assert.rejects(
    restoreTrashOperation(null, { trashDir, operationId: '../outside' }),
    (error) => error.code === 'invalid-argument',
  )
  const missing = await listTrashOperations(null, { trashDir: join(trashDir, 'missing') })
  assert.deepEqual(missing.operations, [])
})

test('restore skips a session whose recorded directory escaped the sessions root', async (t) => {
  const facts = fixture(t)
  const deleted = await deleteSession(facts.ctx, 'session-a', { trashDir: facts.trashDir })
  const manifestPath = join(deleted.trashedPath, 'operation.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.sessions[0].originalDir = '/tmp/elsewhere'
  writeFileSync(manifestPath, JSON.stringify(manifest) + '\n')

  const restored = await restoreTrashOperation(facts.ctx, {
    trashDir: facts.trashDir,
    operationId: basename(deleted.trashedPath),
  })
  assert.deepEqual(
    restored.skipped.map((entry) => entry.reason),
    ['unsafe-location'],
  )
  assert.equal(existsSync('/tmp/elsewhere'), false)
})

test('purge requires confirm and only removes directories inside the trash root', async (t) => {
  const facts = fixture(t)
  await deleteSession(facts.ctx, 'session-a', { trashDir: facts.trashDir })

  await assert.rejects(
    purgeTrashOperations(null, { trashDir: facts.trashDir, operationIds: 'all' }),
    (error) => error.code === 'confirm-required',
  )
  await assert.rejects(
    purgeTrashOperations(null, { trashDir: facts.trashDir, operationIds: ['../outside'], confirm: true }),
    (error) => error.code === 'invalid-argument',
  )

  const purged = await purgeTrashOperations(null, {
    trashDir: facts.trashDir,
    operationIds: 'all',
    confirm: true,
  })
  assert.equal(purged.removed.length, 1)
  assert.ok(purged.freedBytes > 0)
  const remaining = await listTrashOperations(null, { trashDir: facts.trashDir })
  assert.equal(remaining.operations.length, 0)
})
