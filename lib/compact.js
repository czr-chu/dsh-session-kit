/**
 * dsh-session-kit -- compact ("conversation spine") session log.
 *
 * A full session log records every delta, tool call, job, subagent, and
 * runtime record; most of it is only meaningful to the loop that produced it.
 * This module derives a smaller v4 logical log that keeps the conversation a
 * user would recognize -- the human prompts plus each turn's final assistant
 * text -- and drops the machinery. The result is a legal DSH session log: dense
 * seq from 0, paired turn/step boundaries, surface-append messages, and only
 * known v4 event types, so the import path can commit it as a new unseeded
 * session and the reader can replay it.
 *
 * What is preserved:
 *  - session-level configuration: permission/preset, sandbox/mode,
 *    approval/policy, model/selection (all occurrences, in source order);
 *  - the first request/header and request/context, moved into the first turn
 *    because v4 refuses a request record outside an open turn;
 *  - at most one session/title;
 *  - per top-level turn: turn/start, step/start, the turn's human user
 *    messages, the turn's final assistant message (visible text/image/file
 *    blocks only, empty delta stream), step/end, turn/end.
 *
 * What is dropped: every other event type, including stream chunks,
 * reasoning, tool calls and results, jobs, subagents, workspace and
 * working-directory changes, approvals, retries, and the fork-inherited
 * end-seed marker.
 *
 * @module dsh-session-kit/compact
 */

/** Session-level configuration carried into the compact prelude. */
const CONFIG_EVENT_TYPES = new Set([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'model/selection',
]);

const TITLE_EVENT = 'session/title';
const USER_EVENT = 'user/message';
const ASSISTANT_EVENT = 'assistant/message';
const TURN_START = 'turn/start';
const TURN_END = 'turn/end';
const STEP_START = 'step/start';
const STEP_END = 'step/end';
const REQUEST_HEADER = 'request/header';
const REQUEST_CONTEXT = 'request/context';

/** Content block types a compacted message keeps. */
const VISIBLE_BLOCK_TYPES = new Set(['text', 'image', 'file']);

/** True for a plain JSON object (never an array or null). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep clone a JSON value (events and payloads are plain JSON). */
function detach(value) {
  return structuredClone(value);
}

/** Keep only the visible content blocks of one message, detached. */
function visibleContent(content) {
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    if (!isRecord(block) || !VISIBLE_BLOCK_TYPES.has(block.type)) continue;
    if (block.type === 'text' && (typeof block.text !== 'string' || block.text.trim() === '')) continue;
    blocks.push(detach(block));
  }
  return blocks;
}

/** The source event's original seq, or its list position when it carries none. */
function sourceSeqOf(event, index) {
  return Number.isSafeInteger(event?.seq) && event.seq >= 0 ? event.seq : index;
}

/**
 * Split a source log into the pieces a compact log is built from.
 *
 * Turns are delimited by turn/start..turn/end; user and assistant messages
 * outside any turn (a truncated or hand-edited log) form a synthetic turn so
 * their content is not silently lost. Configuration, title, and request
 * events are collected separately because they are re-emitted in fixed
 * positions after compaction.
 * @param {ReadonlyArray<object>} events - source events.
 * @returns {{groups: Array<object>, configs: Array<object>, titles: Array<object>,
 *   requestHeader?: object, requestContext?: object}} grouped source pieces.
 */
function groupSource(events) {
  const groups = [];
  const configs = [];
  const titles = [];
  let requestHeader;
  let requestContext;
  let current;
  for (const [index, event] of events.entries()) {
    if (!isRecord(event) || typeof event.type !== 'string') continue;
    const type = event.type;
    if (CONFIG_EVENT_TYPES.has(type)) {
      configs.push(event);
      continue;
    }
    if (type === TITLE_EVENT) {
      titles.push(event);
      continue;
    }
    if (type === REQUEST_HEADER) {
      requestHeader ??= event;
      continue;
    }
    if (type === REQUEST_CONTEXT) {
      requestContext ??= event;
      continue;
    }
    if (type === TURN_START) {
      current = { start: event, events: [], index };
      groups.push(current);
      continue;
    }
    if (type === TURN_END) {
      if (current !== undefined && current.start !== undefined) current.end = event;
      current = undefined;
      continue;
    }
    if (type === USER_EVENT || type === ASSISTANT_EVENT) {
      if (current === undefined) {
        current = { events: [], index };
        groups.push(current);
      }
      current.events.push({ event, index });
    }
  }
  return {
    groups,
    configs,
    titles,
    ...(requestHeader === undefined ? {} : { requestHeader }),
    ...(requestContext === undefined ? {} : { requestContext }),
  };
}

/**
 * Turn numbers for the compacted log.
 *
 * The v4 relationship validator requires turn numbers to be exactly 1..N, so
 * the source numbering is kept only when it already forms that sequence;
 * otherwise the turns are renumbered sequentially (still in source order).
 * @param {ReadonlyArray<object>} groups - grouped turns.
 * @returns {number[]} one turn number per group.
 */
function planTurnNumbers(groups) {
  const sourceNumbers = groups.map((group) => {
    const turn = group.start?.data?.turn;
    return Number.isSafeInteger(turn) && turn >= 1 ? turn : undefined;
  });
  const contiguous = sourceNumbers.every((turn, index) => turn === index + 1);
  return contiguous ? sourceNumbers : groups.map((_, index) => index + 1);
}

/**
 * The turn's final visible assistant message, or undefined.
 * @param {ReadonlyArray<{event: object, index: number}>} entries - one turn's message entries.
 * @returns {{event: object, index: number, content: Array<object>} | undefined} the reply.
 */
function finalAssistantMessage(entries) {
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position];
    if (entry.event.type !== ASSISTANT_EVENT || !isRecord(entry.event.data)) continue;
    const message = entry.event.data.message;
    if (!isRecord(message) || typeof message.id !== 'string' || message.id === '') continue;
    const source = message.source;
    if (!isRecord(source) || source.kind !== 'model'
      || typeof source.provider !== 'string' || source.provider === ''
      || typeof source.model !== 'string' || source.model === '') continue;
    const content = visibleContent(message.content);
    if (content.length === 0) continue;
    return { event: entry.event, index: entry.index, content };
  }
  return undefined;
}

/**
 * The turn's human user messages with visible content, in source order.
 * @param {ReadonlyArray<{event: object, index: number}>} entries - one turn's message entries.
 * @returns {Array<{event: object, index: number, content: Array<object>, sourceSeq: number}>} prompts.
 */
function humanUserMessages(entries) {
  const messages = [];
  for (const entry of entries) {
    const event = entry.event;
    if (event.type !== USER_EVENT || !isRecord(event.data)) continue;
    const source = event.data.source;
    if (!isRecord(source) || source.kind !== 'user') continue;
    if (typeof event.data.id !== 'string' || event.data.id === '') continue;
    const content = visibleContent(event.data.content);
    if (content.length === 0) continue;
    messages.push({ event, index: entry.index, content, sourceSeq: sourceSeqOf(event, entry.index) });
  }
  return messages;
}

/**
 * Build one compact, standalone, importable v4 log from a full session log.
 *
 * The header is rebuilt as an unseeded standalone header: version, id,
 * createdAt, optional cwd and agentPreset are kept while parentSession,
 * origin, and delegationDepth are dropped, because the compact archive is a
 * new root conversation. isSeeded is forced to false: the inherited end-seed
 * marker is dropped, and a seeded header without that marker is exactly what
 * the v4 reader refuses.
 *
 * The output events are freshly allocated (the input is never mutated) and
 * renumbered seq 0..N-1.
 * @param {{header: object, events: ReadonlyArray<object>}} log - one full session log.
 * @returns {{header: object, events: Array<object>}} the compact log.
 * @throws {TypeError} when the input is not a session log.
 */
export function compactSession({ header, events } = {}) {
  if (!isRecord(header) || typeof header.id !== 'string' || header.id === '') {
    throw new TypeError('compactSession 需要带 id 的会话头对象');
  }
  if (!Array.isArray(events)) throw new TypeError('compactSession 需要事件数组');
  const { groups, configs, titles, requestHeader, requestContext } = groupSource(events);
  const turnNumbers = planTurnNumbers(groups);
  /** @type {Array<object>} */
  const out = [];
  let lastTime = Number.isSafeInteger(header.createdAt) && header.createdAt >= 0 ? header.createdAt : 0;
  /** Clamp one source timestamp to the envelope's integer time. */
  function at(value) {
    if (Number.isSafeInteger(value) && value >= 0) lastTime = value;
    return lastTime;
  }
  /** Append one event object (seq assigned after ordering). */
  function emit(type, time, data, extra) {
    const event = { type, time: at(time), data };
    if (extra !== undefined) Object.assign(event, extra);
    out.push(event);
    return event;
  }

  // 1. Session-level configuration, in source order.
  for (const event of configs) emit(event.type, event.time, detach(isRecord(event.data) ? event.data : {}));
  const preludeEnd = out.length;

  // 2. Turns. User seqs are recorded so a title can cite them.
  const keptUsers = [];
  const groupEndIndexes = [];
  const requestHostIndex = groups.length > 0 ? 0 : -1;
  for (const [position, group] of groups.entries()) {
    const turn = turnNumbers[position];
    const startTime = group.start?.time;
    emit(TURN_START, startTime, { turn });
    emit(STEP_START, startTime, { turn, step: 1 });
    for (const user of humanUserMessages(group.events)) {
      const data = { ...detach(user.event.data), role: 'user', content: user.content };
      const emitted = emit(USER_EVENT, user.event.time, data, { surfaceOp: 'append' });
      keptUsers.push({ event: emitted, groupIndex: position, sourceSeq: user.sourceSeq });
    }
    if (position === requestHostIndex) {
      if (requestHeader !== undefined) emit(REQUEST_HEADER, requestHeader.time, detach(isRecord(requestHeader.data) ? requestHeader.data : {}));
      if (requestContext !== undefined) emit(REQUEST_CONTEXT, requestContext.time, detach(isRecord(requestContext.data) ? requestContext.data : {}));
    }
    const assistant = finalAssistantMessage(group.events);
    if (assistant !== undefined) {
      emit(ASSISTANT_EVENT, assistant.event.time, {
        turn,
        step: 1,
        message: { ...detach(assistant.event.data.message), content: assistant.content },
        stream: [],
      }, { surfaceOp: 'append' });
    }
    const closed = group.start !== undefined && group.end !== undefined;
    const reason = closed && group.end?.data?.reason?.kind === 'completed' ? 'completed' : 'interrupted';
    const endTime = closed ? group.end.time : (group.events.at(-1)?.event.time ?? startTime);
    emit(STEP_END, endTime, { turn, step: 1 });
    emit(TURN_END, endTime, { turn, reason: { kind: reason } });
    groupEndIndexes.push(out.length - 1);
  }

  // 3. At most one session/title.
  //
  // The v4 relationship validator (session-format-v3-to-v4/src/relationships.ts:
  // 349-364) requires messageSeqs to be non-empty exactly when the title is not
  // a user rename, and every cited seq must name an EARLIER user/message whose
  // source.kind is "user". Renumbering therefore cannot copy the source seqs:
  // they are mapped through the kept user messages, and the title is placed
  // behind the last turn that holds a citation. A user rename cites nothing and
  // stays in the prelude; a title whose citations were all dropped falls back
  // to the first kept human prompt, and is dropped when no human prompt exists.
  const titleEvent = titles.at(-1);
  const sourceKind = titleEvent?.data?.source?.kind;
  if (titleEvent !== undefined && isRecord(titleEvent.data)
    && typeof titleEvent.data.title === 'string' && titleEvent.data.title.trim() !== ''
    && typeof sourceKind === 'string' && sourceKind !== '' && sourceKind !== 'plugin') {
    const titleData = detach(titleEvent.data);
    const requested = Array.isArray(titleData.messageSeqs) ? titleData.messageSeqs : [];
    if (sourceKind === 'user' && requested.length === 0) {
      // A user rename legitimately cites nothing: keep the attribution as-is.
      titleData.messageSeqs = [];
      out.splice(preludeEnd, 0, { type: TITLE_EVENT, time: at(titleEvent.time), data: titleData });
    } else {
      // A generated title, or a user title whose source illegally carried
      // citations: rewrite (or promote to fallback) so the payload conforms.
      const cited = [];
      const seen = new Set();
      for (const seq of requested) {
        const kept = keptUsers.find((user) => user.sourceSeq === seq);
        if (kept === undefined || seen.has(kept)) continue;
        seen.add(kept);
        cited.push(kept);
      }
      if (cited.length === 0 && keptUsers.length > 0) cited.push(keptUsers[0]);
      if (cited.length > 0) {
        if (sourceKind === 'user') titleData.source = { kind: 'fallback' };
        titleData.messageSeqs = [];
        // Behind the LAST cited turn, so every cited seq precedes the title even
        // when the source messageSeqs are not in log order.
        const lastCitedGroup = Math.max(...cited.map((user) => user.groupIndex));
        const insertionIndex = groupEndIndexes[lastCitedGroup] + 1;
        out.splice(insertionIndex, 0, { type: TITLE_EVENT, time: at(titleEvent.time), data: titleData });
        const finalIndex = new Map(out.map((event, index) => [event, index]));
        titleData.messageSeqs = cited
          .map((user) => finalIndex.get(user.event))
          .filter((seq) => Number.isSafeInteger(seq))
          .sort((left, right) => left - right);
      }
      // No human prompt to cite: the title is dropped rather than emitted with
      // an invalid empty citation list.
    }
  }

  // 4. Dense seq from 0 after every insertion settled.
  for (const [index, event] of out.entries()) event.seq = index;

  return {
    header: {
      version: Number.isSafeInteger(header.version) ? header.version : 4,
      id: header.id,
      createdAt: Number.isSafeInteger(header.createdAt) && header.createdAt >= 0 ? header.createdAt : 0,
      ...(typeof header.cwd === 'string' && header.cwd !== '' ? { cwd: header.cwd } : {}),
      isSeeded: false,
      ...(typeof header.agentPreset === 'string' && header.agentPreset !== '' ? { agentPreset: header.agentPreset } : {}),
    },
    events: out,
  };
}
