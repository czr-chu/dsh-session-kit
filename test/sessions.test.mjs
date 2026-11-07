/**
 * Behavior tests for the host session helpers. Every test drives the functions
 * through a fake composed context, so no Harness process is started and no
 * real DSH home is touched.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  sessionDetail,
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
      archived: false,
      pinned: false,
      legacy: false,
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
      archived: false,
      pinned: false,
      legacy: false,
      formatVersion: 4,
      eventCount: 12,
    },
    {
      id: 'session-c',
      cwd: '/work/demo',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      running: false,
      archived: false,
      pinned: false,
      legacy: false,
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

test('listSessionEntries marks archived and pinned sessions without hiding them', async () => {
  const records = [
    { header: headerFixture({ id: 'session-a' }) },
    { header: headerFixture({ id: 'session-b' }) },
    { header: headerFixture({ id: 'session-c' }) },
    { header: headerFixture({ id: 'session-sub', origin: 'subagent', parentSession: 'session-a' }) },
  ];
  const ctx = fakeContext({
    sessionQuery: {
      async listSessions() { return records; },
      async readTitle() { return undefined; },
    },
    workspaceRegistry: {
      async list() { return []; },
      archivedSessionIds: ['session-a'],
      pinnedSessionIds: ['session-b', 'session-c'],
    },
  });
  const entries = await listSessionEntries(ctx);
  // Subagent transcripts stay out of the default human listing.
  assert.deepEqual(entries.map((entry) => entry.id), ['session-a', 'session-b', 'session-c']);
  assert.deepEqual(entries.map((entry) => [entry.id, entry.archived, entry.pinned]), [
    ['session-a', true, false],
    ['session-b', false, true],
    ['session-c', false, true],
  ]);
  const withSubagents = await listSessionEntries(ctx, { includeSubagents: true });
  assert.deepEqual(withSubagents.map((entry) => entry.id), ['session-a', 'session-b', 'session-c', 'session-sub']);
  assert.deepEqual(withSubagents.find((entry) => entry.id === 'session-sub').origin, 'subagent');
  // A registry whose archive/pin getters fail degrades to unmarked rows.
  const throwing = fakeContext({
    sessionQuery: {
      async listSessions() { return records; },
      async readTitle() { return undefined; },
    },
    workspaceRegistry: {
      async list() { return []; },
      get archivedSessionIds() { throw new Error('registry state unavailable'); },
      get pinnedSessionIds() { throw new Error('registry state unavailable'); },
    },
  });
  assert.deepEqual(
    (await listSessionEntries(throwing)).map((entry) => [entry.archived, entry.pinned]),
    [[false, false], [false, false], [false, false]],
  );
});

test('listSessionEntries marks legacy formats and merges archived stat snapshots', async () => {
  const records = [
    { header: headerFixture({ id: 'session-legacy' }), formatStatus: 'migration-required' },
    { header: headerFixture({ id: 'session-current' }), formatStatus: 'current' },
    { header: headerFixture({ id: 'session-plain' }) },
  ];
  const snapshots = new Map([
    ['session-legacy', {
      header: headerFixture({ id: 'session-legacy' }),
      formatStatus: 'migration-required',
      location: { kind: 'jsonl', path: '/sessions/--p--/session-legacy/session.v3.jsonl' },
    }],
    ['session-archived', {
      header: headerFixture({ id: 'session-archived' }),
      formatStatus: 'migration-required',
      location: { kind: 'jsonl', path: '/sessions/--p--/session-archived/session.v2.jsonl' },
    }],
  ]);
  const statCalls = [];
  const ctx = fakeContext({
    sessionQuery: {
      async listSessions() { return records; },
      async readTitle() { return undefined; },
    },
    sessionPersistence: {
      async stat(id) { statCalls.push(id); return snapshots.get(id); },
    },
    workspaceRegistry: {
      async list() { return []; },
      archivedSessionIds: ['session-archived'],
    },
  });
  const entries = await listSessionEntries(ctx);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  // A normal query record carries no backend location, so the fast listing does
  // not stat it: the legacy flag is set and the version badge stays version-less.
  assert.deepEqual(
    [byId.get('session-legacy').formatStatus, byId.get('session-legacy').legacy, byId.get('session-legacy').storedVersion],
    ['migration-required', true, undefined],
  );
  // Only the archived id missing from the query corpus is stat'ed.
  assert.deepEqual(statCalls, ['session-archived']);
  assert.equal(byId.get('session-current').formatStatus, 'current');
  assert.equal(byId.get('session-current').legacy, false);
  assert.equal(byId.get('session-current').storedVersion, undefined);
  assert.equal('formatStatus' in byId.get('session-plain'), false);
  assert.equal(byId.get('session-plain').legacy, false);
  // An archived session absent from the query corpus is merged from stat and
  // keeps its own format status plus stored generation.
  assert.equal(byId.get('session-archived').archived, true);
  assert.equal(byId.get('session-archived').formatStatus, 'migration-required');
  assert.equal(byId.get('session-archived').legacy, true);
  assert.equal(byId.get('session-archived').storedVersion, 2);
  // Without a persistence service the legacy row is still marked; only the
  // stored generation is unavailable.
  const withoutStat = fakeContext({
    sessionQuery: {
      async listSessions() { return [{ header: headerFixture({ id: 'session-legacy' }), formatStatus: 'migration-required' }]; },
      async readTitle() { return undefined; },
    },
    workspaceRegistry: { async list() { return []; } },
  });
  const legacyOnly = await listSessionEntries(withoutStat);
  assert.equal(legacyOnly[0].legacy, true);
  assert.equal(legacyOnly[0].storedVersion, undefined);
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
test('listSessionEntries reads cached titles and fills only missing titles from the log', async () => {
  const titleReads = [];
  const ctx = fakeContext({
    sessionQuery: {
      async listSessions() {
        return [
          { header: headerFixture({ id: 'session-a' }) },
          { header: headerFixture({ id: 'session-b', createdAt: 5 }) },
        ];
      },
      async readTitle(id) {
        titleReads.push(id);
        return id === 'session-b' ? { title: '补读标题' } : undefined;
      },
    },
    sessionProjectionCache: {
      cachedSnapshot(header) {
        return header.id === 'session-a' ? { values: { title: '缓存标题' } } : { values: { title: null } };
      },
    },
  });
  const entries = await listSessionEntries(ctx);
  assert.equal(entries[0].title, '缓存标题');
  assert.equal(entries[1].title, '补读标题');
  assert.deepEqual(titleReads, ['session-b'], 'only the cache miss is read');
});

test('listSessionEntries includes an archived session missing from the query corpus', async () => {
  const archivedHeader = headerFixture({ id: 'session-archived', createdAt: 5 });
  const ctx = fakeContext({
    sessionQuery: {
      async listSessions() { return [{ header: headerFixture({ id: 'session-live' }) }]; },
    },
    sessionPersistence: {
      async stat(id) {
        assert.equal(id, 'session-archived');
        return { header: archivedHeader, revision: 'r1' };
      },
    },
    workspaceRegistry: {
      async list() { return []; },
      get archivedSessionIds() { return ['session-archived']; },
      get pinnedSessionIds() { return []; },
    },
    sessionProjectionCache: {
      cachedSnapshot() { return { values: { title: '归档会话标题' } }; },
    },
  });
  const entries = await listSessionEntries(ctx);
  const archived = entries.find((entry) => entry.id === 'session-archived');
  assert.ok(archived, 'the archived session is listed');
  assert.equal(archived.archived, true);
  assert.equal(archived.title, '归档会话标题');
  assert.equal(entries.filter((entry) => entry.id === 'session-live').length, 1);
});

/** Write one file with exact byte length under a directory. */
function writeSizedFile(directory, name, bytes) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, 'x'.repeat(bytes));
  return path;
}

test('sessionDetail sums every retained generation and excludes locks', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsk-detail-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessionDir = join(home, '--work-demo--', 'session-a');
  writeSizedFile(sessionDir, 'session.v3.jsonl', 10);
  const currentLog = writeSizedFile(sessionDir, 'session.v4.jsonl', 20);
  writeSizedFile(sessionDir, 'session.lock', 100);
  writeSizedFile(join(sessionDir, 'artifacts'), 'nested.bin', 5);
  const outside = writeSizedFile(join(home, 'outside'), 'large.bin', 500);
  symlinkSync(outside, join(sessionDir, 'link.bin'));
  const ctx = fakeContext({
    sessionPersistence: {
      async stat(id) {
        assert.equal(id, 'session-a');
        return {
          header: { version: 4, id: 'session-a', createdAt: 1_700_000_000_000, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 },
          formatStatus: 'migration-required',
          revision: 'r1',
          sizeBytes: 999,
          location: { kind: 'jsonl', path: currentLog },
        };
      },
    },
    workspaceRegistry: { get archivedSessionIds() { return ['session-a']; } },
  });
  const detail = await sessionDetail(ctx, 'session-a');
  assert.deepEqual(detail, {
    sessionId: 'session-a',
    sizeBytes: 35,
    formatStatus: 'migration-required',
    legacy: true,
    archived: true,
  });
});

test('sessionDetail falls back to the recorded artifact size and reports states', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsk-detail-fallback-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const missingLog = join(home, 'gone', 'session.v4.jsonl');
  const ctx = fakeContext({
    sessionPersistence: {
      async stat() {
        return {
          header: { version: 4, id: 'session-a', createdAt: 1, isSeeded: false, delegationDepth: 0 },
          formatStatus: 'current',
          revision: 'r1',
          sizeBytes: 1234,
          location: { kind: 'jsonl', path: missingLog },
        };
      },
    },
    workspaceRegistry: { get archivedSessionIds() { throw new Error('registry unavailable'); } },
  });
  assert.deepEqual(await sessionDetail(ctx, 'session-a'), {
    sessionId: 'session-a',
    sizeBytes: 1234,
    formatStatus: 'current',
    legacy: false,
    archived: false,
  });
  // Neither the directory nor a recorded size resolves: the detail reports zero.
  const zeroCtx = fakeContext({
    sessionPersistence: {
      async stat() {
        return {
          header: { version: 4, id: 'session-b', createdAt: 1, isSeeded: false, delegationDepth: 0 },
          revision: 'r1',
          location: { kind: 'jsonl', path: join(home, 'gone-b', 'session.v4.jsonl') },
        };
      },
    },
  });
  assert.deepEqual(await sessionDetail(zeroCtx, 'session-b'), {
    sessionId: 'session-b',
    sizeBytes: 0,
    legacy: false,
    archived: false,
  });
});

test('sessionDetail reports missing sessions and service failures', async () => {
  await assert.rejects(sessionDetail(fakeContext(), 'session-a'), (error) => error.code === 'unavailable');
  await assert.rejects(
    sessionDetail(fakeContext({ sessionPersistence: { async stat() { return undefined; } } }), 'session-a'),
    (error) => error.code === 'not-found',
  );
  await assert.rejects(
    sessionDetail(fakeContext({ sessionPersistence: { async stat() { return { rev: 'r1' }; } } }), 'session-a'),
    (error) => error.code === 'not-found',
  );
  await assert.rejects(
    sessionDetail(fakeContext({ sessionPersistence: { async stat() { throw new Error('storage offline'); } } }), 'session-a'),
    (error) => error.code === 'detail-failed' && /storage offline/u.test(error.message),
  );
  await assert.rejects(
    sessionDetail(fakeContext({ sessionPersistence: { async stat() { return undefined; } } }), '  '),
    (error) => error.code === 'invalid-argument',
  );
});