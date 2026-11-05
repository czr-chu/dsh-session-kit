/**
 * Behavior tests for session management: archive/unarchive through the
 * workspace registry, and delete-as-trash-move with lineage closure, active
 * refusal, and location verification. No real DSH home is touched.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  archiveSession,
  deleteSession,
  encodeSegment,
  unarchiveSession,
} from '../lib/manage.js';

/** One temp directory with cleanup registered on the test context. */
function tempDir(t, label) {
  const dir = mkdtempSync(join(tmpdir(), 'dsk-manage-' + label + '-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Create one JSONL session directory and return its location facts. */
function writeSessionDir(sessionsRoot, projectName, id, logName = 'session.v4.jsonl') {
  const sessionDir = join(sessionsRoot, projectName, encodeSegment(id));
  mkdirSync(sessionDir, { recursive: true });
  const logPath = join(sessionDir, logName);
  writeFileSync(logPath, '{"type":"session"}\n');
  return { sessionDir, logPath };
}

/** One persistence list snapshot for a session stored at logPath. */
function snapshotOf(id, logPath, extraHeader = {}) {
  return {
    header: {
      version: 4,
      id,
      createdAt: 1_700_000_000_000,
      cwd: '/work/demo',
      isSeeded: false,
      delegationDepth: 0,
      ...extraHeader,
    },
    formatStatus: 'current',
    revision: 'revision-1',
    location: { kind: 'jsonl', path: logPath },
  };
}

/** A fake composed context exposing only ctx.get(name) and ctx.logger. */
function fakeContext(services = {}) {
  const warnings = [];
  return {
    ctx: {
      get: (name) => services[name],
      logger: { warn: (message) => warnings.push(message) },
    },
    warnings,
  };
}

/** A recording workspace registry mock. */
function registryMock({ workspaces = [], archived = [], pinned = [] } = {}) {
  const calls = { archive: [], unarchive: [], unpin: [], detach: [] };
  let archivedIds = [...archived];
  let pinnedIds = [...pinned];
  for (const workspace of workspaces) {
    workspace.detachSession = async (id) => {
      calls.detach.push([workspace.id, id]);
      workspace.sessionIds = workspace.sessionIds.filter((value) => value !== id);
    };
  }
  return {
    calls,
    get archivedSessionIds() {
      return archivedIds;
    },
    get pinnedSessionIds() {
      return pinnedIds;
    },
    async list() {
      return workspaces;
    },
    async archiveSession(id, options) {
      calls.archive.push([id, options]);
      if (!archivedIds.includes(id)) archivedIds = [...archivedIds, id];
    },
    async unarchiveSession(id) {
      calls.unarchive.push(id);
      archivedIds = archivedIds.filter((value) => value !== id);
    },
    async unpinSession(id) {
      calls.unpin.push(id);
      pinnedIds = pinnedIds.filter((value) => value !== id);
    },
  };
}

/**
 * Build one complete delete fixture: a root, a two-level subagent chain that
 * must cascade, a user-visible fork child plus its own subagent child that must
 * be preserved, and an unrelated session.
 */
function deleteFixture(t) {
  const home = tempDir(t, 'home');
  const sessionsRoot = join(home, 'sessions');
  const root = writeSessionDir(sessionsRoot, '--work-demo--', 'session-a');
  const child = writeSessionDir(sessionsRoot, '--work-demo--', 'session-b');
  const grandchild = writeSessionDir(sessionsRoot, '--other--', 'session-c');
  const unrelated = writeSessionDir(sessionsRoot, '--work-demo--', 'session-x');
  const forkChild = writeSessionDir(sessionsRoot, '--work-demo--', 'session-fork');
  const forkGrandchild = writeSessionDir(sessionsRoot, '--work-demo--', 'session-fork-sub');
  const snapshots = [
    snapshotOf('session-a', root.logPath),
    snapshotOf('session-b', child.logPath, { parentSession: 'session-a', origin: 'subagent' }),
    snapshotOf('session-c', grandchild.logPath, { parentSession: 'session-b', origin: 'subagent' }),
    snapshotOf('session-x', unrelated.logPath),
    // A user fork: parentSession points at the deleted session, but origin is
    // unset, so it is a conversation the user owns, not a transcript fragment.
    snapshotOf('session-fork', forkChild.logPath, { parentSession: 'session-a', isSeeded: true }),
    snapshotOf('session-fork-sub', forkGrandchild.logPath, { parentSession: 'session-fork', origin: 'subagent' }),
  ];
  return {
    home,
    sessionsRoot,
    trashDir: join(home, 'trash'),
    root,
    child,
    grandchild,
    unrelated,
    forkChild,
    forkGrandchild,
    snapshots,
  };
}

/** Write one workspace file, creating parent directories. */
function writeWorkspaceFile(root, relativePath, content = 'x') {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

/** One related-file plan entry for an existing file under a workspace root. */
function planEntry(root, relativePath, overrides = {}) {
  const path = join(root, relativePath);
  return {
    path,
    relative: relativePath,
    root,
    bytes: statSync(path).size,
    evidence: ['deliverables/presented'],
    weak: false,
    sessionIds: ['session-a'],
    ...overrides,
  };
}

/** Every immediately created operation directory under a trash root. */
function trashOperations(trashDir) {
  try {
    return readdirSync(trashDir).map((name) => join(trashDir, name));
  } catch {
    return [];
  }
}

test('encodeSegment mirrors the JSONL backend safe-segment rules', () => {
  assert.equal(encodeSegment('session-a1'), 'session-a1');
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
  assert.equal(encodeSegment('../evil'), '..~002Fevil');
  assert.equal(encodeSegment('a~b'), 'a~007Eb');
  assert.equal(encodeSegment('中文'), '~4E2D~6587');
  assert.equal(encodeSegment('a/b\\c'), 'a~002Fb~005Cc');
  assert.throws(() => encodeSegment(''), /无法编码空的会话 id/u);
});

test('archiveSession archives through the registry and surfaces active sessions', async () => {
  const registry = registryMock({ pinned: ['session-a'] });
  const { ctx } = fakeContext({ workspaceRegistry: registry });
  assert.deepEqual(await archiveSession(ctx, ' session-a '), { sessionId: 'session-a' });
  assert.deepEqual(registry.calls.archive, [['session-a', { stopActivity: false }]]);
  assert.deepEqual(registry.archivedSessionIds, ['session-a']);

  const activeError = Object.assign(new Error('cannot archive session: the session is active (turn)'), {
    name: 'WorkspaceActiveSessionError',
    sessionId: 'session-a',
    activity: [{ kind: 'turn' }],
  });
  const active = registryMock();
  active.archiveSession = async () => {
    throw activeError;
  };
  const activeCtx = fakeContext({ workspaceRegistry: active }).ctx;
  await assert.rejects(archiveSession(activeCtx, 'session-a'), (error) => {
    assert.equal(error.code, 'active');
    assert.match(error.message, /正在运行/u);
    return true;
  });
  // stopActivity asks the registry to stop running work instead of refusing.
  const stopping = registryMock();
  let seenOptions;
  stopping.archiveSession = async (id, options) => {
    seenOptions = options;
  };
  await archiveSession(fakeContext({ workspaceRegistry: stopping }).ctx, 'session-a', { stopActivity: true });
  assert.deepEqual(seenOptions, { stopActivity: true });

  const unknown = registryMock();
  unknown.archiveSession = async () => {
    throw Object.assign(new Error('unknown session'), { name: 'WorkspaceUnknownSessionError' });
  };
  await assert.rejects(
    archiveSession(fakeContext({ workspaceRegistry: unknown }).ctx, 'session-gone'),
    (error) => error.code === 'not-found',
  );
  await assert.rejects(archiveSession(fakeContext({}).ctx, 'session-a'), (error) => error.code === 'unavailable');
  await assert.rejects(archiveSession(fakeContext({ workspaceRegistry: registryMock() }).ctx, '  '), (error) => error.code === 'invalid-argument');
});

test('unarchiveSession is idempotent and reports registry failures', async () => {
  const registry = registryMock({ archived: ['session-a'] });
  const { ctx } = fakeContext({ workspaceRegistry: registry });
  assert.deepEqual(await unarchiveSession(ctx, 'session-a'), { sessionId: 'session-a' });
  assert.deepEqual(registry.calls.unarchive, ['session-a']);
  assert.deepEqual(registry.archivedSessionIds, []);
  await assert.rejects(unarchiveSession(fakeContext({}).ctx, 'session-a'), (error) => error.code === 'unavailable');
  const broken = registryMock();
  broken.unarchiveSession = async () => {
    throw new Error('registry write failed');
  };
  await assert.rejects(
    unarchiveSession(fakeContext({ workspaceRegistry: broken }).ctx, 'session-a'),
    (error) => error.code === 'unarchive-failed' && /registry write failed/u.test(error.message),
  );
});

test('deleteSession trashes the session, its subagent descendants, and cleans registry state', async (t) => {
  const fixture = deleteFixture(t);
  const workspaces = [{
    id: 'workspace-1',
    title: 'demo',
    path: '/work/demo',
    sessionIds: ['session-a', 'session-b', 'session-x'],
  }];
  const registry = registryMock({ workspaces, archived: ['session-b'], pinned: ['session-a', 'session-b'] });
  const persistence = { async list() { return fixture.snapshots; } };
  const { ctx } = fakeContext({
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    sessionPersistence: persistence,
    workspaceRegistry: registry,
  });
  const result = await deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir });
  assert.deepEqual(result.sessionIds, ['session-a', 'session-b', 'session-c']);
  assert.ok(result.trashedPath.startsWith(fixture.trashDir));
  assert.match(result.trashedPath.slice(fixture.trashDir.length + 1), /^\d{4}-\d{2}-\d{2}T/u);
  // Moved bytes, not erased.
  for (const id of ['session-a', 'session-b', 'session-c']) {
    assert.equal(existsSync(join(result.trashedPath, id, 'session.v4.jsonl')), true, 'trashed ' + id);
  }
  assert.equal(existsSync(fixture.root.sessionDir), false);
  assert.equal(existsSync(fixture.child.sessionDir), false);
  assert.equal(existsSync(fixture.grandchild.sessionDir), false);
  // Unrelated sessions stay put.
  assert.equal(existsSync(fixture.unrelated.sessionDir), true);
  assert.equal(existsSync(fixture.unrelated.logPath), true);
  // A fork/seeded child and its subagent subtree are preserved.
  assert.equal(existsSync(fixture.forkChild.sessionDir), true);
  assert.equal(existsSync(fixture.forkChild.logPath), true);
  assert.equal(existsSync(fixture.forkGrandchild.sessionDir), true);
  assert.equal(existsSync(join(result.trashedPath, 'session-fork')), false);
  assert.equal(existsSync(join(result.trashedPath, 'session-fork-sub')), false);
  // Registry cleanup covers every moved id.
  assert.deepEqual(registry.calls.detach, [['workspace-1', 'session-a'], ['workspace-1', 'session-b']]);
  assert.deepEqual(registry.calls.unpin.sort(), ['session-a', 'session-b', 'session-c']);
  assert.deepEqual(registry.calls.unarchive.sort(), ['session-a', 'session-b', 'session-c']);
  assert.deepEqual(registry.archivedSessionIds, []);
  assert.deepEqual(registry.pinnedSessionIds, []);
});

test('deleteSession cascades only subagent descendants and keeps fork/seeded children', async (t) => {
  const fixture = deleteFixture(t);
  const persistence = { async list() { return fixture.snapshots; } };
  const workspaces = [{ id: 'workspace-1', sessionIds: ['session-a', 'session-b', 'session-fork'] }];
  const registry = registryMock({ workspaces, pinned: ['session-a'], archived: ['session-a'] });
  const { ctx } = fakeContext({
    sessions: { get: () => undefined },
    // A running fork child is not part of this delete, so it must not block it.
    agents: { get: (id) => (id === 'session-fork' ? { status: 'running' } : undefined) },
    sessionPersistence: persistence,
    workspaceRegistry: registry,
  });
  const result = await deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir });
  // Only the root and the two origin='subagent' descendants move.
  assert.deepEqual(result.sessionIds, ['session-a', 'session-b', 'session-c']);
  assert.deepEqual(
    [existsSync(join(result.trashedPath, 'session-a')), existsSync(join(result.trashedPath, 'session-b')), existsSync(join(result.trashedPath, 'session-c'))],
    [true, true, true],
  );
  // The fork/seeded child and its subagent subtree stay exactly in place.
  assert.equal(existsSync(fixture.forkChild.sessionDir), true);
  assert.equal(existsSync(fixture.forkGrandchild.sessionDir), true);
  assert.equal(existsSync(join(result.trashedPath, 'session-fork')), false);
  assert.equal(existsSync(join(result.trashedPath, 'session-fork-sub')), false);
  // Registry cleanup never touches the preserved fork.
  assert.deepEqual(registry.calls.detach, [['workspace-1', 'session-a'], ['workspace-1', 'session-b']]);
  assert.deepEqual(registry.calls.unpin.sort(), ['session-a', 'session-b', 'session-c']);
  assert.deepEqual(registry.archivedSessionIds, []);
});

test('deleteSession accepts the _no-cwd project directory', async (t) => {
  const home = tempDir(t, 'nocwd');
  const sessionsRoot = join(home, 'sessions');
  const stored = writeSessionDir(sessionsRoot, '_no-cwd', 'session-n');
  const persistence = { async list() { return [snapshotOf('session-n', stored.logPath, { cwd: undefined })]; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined }, agents: { get: () => undefined } });
  const result = await deleteSession(ctx, 'session-n', { trashDir: join(home, 'trash') });
  assert.deepEqual(result.sessionIds, ['session-n']);
  assert.equal(existsSync(join(result.trashedPath, 'session-n', 'session.v4.jsonl')), true);
  assert.equal(existsSync(stored.sessionDir), false);
});

test('deleteSession refuses live sessions and running descendants before moving anything', async (t) => {
  const fixture = deleteFixture(t);
  const persistence = { async list() { return fixture.snapshots; } };
  const live = fakeContext({
    sessions: { get: (id) => (id === 'session-a' ? { id } : undefined) },
    agents: { get: () => undefined },
    sessionPersistence: persistence,
  }).ctx;
  await assert.rejects(deleteSession(live, 'session-a', { trashDir: fixture.trashDir }), (error) => {
    assert.equal(error.code, 'active');
    assert.match(error.message, /活动会话/u);
    return true;
  });
  assert.equal(existsSync(fixture.root.sessionDir), true, 'live session is not moved');

  const running = fakeContext({
    sessions: { get: () => undefined },
    agents: { get: (id) => (id === 'session-b' ? { status: 'running' } : undefined) },
    sessionPersistence: persistence,
  }).ctx;
  await assert.rejects(deleteSession(running, 'session-a', { trashDir: fixture.trashDir }), (error) => {
    assert.equal(error.code, 'active');
    assert.match(error.message, /正在运行的代理/u);
    return true;
  });
  assert.equal(existsSync(fixture.root.sessionDir), true, 'running descendant blocks the whole delete');
  assert.equal(existsSync(join(fixture.trashDir)), false, 'nothing was trashed');
});

test('deleteSession reports a missing session without touching the store', async (t) => {
  const fixture = deleteFixture(t);
  const persistence = { async list() { return fixture.snapshots; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  await assert.rejects(deleteSession(ctx, 'session-missing', { trashDir: fixture.trashDir }), (error) => error.code === 'not-found');
  await assert.rejects(deleteSession(fakeContext({}).ctx, 'session-a'), (error) => error.code === 'unavailable');
  assert.equal(existsSync(fixture.root.sessionDir), true);
});

test('deleteSession refuses locations it cannot verify as session directories', async (t) => {
  const home = tempDir(t, 'unsafe');
  const sessionsRoot = join(home, 'sessions');
  const trashDir = join(home, 'trash');
  const makeCtx = (snapshot) => fakeContext({
    sessionPersistence: { async list() { return [snapshot]; } },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
  }).ctx;

  // Wrong session-directory leaf.
  const wrongLeaf = writeSessionDir(sessionsRoot, '--work-demo--', 'session-a');
  const wrongDir = join(sessionsRoot, '--work-demo--', 'not-the-id');
  mkdirSync(wrongDir, { recursive: true });
  writeFileSync(join(wrongDir, 'session.v4.jsonl'), '{}\n');
  await assert.rejects(
    deleteSession(makeCtx(snapshotOf('session-a', join(wrongDir, 'session.v4.jsonl'))), 'session-a', { trashDir }),
    (error) => error.code === 'unsafe-location' && /目录名/u.test(error.message),
  );
  assert.equal(existsSync(wrongDir), true);

  // Non-filesystem backend location.
  await assert.rejects(
    deleteSession(makeCtx({ header: { id: 'session-a' }, location: { kind: 'sqlite', path: '/tmp/sessions.db' } }), 'session-a', { trashDir }),
    (error) => error.code === 'unsafe-location' && /kind=sqlite/u.test(error.message),
  );

  // No location at all.
  await assert.rejects(
    deleteSession(makeCtx({ header: { id: 'session-a' } }), 'session-a', { trashDir }),
    (error) => error.code === 'unsafe-location' && /没有可用的文件系统存储位置/u.test(error.message),
  );

  // Parent directory is not a DSH project directory.
  const nonProjectDir = join(sessionsRoot, 'plain', 'session-a');
  mkdirSync(nonProjectDir, { recursive: true });
  writeFileSync(join(nonProjectDir, 'session.v4.jsonl'), '{}\n');
  await assert.rejects(
    deleteSession(makeCtx(snapshotOf('session-a', join(nonProjectDir, 'session.v4.jsonl'))), 'session-a', { trashDir }),
    (error) => error.code === 'unsafe-location' && /父目录/u.test(error.message),
  );
  assert.equal(existsSync(nonProjectDir), true);

  // Log file is not a session log.
  const oddLog = writeSessionDir(sessionsRoot, '--work-demo--', 'session-a', 'notes.txt');
  await assert.rejects(
    deleteSession(makeCtx(snapshotOf('session-a', oddLog.logPath)), 'session-a', { trashDir }),
    (error) => error.code === 'unsafe-location' && /不是规范的会话日志/u.test(error.message),
  );
  assert.equal(existsSync(oddLog.sessionDir), true);
  assert.equal(existsSync(wrongLeaf.sessionDir), true);

  // Trash root placed inside the session store is refused.
  const inStoreTrash = join(wrongLeaf.sessionDir, 'trash');
  await assert.rejects(
    deleteSession(makeCtx(snapshotOf('session-a', wrongLeaf.logPath)), 'session-a', { trashDir: inStoreTrash }),
    (error) => error.code === 'unsafe-location' && /回收站目录位于会话存储目录内/u.test(error.message),
  );
  assert.equal(existsSync(wrongLeaf.sessionDir), true);
});

test('deleteSession refuses a symlinked session directory', async (t) => {
  const home = tempDir(t, 'symlink');
  const sessionsRoot = join(home, 'sessions');
  const real = writeSessionDir(join(home, 'elsewhere'), '--work-demo--', 'session-real');
  const project = join(sessionsRoot, '--work-demo--');
  mkdirSync(project, { recursive: true });
  const linkPath = join(project, 'session-a');
  try {
    symlinkSync(real.sessionDir, linkPath);
  } catch {
    t.skip('symbolic links are unavailable on this platform');
    return;
  }
  const persistence = { async list() { return [snapshotOf('session-a', join(linkPath, 'session.v4.jsonl'))]; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  await assert.rejects(
    deleteSession(ctx, 'session-a', { trashDir: join(home, 'trash') }),
    (error) => error.code === 'unsafe-location' && /符号链接/u.test(error.message),
  );
  assert.equal(existsSync(real.sessionDir), true);
});

test('deleteSession reports a stale listing as not-found before moving anything', async (t) => {
  const home = tempDir(t, 'stale');
  const sessionsRoot = join(home, 'sessions');
  const stored = writeSessionDir(sessionsRoot, '--work-demo--', 'session-a');
  rmSync(stored.sessionDir, { recursive: true, force: true });
  const persistence = { async list() { return [snapshotOf('session-a', stored.logPath)]; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  await assert.rejects(deleteSession(ctx, 'session-a', { trashDir: join(home, 'trash') }), (error) => error.code === 'not-found');
});

test('deleteSession encodes hostile ids into safe trash leaves', async (t) => {
  const home = tempDir(t, 'hostile');
  const sessionsRoot = join(home, 'sessions');
  const hostileId = '../evil';
  const stored = writeSessionDir(sessionsRoot, '--work-demo--', hostileId);
  const persistence = { async list() { return [snapshotOf(hostileId, stored.logPath)]; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  const result = await deleteSession(ctx, hostileId, { trashDir: join(home, 'trash') });
  const leaf = '..~002Fevil';
  assert.deepEqual(result.sessionIds, [hostileId]);
  assert.equal(existsSync(join(result.trashedPath, leaf, 'session.v4.jsonl')), true);
  assert.equal(existsSync(join(home, 'evil')), false, 'no traversal outside the trash');
  assert.equal(existsSync(stored.sessionDir), false);
});

test('deleteSession rolls back when one move fails', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: directory permissions cannot force a rename failure');
    return;
  }
  const home = tempDir(t, 'rollback');
  const sessionsRoot = join(home, 'sessions');
  const root = writeSessionDir(sessionsRoot, '--work-demo--', 'session-a');
  const child = writeSessionDir(sessionsRoot, '--readonly--', 'session-b');
  const projectB = join(sessionsRoot, '--readonly--');
  const persistence = {
    async list() {
      return [
        snapshotOf('session-a', root.logPath),
        snapshotOf('session-b', child.logPath, { parentSession: 'session-a', origin: 'subagent' }),
      ];
    },
  };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  const trashDir = join(home, 'trash');
  chmodSync(projectB, 0o555);
  try {
    await assert.rejects(deleteSession(ctx, 'session-a', { trashDir }), (error) => {
      assert.equal(error.code, 'delete-failed');
      assert.match(error.message, /移动会话目录到回收站失败/u);
      return true;
    });
  } finally {
    chmodSync(projectB, 0o755);
  }
  assert.equal(existsSync(root.sessionDir), true, 'first move was rolled back');
  assert.equal(existsSync(child.sessionDir), true, 'failed target never moved');
});

test('deleteSession tolerates registry cleanup failures', async (t) => {
  const fixture = deleteFixture(t);
  const workspaces = [{ id: 'workspace-1', sessionIds: ['session-a'] }];
  const registry = registryMock({ workspaces, pinned: ['session-a'], archived: ['session-a'] });
  workspaces[0].detachSession = async () => { throw new Error('detach failed'); };
  registry.unpinSession = async () => { throw new Error('unpin failed'); };
  registry.unarchiveSession = async () => { throw new Error('unarchive failed'); };
  const persistence = { async list() { return fixture.snapshots; } };
  const { ctx, warnings } = fakeContext({
    sessionPersistence: persistence,
    sessions: { get: () => undefined },
    workspaceRegistry: registry,
  });
  const result = await deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir });
  assert.deepEqual(result.sessionIds, ['session-a', 'session-b', 'session-c']);
  assert.equal(existsSync(join(result.trashedPath, 'session-a', 'session.v4.jsonl')), true);
  assert.ok(warnings.some((warning) => warning.includes('detach failed')));
  assert.ok(warnings.some((warning) => warning.includes('unpin failed')));
  assert.ok(warnings.some((warning) => warning.includes('unarchive failed')));
});

test('deleteSession re-reads the authoritative location through persistence.stat', async (t) => {
  const fixture = deleteFixture(t);
  // The listing carries no location; only stat knows where the artifact lives.
  const listed = fixture.snapshots.map((snapshot) => {
    const { location: _location, ...withoutLocation } = snapshot;
    return withoutLocation;
  });
  const locations = new Map([
    ['session-a', fixture.root.logPath],
    ['session-b', fixture.child.logPath],
    ['session-c', fixture.grandchild.logPath],
  ]);
  const persistence = {
    async list() { return listed; },
    async stat(id) { return snapshotOf(id, locations.get(id)); },
  };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  const result = await deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir });
  assert.deepEqual(result.sessionIds, ['session-a', 'session-b', 'session-c']);
  assert.equal(existsSync(join(result.trashedPath, 'session-a', 'session.v4.jsonl')), true);
  assert.equal(existsSync(fixture.root.sessionDir), false);
});

test('deleteSession treats a stat miss or failure as a whole-operation failure', async (t) => {
  const fixture = deleteFixture(t);
  const missing = {
    async list() { return fixture.snapshots; },
    async stat() { return undefined; },
  };
  const missingCtx = fakeContext({ sessionPersistence: missing, sessions: { get: () => undefined } }).ctx;
  await assert.rejects(deleteSession(missingCtx, 'session-a', { trashDir: fixture.trashDir }), (error) => error.code === 'not-found');
  assert.equal(existsSync(fixture.root.sessionDir), true);

  const broken = {
    async list() { return fixture.snapshots; },
    async stat() { throw new Error('store unreadable'); },
  };
  const brokenCtx = fakeContext({ sessionPersistence: broken, sessions: { get: () => undefined } }).ctx;
  await assert.rejects(deleteSession(brokenCtx, 'session-a', { trashDir: fixture.trashDir }), (error) => {
    assert.equal(error.code, 'delete-failed');
    assert.match(error.message, /无法读取会话 session-a 的存储位置/u);
    return true;
  });
  assert.equal(existsSync(fixture.root.sessionDir), true);
});

test('deleteSession falls back to copy + remove across filesystems (EXDEV)', async (t) => {
  const fixture = deleteFixture(t);
  const sourceDevice = statSync(fixture.root.sessionDir).dev;
  const crossDeviceRoots = ['/dev/shm', '/run/shm', '/tmp'].filter((candidate) => {
    try {
      return statSync(candidate).isDirectory() && statSync(candidate).dev !== sourceDevice;
    } catch {
      return false;
    }
  });
  if (crossDeviceRoots.length === 0) {
    t.skip('no second filesystem available for the EXDEV fallback');
    return;
  }
  const crossRoot = mkdtempSync(join(crossDeviceRoots[0], 'dsk-trash-'));
  t.after(() => rmSync(crossRoot, { recursive: true, force: true }));
  const persistence = {
    async list() { return [snapshotOf('session-a', fixture.root.logPath)]; },
  };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  const result = await deleteSession(ctx, 'session-a', { trashDir: join(crossRoot, 'trash') });
  assert.equal(existsSync(join(result.trashedPath, 'session-a', 'session.v4.jsonl')), true);
  assert.equal(existsSync(fixture.root.sessionDir), false);
  assert.equal(statSync(join(result.trashedPath, 'session-a')).dev, statSync(crossRoot).dev);
});

test('deleteSession defaults the trash root to DSH_HOME/session-kit-trash', async (t) => {
  const fixture = deleteFixture(t);
  const persistence = { async list() { return [snapshotOf('session-a', fixture.root.logPath)]; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = fixture.home;
  try {
    const result = await deleteSession(ctx, 'session-a');
    assert.equal(result.trashedPath.startsWith(join(fixture.home, 'session-kit-trash')), true);
    assert.equal(existsSync(join(result.trashedPath, 'session-a', 'session.v4.jsonl')), true);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
  assert.equal(existsSync(fixture.root.sessionDir), false);
});

test('deleteSession fails cleanly when the trash root cannot be created', async (t) => {
  const fixture = deleteFixture(t);
  const blocker = join(fixture.home, 'blocked-trash');
  writeFileSync(blocker, 'not a directory');
  const persistence = { async list() { return [snapshotOf('session-a', fixture.root.logPath)]; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  await assert.rejects(
    deleteSession(ctx, 'session-a', { trashDir: blocker }),
    (error) => error.code === 'delete-failed' && /无法创建回收站目录/u.test(error.message),
  );
  assert.equal(existsSync(fixture.root.sessionDir), true);
});

test('deleteSession removeFiles moves planned files first and writes a manifest', async (t) => {
  const fixture = deleteFixture(t);
  const workspaceRoot = tempDir(t, 'workspace');
  const report = writeWorkspaceFile(workspaceRoot, 'report.md', 'report');
  const data = writeWorkspaceFile(workspaceRoot, 'src/data.txt', 'data');
  const workspaces = [{ id: 'workspace-1', title: 'demo', path: workspaceRoot, sessionIds: ['session-a', 'session-b', 'session-x'] }];
  const registry = registryMock({ workspaces, pinned: ['session-a'], archived: ['session-a'] });
  const persistence = { async list() { return fixture.snapshots; } };
  const { ctx } = fakeContext({
    sessionPersistence: persistence,
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    workspaceRegistry: registry,
  });
  const plan = {
    files: [
      planEntry(workspaceRoot, 'report.md', { evidence: ['deliverables/presented'], weak: false }),
      planEntry(workspaceRoot, 'src/data.txt', { evidence: ['tool/arguments'], weak: true, sessionIds: ['session-a', 'session-b'] }),
    ],
    skipped: [{ path: join(workspaceRoot, 'gone.txt'), reason: 'missing' }],
    warnings: ['文件列表为尽力推导'],
    totalBytes: 2,
  };
  const expectedBytes = statSync(report).size + statSync(data).size;
  const result = await deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir, removeFiles: true, filePlan: plan });
  assert.equal(result.filesMoved, 2);
  assert.equal(result.filesSkipped, 1);
  assert.equal(result.filesBytes, expectedBytes);
  assert.equal(result.filesTrashPath, join(result.trashedPath, 'files'));
  assert.ok(result.fileWarnings.some((warning) => warning.includes('尽力推导')));
  const encodedRoot = encodeSegment(workspaceRoot);
  const trashedReport = join(result.filesTrashPath, encodedRoot, 'report.md');
  const trashedData = join(result.filesTrashPath, encodedRoot, 'src/data.txt');
  assert.equal(existsSync(trashedReport), true);
  assert.equal(existsSync(trashedData), true);
  assert.equal(existsSync(report), false);
  assert.equal(existsSync(data), false);
  const manifest = JSON.parse(readFileSync(join(result.trashedPath, 'files-manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'dsh-session-kit-files');
  assert.equal(manifest.files.length, 2);
  const reportEntry = manifest.files.find((entry) => entry.relative === 'report.md');
  assert.deepEqual(reportEntry.evidence, ['deliverables/presented']);
  assert.equal(reportEntry.path, report);
  assert.equal(reportEntry.trashedPath, trashedReport);
  // Session directories still move and registry state is cleaned as before.
  assert.equal(existsSync(join(result.trashedPath, 'session-a', 'session.v4.jsonl')), true);
  assert.equal(existsSync(fixture.root.sessionDir), false);
  assert.deepEqual(registry.archivedSessionIds, []);
});

test('deleteSession without removeFiles reports empty file stats and writes no manifest', async (t) => {
  const fixture = deleteFixture(t);
  const persistence = { async list() { return fixture.snapshots; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  const result = await deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir });
  assert.equal(result.filesMoved, 0);
  assert.equal(result.filesSkipped, 0);
  assert.equal(result.filesBytes, 0);
  assert.deepEqual(result.fileWarnings, []);
  assert.equal(result.filesTrashPath, undefined);
  assert.equal(existsSync(join(result.trashedPath, 'files-manifest.json')), false);
  assert.equal(existsSync(join(result.trashedPath, 'files')), false);
});

test('deleteSession derives the file plan when removeFiles has no filePlan', async (t) => {
  const fixture = deleteFixture(t);
  const workspaceRoot = tempDir(t, 'derived');
  const derived = writeWorkspaceFile(workspaceRoot, 'derived.txt', 'derived');
  const eventsById = new Map([
    ['session-a', [{ type: 'deliverables/presented', data: { files: [{ path: derived }] } }]],
    ['session-b', []],
    ['session-c', []],
  ]);
  const persistence = {
    async list() { return fixture.snapshots; },
    async open(id, mode) {
      if (mode !== 'read') throw new Error('unexpected write open');
      const snapshot = fixture.snapshots.find((entry) => entry.header.id === id);
      if (snapshot === undefined) throw new Error('missing session ' + id);
      return {
        header: snapshot.header,
        async read() { return { events: eventsById.get(id) ?? [] }; },
        async close() {},
      };
    },
  };
  const workspaces = [{ id: 'workspace-1', path: workspaceRoot, sessionIds: ['session-a', 'session-b', 'session-x'] }];
  const registry = registryMock({ workspaces });
  const { ctx } = fakeContext({
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    sessions: { get: () => undefined },
  });
  const result = await deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir, removeFiles: true });
  assert.equal(result.filesMoved, 1);
  assert.ok(result.fileWarnings.some((warning) => warning.includes('尽力推导')));
  assert.equal(existsSync(join(result.filesTrashPath, encodeSegment(workspaceRoot), 'derived.txt')), true);
  assert.equal(existsSync(derived), false);
  assert.equal(existsSync(join(result.trashedPath, 'session-a', 'session.v4.jsonl')), true);
});

test('deleteSession rolls moved files back when a later file move fails', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: directory permissions cannot force a rename failure');
    return;
  }
  const fixture = deleteFixture(t);
  const workspaceRoot = tempDir(t, 'file-rollback');
  const first = writeWorkspaceFile(workspaceRoot, 'ok/first.txt', 'first');
  const second = writeWorkspaceFile(workspaceRoot, 'locked/second.txt', 'second');
  const workspaces = [{ id: 'workspace-1', path: workspaceRoot, sessionIds: ['session-a'] }];
  const registry = registryMock({ workspaces });
  const persistence = { async list() { return fixture.snapshots; } };
  const { ctx } = fakeContext({
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    sessions: { get: () => undefined },
  });
  const plan = {
    files: [planEntry(workspaceRoot, 'ok/first.txt'), planEntry(workspaceRoot, 'locked/second.txt')],
    skipped: [],
    warnings: [],
    totalBytes: 2,
  };
  const locked = join(workspaceRoot, 'locked');
  chmodSync(locked, 0o555);
  try {
    await assert.rejects(
      deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir, removeFiles: true, filePlan: plan }),
      (error) => {
        assert.equal(error.code, 'delete-failed');
        assert.match(error.message, /移动会话相关文件到回收站失败/u);
        return true;
      },
    );
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.equal(existsSync(first), true, 'the moved file was restored');
  assert.equal(existsSync(second), true, 'the failed file never moved');
  assert.equal(existsSync(fixture.root.sessionDir), true, 'session directories were never touched');
  for (const operation of trashOperations(fixture.trashDir)) {
    const names = readdirSync(operation);
    assert.equal(names.includes('session-a'), false);
    assert.equal(names.includes('session-b'), false);
    assert.equal(names.includes('session-c'), false);
  }
});

test('deleteSession rolls files back when a later session move fails', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: directory permissions cannot force a rename failure');
    return;
  }
  const home = tempDir(t, 'session-rollback');
  const sessionsRoot = join(home, 'sessions');
  const root = writeSessionDir(sessionsRoot, '--work-demo--', 'session-a');
  const child = writeSessionDir(sessionsRoot, '--readonly--', 'session-b');
  const projectB = join(sessionsRoot, '--readonly--');
  const workspaceRoot = tempDir(t, 'session-rollback-workspace');
  const file = writeWorkspaceFile(workspaceRoot, 'file.txt', 'file');
  const snapshots = [
    snapshotOf('session-a', root.logPath),
    snapshotOf('session-b', child.logPath, { parentSession: 'session-a', origin: 'subagent' }),
  ];
  const persistence = { async list() { return snapshots; } };
  const workspaces = [{ id: 'workspace-1', path: workspaceRoot, sessionIds: ['session-a'] }];
  const registry = registryMock({ workspaces });
  const { ctx } = fakeContext({
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    sessions: { get: () => undefined },
  });
  const trashDir = join(home, 'trash');
  const plan = { files: [planEntry(workspaceRoot, 'file.txt')], skipped: [], warnings: [], totalBytes: 1 };
  chmodSync(projectB, 0o555);
  try {
    await assert.rejects(
      deleteSession(ctx, 'session-a', { trashDir, removeFiles: true, filePlan: plan }),
      (error) => {
        assert.equal(error.code, 'delete-failed');
        assert.match(error.message, /移动会话目录到回收站失败/u);
        return true;
      },
    );
  } finally {
    chmodSync(projectB, 0o755);
  }
  assert.equal(existsSync(file), true, 'the moved file was restored');
  assert.equal(existsSync(root.sessionDir), true);
  assert.equal(existsSync(child.sessionDir), true);
  for (const operation of trashOperations(trashDir)) {
    const names = readdirSync(operation);
    assert.equal(names.includes('session-a'), false);
    assert.equal(names.includes('session-b'), false);
    assert.equal(names.includes('files-manifest.json'), false, 'the manifest of rolled-back files is removed');
  }
});

test('deleteSession skips stale or unsafe plan entries but still deletes the session', async (t) => {
  const fixture = deleteFixture(t);
  const workspaceRoot = tempDir(t, 'stale');
  const real = writeWorkspaceFile(workspaceRoot, 'real.txt', 'real');
  const anchor = writeWorkspaceFile(workspaceRoot, 'anchor.txt', 'anchor');
  const link = join(workspaceRoot, 'link.txt');
  symlinkSync(anchor, link);
  const missing = join(workspaceRoot, 'missing.txt');
  const otherRoot = tempDir(t, 'other-root');
  const other = writeWorkspaceFile(otherRoot, 'other.txt', 'other');
  const workspaces = [{ id: 'workspace-1', path: workspaceRoot, sessionIds: ['session-a'] }];
  const registry = registryMock({ workspaces });
  const persistence = { async list() { return fixture.snapshots; } };
  const { ctx } = fakeContext({
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    sessions: { get: () => undefined },
  });
  const plan = {
    files: [
      planEntry(workspaceRoot, 'real.txt'),
      planEntry(workspaceRoot, 'real.txt'),
      { path: link, root: workspaceRoot, relative: 'link.txt', bytes: 1, evidence: [], weak: true, sessionIds: ['session-a'] },
      { path: missing, root: workspaceRoot, relative: 'missing.txt', bytes: 0, evidence: [], weak: true, sessionIds: ['session-a'] },
      planEntry(otherRoot, 'other.txt'),
    ],
    skipped: [],
    warnings: [],
    totalBytes: 0,
  };
  const result = await deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir, removeFiles: true, filePlan: plan });
  assert.equal(result.filesMoved, 1);
  assert.equal(result.filesSkipped, 4);
  assert.ok(result.fileWarnings.some((warning) => warning.includes('同一回收站路径')));
  assert.equal(existsSync(join(result.filesTrashPath, encodeSegment(workspaceRoot), 'real.txt')), true);
  assert.equal(existsSync(link), true, 'a symlink is never moved');
  assert.equal(existsSync(other), true, 'a path outside every allowed workspace root is never moved');
  assert.equal(existsSync(fixture.root.sessionDir), false);
});

test('deleteSession rejects an invalid filePlan before moving anything', async (t) => {
  const fixture = deleteFixture(t);
  const persistence = { async list() { return fixture.snapshots; } };
  const { ctx } = fakeContext({ sessionPersistence: persistence, sessions: { get: () => undefined } });
  await assert.rejects(
    deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir, removeFiles: true, filePlan: { files: null } }),
    (error) => error.code === 'invalid-argument',
  );
  await assert.rejects(
    deleteSession(ctx, 'session-a', { trashDir: fixture.trashDir, removeFiles: true, filePlan: 'nonsense' }),
    (error) => error.code === 'invalid-argument',
  );
  assert.equal(existsSync(fixture.root.sessionDir), true);
  assert.equal(existsSync(fixture.child.sessionDir), true);
});

