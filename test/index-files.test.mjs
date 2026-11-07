/**
 * Unit tests for index.js related-files preview and delete-with-files.
 *
 * Route/tool branches are driven through the documented `config.modules`
 * injection seam, so no real session log or workspace file is read or moved:
 * the module mocks record what the Host passes to `deriveSessionFilePlan` and
 * `deleteSession`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, MAX_FILE_BATCH, name } from '../index.js';

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

/** Default derived plan returned by the mocked session-files module. */
const DEFAULT_PLAN = Object.freeze({
  files: [
    { path: '/ws/a.txt', relative: 'a.txt', root: '/ws', bytes: 10, evidence: ['tool/result'], weak: false, sessionIds: ['s1'] },
    { path: '/ws/sub/b.txt', relative: 'sub/b.txt', root: '/ws', bytes: 20, evidence: ['arguments'], weak: true, sessionIds: ['s1'] },
  ],
  skipped: [{ path: '/ws/node_modules/x.js', reason: 'excluded-dir' }],
  warnings: ['会话 s1 的子代理日志不可读'],
  totalBytes: 30,
});

/**
 * Create one Host-half harness with fake helper modules.
 * @param {object} [options] - behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = {
    route: undefined,
    tool: undefined,
    rejection: undefined,
    deriveCalls: [],
    deleteCalls: [],
    deleteOutcome: options.deleteOutcome ?? {
      sessionIds: ['s1'],
      trashedPath: '/trash/2026-11-05T00:00:00.000Z',
      filesMoved: 2,
      filesSkipped: 1,
      filesBytes: 30,
      filesTrashPath: '/trash/2026-11-05T00:00:00.000Z/files',
      fileWarnings: ['共享文件 a.txt 可能被其他会话使用'],
    },
  };
  const sessions = {
    async detectFormatVersion() {
      return 4;
    },
    servicesOf() {
      return {};
    },
    async listSessionEntries() {
      return options.entries ?? [];
    },
    async listWorkspaceEntries() {
      return [];
    },
  };
  const manage = {
    async archiveSession() {},
    async unarchiveSession() {},
    async deleteSession(ctx, sessionId, opts) {
      state.deleteCalls.push([sessionId, opts]);
      if (typeof options.deleteError === 'function') {
        const error = options.deleteError(sessionId);
        if (error !== undefined) throw error;
      }
      return state.deleteOutcome;
    },
  };
  const files = {
    async deriveSessionFilePlan(ctx, sessionIds) {
      state.deriveCalls.push([...sessionIds]);
      if (options.filesError !== undefined) throw options.filesError;
      return options.plan ?? DEFAULT_PLAN;
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
  const modules = { sessions, manage };
  if (options.omitFiles !== true) modules.files = files;
  apply(ctx, { ...(options.config ?? {}), modules });
  return {
    state,
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

/** Parse a JSON response body. */
function jsonBody(res) {
  return JSON.parse(Buffer.from(res.body).toString('utf8'));
}

test('/info advertises file preview and delete-with-files semantics', async () => {
  const harness = createHarness();
  const res = await harness.call({ method: 'GET', url: '/session-kit/info', headers: {} });
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.plugin, name);
  assert.equal(body.capabilities.filePreview, true);
  assert.equal(body.capabilities.deleteFiles, true);
  assert.equal(body.files.previewBatchLimit, MAX_FILE_BATCH);
  assert.equal(body.files.mode, 'move');
  assert.match(body.files.note, /尽力推导/u);
  assert.match(body.files.note, /二次确认/u);
});

test('/session-files previews the derived plan with trimmed, de-duplicated ids', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/session-files', { sessionIds: [' s1 ', 's1', 's2'] }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.state.deriveCalls, [['s1', 's2']]);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.deepEqual(body.files, DEFAULT_PLAN.files);
  assert.deepEqual(body.skipped, DEFAULT_PLAN.skipped);
  assert.deepEqual(body.warnings, DEFAULT_PLAN.warnings);
  assert.equal(body.totalBytes, 30);
  assert.deepEqual(harness.state.deleteCalls, [], 'preview never moves anything');
});

test('/session-files falls back to summing file bytes when the plan omits totalBytes', async () => {
  const plan = { files: [{ path: '/ws/a', relative: 'a', bytes: 4 }, { path: '/ws/b', relative: 'b' }], skipped: [], warnings: [] };
  const harness = createHarness({ plan });
  const body = jsonBody(await harness.call(jsonRequest('/session-kit/session-files', { sessionIds: ['s1'] })));
  assert.equal(body.totalBytes, 4);
});

test('/session-files enforces the 100-session preview cap before deriving', async () => {
  const harness = createHarness();
  const ids = Array.from({ length: MAX_FILE_BATCH + 1 }, (_, index) => `session-${index}`);
  const res = await harness.call(jsonRequest('/session-kit/session-files', { sessionIds: ids }));
  assert.equal(res.statusCode, 400);
  assert.equal(jsonBody(res).code, 'too-many-sessions');
  assert.deepEqual(harness.state.deriveCalls, []);
});

test('/session-files rejects malformed bodies and "all"', async () => {
  const harness = createHarness();
  for (const payload of [{}, { sessionIds: [] }, { sessionIds: 'all' }, { sessionIds: ['a', ''] }, { sessionIds: ['a', 7] }]) {
    const res = await harness.call(jsonRequest('/session-kit/session-files', payload));
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)}`);
    assert.equal(jsonBody(res).code, 'invalid-sessionIds');
  }
  const invalidJson = await harness.call(rawRequest('/session-kit/session-files', '{bad'));
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(jsonBody(invalidJson).code, 'invalid-json');
  assert.deepEqual(harness.state.deriveCalls, []);
});

test('/session-files answers 503 without the derivation module', async () => {
  const harness = createHarness({ omitFiles: true });
  const res = await harness.call(jsonRequest('/session-kit/session-files', { sessionIds: ['s1'] }));
  assert.equal(res.statusCode, 503);
  assert.equal(jsonBody(res).code, 'unavailable');
});

test('/session-files maps derivation failures to 404/500 and the fence stays first', async () => {
  const formatError = new Error('会话不存在');
  formatError.code = 'not-found';
  formatError.name = 'SessionPortFormatError';
  // SessionPortFormatError identity cannot be faked, so use a module that throws inside derive
  // and verify the generic 500 mapping; the not-found path is covered by manage routes.
  const failure = createHarness({ filesError: new Error('corpus offline') });
  const failureRes = await failure.call(jsonRequest('/session-kit/session-files', { sessionIds: ['s1'] }));
  assert.equal(failureRes.statusCode, 500);
  assert.equal(jsonBody(failureRes).code, 'files-failed');

  const fenced = createHarness();
  fenced.state.rejection = 403;
  const fencedRes = await fenced.call(jsonRequest('/session-kit/session-files', { sessionIds: ['s1'] }));
  assert.equal(fencedRes.statusCode, 403);
  assert.equal(fencedRes.body, undefined);
  assert.deepEqual(fenced.state.deriveCalls, []);
  void formatError;
});

test('/delete removeFiles:true passes the flag, needs confirm, and returns file stats', async () => {
  const harness = createHarness({ config: { trashDir: '/tmp/custom-trash' } });
  const unconfirmed = await harness.call(jsonRequest('/session-kit/delete', { sessionIds: ['s1'], removeFiles: true }));
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal(jsonBody(unconfirmed).code, 'confirm-required');
  assert.deepEqual(harness.state.deleteCalls, []);

  const res = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'],
    removeFiles: true,
    selectedFiles: ['/ws/a.txt', '/ws/sub/b.txt'],
    confirm: true,
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.state.deleteCalls, [
    ['s1', {
      trashDir: '/tmp/custom-trash',
      removeFiles: true,
      selectedFiles: ['/ws/a.txt', '/ws/sub/b.txt'],
    }],
  ]);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.equal(body.filesMoved, 2);
  assert.equal(body.filesSkipped, 1);
  assert.equal(body.filesBytes, 30);
  assert.equal(body.filesTrashPath, '/trash/2026-11-05T00:00:00.000Z/files');
  assert.deepEqual(body.fileWarnings, ['共享文件 a.txt 可能被其他会话使用']);
  assert.deepEqual(body.results[0].files, {
    moved: 2,
    skipped: 1,
    bytes: 30,
    trashPath: '/trash/2026-11-05T00:00:00.000Z/files',
    warnings: ['共享文件 a.txt 可能被其他会话使用'],
  });
});

test('/delete without removeFiles keeps the old behavior and reports no file stats', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/delete', { sessionIds: ['s1'] }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.state.deleteCalls, [['s1', {}]]);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.equal(body.filesMoved, undefined);
  assert.equal(body.results[0].files, undefined);
});

test('/delete removeFiles keeps per-id failures and does not invent file stats', async () => {
  const active = new Error('会话正在运行');
  active.code = 'active';
  const harness = createHarness({
    deleteError: (sessionId) => (sessionId === 'b' ? active : undefined),
  });
  const res = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['a', 'b'],
    removeFiles: true,
    selectedFiles: ['/ws/a.txt'],
    confirm: true,
  }));
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.ok, false);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, false);
  assert.equal(body.results[1].code, 'active');
  assert.equal(body.results[1].files, undefined);
});

test('the files tool previews count, size, paths and the best-effort risk notice', async () => {
  const harness = createHarness();
  const text = await harness.state.tool.execute({ action: 'files', sessionIds: ['s1'] }, {});
  assert.match(text, /会话相关文件：2 个（30 字节），跳过 1 个/u);
  assert.match(text, /风险提示/u);
  assert.match(text, /shell 重定向/u);
  assert.match(text, /二次确认/u);
  assert.match(text, /- a\.txt（10 字节）/u);
  assert.match(text, /- sub\/b\.txt（20 字节，弱证据）/u);
  assert.deepEqual(harness.state.deriveCalls, [['s1']]);
});

test('the files tool requires explicit ids and refuses "all" and oversized batches', async () => {
  const harness = createHarness();
  await assert.rejects(() => harness.state.tool.execute({ action: 'files' }, {}), /需要 sessionIds/u);
  await assert.rejects(() => harness.state.tool.execute({ action: 'files', sessionIds: 'all' }, {}));
  const ids = Array.from({ length: MAX_FILE_BATCH + 1 }, (_, index) => `session-${index}`);
  await assert.rejects(() => harness.state.tool.execute({ action: 'files', sessionIds: ids }, {}), /最多处理/u);
  assert.deepEqual(harness.state.deriveCalls, []);
});

test('the files tool reports derivation failures and a missing module', async () => {
  const failing = createHarness({ filesError: new Error('corpus offline') });
  await assert.rejects(
    () => failing.state.tool.execute({ action: 'files', sessionIds: ['s1'] }, {}),
    /推导会话相关文件失败/u,
  );
  const missing = createHarness({ omitFiles: true });
  await assert.rejects(
    () => missing.state.tool.execute({ action: 'files', sessionIds: ['s1'] }, {}),
    /模块不可用/u,
  );
});

test('the delete tool accepts removeFiles and still requires confirm:true', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'delete', sessionIds: ['s1'], removeFiles: true }, {}),
    /confirm/u,
  );
  assert.deepEqual(harness.state.deleteCalls, []);
  const text = await harness.state.tool.execute({
    action: 'delete',
    sessionIds: ['s1'],
    removeFiles: true,
    selectedFiles: ['/ws/a.txt'],
    confirm: true,
  }, {});
  assert.deepEqual(harness.state.deleteCalls, [['s1', { removeFiles: true, selectedFiles: ['/ws/a.txt'] }]]);
  assert.match(text, /同时移走文件 2 个（30 字节），跳过 1 个/u);
  assert.match(text, /文件回收站/u);
  assert.match(text, /共享文件 a\.txt/u);
});

test('the tool schema exposes the files action and removeFiles parameter', async () => {
  const harness = createHarness();
  const schema = harness.state.tool.parameters;
  assert.ok(schema.properties.action.enum.includes('files'));
  assert.equal(schema.properties.removeFiles.type, 'boolean');
  assert.match(harness.state.tool.description, /action=files/u);
  assert.match(harness.state.tool.description, /removeFiles:true/u);
});
