/**
 * Unit tests for index.js session detail, selectable related files, and
 * permanent delete.
 *
 * The Host half runs with the test-only third `apply` argument, so detail
 * lookups and delete options are recorded without touching a real session log or
 * workspace file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, MAX_DETAIL_BATCH, MAX_SELECTED_FILES, name } from '../index.js';

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

const TRASH_OUTCOME = Object.freeze({
  sessionIds: ['s1'],
  trashedPath: '/trash/2026-11-07T00:00:00.000Z',
  filesMoved: 2,
  filesSkipped: 1,
  filesBytes: 30,
  filesTrashPath: '/trash/2026-11-07T00:00:00.000Z/files',
  fileWarnings: ['共享文件 a.txt 可能被其他会话使用'],
});

const PERMANENT_OUTCOME = Object.freeze({
  sessionIds: ['s1'],
  filesRemoved: 2,
  filesSkipped: 1,
  filesBytes: 30,
  fileWarnings: ['永久删除后无法恢复'],
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
    detailCalls: [],
    deleteCalls: [],
    deriveCalls: [],
  };
  const details = options.details ?? {};
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
    async sessionDetail(ctx, id) {
      state.detailCalls.push(id);
      const value = details[id];
      if (value instanceof Error) throw value;
      return value ?? { sessionId: id, sizeBytes: 2048, formatStatus: 'current', legacy: false, archived: false };
    },
  };
  if (options.omitSessionDetail === true) delete sessions.sessionDetail;
  const manage = {
    async archiveSession() {},
    async unarchiveSession() {},
    async deleteSession(ctx, sessionId, opts) {
      state.deleteCalls.push([sessionId, opts]);
      if (typeof options.deleteError === 'function') {
        const error = options.deleteError(sessionId, opts);
        if (error !== undefined) throw error;
      }
      return opts.permanent === true ? PERMANENT_OUTCOME : TRASH_OUTCOME;
    },
  };
  const files = {
    async deriveSessionFilePlan(ctx, sessionIds) {
      state.deriveCalls.push([...sessionIds]);
      return {
        files: [
          { path: '/ws/a.txt', relative: 'a.txt', root: '/ws', bytes: 10, evidence: ['deliverables/presented'], weak: false, sessionIds: ['s1'] },
          { path: '/ws/sub/b.txt', relative: 'sub/b.txt', root: '/ws', bytes: 20, evidence: ['tool/arguments'], weak: true, sessionIds: ['s1'] },
        ],
        skipped: [],
        warnings: ['尽力推导提示'],
        totalBytes: 30,
      };
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
  apply(ctx, options.config ?? {}, { modules: { sessions, manage, files } });
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

test('/info advertises detail, permanent delete and selected-file delete', async () => {
  const harness = createHarness();
  const res = await harness.call({ method: 'GET', url: '/session-kit/info', headers: {} });
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.plugin, name);
  for (const capability of ['detail', 'deletePermanent', 'deleteSelectedFiles']) {
    assert.equal(body.capabilities[capability], true, capability);
  }
  assert.equal(body.files.experimental, true);
  assert.equal(body.files.permanent, true);
  assert.equal(body.files.detailBatchLimit, MAX_DETAIL_BATCH);
  assert.equal(body.files.selectedFilesLimit, MAX_SELECTED_FILES);
});

test('/session-detail returns the per-session size/format facts for trimmed, unique ids', async () => {
  const harness = createHarness({
    details: {
      s1: { sessionId: 's1', sizeBytes: 4096, formatStatus: 'current', legacy: false, archived: true },
      s2: { sessionId: 's2', sizeBytes: 512, formatStatus: 'migration-required', legacy: true, archived: false },
    },
  });
  const res = await harness.call(jsonRequest('/session-kit/session-detail', { sessionIds: [' s1 ', 's1', 's2'] }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.state.detailCalls, ['s1', 's2']);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.deepEqual(body.sessions, [
    { id: 's1', ok: true, sizeBytes: 4096, formatStatus: 'current', legacy: false, archived: true },
    { id: 's2', ok: true, sizeBytes: 512, formatStatus: 'migration-required', legacy: true, archived: false },
  ]);
});

test('/session-detail keeps per-id failures and maps a fully failed batch', async () => {
  const notFound = new Error('会话存储里找不到会话 gone');
  notFound.code = 'not-found';
  notFound.name = 'SessionPortFormatError';
  const harness = createHarness({ details: { s1: notFound } });
  const partial = await harness.call(jsonRequest('/session-kit/session-detail', { sessionIds: ['s1', 's2'] }));
  assert.equal(partial.statusCode, 200);
  const partialBody = jsonBody(partial);
  assert.equal(partialBody.ok, false);
  assert.equal(partialBody.sessions[0].ok, false);
  assert.equal(partialBody.sessions[0].code, 'not-found');
  assert.equal(partialBody.sessions[1].ok, true);

  const allFail = createHarness({ details: { s1: notFound } });
  const failed = await allFail.call(jsonRequest('/session-kit/session-detail', { sessionIds: ['s1'] }));
  assert.equal(failed.statusCode, 404);
  assert.equal(jsonBody(failed).sessions[0].code, 'not-found');
});

test('/session-detail enforces the 100-id cap and rejects malformed bodies', async () => {
  const harness = createHarness();
  const tooMany = await harness.call(jsonRequest('/session-kit/session-detail', {
    sessionIds: Array.from({ length: MAX_DETAIL_BATCH + 1 }, (_, index) => `session-${index}`),
  }));
  assert.equal(tooMany.statusCode, 400);
  assert.equal(jsonBody(tooMany).code, 'too-many-sessions');
  for (const payload of [{}, { sessionIds: [] }, { sessionIds: 'all' }, { sessionIds: ['a', ''] }, { sessionIds: ['a', 7] }]) {
    const res = await harness.call(jsonRequest('/session-kit/session-detail', payload));
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)}`);
    assert.equal(jsonBody(res).code, 'invalid-sessionIds');
  }
  assert.equal(jsonBody(await harness.call(rawRequest('/session-kit/session-detail', '{bad'))).code, 'invalid-json');
  assert.deepEqual(harness.state.detailCalls, []);
});

test('/session-detail answers 503 without the detail helper and 403 behind the fence', async () => {
  const missing = createHarness({ omitSessionDetail: true });
  const missingRes = await missing.call(jsonRequest('/session-kit/session-detail', { sessionIds: ['s1'] }));
  assert.equal(missingRes.statusCode, 503);
  assert.equal(jsonBody(missingRes).code, 'unavailable');

  const fenced = createHarness();
  fenced.state.rejection = 403;
  const fencedRes = await fenced.call(jsonRequest('/session-kit/session-detail', { sessionIds: ['s1'] }));
  assert.equal(fencedRes.statusCode, 403);
  assert.equal(fencedRes.body, undefined);
  assert.deepEqual(fenced.state.detailCalls, []);
});

test('/session-files preview shape is unchanged by the detail work', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/session-files', { sessionIds: ['s1'] }));
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.deepEqual(Object.keys(body).sort(), ['files', 'ok', 'skipped', 'totalBytes', 'warnings']);
  assert.equal(body.totalBytes, 30);
});

test('/delete removeFiles requires an explicit selectedFiles list', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'], removeFiles: true, confirm: true,
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(jsonBody(res).code, 'invalid-selection');
  assert.deepEqual(harness.state.deleteCalls, []);
});

test('/delete selectedFiles is refused without removeFiles and must be absolute', async () => {
  const harness = createHarness();
  const withoutRemove = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'], selectedFiles: ['/ws/a.txt'], confirm: true,
  }));
  assert.equal(withoutRemove.statusCode, 400);
  assert.equal(jsonBody(withoutRemove).code, 'invalid-selection');

  for (const selectedFiles of [['relative/a.txt'], [''], ['/ws/a.txt', 7], []]) {
    const res = await harness.call(jsonRequest('/session-kit/delete', {
      sessionIds: ['s1'], removeFiles: true, selectedFiles, confirm: true,
    }));
    assert.equal(res.statusCode, 400, `selectedFiles ${JSON.stringify(selectedFiles)}`);
    assert.equal(jsonBody(res).code, 'invalid-selection');
  }
  const tooMany = Array.from({ length: MAX_SELECTED_FILES + 1 }, (_, index) => `/ws/f${index}`);
  const capped = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'], removeFiles: true, selectedFiles: tooMany, confirm: true,
  }));
  assert.equal(capped.statusCode, 400);
  assert.equal(jsonBody(capped).code, 'too-many-files');
  assert.deepEqual(harness.state.deleteCalls, []);
});

test('/delete selectedFiles are passed to the management module with the trash options', async () => {
  const harness = createHarness({ config: { trashDir: '/tmp/custom-trash' } });
  const res = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'],
    removeFiles: true,
    selectedFiles: ['/ws/a.txt', '/ws/a.txt', '/ws/sub/b.txt'],
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
  assert.deepEqual(body.results[0].files, {
    moved: 2,
    skipped: 1,
    bytes: 30,
    trashPath: '/trash/2026-11-07T00:00:00.000Z/files',
    warnings: ['共享文件 a.txt 可能被其他会话使用'],
  });
  assert.equal(body.results[0].permanent, undefined, 'non-permanent delete has no permanent marker');
});

test('/delete permanent:true needs confirm and reports removed files without a trash path', async () => {
  const harness = createHarness();
  const unconfirmed = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'], permanent: true,
  }));
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal(jsonBody(unconfirmed).code, 'confirm-required');
  assert.deepEqual(harness.state.deleteCalls, []);

  const res = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'], permanent: true, confirm: true,
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.state.deleteCalls, [['s1', { permanent: true }]]);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.equal(body.permanent, true);
  assert.equal(body.filesRemoved, undefined, 'no files are involved without removeFiles');
  assert.equal(body.filesMoved, undefined);
  assert.equal(body.trashedPath, undefined);
  assert.deepEqual(body.results[0], { sessionId: 's1', ok: true, permanent: true });

  // permanent + removeFiles + selectedFiles reports erased files, still no trash path.
  const withFiles = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'],
    permanent: true,
    removeFiles: true,
    selectedFiles: ['/ws/a.txt'],
    confirm: true,
  }));
  const withFilesBody = jsonBody(withFiles);
  assert.equal(withFiles.statusCode, 200);
  assert.deepEqual(harness.state.deleteCalls.at(-1), ['s1', {
    removeFiles: true,
    selectedFiles: ['/ws/a.txt'],
    permanent: true,
  }]);
  assert.equal(withFilesBody.permanent, true);
  assert.equal(withFilesBody.filesRemoved, 2);
  assert.equal(withFilesBody.filesMoved, 0);
  assert.equal(withFilesBody.filesSkipped, 1);
  assert.equal(withFilesBody.filesBytes, 30);
  assert.equal(withFilesBody.trashedPath, undefined);
  assert.equal(withFilesBody.results[0].permanent, true);
  assert.deepEqual(withFilesBody.results[0].files, {
    removed: 2,
    skipped: 1,
    bytes: 30,
    warnings: ['永久删除后无法恢复'],
  });
});

test('/delete permanent with removeFiles still requires selectedFiles', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/delete', {
    sessionIds: ['s1'], permanent: true, removeFiles: true, confirm: true,
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(jsonBody(res).code, 'invalid-selection');
  assert.deepEqual(harness.state.deleteCalls, []);
});

test('the delete tool enforces selectedFiles removal and permanent confirmation', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'delete', sessionIds: ['s1'], removeFiles: true, confirm: true }, {}),
    /selectedFiles/u,
  );
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'delete', sessionIds: ['s1'], permanent: true }, {}),
    /confirm:true/u,
  );
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'delete', sessionIds: ['s1'], permanent: true, confirm: true, removeFiles: true }, {}),
    /selectedFiles/u,
  );
  assert.deepEqual(harness.state.deleteCalls, []);
});

test('the delete tool passes selectedFiles via removeFiles', async () => {
  const harness = createHarness();
  const text = await harness.state.tool.execute({
    action: 'delete',
    sessionIds: ['s1'],
    removeFiles: true,
    selectedFiles: ['/ws/a.txt'],
    confirm: true,
  }, {});
  assert.deepEqual(harness.state.deleteCalls, [
    ['s1', { removeFiles: true, selectedFiles: ['/ws/a.txt'] }],
  ]);
  assert.match(text, /同时移走文件 2 个/u);
});

test('the delete tool marks a permanent erase in its summary', async () => {
  const harness = createHarness();
  const text = await harness.state.tool.execute({
    action: 'delete',
    sessionIds: ['s1'],
    permanent: true,
    removeFiles: true,
    selectedFiles: ['/ws/a.txt'],
    confirm: true,
  }, {});
  assert.deepEqual(harness.state.deleteCalls, [
    ['s1', { removeFiles: true, selectedFiles: ['/ws/a.txt'], permanent: true }],
  ]);
  assert.match(text, /已永久删除所选会话与文件（不可恢复）/u);
  assert.match(text, /永久删除文件 2 个/u);
});

test('the tool schema exposes selectedFiles and permanent', async () => {
  const harness = createHarness();
  const schema = harness.state.tool.parameters;
  assert.equal(schema.properties.selectedFiles.type, 'array');
  assert.deepEqual(schema.properties.selectedFiles.items, { type: 'string' });
  assert.equal(schema.properties.permanent.type, 'boolean');
  assert.match(harness.state.tool.description, /selectedFiles/u);
  assert.match(harness.state.tool.description, /permanent:true/u);
});
