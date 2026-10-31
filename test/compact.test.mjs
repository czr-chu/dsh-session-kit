/**
 * Behavior tests for the compact session-log derivation plus real-backend
 * validation against the DSH checkout this plugin is developed in.
 *
 * The repository-backed checks import built DSH artifacts by absolute path and
 * are skipped when the plugin is installed outside the DSH repository.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { compactSession } from '../lib/compact.js';
import { headerLineOf } from '../lib/format.js';
import { createRealBackend, replayValidate, writeAndReadBack } from './support/real-backend.mjs';

/** Repository root when this plugin runs from the DSH checkout. */
const REPO_ROOT = new URL('../../', import.meta.url);

/** Absolute URL for one repository path. */
function repoUrl(relative) {
  return new URL(relative, REPO_ROOT);
}

/** Load the built v4 validator and session replay, or undefined outside the repo. */
async function loadRealDsh() {
  const sessionUrl = repoUrl('packages/core/session/lib/index.js');
  const validatorUrl = repoUrl('packages/session/session-format-v3-to-v4/lib/index.js');
  if (!existsSync(sessionUrl) || !existsSync(validatorUrl)) return undefined;
  try {
    const [session, validator] = await Promise.all([import(sessionUrl.href), import(validatorUrl.href)]);
    if (typeof validator.restoreReleasedV4Artifact !== 'function' || typeof session.Session?.create !== 'function') return undefined;
    return { session, validator };
  } catch {
    return undefined;
  }
}



/** Event types a compact log may contain. */
const COMPACT_TYPES = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'model/selection',
  'request/header',
  'request/context',
  'session/title',
  'turn/start',
  'step/start',
  'user/message',
  'assistant/message',
  'step/end',
  'turn/end',
]);

/** A source log builder with automatic seq/time assignment. */
function sourceBuilder(header) {
  const events = [];
  let seq = 0;
  let time = header.createdAt + 1;
  const add = (type, data, extra) => {
    const event = { type, seq: seq++, time: time++, data };
    if (extra !== undefined) Object.assign(event, extra);
    events.push(event);
    return event.seq;
  };
  return { events, add };
}

/**
 * A realistic two-turn source log: session config, injected user context,
 * streaming chunks, reasoning, tool calls/results, jobs, subagents, two
 * titles, and multi-step turns.
 */
function realisticSource() {
  const header = {
    version: 4,
    id: 'session-source',
    createdAt: 1_700_000_000_000,
    cwd: '/work/demo',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  };
  const { events, add } = sourceBuilder(header);
  add('permission/preset', { preset: 'workspace-write' });
  add('sandbox/mode', { mode: 'workspace-write' });
  add('approval/policy', { policy: 'ask' });
  add('model/selection', { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  add('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ role: 'user', id: 'inbox-1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] }] });
  add('turn/start', { turn: 1 });
  add('step/start', { turn: 1, step: 1 });
  add('system/message', {
    turn: 1,
    step: 1,
    message: { role: 'system', id: 'msg-system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '旧的系统提示词' }] },
  }, { surfaceOp: 'append' });
  const firstUser = add('user/message', {
    role: 'user',
    id: 'msg-user-1',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '第一问' }],
  }, { surfaceOp: 'append' });
  add('user/message', {
    role: 'user',
    id: 'msg-context-1',
    source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'cwd', text: 'x' }] },
    content: [{ type: 'text', text: 'Current runtime context...' }],
  }, { surfaceOp: 'append' });
  add('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }] }, reason: 'initial' });
  add('request/context', { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  add('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'msg-assistant-1a',
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      content: [
        { type: 'reasoning', text: '先跑个命令' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"echo hi"}' },
      ],
    },
    usage: { inputTokens: 1 },
    stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }],
  }, { surfaceOp: 'append' });
  add('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"echo hi"}' });
  add('job/registered', { jobId: 'job-1', owner: header.id, kind: 'bash', label: 'echo hi', startedAt: 1 });
  add('job/settled', { jobId: 'job-1', owner: header.id, kind: 'bash', label: 'echo hi', startedAt: 1, finishedAt: 2, status: 'completed', cause: 'producer' });
  add('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      id: 'msg-tool-1',
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
    },
  }, { surfaceOp: 'append', sourceEventSeqs: [12] });
  add('step/end', { turn: 1, step: 1 });
  add('step/start', { turn: 1, step: 2 });
  add('assistant/message', {
    turn: 1,
    step: 2,
    message: {
      role: 'assistant',
      id: 'msg-assistant-1b',
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      content: [
        { type: 'reasoning', text: '整理回答' },
        { type: 'text', text: '答一' },
      ],
    },
    usage: { inputTokens: 2 },
    stream: [{ type: 'chunk', time: 2, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: '答一' } } }],
  }, { surfaceOp: 'append' });
  add('session/title', { title: '源标题', messageSeqs: [firstUser], source: { kind: 'fallback' } });
  add('step/end', { turn: 1, step: 2 });
  add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  add('turn/start', { turn: 2 });
  add('step/start', { turn: 2, step: 1 });
  const secondUser = add('user/message', {
    role: 'user',
    id: 'msg-user-2',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '第二问' },
      { type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 68, width: 1, height: 1 } },
    ],
  }, { surfaceOp: 'append' });
  add('user/message', {
    role: 'user',
    id: 'msg-user-3',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '补充说明' }],
  }, { surfaceOp: 'append' });
  add('workspace/changes', { sessionId: header.id, changes: [] });
  add('assistant/message', {
    turn: 2,
    step: 1,
    message: {
      role: 'assistant',
      id: 'msg-assistant-2a',
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      content: [{ type: 'tool-call', id: 'call-2', name: 'bash', arguments: '{}' }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  add('tool/call', { turn: 2, step: 1, callId: 'call-2', name: 'bash', arguments: '{}' });
  add('tool/result', {
    turn: 2,
    step: 1,
    message: { role: 'tool', id: 'msg-tool-2', source: { kind: 'tool', callId: 'call-2' }, toolCallId: 'call-2', content: [{ type: 'text', text: 'ok' }], isError: false },
  }, { surfaceOp: 'append' });
  add('step/end', { turn: 2, step: 1 });
  add('step/start', { turn: 2, step: 2 });
  add('assistant/message', {
    turn: 2,
    step: 2,
    message: {
      role: 'assistant',
      id: 'msg-assistant-2b',
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      content: [{ type: 'reasoning', text: '回答' }, { type: 'text', text: '答二' }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  add('session/title', { title: '更新的标题', messageSeqs: [secondUser], source: { kind: 'provider', provider: 'title-provider' } });
  add('working-directory/change', { cwd: '/work/demo' });
  add('deliverables/presented', { deliverables: [] });
  add('subagent/catalog', { version: 0, childId: 'session-child', childCreatedAt: 2, mode: 'one-shot' });
  add('compaction/start', { compactionId: 'c1', sourceCommandId: undefined, turn: 2 });
  add('compaction/end', { compactionId: 'c1', turn: 2 });
  add('llm/retry', { turn: 2, step: 2, provider: 'deepseek-official', retry: 1, retryId: 'r1', policyKey: 'k', delayMs: 1 });
  add('step/end', { turn: 2, step: 2 });
  add('turn/end', { turn: 2, reason: { kind: 'completed' } });
  add('goal/change', { goal: null });
  return { header, events };
}

/** Assert the structural invariants every compact log must satisfy. */
function assertCompactStructure(result) {
  const { events } = result;
  // Dense seq from 0.
  events.forEach((event, index) => assert.equal(event.seq, index, 'event ' + index + ' seq'));
  // Only whitelisted types.
  for (const event of events) {
    assert.ok(COMPACT_TYPES.has(event.type), 'unexpected compact event type ' + event.type);
    assert.ok(Number.isSafeInteger(event.time), 'integer time for ' + event.type);
    assert.ok(event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data), 'object data for ' + event.type);
  }
  // Paired turns and steps: turn n opens on 1..N, step 1, both closed.
  const turns = events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn);
  assert.deepEqual(turns, turns.map((_, index) => index + 1), 'turn numbers are 1..N');
  let openTurn;
  let openStep;
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        assert.equal(openTurn, undefined, 'no nested turn');
        assert.equal(openStep, undefined, 'no open step before turn');
        openTurn = event.data.turn;
        break;
      case 'step/start':
        assert.equal(openTurn, event.data.turn, 'step belongs to the open turn');
        assert.equal(openStep, undefined, 'no nested step');
        assert.equal(event.data.step, 1, 'compacted turns use step 1');
        openStep = event.data.step;
        break;
      case 'step/end':
        assert.equal(openTurn, event.data.turn);
        assert.equal(openStep, event.data.step, 'step/end matches step/start');
        openStep = undefined;
        break;
      case 'turn/end':
        assert.equal(openTurn, event.data.turn, 'turn/end matches turn/start');
        assert.equal(openStep, undefined, 'turn closes after its step');
        openTurn = undefined;
        break;
      default:
        break;
    }
  }
  assert.equal(openTurn, undefined, 'every turn is closed');
  // Messages carry surfaceOp append; only assistant messages carry stream [].
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      assert.equal(event.surfaceOp, 'append', event.type + ' surfaceOp');
      assert.equal(event.sourceEventSeqs, undefined, event.type + ' has no sourceEventSeqs');
    } else {
      assert.equal(event.surfaceOp, undefined, event.type + ' carries no surfaceOp');
    }
  }
  for (const event of events.filter((entry) => entry.type === 'assistant/message')) {
    assert.deepEqual(event.data.stream, [], 'assistant stream is empty');
    assert.deepEqual(Object.keys(event.data).sort(), ['message', 'step', 'stream', 'turn'].sort());
  }
  // At most one title, and every cited seq exists and precedes it.
  const titles = events.filter((event) => event.type === 'session/title');
  assert.ok(titles.length <= 1, 'at most one title');
  for (const title of titles) {
    for (const seq of title.data.messageSeqs) {
      assert.ok(Number.isSafeInteger(seq) && seq >= 0 && seq < title.seq, 'title cites an earlier event');
      const cited = events[seq];
      assert.equal(cited.type, 'user/message', 'title cites a user message');
      assert.equal(cited.data.source.kind, 'user', 'title cites a human user message');
    }
    const isUserTitle = title.data.source.kind === 'user';
    assert.equal(title.data.messageSeqs.length === 0, isUserTitle, 'empty messageSeqs exactly for a user title');
  }
}

test('compactSession drops the machinery and keeps the conversation spine', () => {
  const source = realisticSource();
  const snapshot = structuredClone(source);
  const result = compactSession(source);
  assertCompactStructure(result);
  assert.deepEqual(source, snapshot, 'input log is not mutated');

  const types = new Set(result.events.map((event) => event.type));
  for (const dropped of [
    'assistant/chunk', 'tool/call', 'tool/result', 'job/registered', 'job/settled',
    'subagent/catalog', 'agent/inbox/spliced', 'working-directory/change',
    'deliverables/presented', 'workspace/changes', 'session/end-seed',
    'compaction/start', 'compaction/end', 'llm/retry', 'goal/change',
    'system/message', 'approval/asked', 'plan/mode', 'todo/write',
  ]) {
    assert.equal(types.has(dropped), false, 'dropped type ' + dropped);
  }
  assert.ok(result.events.length < source.events.length / 2, 'compact log is materially smaller');

  const users = result.events.filter((event) => event.type === 'user/message');
  assert.deepEqual(users.map((event) => event.data.id), ['msg-user-1', 'msg-user-2', 'msg-user-3']);
  assert.deepEqual(users.map((event) => event.data.content.map((block) => block.text ?? block.type)), [['第一问'], ['第二问', 'image'], ['补充说明']]);
  for (const user of users) {
    assert.equal(user.data.role, 'user');
    assert.deepEqual(user.data.source, { kind: 'user' });
  }

  const assistants = result.events.filter((event) => event.type === 'assistant/message');
  assert.deepEqual(assistants.map((event) => event.data.message.id), ['msg-assistant-1b', 'msg-assistant-2b']);
  for (const assistant of assistants) {
    assert.deepEqual(assistant.data.message.content.map((block) => block.type), ['text']);
    assert.deepEqual(assistant.data.message.content.map((block) => block.text), ['答一', '答二'].slice(assistants.indexOf(assistant), assistants.indexOf(assistant) + 1));
    assert.equal(assistant.data.step, 1);
    assert.deepEqual(assistant.data.message.source, { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  }

  // The latest title wins; it is a provider title, so it cites the kept user
  // message that the source cited and sits behind that turn.
  const titles = result.events.filter((event) => event.type === 'session/title');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].data.title, '更新的标题');
  assert.equal(titles[0].data.source.kind, 'provider');
  assert.equal(result.events[titles[0].data.messageSeqs[0]].data.id, 'msg-user-2');
  assert.ok(titles[0].seq > result.events.findIndex((event) => event.type === 'turn/end' && event.data.turn === 2));
  // Configuration events keep source order; the request records host turn 1.
  assert.deepEqual(
    result.events.slice(0, 4).map((event) => event.type),
    ['permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection'],
  );
  const headerSeq = result.events.findIndex((event) => event.type === 'request/header');
  const contextSeq = result.events.findIndex((event) => event.type === 'request/context');
  const turnOneStart = result.events.findIndex((event) => event.type === 'turn/start');
  const firstTurnEnd = result.events.findIndex((event) => event.type === 'turn/end');
  assert.ok(headerSeq > turnOneStart && contextSeq > headerSeq && contextSeq < firstTurnEnd, 'request records live inside turn 1');
});

test('compactSession builds a standalone unseeded header and flattens fork history', () => {
  const source = realisticSource();
  source.header.isSeeded = true;
  source.header.parentSession = 'session-parent';
  source.header.origin = 'subagent';
  source.header.delegationDepth = 1;
  // A fork log carries the inherited cut marker; the compact log must drop it.
  source.events.splice(source.events.findIndex((event) => event.type === 'permission/preset'), 0, {
    type: 'user/message',
    seq: -1,
    time: 1,
    data: { role: 'user', id: 'msg-inherited', source: { kind: 'user' }, content: [{ type: 'text', text: '继承的历史' }] },
    surfaceOp: 'append',
  }, {
    type: 'session/end-seed',
    seq: -1,
    time: 2,
    data: { inherited: true },
  });
  // Renumber the injected prefix events so the fixture stays a legal source log.
  source.events.forEach((event, index) => { event.seq = index; });
  const result = compactSession(source);
  assertCompactStructure(result);
  assert.equal(result.header.isSeeded, false);
  assert.equal(result.header.parentSession, undefined);
  assert.equal(result.header.origin, undefined);
  assert.equal(result.header.delegationDepth, undefined);
  assert.equal(result.header.agentPreset, 'standard');
  assert.equal(result.header.id, 'session-source');
  assert.equal(result.header.cwd, '/work/demo');
  assert.equal(result.events.some((event) => event.type === 'session/end-seed'), false);
  // Inherited history is normal conversation in a standalone compact log.
  assert.ok(result.events.some((event) => event.type === 'user/message' && event.data.id === 'msg-inherited'));
});

test('compactSession tolerates empty and system-only sessions', () => {
  const header = { version: 4, id: 'session-empty', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const empty = compactSession({ header, events: [] });
  assert.equal(empty.header.isSeeded, false);
  assert.deepEqual(empty.events, []);

  const source = sourceBuilder(header);
  source.add('permission/preset', { preset: 'workspace-write' });
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  source.add('system/message', {
    turn: 1,
    step: 1,
    message: { role: 'system', id: 'msg-sys', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'only system' }] },
  }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  assert.equal(result.events.some((event) => event.type === 'user/message' || event.type === 'assistant/message'), false);
  assert.deepEqual(result.events.map((event) => event.type), [
    'permission/preset', 'turn/start', 'step/start', 'step/end', 'turn/end',
  ]);
});

test('compactSession closes a truncated turn as interrupted', () => {
  const header = { version: 4, id: 'session-truncated', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  source.add('user/message', { role: 'user', id: 'msg-u', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] }, { surfaceOp: 'append' });
  // No step/end, no turn/end: the writer crashed mid-turn.
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  const turnEnd = result.events.find((event) => event.type === 'turn/end');
  assert.deepEqual(turnEnd.data, { turn: 1, reason: { kind: 'interrupted' } });
});

test('compactSession renumbers sparse source turns and maps titles by source seq', () => {
  const header = { version: 4, id: 'session-sparse', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 3 });
  source.add('step/start', { turn: 3, step: 1 });
  const first = source.add('user/message', { role: 'user', id: 'msg-a', source: { kind: 'user' }, content: [{ type: 'text', text: 'A' }] }, { surfaceOp: 'append' });
  source.add('assistant/message', {
    turn: 3,
    step: 1,
    message: { role: 'assistant', id: 'msg-r', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'R' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 3, step: 1 });
  source.add('turn/end', { turn: 3, reason: { kind: 'completed' } });
  source.add('turn/start', { turn: 7 });
  source.add('step/start', { turn: 7, step: 1 });
  source.add('user/message', { role: 'user', id: 'msg-b', source: { kind: 'user' }, content: [{ type: 'text', text: 'B' }] }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 7, step: 1 });
  source.add('turn/end', { turn: 7, reason: { kind: 'cancelled' } });
  source.add('session/title', { title: '稀疏标题', messageSeqs: [first], source: { kind: 'fallback' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  assert.deepEqual(result.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn), [1, 2]);
  // Non-completed source reasons collapse to interrupted, per the compact contract.
  assert.deepEqual(result.events.filter((event) => event.type === 'turn/end').map((event) => event.data.reason.kind), ['completed', 'interrupted']);
  const title = result.events.find((event) => event.type === 'session/title');
  assert.equal(result.events[title.data.messageSeqs[0]].data.id, 'msg-a');
});

test('compactSession keeps a user-renamed title in the prelude with no citations', () => {
  const header = { version: 4, id: 'session-renamed', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  source.add('user/message', { role: 'user', id: 'msg-u', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  source.add('session/title', { title: '用户改的标题', messageSeqs: [], source: { kind: 'user' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  const title = result.events.find((event) => event.type === 'session/title');
  assert.deepEqual(title.data, { title: '用户改的标题', messageSeqs: [], source: { kind: 'user' } });
  assert.ok(title.seq < result.events.findIndex((event) => event.type === 'turn/start'), 'user title stays in the prelude');
});

test('compactSession drops a provider title it cannot cite', () => {
  const header = { version: 4, id: 'session-no-user', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  source.add('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', id: 'msg-r', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '没有人类提问' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  source.add('session/title', { title: '无引用标题', messageSeqs: [], source: { kind: 'fallback' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  assert.equal(result.events.some((event) => event.type === 'session/title'), false);
});

test('compactSession keeps a generated title behind the turn that holds its citation', () => {
  const header = { version: 4, id: 'session-title-order', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  const first = source.add('user/message', { role: 'user', id: 'msg-a', source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮' }] }, { surfaceOp: 'append' });
  source.add('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', id: 'msg-r1', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '回一' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  source.add('turn/start', { turn: 2 });
  source.add('step/start', { turn: 2, step: 1 });
  source.add('user/message', { role: 'user', id: 'msg-b', source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮' }] }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 2, step: 1 });
  source.add('turn/end', { turn: 2, reason: { kind: 'completed' } });
  // The generated title appears after its citation in the source log.
  source.add('session/title', { title: '生成的标题', messageSeqs: [first], source: { kind: 'fallback' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  const title = result.events.find((event) => event.type === 'session/title');
  assert.equal(title.data.title, '生成的标题');
  assert.equal(result.events[title.data.messageSeqs[0]].data.id, 'msg-a');
  const firstTurnEnd = result.events.findIndex((event) => event.type === 'turn/end' && event.data.turn === 1);
  const secondTurnStart = result.events.findIndex((event) => event.type === 'turn/start' && event.data.turn === 2);
  assert.ok(title.seq > firstTurnEnd && title.seq < secondTurnStart, 'title sits behind its cited turn, in source order');
});

test('compactSession rewrites a title whose citations were dropped', () => {
  const header = { version: 4, id: 'session-title-fallback', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  const human = source.add('user/message', { role: 'user', id: 'msg-human', source: { kind: 'user' }, content: [{ type: 'text', text: '人类提问' }] }, { surfaceOp: 'append' });
  // A context-only user message is not part of the compact conversation.
  const injected = source.add('user/message', { role: 'user', id: 'msg-context', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: '上下文' }] }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  // The provider title cites the injected message, which compaction drops.
  source.add('session/title', { title: '生成标题', messageSeqs: [injected], source: { kind: 'provider', provider: 'title-provider' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  assert.equal(result.events.some((event) => event.type === 'user/message' && event.data.id === 'msg-context'), false);
  const title = result.events.find((event) => event.type === 'session/title');
  assert.equal(title.data.source.kind, 'provider');
  assert.equal(title.data.messageSeqs.length, 1);
  assert.equal(result.events[title.data.messageSeqs[0]].data.id, 'msg-human', 'lost citation falls back to the first kept human prompt');
  assert.ok(human >= 0);
});

test('compactSession places a title behind every out-of-order citation', () => {
  const header = { version: 4, id: 'session-title-order2', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  const first = source.add('user/message', { role: 'user', id: 'msg-a', source: { kind: 'user' }, content: [{ type: 'text', text: 'A' }] }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  source.add('turn/start', { turn: 2 });
  source.add('step/start', { turn: 2, step: 1 });
  const second = source.add('user/message', { role: 'user', id: 'msg-b', source: { kind: 'user' }, content: [{ type: 'text', text: 'B' }] }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 2, step: 1 });
  source.add('turn/end', { turn: 2, reason: { kind: 'completed' } });
  source.add('session/title', { title: '乱序引用', messageSeqs: [second, first], source: { kind: 'provider', provider: 'p' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  const title = result.events.find((event) => event.type === 'session/title');
  assert.equal(title.data.messageSeqs.length, 2);
  for (const seq of title.data.messageSeqs) assert.ok(seq < title.seq, 'every citation precedes the title');
  assert.deepEqual(title.data.messageSeqs.map((seq) => result.events[seq].data.id), ['msg-a', 'msg-b']);
});

test('compactSession repairs a user title that illegally cites messages', () => {
  const header = { version: 4, id: 'session-title-repair', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  const human = source.add('user/message', { role: 'user', id: 'msg-human', source: { kind: 'user' }, content: [{ type: 'text', text: '人类提问' }] }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  // Invalid source payload: a user rename must cite nothing. The compact log
  // repairs it instead of forwarding an unreadable event.
  source.add('session/title', { title: '用户标题', messageSeqs: [human], source: { kind: 'user' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  const title = result.events.find((event) => event.type === 'session/title');
  assert.equal(title.data.source.kind, 'fallback');
  assert.equal(result.events[title.data.messageSeqs[0]].data.id, 'msg-human');
});

test('compactSession emits no assistant message when a turn has no visible reply', () => {
  const header = { version: 4, id: 'session-no-reply', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  source.add('user/message', { role: 'user', id: 'msg-u', source: { kind: 'user' }, content: [{ type: 'text', text: '只调用了工具' }] }, { surfaceOp: 'append' });
  source.add('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'msg-tools-only',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'reasoning', text: 'x' }, { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }],
    },
    stream: [],
  }, { surfaceOp: 'append' });
  source.add('tool/call', { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{}' });
  source.add('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', id: 'msg-tool', source: { kind: 'tool', callId: 'c' }, toolCallId: 'c', content: [{ type: 'text', text: 'ok' }], isError: false },
  }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  assert.equal(result.events.some((event) => event.type === 'assistant/message'), false, 'tool-only replies are not part of the compact conversation');
  assert.deepEqual(result.events.map((event) => event.type), [
    'turn/start', 'step/start', 'user/message', 'step/end', 'turn/end',
  ]);
});

test('compactSession prefers the turn final visible assistant message', () => {
  const header = { version: 4, id: 'session-final', createdAt: 5, cwd: '/work/demo', isSeeded: false, delegationDepth: 0 };
  const source = sourceBuilder(header);
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  source.add('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', id: 'msg-a', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: '早期回答' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('step/start', { turn: 1, step: 2 });
  source.add('assistant/message', {
    turn: 1,
    step: 2,
    message: { role: 'assistant', id: 'msg-b', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 2 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const result = compactSession({ header, events: source.events });
  assertCompactStructure(result);
  const assistants = result.events.filter((event) => event.type === 'assistant/message');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].data.message.id, 'msg-a');
  assert.equal(assistants[0].data.message.content[0].text, '早期回答');
});

test('compactSession handles a real recorded session log', async (t) => {
  // Repository snapshots store normalized rows (no seq/time), so this fixture
  // renumbers them; the event shapes and ordering are the recorded ones.
  const fixture = repoUrl('snapshots/sdk/bash-tool/session.v4.jsonl');
  if (!existsSync(fixture)) {
    t.skip('recorded session fixture unavailable outside the DSH repository');
    return;
  }
  const lines = readFileSync(fixture, 'utf8').trim().split('\n');
  const sourceHeader = { ...JSON.parse(lines[0]), cwd: '/work/demo' };
  const sourceEvents = lines.slice(1).map((line, index) => ({ ...JSON.parse(line), seq: index, time: 1_700_000_000_000 + index }));
  const compact = compactSession({ header: sourceHeader, events: sourceEvents });
  assertCompactStructure(compact);
  assert.ok(compact.events.length < sourceEvents.length, 'compacted a real log');
  assert.ok(compact.events.some((event) => event.type === 'user/message' && event.data.content[0].text.includes('bash')));
  assert.ok(compact.events.some((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'text')));
  assert.equal(compact.events.some((event) => event.type === 'tool/result' || event.type === 'job/settled'), false);
  const dsh = await loadRealDsh();
  if (dsh !== undefined) {
    const { type: _type, ...header } = headerLineOf(compact.header);
    assert.doesNotThrow(() => dsh.validator.restoreReleasedV4Artifact({ header, events: compact.events, inheritedEventCount: 0 }, dsh.session.KNOWN_SESSION_EVENT_TYPES));
    assert.doesNotThrow(() => dsh.session.Session.create(header.id, compact.events, header, 0));
  }
});

test('compactSession output is accepted by the real v4 artifact validator and replay', async (t) => {
  const dsh = await loadRealDsh();
  if (dsh === undefined) {
    t.skip('built DSH checkout artifacts unavailable; skipping real-validator check');
    return;
  }
  /** The physical header line minus its record tag is the logical v4 header. */
  const logicalHeaderOf = (compact) => {
    const { type: _type, ...header } = headerLineOf(compact.header);
    return header;
  };
  for (const source of [realisticSource(), seededSource()]) {
    const compact = compactSession(source);
    const artifact = {
      header: logicalHeaderOf(compact),
      events: compact.events,
      inheritedEventCount: 0,
    };
    assert.doesNotThrow(() => dsh.validator.restoreReleasedV4Artifact(artifact, dsh.session.KNOWN_SESSION_EVENT_TYPES));
    assert.doesNotThrow(() => dsh.session.Session.create(artifact.header.id, compact.events, artifact.header, 0));
  }
  // The validator is meaningful: a tampered turn number is refused.
  const compact = compactSession(realisticSource());
  const tampered = compact.events.map((event) => (event.type === 'turn/start' ? { ...event, data: { ...event.data, turn: 7 } } : event));
  assert.throws(
    () => dsh.validator.restoreReleasedV4Artifact({ header: logicalHeaderOf(compact), events: tampered, inheritedEventCount: 0 }, dsh.session.KNOWN_SESSION_EVENT_TYPES),
    /turn\/start does not open the expected turn|format v4/,
  );
});

test('compact log replays through the real product validator and JSONL backend', async (t) => {
  const backend = await createRealBackend();
  if (!backend.ok) {
    t.skip('real JSONL backend unavailable (run from the DSH repo with node --import tsx/esm): ' + backend.error);
    return;
  }
  const replay = await replayValidate({ version: 4, id: 'session-probe', createdAt: 1, cwd: '/work/demo', isSeeded: false }, []);
  if (!replay.ok) {
    backend.cleanup();
    t.skip('real @deepseek-ai/dsh-session replay unavailable: ' + replay.error);
    return;
  }
  try {
    for (const [index, source] of [realisticSource(), seededSource()].entries()) {
      const compact = compactSession(source);
      const header = { ...compact.header, id: 'session-compact-real-' + index };
      const checked = await replayValidate(header, compact.events);
      assert.deepEqual(checked, { ok: true }, 'product replay accepts the compact log');
      const readBack = await writeAndReadBack(backend.persistence, header, compact.events);
      assert.deepEqual(readBack.events, compact.events, 'the backend returns every compact event unchanged');
      // writeAndReadBack exposes the read slice (which carries no header), so
      // confirm the stored header through the open handle.
      const opened = await backend.persistence.open(header.id, 'read');
      try {
        assert.equal(opened.header.id, header.id);
        assert.equal(opened.header.isSeeded, false);
      } finally {
        await opened.close();
      }
    }
    // The backend validates on read: a tampered compact log must be refused.
    const compact = compactSession(realisticSource());
    const header = { ...compact.header, id: 'session-compact-tampered' };
    const tampered = compact.events.map((event) => (event.type === 'turn/start' ? { ...event, data: { ...event.data, turn: 7 } } : event));
    await assert.rejects(writeAndReadBack(backend.persistence, header, tampered), /turn\/start does not open the expected turn|format v4/);
  } finally {
    backend.cleanup();
  }
});

/** Minimal seeded source for the fork/end-seed coverage. */
function seededSource() {
  const header = {
    version: 4,
    id: 'session-fork',
    createdAt: 1_700_000_000_000,
    cwd: '/work/demo',
    isSeeded: true,
    parentSession: 'session-parent',
    origin: 'subagent',
    delegationDepth: 1,
  };
  const source = sourceBuilder(header);
  source.add('session/end-seed', { inherited: true });
  source.add('turn/start', { turn: 1 });
  source.add('step/start', { turn: 1, step: 1 });
  source.add('user/message', { role: 'user', id: 'msg-fork', source: { kind: 'user' }, content: [{ type: 'text', text: '继承问题' }] }, { surfaceOp: 'append' });
  source.add('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', id: 'msg-fork-a', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '继承回答' }] },
    stream: [],
  }, { surfaceOp: 'append' });
  source.add('step/end', { turn: 1, step: 1 });
  source.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return { header, events: source.events };
}
