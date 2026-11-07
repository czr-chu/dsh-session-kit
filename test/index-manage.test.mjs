/**
 * Unit tests for index.js session management (archive / unarchive / delete).
 *
 * The Host half is driven with a fake Cordis context and the documented
 * `config.modules` injection seam, so every route/tool branch (parsing, batch
 * cap, confirm requirement, per-id error results) is exercised without a real
 * `lib/manage.js`, filesystem trash, or DSH process.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, MAX_MANAGE_BATCH, name } from '../index.js';

/** Build a response object whose end() settles a promise. */
function makeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers ?? {});
    },
  };
  let resolveDone;
  res.done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  res.end = (body) => {
    res.body = body;
    resolveDone();
  };
  return res;
}

/**
 * Create one Host-half harness: fake ctx services + fake helper modules.
 * @param {object} [options] - module overrides and behavior switches.
 * @returns {object} harness with route/tool/call helpers.
 */
function createHarness(options = {}) {
  const state = {
    route: undefined,
    tool: undefined,
    rejection: undefined,
    listCalls: 0,
    archiveCalls: [],
    unarchiveCalls: [],
    deleteCalls: [],
  };
  const entries = options.entries ?? [];
  const registry = options.registry ?? { archivedSessionIds: [] };
  const sessions = options.sessions ?? {
    async detectFormatVersion() {
      return 4;
    },
    servicesOf() {
      return { workspaceRegistry: registry, attachments: undefined };
    },
    async listSessionEntries() {
      state.listCalls += 1;
      return entries;
    },
    async listWorkspaceEntries() {
      return [];
    },
  };
  const manage = options.manage ?? {
    async archiveSession(ctx, sessionId, opts) {
      state.archiveCalls.push([sessionId, opts]);
    },
    async unarchiveSession(ctx, sessionId) {
      state.unarchiveCalls.push(sessionId);
    },
    async deleteSession(ctx, sessionId, opts) {
      state.deleteCalls.push([sessionId, opts]);
      return { sessionIds: [sessionId], trashedPath: '/trash/2026-11-01T00:00:00.000Z' };
    },
  };
  const tools = {
    register(definition) {
      state.tool = definition;
      return () => {};
    },
  };
  const webServer = {
    register(route) {
      state.route = route;
      return () => {};
    },
  };
  const connection = {
    requestRejection() {
      return state.rejection;
    },
  };
  const services = new Map([
    ['tools', tools],
    ['webServer', webServer],
    ['connection', connection],
  ]);
  const ctx = {
    get(service) {
      return services.get(service);
    },
    inject(deps, callback) {
      if (deps.every((dep) => services.has(dep))) {
        callback({ get: (service) => services.get(service), effect: (fn) => fn() });
      }
      return () => {};
    },
    effect(fn) {
      return fn();
    },
  };
  const modules = options.modules ?? { sessions, manage };
  apply(ctx, { ...(options.config ?? {}), modules });
  return {
    state,
    ctx,
    sessions,
    manage,
    async call(req) {
      const res = makeResponse();
      state.route.handler(req, res);
      await res.done;
      return res;
    },
  };
}

/** A POST request carrying a JSON body. */
function jsonRequest(url, payload) {
  const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    method: 'POST',
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

/** A raw request body. */
function rawRequest(url, text) {
  const buffer = Buffer.from(text, 'utf8');
  return {
    method: 'POST',
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

/** Guard a JSON response body. */
function jsonBody(res) {
  assert.equal(typeof res.body !== 'undefined', true, 'response must have a body');
  return JSON.parse(Buffer.from(res.body).toString('utf8'));
}

test('/info advertises management capabilities and the trash directory', async () => {
  const harness = createHarness({ config: { trashDir: '/tmp/custom-trash' } });
  const res = await harness.call({ method: 'GET', url: '/session-kit/info', headers: {} });
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.plugin, name);
  for (const capability of ['manage', 'archive', 'unarchive', 'delete']) {
    assert.equal(body.capabilities[capability], true, `capability ${capability}`);
  }
  assert.equal(body.trash.directory, '/tmp/custom-trash');
  assert.equal(body.trash.mode, 'move');
  assert.equal(body.trash.batchLimit, MAX_MANAGE_BATCH);
});

test('/list passes archived and pinned state through to the client', async () => {
  const entries = [
    { id: 'a', title: 'Alpha', cwd: '/w', archived: false, pinned: true },
    { id: 'b', title: 'Beta', cwd: '/w', archived: true, pinned: false },
  ];
  const harness = createHarness({ entries });
  const res = await harness.call({ method: 'GET', url: '/session-kit/list', headers: {} });
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.deepEqual(body.sessions, entries);
});

test('/archive runs one result per id, passes stopActivity, and reports archived ids', async () => {
  const harness = createHarness({ registry: { archivedSessionIds: ['a'] } });
  const res = await harness.call(jsonRequest('/session-kit/archive', { sessionIds: ['a', 'b'], stopActivity: true }));
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.deepEqual(body.results, [
    { sessionId: 'a', ok: true },
    { sessionId: 'b', ok: true },
  ]);
  assert.deepEqual(body.archivedSessionIds, ['a']);
  assert.deepEqual(harness.state.archiveCalls, [
    ['a', { stopActivity: true }],
    ['b', { stopActivity: true }],
  ]);
});

test('/archive de-duplicates ids and defaults stopActivity to false', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/archive', { sessionIds: ['a', 'a', ' b '] }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.state.archiveCalls, [
    ['a', { stopActivity: false }],
    ['b', { stopActivity: false }],
  ]);
});

test('management batch cap is enforced before any module call', async () => {
  const harness = createHarness();
  const ids = Array.from({ length: MAX_MANAGE_BATCH + 1 }, (_, index) => `session-${index}`);
  const res = await harness.call(jsonRequest('/session-kit/archive', { sessionIds: ids }));
  assert.equal(res.statusCode, 400);
  assert.equal(jsonBody(res).code, 'too-many-sessions');
  assert.deepEqual(harness.state.archiveCalls, []);
});

test('invalid management bodies are rejected with 400', async () => {
  const harness = createHarness();
  for (const payload of [
    {},
    { sessionIds: [] },
    { sessionIds: 'all' },
    { sessionIds: ['a', ''] },
    { sessionIds: ['a', 7] },
  ]) {
    const res = await harness.call(jsonRequest('/session-kit/archive', payload));
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)}`);
    assert.equal(jsonBody(res).code, 'invalid-sessionIds');
  }
  assert.deepEqual(harness.state.archiveCalls, []);
});

test('invalid JSON bodies are rejected with 400 invalid-json', async () => {
  const harness = createHarness();
  const res = await harness.call(rawRequest('/session-kit/archive', '{not json'));
  assert.equal(res.statusCode, 400);
  assert.equal(jsonBody(res).code, 'invalid-json');
});

test('unarchive and delete refuse the "all" shorthand explicitly', async () => {
  const harness = createHarness();
  for (const action of ['unarchive', 'delete']) {
    const res = await harness.call(jsonRequest(`/session-kit/${action}`, { sessionIds: 'all' }));
    assert.equal(res.statusCode, 400, action);
    assert.equal(jsonBody(res).code, 'invalid-sessionIds');
    const resArray = await harness.call(jsonRequest(`/session-kit/${action}`, { sessionIds: ['all'] }));
    assert.equal(resArray.statusCode, 400, `array form ${action}`);
  }
  assert.deepEqual(harness.state.unarchiveCalls, []);
  assert.deepEqual(harness.state.deleteCalls, []);
});

test('a partial failure answers 200 with per-id errors while a fully failed batch maps its code', async () => {
  const manage = {
    async archiveSession(ctx, sessionId) {
      if (sessionId === 'b') {
        const error = new Error('会话正在运行，无法归档');
        error.code = 'active';
        throw error;
      }
    },
    async unarchiveSession() {},
    async deleteSession() {
      return { sessionIds: [], trashedPath: '/trash/x' };
    },
  };
  const partial = createHarness({ manage });
  const res = await partial.call(jsonRequest('/session-kit/archive', { sessionIds: ['a', 'b'] }));
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.ok, false);
  assert.deepEqual(body.results[0], { sessionId: 'a', ok: true });
  assert.equal(body.results[1].ok, false);
  assert.equal(body.results[1].code, 'active');
  assert.match(body.results[1].error, /正在运行/u);

  const failing = createHarness({
    manage: {
      async archiveSession() {
        const error = new Error('会话正在运行');
        error.code = 'active';
        throw error;
      },
      async unarchiveSession() {},
      async deleteSession() {
        return { sessionIds: [], trashedPath: '/trash/x' };
      },
    },
  });
  const activeRes = await failing.call(jsonRequest('/session-kit/archive', { sessionIds: ['a'] }));
  assert.equal(activeRes.statusCode, 409);
  assert.equal(jsonBody(activeRes).results[0].code, 'active');

  const missing = createHarness({
    manage: {
      async archiveSession() {
        const error = new Error('会话不存在');
        error.code = 'not-found';
        throw error;
      },
      async unarchiveSession() {},
      async deleteSession() {
        return { sessionIds: [], trashedPath: '/trash/x' };
      },
    },
  });
  const missingRes = await missing.call(jsonRequest('/session-kit/archive', { sessionIds: ['nope'] }));
  assert.equal(missingRes.statusCode, 404);
});

test('/delete moves sessions with the configured trash directory and returns trashedPath', async () => {
  const harness = createHarness({ config: { trashDir: '/tmp/custom-trash' } });
  const res = await harness.call(jsonRequest('/session-kit/delete', { sessionIds: ['a'] }));
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.equal(body.trashedPath, '/trash/2026-11-01T00:00:00.000Z');
  assert.deepEqual(harness.state.deleteCalls, [['a', { trashDir: '/tmp/custom-trash' }]]);
});

test('/delete permanent:true requires confirm and never calls the management module unconfirmed', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/delete', { sessionIds: ['a'], permanent: true }));
  assert.equal(res.statusCode, 400);
  assert.equal(jsonBody(res).code, 'confirm-required');
  assert.deepEqual(harness.state.deleteCalls, []);
});

test('management routes answer 503 when the management module is unavailable', async () => {
  const harness = createHarness({ modules: { sessions: undefined } });
  // Replace the injected sessions module with a working one but no manage.
  const sessions = {
    async detectFormatVersion() {
      return 4;
    },
    servicesOf() {
      return {};
    },
    async listSessionEntries() {
      return [];
    },
    async listWorkspaceEntries() {
      return [];
    },
  };
  apply(harness.ctx, { modules: { sessions } });
  const res = await harness.call(jsonRequest('/session-kit/archive', { sessionIds: ['a'] }));
  assert.equal(res.statusCode, 503);
  assert.equal(jsonBody(res).code, 'unavailable');
});

test('the trust fence rejects management requests before parsing the body', async () => {
  const harness = createHarness();
  harness.state.rejection = 403;
  const res = await harness.call(jsonRequest('/session-kit/archive', { sessionIds: ['a'] }));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, undefined);
  assert.deepEqual(harness.state.archiveCalls, []);
});

test('unknown routes stay 404 and existing export parsing still works', async () => {
  const harness = createHarness();
  const notFound = await harness.call(jsonRequest('/session-kit/nope', {}));
  assert.equal(notFound.statusCode, 404);

  const missing = await harness.call(jsonRequest('/session-kit/export', {}));
  assert.equal(missing.statusCode, 400);
  assert.equal(jsonBody(missing).code, 'missing-sessions');
});

test('the session_kit tool requires confirm:true for delete and then moves to trash', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'delete', sessionIds: ['a'] }, {}),
    /confirm/u,
  );
  assert.deepEqual(harness.state.deleteCalls, []);
  const text = await harness.state.tool.execute({ action: 'delete', sessionIds: ['a'], confirm: true }, {});
  assert.match(text, /回收站/u);
  assert.deepEqual(harness.state.deleteCalls, [['a', {}]]);
});

test('the session_kit tool archives "all" and refuses "all" for unarchive/delete', async () => {
  const entries = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }];
  const harness = createHarness({ entries });
  const text = await harness.state.tool.execute({ action: 'archive', sessionIds: 'all', stopActivity: true }, {});
  assert.match(text, /成功 2 个/u);
  assert.deepEqual(harness.state.archiveCalls, [
    ['a', { stopActivity: true }],
    ['b', { stopActivity: true }],
  ]);
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'unarchive', sessionIds: 'all' }, {}),
  );
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'delete', sessionIds: 'all', confirm: true }, {}),
  );
});

test('the session_kit tool requires sessionIds and rejects unknown actions', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'archive' }, {}),
    /需要 sessionIds/u,
  );
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'trash' }, {}),
    /action 必须是/u,
  );
});

test('the list tool marks archived sessions', async () => {
  const entries = [{ id: 'a', title: 'Alpha', archived: true }];
  const harness = createHarness({ entries });
  const text = await harness.state.tool.execute({ action: 'list' }, {});
  assert.match(text, /已归档/u);
  assert.match(text, /会话 1 个/u);
});

test('management tool batches report per-id failures instead of throwing', async () => {
  const harness = createHarness({
    manage: {
      async archiveSession(ctx, sessionId) {
        if (sessionId === 'b') throw new Error('磁盘繁忙');
      },
      async unarchiveSession() {},
      async deleteSession() {
        return { sessionIds: [], trashedPath: '/trash/x' };
      },
    },
  });
  const text = await harness.state.tool.execute({ action: 'archive', sessionIds: ['a', 'b'] }, {});
  assert.match(text, /成功 1 个，失败 1 个/u);
  assert.match(text, /b：磁盘繁忙/u);
});
