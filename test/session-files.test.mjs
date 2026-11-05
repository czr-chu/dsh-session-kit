/**
 * Behavior tests for the best-effort related-file derivation.
 *
 * Sessions are mocked through the persistence seam (list/open read), workspace
 * files are real temp files, so the tests cover resolution, filtering, evidence,
 * deduplication, and the runtime-state exclusions without a DSH process.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveSessionFilePlan } from '../lib/session-files.js';
import { createRealBackend, writeAndReadBack } from './support/real-backend.mjs';

/** One temp directory with cleanup registered on the test context. */
function tempDir(t, label) {
  const dir = mkdtempSync(join(tmpdir(), 'dsk-session-files-' + label + '-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write one file, creating parents. */
function writeFile(root, relativePath, content = 'x') {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

/** One persistence snapshot for a stored session. */
function snapshotOf(id, options = {}) {
  return {
    header: {
      version: 4,
      id,
      createdAt: 1_700_000_000_000,
      cwd: options.cwd,
      isSeeded: false,
      delegationDepth: 0,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    formatStatus: 'current',
    revision: 'revision-1',
    location: { kind: 'jsonl', path: options.locationPath },
  };
}

/**
 * One fake persistence seam serving read events for the given sessions.
 * @param {Map<string, {snapshot: object, events: Array<object>, fail?: boolean}>} sessions - stored sessions.
 */
function persistenceMock(sessions) {
  return {
    async list() {
      return [...sessions.values()].map((entry) => entry.snapshot);
    },
    async open(id, mode) {
      const entry = sessions.get(id);
      if (entry === undefined) throw new Error('missing session ' + id);
      if (mode !== 'read') throw new Error('unexpected open mode ' + mode);
      if (entry.fail === true) throw new Error('log unreadable');
      return {
        header: entry.snapshot.header,
        async read() {
          return { events: entry.events };
        },
        async close() {},
      };
    },
  };
}

/** A composed-context stand-in exposing only ctx.get(name). */
function fakeContext(services = {}) {
  return {
    get: (name) => services[name],
    logger: { warn() {} },
  };
}

test('deriveSessionFilePlan resolves presented, meta, and argument paths under the workspace root', async (t) => {
  const root = tempDir(t, 'root');
  const report = writeFile(root, 'report.md');
  const out = writeFile(root, 'out.txt');
  const changed = writeFile(root, 'src/change.js');
  const argued = writeFile(root, 'src/arg.js');
  const shared = writeFile(root, 'shared.txt');
  const merged = writeFile(root, 'merged.txt');
  const rel = writeFile(root, 'sub/rel.txt');
  const dirPath = join(root, 'src');
  const missing = join(root, 'missing.txt');
  const symlinkPath = join(root, 'link.md');
  symlinkSync(report, symlinkPath);
  const outside = writeFile(tempDir(t, 'outside'), 'outside.txt');
  const storageDir = join(root, '.store');
  const storageFile = writeFile(root, '.store/session-main/leak.txt');
  mkdirSync(storageDir, { recursive: true });

  const sessions = new Map();
  sessions.set('session-main', {
    snapshot: snapshotOf('session-main', { cwd: root, locationPath: join(storageDir, 'session-main', 'session.v4.jsonl') }),
    events: [
      { type: 'deliverables/presented', data: { files: [{ path: 'report.md' }, { path: merged }, { path: outside }, { path: symlinkPath }, { path: storageFile }] } },
      { type: 'tool/result', data: { meta: { path: 'out.txt', cwd: root, diffs: [{ path: 'src/change.js' }] } } },
      { type: 'working-directory/change', data: { cwd: join(root, 'sub') } },
      { type: 'tool/call', data: { arguments: JSON.stringify({ file_path: 'rel.txt' }) } },
      { type: 'tool/call', data: { arguments: JSON.stringify({ path: 'shared.txt' }) } },
      { type: 'tool/call', data: { arguments: JSON.stringify({ file_path: dirPath }) } },
      { type: 'tool/call', data: { arguments: JSON.stringify({ file_path: missing }) } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'notes.txt' }] } },
    ],
  });
  sessions.set('session-child', {
    snapshot: snapshotOf('session-child', {
      cwd: root,
      parentSession: 'session-main',
      origin: 'subagent',
      locationPath: join(storageDir, 'session-child', 'session.v4.jsonl'),
    }),
    events: [
      { type: 'tool/result', data: { meta: { path: argued } } },
      { type: 'tool/call', data: { arguments: JSON.stringify({ path: 'shared.txt' }) } },
      { type: 'tool/call', data: { arguments: JSON.stringify({ path: 'merged.txt' }) } },
    ],
  });
  // A user-visible fork child (origin unset) and its subagent child are NOT part
  // of the derivation closure.
  sessions.set('session-fork', {
    snapshot: snapshotOf('session-fork', { cwd: root, parentSession: 'session-main', isSeeded: true, locationPath: join(storageDir, 'session-fork', 'session.v4.jsonl') }),
    events: [{ type: 'deliverables/presented', data: { files: [{ path: 'fork-only.txt' }] } }],
  });
  sessions.set('session-fork-sub', {
    snapshot: snapshotOf('session-fork-sub', { cwd: root, parentSession: 'session-fork', origin: 'subagent', locationPath: join(storageDir, 'session-fork-sub', 'session.v4.jsonl') }),
    events: [{ type: 'deliverables/presented', data: { files: [{ path: 'fork-sub-only.txt' }] } }],
  });
  const registry = { async list() { return [{ id: 'w1', path: root, sessionIds: ['session-main', 'session-child'] }]; } };
  const ctx = fakeContext({ sessionPersistence: persistenceMock(sessions), workspaceRegistry: registry });

  const plan = await deriveSessionFilePlan(ctx, ['session-main', 'session-child']);
  const byPath = new Map(plan.files.map((file) => [file.path, file]));
  assert.deepEqual([...byPath.keys()].sort(), [argued, changed, merged, out, rel, report, shared].sort());
  assert.deepEqual(byPath.get(report).evidence, ['deliverables/presented']);
  assert.equal(byPath.get(report).weak, false);
  assert.deepEqual(byPath.get(report).sessionIds, ['session-main']);
  assert.deepEqual(byPath.get(out).evidence, ['tool/result.meta']);
  assert.deepEqual(byPath.get(changed).evidence, ['tool/result.meta']);
  assert.deepEqual(byPath.get(rel).evidence, ['tool/arguments']);
  assert.equal(byPath.get(rel).weak, true);
  assert.deepEqual(byPath.get(argued).evidence, ['tool/result.meta']);
  // One path from both a strong and a weak source stays strong.
  assert.deepEqual(byPath.get(merged).evidence, ['deliverables/presented', 'tool/arguments']);
  assert.equal(byPath.get(merged).weak, false);
  assert.deepEqual(byPath.get(merged).sessionIds, ['session-child', 'session-main']);
  // A path only ever named by tool arguments stays weak even across sessions.
  assert.deepEqual(byPath.get(shared).evidence, ['tool/arguments']);
  assert.equal(byPath.get(shared).weak, true);
  // The main session's cwd changed before naming shared.txt, so only the child
  // resolves it; the merge across sessions is covered by merged.txt above.
  assert.deepEqual(byPath.get(shared).sessionIds, ['session-child']);
  const expectedBytes = [report, out, changed, argued, merged, shared, rel]
    .reduce((sum, path) => sum + statSync(path).size, 0);
  assert.equal(plan.totalBytes, expectedBytes);
  assert.equal(plan.files.some((file) => file.path === join(root, 'fork-only.txt') || file.path === join(root, 'fork-sub-only.txt')), false);
  const reasons = new Map(plan.skipped.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons.get(outside), 'outside-workspace');
  assert.equal(reasons.get(symlinkPath), 'symlink');
  assert.equal(reasons.get(dirPath), 'not-a-file');
  assert.equal(reasons.get(missing), 'missing');
  assert.equal(reasons.get(storageFile), 'excluded-runtime-state');
  assert.match(plan.warnings[0], /尽力推导/u);
});

test('deriveSessionFilePlan excludes the trash root and DSH_HOME', async (t) => {
  const root = tempDir(t, 'exclude');
  const visible = writeFile(root, 'keep.txt');
  const trashFile = writeFile(root, 'trash/drop.txt');
  const homeFile = writeFile(root, '.dsh/config.json');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, '.dsh');
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });
  const sessions = new Map();
  sessions.set('session-a', {
    snapshot: snapshotOf('session-a', { cwd: root, locationPath: join(root, 'store', 'session-a', 'session.v4.jsonl') }),
    events: [
      { type: 'deliverables/presented', data: { files: [{ path: 'keep.txt' }, { path: 'trash/drop.txt' }, { path: '.dsh/config.json' }] } },
    ],
  });
  const registry = { async list() { return [{ id: 'w1', path: root, sessionIds: ['session-a'] }]; } };
  const ctx = fakeContext({ sessionPersistence: persistenceMock(sessions), workspaceRegistry: registry });
  const plan = await deriveSessionFilePlan(ctx, ['session-a'], { trashDir: join(root, 'trash') });
  assert.deepEqual(plan.files.map((file) => file.path), [visible]);
  const reasons = new Map(plan.skipped.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons.get(trashFile), 'excluded-runtime-state');
  assert.equal(reasons.get(homeFile), 'excluded-runtime-state');
});

test('deriveSessionFilePlan reads a real stored session through the persistence seam (guarded)', async (t) => {
  const backend = await createRealBackend();
  if (!backend.ok) {
    t.skip('real JSONL backend unavailable (run from the DSH repo with node --import tsx/esm): ' + backend.error);
    return;
  }
  const workspaceRoot = tempDir(t, 'real');
  const delivered = writeFile(workspaceRoot, 'delivered.txt', 'delivered');
  try {
    const header = {
      version: 4,
      id: 'session-files-real',
      createdAt: 1_700_000_000_000,
      cwd: workspaceRoot,
      isSeeded: false,
      delegationDepth: 0,
    };
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, time: 3, data: { role: 'user', id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'deliver it' }] }, surfaceOp: 'append' },
      { type: 'deliverables/presented', seq: 3, time: 4, data: { turn: 1, files: [{ path: delivered }] } },
      { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const written = await writeAndReadBack(backend.persistence, header, events);
    assert.equal(written.events.length, events.length);
    const registry = { async list() { return [{ id: 'w1', path: workspaceRoot, sessionIds: ['session-files-real'] }]; } };
    const ctx = fakeContext({ sessionPersistence: backend.persistence, workspaceRegistry: registry });
    const plan = await deriveSessionFilePlan(ctx, ['session-files-real']);
    assert.deepEqual(plan.files.map((entry) => entry.path), [delivered]);
    assert.deepEqual(plan.files[0].evidence, ['deliverables/presented']);
    assert.equal(plan.files[0].relative, 'delivered.txt');
    assert.equal(plan.totalBytes, statSync(delivered).size);
  } finally {
    backend.cleanup();
  }
});

test('deriveSessionFilePlan falls back to the session cwd and tolerates misses', async (t) => {
  const root = tempDir(t, 'cwd');
  const file = writeFile(root, 'file.txt');
  const sessions = new Map();
  sessions.set('session-a', {
    snapshot: snapshotOf('session-a', { cwd: root, locationPath: join(root, 'store', 'session-a', 'session.v4.jsonl') }),
    events: [{ type: 'deliverables/presented', data: { files: [{ path: 'file.txt' }] } }],
  });
  sessions.set('session-b', {
    snapshot: snapshotOf('session-b', { cwd: root, locationPath: join(root, 'store', 'session-b', 'session.v4.jsonl') }),
    fail: true,
    events: [],
  });
  const ctx = fakeContext({ sessionPersistence: persistenceMock(sessions) });
  const plan = await deriveSessionFilePlan(ctx, ['session-a', 'session-b', 'session-missing']);
  assert.deepEqual(plan.files.map((entry) => entry.path), [file]);
  assert.ok(plan.warnings.some((warning) => warning.includes('session-b') && warning.includes('读取会话')));
  assert.ok(plan.warnings.some((warning) => warning.includes('找不到会话 session-missing')));

  await assert.rejects(deriveSessionFilePlan(fakeContext(), ['session-a']), (error) => error.code === 'unavailable');
  await assert.rejects(
    deriveSessionFilePlan(fakeContext({ sessionPersistence: persistenceMock(sessions) }), 'session-a'),
    (error) => error.code === 'invalid-argument',
  );
  const emptyPlan = await deriveSessionFilePlan(fakeContext({ sessionPersistence: persistenceMock(sessions) }), []);
  assert.deepEqual(emptyPlan.files, []);
  assert.deepEqual(emptyPlan.skipped, []);
  assert.equal(emptyPlan.totalBytes, 0);
  assert.match(emptyPlan.warnings[0], /尽力推导/u);
});
