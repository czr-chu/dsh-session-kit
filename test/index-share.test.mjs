/**
 * Unit tests for index.js DeepSeek share import (route + tool action).
 *
 * The share module is injected through the test-only third `apply` argument, so
 * no network request is made and no session is written: the mock records what
 * the Host passes to `importShare` and returns a canned outcome.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, MAX_SHARE_INPUT_LENGTH, name } from '../index.js';
import { SessionPortFormatError } from '../lib/format.js';

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
 * Create one Host-half harness with a mocked share module.
 * @param {object} [options] - registry/target/share behavior overrides.
 * @returns {object} harness.
 */
function createHarness(options = {}) {
  const state = {
    route: undefined,
    tool: undefined,
    rejection: undefined,
    shareCalls: [],
    registryGets: [],
  };
  const registry = options.registry ?? {
    async get() {
      return undefined;
    },
  };
  const sessions = {
    async detectFormatVersion() {
      return 4;
    },
    servicesOf() {
      return options.omitRegistry === true ? {} : { workspaceRegistry: registry };
    },
    async listSessionEntries() {
      return [];
    },
    async listWorkspaceEntries() {
      return [];
    },
    async resolveTargetDirectory() {
      return options.targetDirectory ?? '/deploy/default';
    },
  };
  const share = {
    async importShare(ctx, request) {
      state.shareCalls.push(request);
      if (options.shareError !== undefined) throw options.shareError;
      return options.shareResult ?? {
        sessionId: 'session-share-1',
        title: '分享对话',
        eventCount: 12,
        warnings: ['思维链按未签名 thinking 重放'],
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
  const modules = { sessions };
  if (options.omitShare !== true) modules.share = share;
  apply(ctx, options.config ?? {}, { modules });
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

const SHARE_INPUT = 'https://chat.deepseek.com/share/amsflpzddeqka0cylw';

test('/info advertises shareImport with provider/model hints', async () => {
  const harness = createHarness();
  const res = await harness.call({ method: 'GET', url: '/session-kit/info', headers: {} });
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.plugin, name);
  assert.equal(body.capabilities.shareImport, true);
  assert.equal(body.share.provider, 'deepseek');
  assert.equal(body.share.model, 'deepseek-chat');
  assert.equal(body.share.endpoint, 'https://chat.deepseek.com/api/v0/share/content');
  assert.equal(body.share.inputMaxLength, MAX_SHARE_INPUT_LENGTH);
});

test('/import-share uses the resolved deployment directory when no workspace/cwd is given', async () => {
  const harness = createHarness({ targetDirectory: '/deploy/default' });
  const res = await harness.call(jsonRequest('/session-kit/import-share', { input: ` ${SHARE_INPUT} ` }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.state.shareCalls, [{ input: SHARE_INPUT, cwd: '/deploy/default' }]);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.deepEqual(body.session, { sessionId: 'session-share-1', title: '分享对话', eventCount: 12 });
  assert.deepEqual(body.warnings, ['思维链按未签名 thinking 重放']);
  assert.equal(body.workspace, undefined);
});

test('/import-share resolves a chosen workspace through the registry (sync and async)', async () => {
  const syncRegistry = {
    get(workspaceId) {
      if (workspaceId === 'ws-1') return { id: 'ws-1', path: '/home/u/Piwork/target' };
      return undefined;
    },
  };
  const syncHarness = createHarness({ registry: syncRegistry });
  const syncRes = await syncHarness.call(jsonRequest('/session-kit/import-share', {
    input: SHARE_INPUT,
    workspaceId: ' ws-1 ',
  }));
  assert.equal(syncRes.statusCode, 200);
  assert.deepEqual(syncHarness.state.shareCalls, [{
    input: SHARE_INPUT,
    cwd: '/home/u/Piwork/target',
    workspaceId: 'ws-1',
  }]);
  assert.deepEqual(jsonBody(syncRes).workspace, {
    workspaceId: 'ws-1',
    path: '/home/u/Piwork/target',
  });

  const asyncHarness = createHarness({
    registry: {
      async get() {
        return { id: 'ws-2', path: '/home/u/other' };
      },
    },
  });
  const asyncRes = await asyncHarness.call(jsonRequest('/session-kit/import-share', {
    input: SHARE_INPUT,
    workspaceId: 'ws-2',
  }));
  assert.equal(asyncRes.statusCode, 200);
  assert.equal(jsonBody(asyncRes).workspace.path, '/home/u/other');
});

test('/import-share answers 404 workspace-not-found for an unknown workspace', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/import-share', {
    input: SHARE_INPUT,
    workspaceId: 'missing-ws',
  }));
  assert.equal(res.statusCode, 404);
  assert.equal(jsonBody(res).code, 'workspace-not-found');
  assert.deepEqual(harness.state.shareCalls, []);
});

test('/import-share answers 503 when the workspace registry is unavailable', async () => {
  const harness = createHarness({ omitRegistry: true });
  const res = await harness.call(jsonRequest('/session-kit/import-share', {
    input: SHARE_INPUT,
    workspaceId: 'ws-1',
  }));
  assert.equal(res.statusCode, 503);
  assert.equal(jsonBody(res).code, 'unavailable');
  assert.deepEqual(harness.state.shareCalls, []);
});

test('/import-share prefers an explicit cwd over the deployment default', async () => {
  const harness = createHarness({ targetDirectory: '/deploy/default' });
  const res = await harness.call(jsonRequest('/session-kit/import-share', {
    input: SHARE_INPUT,
    cwd: ' /custom/cwd ',
    title: '  自定义标题  ',
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.state.shareCalls, [{
    input: SHARE_INPUT,
    cwd: '/custom/cwd',
    title: '自定义标题',
  }]);
});

test('/import-share rejects malformed bodies without calling the share module', async () => {
  const harness = createHarness();
  for (const payload of [
    {},
    { input: 42 },
    { input: '' },
    { input: '   ' },
    { input: SHARE_INPUT, workspaceId: 42 },
    { input: SHARE_INPUT, title: {} },
    { input: SHARE_INPUT, cwd: 7 },
  ]) {
    const res = await harness.call(jsonRequest('/session-kit/import-share', payload));
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)}`);
    assert.equal(jsonBody(res).code, 'invalid-body');
  }
  assert.equal(
    jsonBody(await harness.call(rawRequest('/session-kit/import-share', '{bad'))).code,
    'invalid-json',
  );
  assert.deepEqual(harness.state.shareCalls, []);
});

test('/import-share rejects an oversized input as invalid-share', async () => {
  const harness = createHarness();
  const res = await harness.call(jsonRequest('/session-kit/import-share', {
    input: `${SHARE_INPUT}${'x'.repeat(MAX_SHARE_INPUT_LENGTH)}`,
  }));
  assert.equal(res.statusCode, 400);
  assert.equal(jsonBody(res).code, 'invalid-share');
  assert.deepEqual(harness.state.shareCalls, []);
});

test('/import-share maps share-module failures to 400/502/500 and unknown errors to import-failed', async () => {
  const cases = [
    ['invalid-share', 400],
    ['share-fetch', 502],
    ['share-api', 502],
    ['timeout', 502],
    ['import-failed', 500],
  ];
  for (const [code, expected] of cases) {
    const harness = createHarness({
      shareError: new SessionPortFormatError(code, `mock ${code}`),
    });
    const res = await harness.call(jsonRequest('/session-kit/import-share', { input: SHARE_INPUT }));
    assert.equal(res.statusCode, expected, code);
    assert.equal(jsonBody(res).code, code);
  }
  const unknown = createHarness({ shareError: new Error('boom') });
  const res = await unknown.call(jsonRequest('/session-kit/import-share', { input: SHARE_INPUT }));
  assert.equal(res.statusCode, 500);
  assert.equal(jsonBody(res).code, 'import-failed');
});

test('/import-share answers 503 without the share module and 403 behind the fence', async () => {
  const missing = createHarness({ omitShare: true });
  const missingRes = await missing.call(jsonRequest('/session-kit/import-share', { input: SHARE_INPUT }));
  assert.equal(missingRes.statusCode, 503);
  assert.equal(jsonBody(missingRes).code, 'unavailable');

  const fenced = createHarness();
  fenced.state.rejection = 403;
  const fencedRes = await fenced.call(jsonRequest('/session-kit/import-share', { input: SHARE_INPUT }));
  assert.equal(fencedRes.statusCode, 403);
  assert.equal(fencedRes.body, undefined);
  assert.deepEqual(fenced.state.shareCalls, []);
});

test('an invalid share module result is reported as import-failed', async () => {
  const harness = createHarness({ shareResult: { title: 'no id' } });
  const res = await harness.call(jsonRequest('/session-kit/import-share', { input: SHARE_INPUT }));
  assert.equal(res.statusCode, 500);
  assert.equal(jsonBody(res).code, 'import-failed');
});

test('the import_share tool imports with a workspace and summarises the result', async () => {
  const harness = createHarness({
    registry: {
      async get() {
        return { id: 'ws-9', path: '/home/u/Piwork/ws9' };
      },
    },
  });
  const text = await harness.state.tool.execute({
    action: 'import_share',
    input: SHARE_INPUT,
    workspaceId: 'ws-9',
    title: ' 标题 ',
  }, {});
  assert.deepEqual(harness.state.shareCalls, [{
    input: SHARE_INPUT,
    cwd: '/home/u/Piwork/ws9',
    workspaceId: 'ws-9',
    title: '标题',
  }]);
  assert.match(text, /已导入分享会话：session-share-1/u);
  assert.match(text, /标题 分享对话/u);
  assert.match(text, /12 条事件/u);
  assert.match(text, /工作区：ws-9（\/home\/u\/Piwork\/ws9）/u);
  assert.match(text, /注意：思维链按未签名 thinking 重放/u);
});

test('the import_share tool requires input and rejects oversize input', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'import_share' }, {}),
    /input 参数/u,
  );
  await assert.rejects(
    () => harness.state.tool.execute({ action: 'import_share', input: `${SHARE_INPUT}${'x'.repeat(MAX_SHARE_INPUT_LENGTH)} ` }, {}),
    /过长/u,
  );
  assert.deepEqual(harness.state.shareCalls, []);
});

test('the import_share tool surfaces import failures and a missing module', async () => {
  const failing = createHarness({ shareError: new SessionPortFormatError('share-api', '接口返回错误') });
  await assert.rejects(
    () => failing.state.tool.execute({ action: 'import_share', input: SHARE_INPUT }, {}),
    /导入分享会话失败：接口返回错误/u,
  );
  const missing = createHarness({ omitShare: true });
  await assert.rejects(
    () => missing.state.tool.execute({ action: 'import_share', input: SHARE_INPUT }, {}),
    /模块不可用/u,
  );
});

test('the tool schema exposes import_share and its input/workspaceId/title parameters', async () => {
  const harness = createHarness();
  const schema = harness.state.tool.parameters;
  assert.ok(schema.properties.action.enum.includes('import_share'));
  for (const field of ['input', 'workspaceId', 'title']) {
    assert.equal(schema.properties[field].type, 'string', field);
  }
  assert.match(harness.state.tool.description, /action=import_share/u);
});
