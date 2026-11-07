/**
 * dsh-session-kit -- DeepSeek share-link import.
 *
 * Integrates the standalone deepseek-share-to-dsh-session skill into the plugin:
 * parse a public share link or id, fetch its public content (no auth), normalize
 * the fragments into plain messages, build a canonical v4 session log, and hand
 * that JSONL to the existing archive importer so the new conversation lands in
 * the chosen workspace like any other imported session.
 *
 * Only chat.deepseek.com share links/ids are accepted; the Host never fetches an
 * arbitrary URL from the client.
 *
 * @module dsh-session-kit/deepseek-share
 */

import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { errorText } from './attachments.js';
import { SessionPortFormatError, serializeSessionLog, validateEvents } from './format.js';

/** Public share-content endpoint (no authentication). */
const SHARE_API = 'https://chat.deepseek.com/api/v0/share/content';

/** Canonical share page for one id. */
const SHARE_PAGE = 'https://chat.deepseek.com/share/';

/** Bare share id grammar. */
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

/** Default network timeout for one share fetch. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Default response byte cap for one share fetch. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Defaults for the v4 conversation build (mirroring the share skill). */
const BUILD_DEFAULTS = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  historyModel: 'deepseek-chat',
  reasoningEffort: 'high',
  agentPreset: 'standard',
  permissionPreset: 'workspace-write',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'ask',
  includeReasoning: true,
  title: '导入的 DeepSeek 分享对话',
});

/** Resolve one optional composed service without throwing on a missing context. */
function serviceOf(ctx, name) {
  return ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
}

/** Join the non-empty fragment contents of one type. */
function fragmentText(message, type) {
  const fragments = Array.isArray(message?.fragments) ? message.fragments : [];
  return fragments
    .filter((fragment) => fragment?.type === type && typeof fragment.content === 'string' && fragment.content.trim() !== '')
    .map((fragment) => fragment.content)
    .join('\n\n');
}

/**
 * Parse a share link or bare id.
 *
 * Accepts only https://chat.deepseek.com/share/<id> (query/fragment allowed) and
 * a bare [A-Za-z0-9_-]+ id. Every other URL, domain, or malformed id is refused
 * so the Host never fetches an arbitrary address.
 * @param {unknown} input - user-supplied link or id.
 * @returns {{shareId: string, url: string}} canonical identity.
 * @throws {SessionPortFormatError} code 'invalid-share'.
 */
export function parseShareInput(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') throw new SessionPortFormatError('invalid-share', '请输入 DeepSeek 分享链接或分享 id');
  if (SHARE_ID_PATTERN.test(raw)) {
    return { shareId: raw, url: SHARE_PAGE + raw };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SessionPortFormatError('invalid-share', '无法识别的分享链接：' + raw);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'chat.deepseek.com') {
    throw new SessionPortFormatError('invalid-share', '只接受 https://chat.deepseek.com/share/<id> 形式的分享链接');
  }
  const match = /^\/share\/([A-Za-z0-9_-]+)\/?$/u.exec(parsed.pathname);
  if (match === null || !SHARE_ID_PATTERN.test(match[1])) {
    throw new SessionPortFormatError('invalid-share', '分享链接缺少有效的分享 id：' + raw);
  }
  return { shareId: match[1], url: SHARE_PAGE + match[1] };
}

/** Resolve one positive integer option. */
function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SessionPortFormatError('invalid-argument', label + ' 必须是正整数');
  }
  return value;
}

/** Run one fetch with a hard timeout and an optional caller signal. */
async function fetchWithTimeout(fetchImpl, url, timeoutMs, externalSignal) {
  const controller = new AbortController();
  const forwardAbort = () => {
    try {
      controller.abort();
    } catch {
      // Aborting an already-settled request is a no-op.
    }
  };
  if (externalSignal !== undefined && externalSignal !== null) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new SessionPortFormatError('share-fetch', '抓取分享内容超时（' + timeoutMs + 'ms）');
      try {
        controller.abort();
      } catch {
        // Abort is best-effort; the timeout rejection below still settles the race.
      }
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', forwardAbort);
  }
}

/** Read a bounded response body as bytes. */
async function readBoundedBody(response, maxBytes) {
  const declared = typeof response?.headers?.get === 'function'
    ? Number(response.headers.get('content-length'))
    : NaN;
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    throw new SessionPortFormatError('share-fetch', '分享内容超过大小上限（' + declared + ' > ' + maxBytes + ' 字节）');
  }
  let bytes;
  if (typeof response?.arrayBuffer === 'function') {
    bytes = Buffer.from(await response.arrayBuffer());
  } else if (typeof response?.text === 'function') {
    bytes = Buffer.from(await response.text(), 'utf8');
  } else {
    throw new SessionPortFormatError('share-fetch', '分享接口返回了无法读取的响应');
  }
  if (bytes.byteLength > maxBytes) {
    throw new SessionPortFormatError('share-fetch', '分享内容超过大小上限（' + bytes.byteLength + ' > ' + maxBytes + ' 字节）');
  }
  return bytes;
}

/**
 * Fetch and normalize one public DeepSeek share conversation.
 *
 * GETs the public share-content API (no authentication), enforces a request
 * timeout and a response byte cap, and normalizes every fragment type into the
 * flat message shape the session builder consumes. A non-zero API code is a
 * 'share-api' failure; transport, HTTP, size, and JSON failures are
 * 'share-fetch'.
 * @param {string} shareId - parsed share id.
 * @param {{fetchImpl?: Function, timeoutMs?: number, maxBytes?: number}} [options] - fetch injection and limits.
 * @returns {Promise<{shareId: string, title: string | null, modelType: string | null, messages: Array<object>}>} normalized share.
 * @throws {SessionPortFormatError} code 'invalid-share' | 'invalid-argument' | 'share-fetch' | 'share-api'.
 */
export async function fetchShare(shareId, options = {}) {
  if (typeof shareId !== 'string' || !SHARE_ID_PATTERN.test(shareId)) {
    throw new SessionPortFormatError('invalid-share', '无效的分享 id：' + String(shareId));
  }
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new SessionPortFormatError('share-fetch', '当前环境没有可用的 fetch，无法抓取分享内容');
  }
  const url = SHARE_API + '?share_id=' + encodeURIComponent(shareId);
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, timeoutMs, options.signal);
  } catch (error) {
    if (error instanceof SessionPortFormatError) throw error;
    throw new SessionPortFormatError('share-fetch', '抓取分享内容失败：' + errorText(error));
  }
  if (response === null || typeof response !== 'object' || response.ok !== true) {
    const status = response !== null && typeof response === 'object' ? response.status : undefined;
    throw new SessionPortFormatError('share-fetch', '分享接口返回 HTTP ' + String(status ?? '错误'));
  }
  let bytes;
  try {
    bytes = await readBoundedBody(response, maxBytes);
  } catch (error) {
    if (error instanceof SessionPortFormatError) throw error;
    throw new SessionPortFormatError('share-fetch', '读取分享内容失败：' + errorText(error));
  }
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new SessionPortFormatError('share-fetch', '分享接口返回的不是合法 JSON：' + errorText(error));
  }
  if (payload === null || typeof payload !== 'object') {
    throw new SessionPortFormatError('share-fetch', '分享接口返回了无法识别的载荷');
  }
  if (payload.code !== 0) {
    throw new SessionPortFormatError(
      'share-api',
      '分享接口返回错误 code=' + String(payload.code) + (typeof payload.msg === 'string' && payload.msg !== '' ? '（' + payload.msg + '）' : ''),
    );
  }
  const biz = payload.data !== null && typeof payload.data === 'object' && payload.data.biz_data !== null && typeof payload.data.biz_data === 'object'
    ? payload.data.biz_data
    : {};
  const rawMessages = Array.isArray(biz.messages) ? biz.messages : [];
  const fragmentById = new Map();
  for (const message of rawMessages) {
    for (const fragment of Array.isArray(message?.fragments) ? message.fragments : []) {
      if (fragment?.id !== undefined) fragmentById.set(fragment.id, fragment);
    }
  }
  const messages = rawMessages.map((message, index) => {
    const role = String(message?.role ?? '').toLowerCase() === 'user' ? 'user' : 'assistant';
    const content = role === 'user' ? fragmentText(message, 'REQUEST') : fragmentText(message, 'RESPONSE');
    const reasoning = fragmentText(message, 'THINK');
    const fragments = Array.isArray(message?.fragments) ? message.fragments : [];
    const searches = fragments
      .filter((fragment) => fragment?.type === 'TOOL_SEARCH')
      .map((fragment) => ({
        content: typeof fragment.content === 'string' ? fragment.content : '',
        queries: (Array.isArray(fragment.queries) ? fragment.queries : []).map((query) => (typeof query === 'string' ? query : query?.query ?? '')),
        results: (Array.isArray(fragment.results) ? fragment.results : []).map((result) => ({
          url: result?.url ?? null,
          title: result?.title ?? null,
          snippet: result?.snippet ?? null,
          site_name: result?.site_name ?? null,
          published_at: result?.published_at ?? null,
        })),
      }));
    const sources = fragments
      .filter((fragment) => fragment?.type === 'TOOL_OPEN' && fragment.result !== null && typeof fragment.result === 'object')
      .map((fragment) => ({
        fragment_id: fragment.id ?? null,
        url: fragment.result.url ?? null,
        title: fragment.result.title ?? null,
        snippet: fragment.result.snippet ?? null,
        site_name: fragment.result.site_name ?? null,
        published_at: fragment.result.published_at ?? null,
      }));
    const citationMap = [];
    for (const fragment of fragments.filter((entry) => entry?.type === 'RESPONSE')) {
      const references = Array.isArray(fragment.references) ? fragment.references : [];
      for (const [position, reference] of references.entries()) {
        const source = reference?.id !== undefined ? fragmentById.get(reference.id) : undefined;
        const result = source !== null && typeof source === 'object' && source.result !== null && typeof source.result === 'object'
          ? source.result
          : null;
        citationMap[position] = {
          marker: '[reference:' + position + ']',
          ref_type: reference?.type ?? null,
          fragment_id: reference?.id ?? null,
          url: result?.url ?? null,
          title: result?.title ?? null,
          snippet: result?.snippet ?? null,
        };
      }
    }
    return {
      index,
      role,
      content,
      reasoning: reasoning === '' ? null : reasoning,
      timestamp: typeof message?.inserted_at === 'number' ? message.inserted_at : null,
      citation_map: citationMap,
      searches,
      sources,
    };
  });
  return {
    shareId,
    title: typeof biz.title === 'string' && biz.title.trim() !== '' ? biz.title.trim() : null,
    modelType: typeof biz.model_type === 'string' ? biz.model_type : null,
    messages,
  };
}

/** Resolve [reference:N] markers to markdown links using the citation map. */
function resolveCitations(text, citationMap) {
  if (typeof text !== 'string' || !Array.isArray(citationMap) || citationMap.length === 0) return text;
  const byMarker = new Map();
  for (const entry of citationMap) {
    if (entry !== null && typeof entry === 'object' && typeof entry.marker === 'string' && typeof entry.url === 'string') {
      byMarker.set(entry.marker, entry.url);
    }
  }
  return text.replace(/\[reference:(\d+)\]/gu, (whole, number) => {
    const url = byMarker.get('[reference:' + number + ']');
    return url === undefined ? whole : '[[' + number + ']](' + url + ')';
  });
}

/**
 * Build one canonical v4 session log from normalized share messages.
 *
 * The skeleton mirrors the share skill: session config headers, one turn per
 * human message with a closed step, user messages with surfaceOp 'append', an
 * assistant message whose only blocks are optional reasoning plus text, the
 * first request header/context, and a session title citing the first user
 * message. No system message is written by default; DSH injects the current
 * prompt on the next request.
 * @param {ReadonlyArray<object>} messages - normalized messages from fetchShare.
 * @param {object} options - build options.
 * @param {string} [options.cwd] - absolute working directory for the session header.
 * @param {string} [options.title] - explicit title.
 * @param {string} [options.provider] - model provider.
 * @param {string} [options.model] - model the session continues with.
 * @param {string} [options.historyModel] - model attributed to the imported replies.
 * @param {string} [options.reasoningEffort] - reasoning effort for the next request.
 * @param {string} [options.agentPreset] - agent preset id.
 * @param {string} [options.permissionPreset] - permission preset.
 * @param {string} [options.sandboxMode] - sandbox mode.
 * @param {string} [options.approvalPolicy] - approval policy.
 * @param {boolean} [options.includeReasoning] - keep reasoning blocks (default true).
 * @returns {{header: object, events: Array<object>, jsonl: string, title: string, turns: number}} built session.
 * @throws {SessionPortFormatError} code 'invalid-argument' | 'invalid-event'.
 */
export function buildShareSession(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new SessionPortFormatError('invalid-argument', '分享内容没有可导入的消息');
  }
  const cwd = options.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '' || !isAbsolute(cwd.trim()))) {
    throw new SessionPortFormatError('invalid-argument', 'cwd 必须是绝对路径');
  }
  const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : BUILD_DEFAULTS.provider;
  const nextModel = typeof options.model === 'string' && options.model !== '' ? options.model : BUILD_DEFAULTS.model;
  const historyModel = typeof options.historyModel === 'string' && options.historyModel !== '' ? options.historyModel : BUILD_DEFAULTS.historyModel;
  const reasoningEffort = typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '' ? options.reasoningEffort : BUILD_DEFAULTS.reasoningEffort;
  const agentPreset = typeof options.agentPreset === 'string' && options.agentPreset !== '' ? options.agentPreset : BUILD_DEFAULTS.agentPreset;
  const permissionPreset = typeof options.permissionPreset === 'string' && options.permissionPreset !== '' ? options.permissionPreset : BUILD_DEFAULTS.permissionPreset;
  const sandboxMode = typeof options.sandboxMode === 'string' && options.sandboxMode !== '' ? options.sandboxMode : BUILD_DEFAULTS.sandboxMode;
  const approvalPolicy = typeof options.approvalPolicy === 'string' && options.approvalPolicy !== '' ? options.approvalPolicy : BUILD_DEFAULTS.approvalPolicy;
  const includeReasoning = options.includeReasoning !== false;

  const firstTimestamp = Number(messages[0]?.timestamp);
  const createdAt = Number.isFinite(firstTimestamp) && firstTimestamp > 0
    ? Math.round(firstTimestamp * 1000)
    : Date.now();
  const sessionId = 'session-' + randomUUID();
  const header = {
    version: 4,
    id: sessionId,
    createdAt,
    ...(cwd === undefined ? {} : { cwd }),
    isSeeded: false,
    delegationDepth: 0,
    agentPreset,
  };

  const events = [];
  let lastTime = createdAt - 1;
  const at = (milliseconds) => {
    const value = Number.isFinite(milliseconds) ? Math.round(milliseconds) : lastTime + 1;
    lastTime = Math.max(lastTime + 1, value);
    return lastTime;
  };
  const push = (type, data, extra) => {
    const event = { type, seq: events.length, time: lastTime, data };
    if (extra !== undefined) Object.assign(event, extra);
    events.push(event);
    return event;
  };

  const pushConfig = () => {
    at(createdAt);
    push('permission/preset', { preset: permissionPreset });
    push('sandbox/mode', { mode: sandboxMode });
    push('approval/policy', { policy: approvalPolicy });
    push('model/selection', { provider, model: nextModel, reasoningEffort });
  };
  pushConfig();

  // Pair each human message with the assistant reply that follows it.
  const turns = [];
  let pendingUser;
  for (const message of messages) {
    const role = String(message?.role ?? '').toLowerCase();
    if (role === 'user') {
      if (pendingUser !== undefined) turns.push({ user: pendingUser, assistant: undefined });
      pendingUser = message;
    } else if (role === 'assistant') {
      turns.push({ user: pendingUser, assistant: message });
      pendingUser = undefined;
    }
  }
  if (pendingUser !== undefined) turns.push({ user: pendingUser, assistant: undefined });

  const firstUserText = String(turns[0]?.user?.content ?? '').replace(/\s+/gu, ' ').trim();
  const title = typeof options.title === 'string' && options.title.trim() !== ''
    ? options.title.trim()
    : firstUserText !== ''
      ? firstUserText.slice(0, 24)
      : BUILD_DEFAULTS.title;

  for (const [index, turn] of turns.entries()) {
    const turnNumber = index + 1;
    const userTime = Number(turn.user?.timestamp) * 1000;
    const assistantTime = Number(turn.assistant?.timestamp) * 1000;
    at(userTime);
    push('turn/start', { turn: turnNumber });
    push('step/start', { turn: turnNumber, step: 1 });
    if (turn.user !== undefined) {
      push('user/message', {
        content: [{ type: 'text', text: resolveCitations(String(turn.user.content ?? ''), turn.user.citation_map) }],
        source: { kind: 'user', rpcId: randomUUID() },
        role: 'user',
        id: randomUUID(),
      }, { surfaceOp: 'append' });
    }
    if (turnNumber === 1) {
      push('request/header', {
        header: {
          config: {
            provider,
            model: nextModel,
            reasoningEffort,
            maxTokens: 256000,
          },
          adapterDefaults: { maxTokens: true },
        },
        reason: 'initial',
      });
      push('request/context', {
        provider,
        model: nextModel,
        contextWindow: 1000000,
        systemPromptUpdate: 'in-history',
      });
      const firstUserSeq = events.find((event) => event.type === 'user/message')?.seq;
      if (firstUserSeq !== undefined) {
        push('session/title', {
          title,
          messageSeqs: [firstUserSeq],
          source: { kind: 'fallback' },
        });
      }
    }
    if (turn.assistant !== undefined) {
      const blocks = [];
      const reasoning = includeReasoning ? String(turn.assistant.reasoning ?? '') : '';
      if (reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning });
      blocks.push({ type: 'text', text: resolveCitations(String(turn.assistant.content ?? ''), turn.assistant.citation_map) });
      at(assistantTime);
      push('assistant/message', {
        turn: turnNumber,
        step: 1,
        message: {
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider, model: historyModel },
          id: randomUUID(),
        },
        stream: [],
      }, { surfaceOp: 'append' });
    }
    push('step/end', { turn: turnNumber, step: 1 });
    push('turn/end', { turn: turnNumber, reason: { kind: 'completed' } });
  }

  try {
    validateEvents(events);
  } catch (error) {
    throw new SessionPortFormatError('invalid-event', '生成的会话日志未通过事件校验：' + errorText(error));
  }
  return {
    header,
    events,
    jsonl: serializeSessionLog(header, events),
    title,
    turns: turns.length,
  };
}

/** Resolve the workspace path a requested workspaceId names, when possible. */
async function workspacePathOf(ctx, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') return undefined;
  const registry = serviceOf(ctx, 'workspaceRegistry');
  if (registry === null || registry === undefined || typeof registry.get !== 'function') return undefined;
  const workspace = registry.get(workspaceId.trim());
  if (workspace === null || workspace === undefined) {
    throw new SessionPortFormatError('workspace-not-found', '找不到工作区：' + workspaceId);
  }
  return typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : undefined;
}

/**
 * Import one DeepSeek share link as a new DSH session.
 *
 * The share is parsed, fetched, converted into a canonical v4 JSONL, and handed
 * to the existing archive importer as a bare JSONL buffer, so the created
 * session gets the same validation, id minting, workspace attachment, and
 * read-back verification as any other import. The chosen workspace path becomes
 * the session cwd; without one the importer resolves the deployment default.
 * @param {object} ctx - the plugin context.
 * @param {{input: string, cwd?: string, workspaceId?: string, title?: string, signal?: AbortSignal}} options - share input and target.
 * @param {{fetchImpl?: Function, importArchiveImpl?: Function}} [deps] - fetch/import injection for tests.
 * @returns {Promise<{sessionId: string, title: string, eventCount: number, workspaceId?: string, warnings: string[]}>} imported session facts.
 * @throws {SessionPortFormatError} code 'invalid-share' | 'share-fetch' | 'share-api' | 'workspace-not-found' | 'invalid-argument' plus importer failures.
 */
export async function importShare(ctx, options, deps = {}) {
  const input = options?.input;
  const parsed = parseShareInput(input);
  const workspaceId = typeof options?.workspaceId === 'string' && options.workspaceId.trim() !== ''
    ? options.workspaceId.trim()
    : undefined;
  // Resolve the target workspace before any network call, so a known-bad id
  // fails fast without fetching the share.
  const workspacePath = await workspacePathOf(ctx, workspaceId);
  const fetched = await fetchShare(parsed.shareId, { fetchImpl: deps?.fetchImpl, signal: options?.signal });
  const requestedCwd = typeof options?.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd.trim() : undefined;
  const buildCwd = requestedCwd !== undefined && isAbsolute(requestedCwd)
    ? requestedCwd
    : workspacePath;
  const built = buildShareSession(fetched.messages, {
    ...(buildCwd === undefined ? {} : { cwd: buildCwd }),
    ...(typeof options?.title === 'string' && options.title.trim() !== '' ? { title: options.title } : {}),
  });
  const importArchive = typeof deps?.importArchiveImpl === 'function'
    ? deps.importArchiveImpl
    : (await import('./import.js')).importArchive;
  const result = await importArchive(ctx, {
    buffer: Buffer.from(built.jsonl, 'utf8'),
    ...(buildCwd === undefined ? {} : { cwd: buildCwd }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  const imported = Array.isArray(result?.sessions) ? result.sessions[0] : undefined;
  if (imported === undefined || typeof imported.sessionId !== 'string' || imported.sessionId === '') {
    throw new SessionPortFormatError('import-failed', '分享内容导入后没有返回新的会话 id');
  }
  const warnings = [
    ...(Array.isArray(result?.warnings) ? result.warnings.map(String) : []),
    ...(Array.isArray(imported.warnings) ? imported.warnings.map(String) : []),
  ];
  const attached = workspaceId !== undefined && !warnings.some((warning) => warning.includes('没能加入工作区'));
  return {
    sessionId: imported.sessionId,
    title: typeof imported.title === 'string' && imported.title !== '' ? imported.title : built.title,
    eventCount: Number.isSafeInteger(imported.eventCount) ? imported.eventCount : built.events.length,
    ...(attached ? { workspaceId } : {}),
    warnings,
  };
}
