/**
 * Behavior tests for the host session helpers. Every test drives the functions
 * through a fake composed context, so no Harness process is started and no
 * real DSH home is touched.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FALLBACK_SESSION_FORMAT_VERSION,
  attachToWorkspace,
  detectFormatVersion,
  foldTitle,
  listSessionEntries,
  listWorkspaceEntries,
  mintSessionId,
  readSessionDoc,
  resolveTargetDirectory,
  servicesOf,
  sessionHeaderToSummary,
  writeNewSession,
} from '../lib/sessions.js';

/** A composed-context stand-in exposing only ctx.get(name). */
function fakeContext(services = {}) {
  return { get: (name) => services[name] };
}

/** A session header fixture. */
function headerFixture(overrides = {}) {
  return {
    version: 4,
    id: 'session-a',
    createdAt: 1_700_000_000_000,
    cwd: '/work/demo',
    isSeeded: false,
    delegationDepth: 0,
    ...overrides,
  };
}

test('servicesOf resolves every optional service without throwing', () => {
  const query = { listSessions() {} };
  const persistence = { stat() {} };
  const services = servicesOf(fakeContext({
    sessionQuery: query,
    sessionPersistence: persistence,
    sessions: { get() {} },
    attachments: { saveFile() {} },
    workspaceRegistry: { list() {} },
    agentPresets: { resolve() {} },
    workingDirectory: { defaultDirectory: '/work/demo' },
  }));
  assert.equal(services.sessionQuery, query);
  assert.equal(services.sessionPersistence, persistence);
  assert.equal(services.workingDirectory.defaultDirectory, '/work/demo');
  const empty = servicesOf(fakeContext());
  assert.equal(empty.sessionQuery, undefined);
  assert.equal(empty.workspaceRegistry, undefined);
});

test('detectFormatVersion prefers the configured override, then the newest stored header', async () => {
  const versions = (list) => fakeContext({ sessionQuery: { async listSessions() { return list; } } });
  assert.equal(await detectFormatVersion(versions([{ header: { version: 3 } }, { header: { version: 4 } }]), undefined), 4);
  assert.equal(await detectFormatVersion(versions([{ header: { version: 2 } }]), 7), 7);
  assert.equal(await detectFormatVersion(versions([]), undefined), FALLBACK_SESSION_FORMAT_VERSION);
  assert.equal(await detectFormatVersion(versions([{}, { header: {} }]), undefined), FALLBACK_SESSION_FORMAT_VERSION);
  const failing = fakeContext({ sessionQuery: { async listSessions() { throw new Error('store offline'); } } });
  assert.equal(await detectFormatVersion(failing, undefined), FALLBACK_SESSION_FORMAT_VERSION);
  assert.equal(await detectFormatVersion(fakeContext(), undefined), FALLBACK_SESSION_FORMAT_VERSION);
  assert.equal(Math.max(...[3, 4].filter((value) => Number.isSafeInteger(value))), 4);
});

test('readSessionDoc flushes a live session, then returns a detached replay-validated log', async () => {
  const flushed = [];
  const sourceHeader = headerFixture({ parentSession: 'session-parent' });
  const sourceEvents = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const ctx = fakeContext({
    sessionQuery: {
      async readSession(id) {
        assert.equal(id, 'session-a');
        return { session: sourceHeader, events: sourceEvents, inheritedEventCount: 0 };
      },
    },
    sessions: {
      get: (id) => (id === 'session-a' ? { id } : undefined),
      async flush(session) { flushed.push(session.id); },
    },
  });
  const doc = await readSessionDoc(ctx, 'session-a');
  assert.deepEqual(flushed, ['session-a']);
  assert.deepEqual(doc.header, sourceHeader);
  assert.deepEqual(doc.events, sourceEvents);
  assert.equal(doc.inheritedEventCount, 0);
  // Detached: mutating the result never reaches the query's cached values.
  doc.header.id = 'mutated';
  doc.events[0].seq = 99;
  assert.equal(sourceHeader.id, 'session-a');
  assert.equal(sourceEvents[0].seq, 0);
});

test('readSessionDoc reports unreadable and absent sessions with readable errors', async () => {
  await assert.rejects(readSessionDoc(fakeContext(), 'session-a'), /会话查询服务不可用/);
  await assert.rejects(readSessionDoc(fakeContext({ sessionQuery: { readSession: async () => ({}) } }), '  '), /缺少要读取的会话 id/);
  const throwing = fakeContext({ sessionQuery: { async readSession() { throw new Error('session not found'); } } });
  await assert.rejects(readSessionDoc(throwing, 'session-missing'), /读取会话 session-missing 失败：session not found/);
  await assert.rejects(
    readSessionDoc(fakeContext({ sessionQuery: { async readSession() { return { session: undefined, events: [] }; } } }), 'session-a'),
    /没有存储头信息/,
  );
  const flushFails = fakeContext({
    sessionQuery: { async readSession() { return { session: headerFixture(), events: [] }; } },
    sessions: { get: () => ({ id: 'session-a' }), async flush() { throw new Error('disk busy'); } },
  });
  await assert.rejects(readSessionDoc(flushFails, 'session-a'), /不是最新内容|最新内容尚未写入存储/);
});

test('listWorkspaceEntries maps the registry and degrades to an empty list', async () => {
  const ctx = fakeContext({
    workspaceRegistry: {
      async list() {
        return [
          { id: 'workspace-1', title: 'demo', path: '/work/demo', sessionIds: ['session-a', 'session-b'] },
          { id: 2, sessionIds: undefined },
          { title: 'no id' },
          null,
        ];
      },
    },
  });
  assert.deepEqual(await listWorkspaceEntries(ctx), [
    { workspaceId: 'workspace-1', title: 'demo', path: '/work/demo', sessionIds: ['session-a', 'session-b'] },
    { workspaceId: '2', sessionIds: [] },
  ]);
  assert.deepEqual(await listWorkspaceEntries(fakeContext()), []);
  const broken = fakeContext({ workspaceRegistry: { async list() { throw new Error('registry down'); } } });
  assert.deepEqual(await listWorkspaceEntries(broken), []);
});

test('listSessionEntries decorates cheap records without opening logs', async () => {
  const records = [
    { header: headerFixture({ id: 'session-a', cwd: '/work/demo' }) },
    { header: headerFixture({ id: 'session-b', cwd: undefined, createdAt: 5 }), eventCount: 12 },
    { header: headerFixture({ id: 'session-c' }) },
    { header: null },
    null,
  ];
  const titles = {
    'session-a': { title: ' 会话 A ', messageSeqs: [], source: { kind: 'fallback' }, eventSeq: 2, updatedAt: 999 },
    'session-b': '裸字符串标题',
    'session-c': undefined,
  };
  const ctx = fakeContext({
    sessionQuery: {
      async listSessions(signal) {
        assert.equal(signal, undefined);
        return records;
      },
      async readTitle(id) {
        if (id === 'session-c') throw new Error('title failed');
        return titles[id];
      },
    },
    agents: { get: (id) => (id === 'session-a' ? { status: 'running' } : undefined) },
    workspaceRegistry: {
      async list() {
        return [{ id: 'workspace-1', title: 'demo', path: '/work/demo', sessionIds: ['session-a', 'session-b'] }];
      },
    },
  });
  const entries = await listSessionEntries(ctx);
  assert.deepEqual(entries, [
    {
      id: 'session-a',
      title: '会话 A',
      cwd: '/work/demo',
      workspaceId: 'workspace-1',
      workspaceTitle: 'demo',
      createdAt: 1_700_000_000_000,
      updatedAt: 999,
      running: true,
      formatVersion: 4,
      eventCount: 0,
    },
    {
      id: 'session-b',
      title: '裸字符串标题',
      workspaceId: 'workspace-1',
      workspaceTitle: 'demo',
      createdAt: 5,
      updatedAt: 5,
      running: false,
      formatVersion: 4,
      eventCount: 12,
    },
    {
      id: 'session-c',
      cwd: '/work/demo',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      running: false,
      formatVersion: 4,
      eventCount: 0,
    },
  ]);
  // The listing honours cancellation by forwarding the signal.
  const signal = new AbortController().signal;
  let seen;
  const withSignal = fakeContext({
    sessionQuery: { async listSessions(forwarded) { seen = forwarded; return []; } },
  });
  assert.deepEqual(await listSessionEntries(withSignal, { signal }), []);
  assert.equal(seen, signal);
  await assert.rejects(listSessionEntries(fakeContext(), {}), /会话查询服务不可用/);
  const failing = fakeContext({ sessionQuery: { async listSessions() { throw new Error('list failed'); } } });
  await assert.rejects(listSessionEntries(failing), /读取会话列表失败：list failed/);
});

test('resolveTargetDirectory prefers requested, then source, then the deployment default', async (t) => {
  const requested = mkdtempSync(join(tmpdir(), 'dsk-requested-'));
  const source = mkdtempSync(join(tmpdir(), 'dsk-source-'));
  t.after(() => {
    rmSync(requested, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });
  const ctx = fakeContext({ workingDirectory: { defaultDirectory: source } });
  assert.equal(await resolveTargetDirectory(ctx, { requestedCwd: requested, sourceCwd: source }), requested);
  assert.equal(await resolveTargetDirectory(ctx, { requestedCwd: join(requested, 'missing'), sourceCwd: source }), source);
  assert.equal(await resolveTargetDirectory(ctx, { requestedCwd: 'relative/dir', sourceCwd: join(requested, 'missing') }), source);
  const noDefault = fakeContext();
  assert.equal(await resolveTargetDirectory(noDefault, { requestedCwd: join(requested, 'missing') }), process.cwd());
});

test('mintSessionId mints unused session ids and gives up after repeated collisions', async () => {
  const checked = [];
  const persistence = {
    async stat(id) {
      checked.push(id);
      return undefined;
    },
  };
  const id = await mintSessionId(persistence);
  assert.match(id, /^session-[0-9a-f-]{36}$/u);
  assert.deepEqual(checked, [id]);
  const alwaysTaken = { async stat() { return { header: {} }; } };
  await assert.rejects(mintSessionId(alwaysTaken), /无法生成唯一的会话 id/);
  const broken = { async stat() { throw new Error('store unreadable'); } };
  assert.match(await mintSessionId(broken), /^session-/u);
  assert.match(await mintSessionId(undefined), /^session-/u);
});

test('attachToWorkspace joins the requested workspace and never throws', async () => {
  const attached = [];
  const workspace = { id: 'workspace-1', async attachSession(sessionId) { attached.push(sessionId); } };
  const joined = await attachToWorkspace(fakeContext({
    workspaceRegistry: { get: (id) => (id === 'workspace-1' ? workspace : undefined), async resolveByPath() { return undefined; } },
  }), { sessionId: 'session-new', workspaceId: 'workspace-1', cwd: '/work/demo' });
  assert.deepEqual(joined, { workspaceId: 'workspace-1' });
  assert.deepEqual(attached, ['session-new']);

  const fellBack = await attachToWorkspace(fakeContext({
    workspaceRegistry: { get: () => undefined, async resolveByPath(path) { assert.equal(path, '/work/demo'); return workspace; } },
  }), { sessionId: 'session-new', workspaceId: 'workspace-gone', cwd: '/work/demo' });
  assert.equal(fellBack.workspaceId, 'workspace-1');
  assert.match(fellBack.warning, /找不到请求的工作区 workspace-gone/u);

  const missing = await attachToWorkspace(fakeContext({
    workspaceRegistry: { get: () => undefined, async resolveByPath() { return undefined; } },
  }), { sessionId: 'session-new', workspaceId: 'workspace-gone', cwd: '/work/demo' });
  assert.equal(missing.workspaceId, undefined);
  assert.match(missing.warning, /找不到工作区 workspace-gone/u);
  assert.deepEqual(
    await attachToWorkspace(fakeContext({ workspaceRegistry: { get: () => undefined } }), { sessionId: 'x', cwd: '/work/demo' }),
    {},
  );
  assert.deepEqual(await attachToWorkspace(fakeContext(), { sessionId: 'x' }), {});
  assert.deepEqual(await attachToWorkspace(fakeContext({ workspaceRegistry: { get: () => workspace } }), { sessionId: '' }), {});

  const attachFails = await attachToWorkspace(fakeContext({
    workspaceRegistry: { get: () => ({ id: 'workspace-broken', async attachSession() { throw new Error('attach denied'); } }) },
  }), { sessionId: 'session-new', workspaceId: 'workspace-broken' });
  assert.equal(attachFails.workspaceId, undefined);
  assert.match(attachFails.warning, /没能加入工作区 workspace-broken.*attach denied/u);

  const registryThrows = await attachToWorkspace(fakeContext({
    workspaceRegistry: { get() { throw new Error('registry exploded'); } },
  }), { sessionId: 'session-new', workspaceId: 'workspace-1' });
  assert.match(registryThrows.warning, /工作区归属未能确定：registry exploded/u);
});

test('foldTitle folds the latest non-empty log title', () => {
  assert.equal(foldTitle([
    { type: 'session/title', data: { title: '旧' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'session/title', data: { title: '  新标题  ' } },
  ]), '新标题');
  assert.equal(foldTitle([{ type: 'session/title', data: { title: '   ' } }]), undefined);
  assert.equal(foldTitle([{ type: 'session/title', data: { title: 42 } }]), undefined);
  assert.equal(foldTitle([{ type: 'session/title' }]), undefined);
  assert.equal(foldTitle([]), undefined);
  assert.equal(foldTitle(undefined), undefined);
});

test('sessionHeaderToSummary keeps lineage facts and detaches them', () => {
  const header = headerFixture({ parentSession: 'session-parent', origin: 'subagent', agentPreset: 'standard' });
  assert.deepEqual(sessionHeaderToSummary(header), {
    id: 'session-a',
    cwd: '/work/demo',
    createdAt: 1_700_000_000_000,
    isSeeded: false,
    parentSession: 'session-parent',
    origin: 'subagent',
    agentPreset: 'standard',
  });
  assert.deepEqual(sessionHeaderToSummary({ id: 'x' }), { id: 'x', createdAt: undefined, isSeeded: false });
  assert.deepEqual(sessionHeaderToSummary(undefined), { id: '', createdAt: undefined, isSeeded: false });
});

test('writeNewSession creates, appends one batch, flushes, and closes', async () => {
  const calls = [];
  const handle = {
    async append(events) { calls.push(['append', events]); },
    async flush() { calls.push(['flush']); },
    async close() { calls.push(['close']); },
  };
  const persistence = {
    async create(header, options) {
      calls.push(['create', header, options]);
      return handle;
    },
  };
  const header = headerFixture({ id: 'session-new', isSeeded: false });
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  assert.deepEqual(await writeNewSession(persistence, header, events), { id: 'session-new' });
  assert.deepEqual(calls.map((entry) => entry[0]), ['create', 'append', 'flush', 'close']);
  assert.equal(calls[0][2], undefined, 'unseeded create carries no inherited count');
  assert.deepEqual(calls[1][1], events, 'all events travel in one batch');

  const seededCalls = [];
  const seeded = {
    async create(nextHeader, options) { seededCalls.push([nextHeader, options]); return handle; },
  };
  await writeNewSession(seeded, headerFixture({ id: 'session-fork', isSeeded: true }), [], 2);
  assert.deepEqual(seededCalls[0][1], { inheritedEventCount: 2 });
  assert.deepEqual(seededCalls[0][0].id, 'session-fork');
});

test('writeNewSession reports failures without masking them', async () => {
  await assert.rejects(writeNewSession(undefined, headerFixture(), []), /会话存储服务不可用/);
  await assert.rejects(writeNewSession({ create: async () => ({}) }, {}, []), /写入会话需要带 id 的会话头/);
  await assert.rejects(writeNewSession({ create: async () => ({}) }, headerFixture(), undefined), /写入会话需要事件数组/);
  await assert.rejects(
    writeNewSession({ async create() { throw new Error('denied'); } }, headerFixture(), []),
    /创建会话失败：denied/,
  );

  const closed = [];
  const failingAppend = {
    async create() {
      return {
        async append() { throw new Error('disk full'); },
        async flush() {},
        async close() { closed.push('close'); },
      };
    },
  };
  await assert.rejects(writeNewSession(failingAppend, headerFixture(), [{ seq: 0 }]), /写入会话内容失败：disk full/);
  assert.deepEqual(closed, ['close'], 'a failed write still releases write ownership');

  const closeFails = {
    async create() {
      return {
        async append() {},
        async flush() {},
        async close() { throw new Error('close blew up'); },
      };
    },
  };
  await assert.rejects(writeNewSession(closeFails, headerFixture(), [{ seq: 0 }]), /关闭会话失败：close blew up/);

  const appendFailsAndCloseFails = {
    async create() {
      return {
        async append() { throw new Error('append first'); },
        async flush() {},
        async close() { throw new Error('close second'); },
      };
    },
  };
  await assert.rejects(
    writeNewSession(appendFailsAndCloseFails, headerFixture(), [{ seq: 0 }]),
    /写入会话内容失败：append first/,
    'the original write failure wins over a teardown failure',
  );
});
