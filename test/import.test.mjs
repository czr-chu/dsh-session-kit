/**
 * Unit tests for lib/import.js.
 *
 * Most cases use the documented `deps` helper seam with a mocked persistence
 * handle, so they need no DSH process. The last case (guarded) imports into the
 * repository's real JSONL persistence backend when it is runnable; under plain
 * `node --test` it skips.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildArchive } from '../lib/export.js';
import { parseSessionLog, serializeSessionLog } from '../lib/format.js';
import { importArchive, readImportFile } from '../lib/import.js';
import { readZipEntries, writeZipEntries } from '../lib/zip.js';

const IMAGE_ID = 'img-old';
const FILE_DIGEST = 'a'.repeat(64);
const FILE_ID = 'sha256:' + FILE_DIGEST;
const NEW_IMAGE_ID = 'img-new';
const NEW_FILE_DIGEST = 'b'.repeat(64);
const NEW_FILE_ID = 'sha256:' + NEW_FILE_DIGEST;
const SOURCE_ID = 'src-1';

/** sha256 hex of a Buffer. */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Canonical header of one synthesized source session. */
function makeHeader(id = SOURCE_ID, version = 4) {
  return {
    version,
    id,
    createdAt: 1000,
    cwd: '/source/ws',
    isSeeded: false,
    delegationDepth: 0,
  };
}

/** Source events exercising delivery/seed rewrites plus image and file refs. */
function makeSourceEvents(id = SOURCE_ID) {
  return [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 11,
      surfaceOp: 'append',
      data: {
        id: 'msg-1',
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'image',
            attachment: { attachmentId: IMAGE_ID, mediaType: 'image/png', bytes: 3, width: 2, height: 2 },
          },
          {
            type: 'file',
            attachment: { attachmentId: FILE_ID, name: 'a.txt', bytes: 3 },
          },
        ],
        source: { kind: 'user' },
      },
    },
    { type: 'session/end-seed', seq: 2, time: 12, data: { inherited: true } },
    {
      type: 'session-log-deepseek/delivery-accepted',
      seq: 3,
      time: 13,
      data: { sessionId: id, sessionFormatVersion: 4, throughSeq: 1 },
    },
    {
      type: 'session/title',
      seq: 4,
      time: 14,
      data: { title: '旧标题', messageSeqs: [], source: { kind: 'user' } },
    },
    { type: 'turn/end', seq: 5, time: 15, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

/** Mock attachment service used as the export source (reads bytes). */
function makeSourceAttachments() {
  return {
    imageHostPath: () => undefined,
    fileHostPath: () => undefined,
    async readImage() {
      return { data: new Uint8Array([1, 2, 3]) };
    },
    async *readFileStream() {
      yield new Uint8Array([4, 5, 6]);
    },
  };
}

/** Mock attachment store used by import (writes bytes back). */
function makeRestoreAttachments() {
  const saved = [];
  return {
    saved,
    async saveImages(inputs) {
      saved.push(['image', inputs.length]);
      return inputs.map((input) => ({
        attachmentId: NEW_IMAGE_ID,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 2,
        height: 2,
      }));
    },
    async saveFile(input) {
      saved.push(['file', input.name]);
      return { attachmentId: NEW_FILE_ID, name: input.name, bytes: input.data.byteLength };
    },
  };
}

/** Mock persistence that records one created session per id. */
function makePersistence() {
  const sessions = new Map();
  return {
    sessions,
    async create(header) {
      if (sessions.has(header.id)) throw new Error('session already exists');
      sessions.set(header.id, { header: structuredClone(header), events: [], flushed: false, closed: false });
      return {
        id: header.id,
        header,
        async append(events) {
          sessions.get(header.id).events.push(...structuredClone(events));
        },
        async flush() {
          sessions.get(header.id).flushed = true;
        },
        async close() {
          sessions.get(header.id).closed = true;
        },
      };
    },
  };
}

/**
 * Build the helper-module override import.js consumes.
 * @param {object} options - persistence, attachments, verify hook and flags.
 * @returns {object} helper module mock.
 */
function makeImportDeps({ persistence, attachments, verifyFails = false, writes, workspaceFiles } = {}) {
  const calls = writes ?? { written: [] };
  const deps = {
    calls,
    async detectFormatVersion() {
      return 4;
    },
    async resolveTargetDirectory(ctx, { requestedCwd, sourceCwd }) {
      calls.targetArgs = { requestedCwd, sourceCwd };
      return requestedCwd ?? sourceCwd ?? '/fallback';
    },
    async mintSessionId() {
      const id = `session-${randomUUID()}`;
      calls.minted = [...(calls.minted ?? []), id];
      return id;
    },
    async attachToWorkspace() {
      calls.attached = true;
      return {};
    },
    async writeNewSession(targetPersistence, header, events) {
      calls.written.push({ id: header.id, header, events, persistence: targetPersistence });
      calls.writeOrder = [...(calls.writeOrder ?? []), header.id];
      return { id: header.id };
    },
    foldTitle(events) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type === 'session/title' && typeof event.data?.title === 'string') {
          return event.data.title;
        }
      }
      return undefined;
    },
    servicesOf() {
      return {
        sessionPersistence: persistence,
        attachments,
        sessionQuery: {
          async readSession(id) {
            if (verifyFails) throw new Error('replay validation failed');
            return { session: { id }, events: [] };
          },
        },
      };
    },
    ...(workspaceFiles !== undefined ? { workspaceFiles } : {}),
  };
  return deps;
}

/** Build one plugin-shaped archive through the real exporter + mock source docs. */
async function buildPluginZip({ mode = 'full', events = makeSourceEvents(), includeAttachments = true, compactSession } = {}) {
  const header = makeHeader();
  const exportDeps = {
    async detectFormatVersion() {
      return 4;
    },
    async readSessionDoc() {
      return { header, events, inheritedEventCount: 0 };
    },
    async listSessionEntries() {
      return [{ id: SOURCE_ID, title: '清单标题', cwd: '/source/ws', createdAt: 1000, updatedAt: 1000, formatVersion: 4, eventCount: events.length }];
    },
    servicesOf() {
      return { attachments: makeSourceAttachments() };
    },
    foldTitle(eventsIn) {
      for (let index = eventsIn.length - 1; index >= 0; index -= 1) {
        const event = eventsIn[index];
        if (event.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title;
      }
      return undefined;
    },
    ...(compactSession !== undefined ? { compactSession } : {}),
  };
  return buildArchive({}, { sessionIds: [SOURCE_ID], mode, includeAttachments, deps: exportDeps, now: 1730000000000 });
}

/** Build a ZIP from `[name, Buffer|string]` pairs. */
function zipOf(pairs) {
  return writeZipEntries(pairs.map(([name, value]) => ({
    name,
    data: Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'),
  })));
}

test('imports a plugin archive as a fresh standalone session with rewritten markers and attachments', async () => {
  const built = await buildPluginZip();
  const persistence = makePersistence();
  const attachments = makeRestoreAttachments();
  const deps = makeImportDeps({ persistence, attachments });
  const result = await importArchive({}, { buffer: built.data, cwd: '/target/ws', workspaceId: 'ws-9', deps });

  assert.equal(result.sessions.length, 1);
  assert.deepEqual(result.warnings, []);
  const imported = result.sessions[0];
  assert.match(imported.sessionId, /^session-/u);
  assert.equal(imported.title, '旧标题');
  assert.equal(imported.eventCount, 6);
  assert.equal(imported.mode, 'full');
  assert.equal(imported.verified, true);
  assert.deepEqual(imported.warnings, []);

  assert.equal(deps.calls.written.length, 1);
  const written = deps.calls.written[0];
  assert.equal(written.id, imported.sessionId);
  assert.equal(written.header.version, 4);
  assert.equal(written.header.isSeeded, false);
  assert.equal(written.header.cwd, '/target/ws');
  assert.equal(written.header.delegationDepth, 0);
  assert.equal(written.header.parentSession, undefined);
  assert.equal(written.header.origin, undefined);
  assert.equal(deps.calls.attached, true, 'the imported session joins a workspace');

  const delivery = written.events.find((event) => event.type === 'session-log-deepseek/delivery-accepted');
  assert.equal(delivery.data.sessionId, imported.sessionId, 'delivery marker is re-pointed at the new Session');
  assert.equal(delivery.data.sessionFormatVersion, 4);
  const seed = written.events.find((event) => event.type === 'session/end-seed');
  assert.equal(seed.data.inherited, undefined, 'the inherited end-seed flag is dropped');
  const userMessage = written.events.find((event) => event.type === 'user/message');
  const image = userMessage.data.content.find((block) => block.type === 'image');
  assert.equal(image.attachment.attachmentId, NEW_IMAGE_ID, 'image reference rewritten to the restored object');
  const file = userMessage.data.content.find((block) => block.type === 'file');
  assert.equal(file.attachment.attachmentId, NEW_FILE_ID, 'file reference rewritten to the restored object');
  assert.equal(file.attachment.name, 'a.txt');
  assert.equal(written.events[0].seq, 0);
  assert.deepEqual(written.events.map((event) => event.seq), [0, 1, 2, 3, 4, 5]);
  assert.equal(attachments.saved.length, 2);
});

test('imports a compact archive and reports the compact mode', async () => {
  const compactSession = ({ header, events }) => ({
    header: { ...header, isSeeded: false },
    events: [
      { type: 'turn/start', seq: 0, time: events[0].time, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: events[0].time, data: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'turn/end', seq: 2, time: events[0].time, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  });
  const built = await buildPluginZip({ mode: 'compact', includeAttachments: false, compactSession });
  const persistence = makePersistence();
  const deps = makeImportDeps({ persistence, attachments: undefined });
  const result = await importArchive({}, { buffer: built.data, deps });
  assert.equal(result.sessions[0].mode, 'compact');
  assert.equal(result.sessions[0].eventCount, 3);
  assert.equal(deps.calls.written[0].header.isSeeded, false);
});

test('accepts a DSH built-in session-log export ZIP (root log plus media/ and files/)', async () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 11,
      surfaceOp: 'append',
      data: {
        id: 'builtin-msg-1',
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'pic', mediaType: 'image/png', bytes: 2, width: 1, height: 1 } },
          { type: 'file', attachment: { attachmentId: FILE_ID, name: 'note.txt', bytes: 2 } },
        ],
      },
    },
    { type: 'turn/end', seq: 2, time: 12, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const log = serializeSessionLog(makeHeader('builtin-1'), events);
  const zip = zipOf([
    ['session.v4.jsonl', log],
    ['media/pic.png', Buffer.from([9, 9])],
    [`files/${FILE_DIGEST.slice(0, 2)}/${FILE_DIGEST}/note.txt`, Buffer.from([7, 7])],
  ]);
  const persistence = makePersistence();
  const attachments = makeRestoreAttachments();
  const deps = makeImportDeps({ persistence, attachments });
  const result = await importArchive({}, { buffer: zip, cwd: '/target/ws', deps });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].mode, 'full');
  assert.equal(result.sessions[0].eventCount, 3);
  assert.equal(attachments.saved.length, 2);
  const userMessage = deps.calls.written[0].events.find((event) => event.type === 'user/message');
  assert.equal(userMessage.data.content[0].attachment.attachmentId, NEW_IMAGE_ID);
});

test('accepts a bare .jsonl session log', async () => {
  const events = makeSourceEvents();
  const log = Buffer.from(serializeSessionLog(makeHeader('bare-1'), events), 'utf8');
  const persistence = makePersistence();
  const deps = makeImportDeps({ persistence, attachments: undefined });
  const result = await importArchive({}, { buffer: log, cwd: '/target/ws', deps });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].mode, 'full');
  assert.equal(deps.calls.written[0].header.cwd, '/target/ws');
});

test('rejects a log whose format version differs from the running one', async () => {
  const log = Buffer.from(serializeSessionLog(makeHeader('old-1', 3), []), 'utf8');
  const deps = makeImportDeps({ persistence: makePersistence() });
  await assert.rejects(
    () => importArchive({}, { buffer: log, deps }),
    (error) => error.code === 'format-version' && /v3/u.test(error.message),
  );
});

test('rejects a malformed ZIP without creating anything', async () => {
  const writes = { written: [] };
  const deps = makeImportDeps({ persistence: makePersistence(), writes });
  const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not a zip payload')]);
  await assert.rejects(
    () => importArchive({}, { buffer: broken, deps }),
    (error) => error.code === 'invalid-zip',
  );
  assert.deepEqual(writes.written, []);
});

test('rejects duplicate source session ids', async () => {
  const header = makeHeader('dupe-1');
  const log = serializeSessionLog(header, []);
  const zip = zipOf([
    ['sessions/one/session.v4.jsonl', log],
    ['sessions/two/session.v4.jsonl', log],
  ]);
  const deps = makeImportDeps({ persistence: makePersistence() });
  await assert.rejects(
    () => importArchive({}, { buffer: zip, deps }),
    (error) => error.code === 'duplicate-session',
  );
});

test('enforces maxImportBytes and the 100-session cap before writing', async () => {
  const built = await buildPluginZip({ includeAttachments: false });
  const deps = makeImportDeps({ persistence: makePersistence() });
  await assert.rejects(
    () => importArchive({}, { buffer: built.data, maxImportBytes: 10, deps }),
    (error) => error.code === 'too-large',
  );

  const entries = [];
  for (let index = 0; index < 101; index += 1) {
    entries.push([`sessions/s${index}/session.v4.jsonl`, serializeSessionLog(makeHeader(`many-${index}`), [])]);
  }
  const writes = { written: [] };
  const manyDeps = makeImportDeps({ persistence: makePersistence(), writes });
  await assert.rejects(
    () => importArchive({}, { buffer: zipOf(entries), deps: manyDeps }),
    (error) => error.code === 'too-many-sessions',
  );
  assert.deepEqual(writes.written, []);
});

test('reports a session whose log cannot be re-opened as verified:false with a warning', async () => {
  const built = await buildPluginZip({ includeAttachments: false });
  const deps = makeImportDeps({ persistence: makePersistence(), verifyFails: true });
  const result = await importArchive({}, { buffer: built.data, deps });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].verified, false);
  assert.match(result.sessions[0].warnings.join('\n'), /无法重新打开/u);
});

test('fails a corrupted manifest checksum before creating a session', async () => {
  const built = await buildPluginZip({ includeAttachments: false });
  const entries = readZipEntries(built.data).map((entry) => ({
    name: entry.name,
    data: Buffer.from(entry.data),
  }));
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  manifest.sessions[0].logSha256 = 'c'.repeat(64);
  manifestEntry.data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const corrupted = writeZipEntries(entries);
  const writes = { written: [] };
  const deps = makeImportDeps({ persistence: makePersistence(), writes });
  await assert.rejects(
    () => importArchive({}, { buffer: corrupted, deps }),
    (error) => error.code === 'checksum-mismatch',
  );
  assert.deepEqual(writes.written, []);
});

test('readImportFile reads a path relative to cwd and reports a missing file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-kit-import-'));
  try {
    const file = join(directory, 'archive.zip');
    const bytes = Buffer.from('PK-placeholder');
    await writeFile(file, bytes);
    const read = await readImportFile('archive.zip', { cwd: directory });
    assert.equal(read.filename, 'archive.zip');
    assert.equal(read.resolved, file);
    assert.deepEqual([...read.buffer], [...bytes]);
    await assert.rejects(
      () => readImportFile('missing.zip', { cwd: directory }),
      (error) => error.code === 'file-missing',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('imports into the repository real JSONL persistence backend (guarded)', async (t) => {
  let support;
  try {
    support = await import('./support/real-backend.mjs');
  } catch {
    t.skip('real-backend helper is not available');
    return;
  }
  const backend = await support.createRealBackend();
  if (!backend.ok) {
    t.skip(`real backend unavailable: ${backend.error}`);
    return;
  }
  try {
    const header = makeHeader('real-src', 4);
    const events = [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 11,
        surfaceOp: 'append',
        data: { id: 'real-msg-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
      },
      { type: 'session/end-seed', seq: 2, time: 12, data: { inherited: true } },
      {
        type: 'session-log-deepseek/delivery-accepted',
        seq: 3,
        time: 13,
        data: { sessionId: 'real-src', sessionFormatVersion: 4, throughSeq: 1 },
      },
      // The V4 reader requires empty messageSeqs exactly for an explicit
      // user title (relationships.ts: titleSources), so this fixture is valid;
      // a non-'user' source with empty messageSeqs would be rejected.
      { type: 'session/title', seq: 4, time: 14, data: { title: '真实后端', messageSeqs: [], source: { kind: 'user' } } },
      { type: 'turn/end', seq: 5, time: 15, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    const archive = Buffer.from(serializeSessionLog(header, events), 'utf8');
    const persistence = backend.persistence;
    const readSession = async (id) => {
      const handle = await persistence.open(id, 'read');
      try {
        const slice = await handle.read(0, Number.MAX_SAFE_INTEGER);
        return { session: handle.header, events: slice.events, inheritedEventCount: handle.inheritedEventCount };
      } finally {
        await handle.close();
      }
    };
    const deps = {
      async detectFormatVersion(ctx, configured) {
        if (configured !== undefined) return configured;
        return 4;
      },
      async resolveTargetDirectory() {
        return backend.root;
      },
      async mintSessionId() {
        return `session-${randomUUID()}`;
      },
      async attachToWorkspace() {
        return {};
      },
      async writeNewSession(target, newHeader, newEvents) {
        const handle = await target.create(newHeader);
        try {
          if (newEvents.length > 0) await handle.append(newEvents);
          await handle.flush();
        } finally {
          await handle.close();
        }
        return { id: newHeader.id };
      },
      foldTitle(eventsIn) {
        for (let index = eventsIn.length - 1; index >= 0; index -= 1) {
          const event = eventsIn[index];
          if (event.type === 'session/title' && typeof event.data?.title === 'string') return event.data.title;
        }
        return undefined;
      },
      servicesOf() {
        return { sessionPersistence: persistence, attachments: undefined, sessionQuery: { readSession } };
      },
    };
    const result = await importArchive({}, { buffer: archive, cwd: backend.root, deps });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].verified, true, 'the real backend re-opens the imported session');
    assert.equal(result.sessions[0].title, '真实后端');
    const stored = await readSession(result.sessions[0].sessionId);
    assert.equal(stored.session.isSeeded, false);
    assert.equal(stored.session.cwd, backend.root);
    const delivery = stored.events.find((event) => event.type === 'session-log-deepseek/delivery-accepted');
    assert.equal(delivery.data.sessionId, result.sessions[0].sessionId);
    const seed = stored.events.find((event) => event.type === 'session/end-seed');
    assert.equal(seed.data.inherited, undefined);
  } finally {
    backend.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Workspace files + subagent filtering (task-11)
// ---------------------------------------------------------------------------

/** Mock `lib/workspace-files.js` exclusion surface for restore tests. */
function makeRestoreSafety() {
  return {
    isSensitivePath(relPath) {
      const base = relPath.split('/').pop() ?? '';
      return base === '.env' || base.startsWith('.env.') || /\.(?:pem|key)$/u.test(base);
    },
    isExcludedDir(relPath) {
      return relPath.split('/').some((segment) => segment === 'node_modules' || segment === '.git');
    },
  };
}

/** Build a plugin-shaped ZIP with session logs and an optional workspaces tree. */
function pluginZipWithWorkspaces({ sessions, workspaces = [], files = {}, manifestExtra = {} }) {
  const pairs = [];
  const manifestSessions = [];
  for (const session of sessions) {
    const events = session.events ?? [];
    const logText = serializeSessionLog(session.header, events);
    const logName = `sessions/${session.header.id}/session.v4.jsonl`;
    pairs.push([logName, Buffer.from(logText, 'utf8')]);
    manifestSessions.push({
      id: session.header.id,
      title: session.title,
      cwd: session.header.cwd,
      createdAt: session.header.createdAt,
      updatedAt: session.header.createdAt,
      formatVersion: session.header.version,
      mode: 'full',
      eventCount: events.length,
      log: logName,
      attachments: [],
    });
  }
  for (const [name, data] of Object.entries(files)) {
    pairs.push([name, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')]);
  }
  const manifest = {
    manifestVersion: 1,
    kind: 'dsh-session-kit',
    createdAt: new Date(0).toISOString(),
    source: { sessionFormatVersion: 4, compression: 'deflate' },
    mode: 'full',
    sessions: manifestSessions,
    attachments: [],
    workspaces,
    ...manifestExtra,
  };
  pairs.unshift(['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')]);
  return zipOf(pairs);
}

/** Whether a path exists (test helper). */
async function exists(path) {
  return stat(path).then(() => true, () => false);
}

test('restoreWorkspaceFiles unpacks workspaces/ into the target directory', async () => {
  const target = await mkdtemp(join(tmpdir(), 'session-kit-target-'));
  try {
    const archive = pluginZipWithWorkspaces({
      sessions: [{ header: makeHeader('ws-src'), events: [] }],
      workspaces: [{ path: '/source/ws', archivePath: 'workspaces/abc', sessionIds: ['ws-src'], bytes: 5, files: 2, skipped: 0 }],
      files: {
        'workspaces/abc/a.txt': Buffer.from('abc'),
        'workspaces/abc/sub/b.txt': Buffer.from('de'),
      },
    });
    const deps = makeImportDeps({ persistence: makePersistence(), workspaceFiles: makeRestoreSafety() });
    const result = await importArchive({}, { buffer: archive, cwd: target, restoreWorkspaceFiles: true, deps });
    assert.equal(result.restoredFiles, 2);
    assert.equal(result.restoredBytes, 5);
    assert.equal(result.skipped, 0);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].verified, true);
    assert.equal(await readFile(join(target, 'a.txt'), 'utf8'), 'abc');
    assert.equal(await readFile(join(target, 'sub/b.txt'), 'utf8'), 'de');
    assert.equal(deps.calls.written[0].header.cwd, target, 'restored sessions record the target directory');
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('restoreWorkspaceFiles never overwrites an existing file', async () => {
  const target = await mkdtemp(join(tmpdir(), 'session-kit-target-'));
  try {
    await writeFile(join(target, 'a.txt'), Buffer.from('keep'));
    const archive = pluginZipWithWorkspaces({
      sessions: [{ header: makeHeader('ws-src'), events: [] }],
      workspaces: [{ path: '/source/ws', archivePath: 'workspaces/abc', sessionIds: ['ws-src'], bytes: 0, files: 0, skipped: 0 }],
      files: {
        'workspaces/abc/a.txt': Buffer.from('NEW'),
        'workspaces/abc/b.txt': Buffer.from('b'),
      },
    });
    const deps = makeImportDeps({ persistence: makePersistence(), workspaceFiles: makeRestoreSafety() });
    const result = await importArchive({}, { buffer: archive, cwd: target, restoreWorkspaceFiles: true, deps });
    assert.equal(result.restoredFiles, 1);
    assert.equal(result.skipped, 1);
    assert.equal(await readFile(join(target, 'a.txt'), 'utf8'), 'keep');
    assert.ok(result.warnings.some((warning) => /已存在/u.test(warning)));
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('restoreWorkspaceFiles skips sensitive and excluded entries', async () => {
  const target = await mkdtemp(join(tmpdir(), 'session-kit-target-'));
  try {
    const archive = pluginZipWithWorkspaces({
      sessions: [{ header: makeHeader('ws-src'), events: [] }],
      workspaces: [{ path: '/source/ws', archivePath: 'workspaces/abc', sessionIds: ['ws-src'], bytes: 0, files: 0, skipped: 0 }],
      files: {
        'workspaces/abc/.env': Buffer.from('SECRET=1'),
        'workspaces/abc/node_modules/x.js': Buffer.from('x'),
        'workspaces/abc/ok.txt': Buffer.from('ok'),
      },
    });
    const deps = makeImportDeps({ persistence: makePersistence(), workspaceFiles: makeRestoreSafety() });
    const result = await importArchive({}, { buffer: archive, cwd: target, restoreWorkspaceFiles: true, deps });
    assert.equal(result.restoredFiles, 1);
    assert.equal(result.skipped, 2);
    assert.ok(result.warnings.some((warning) => /跳过 2 个敏感/u.test(warning)));
    assert.equal(await exists(join(target, '.env')), false);
    assert.equal(await exists(join(target, 'node_modules')), false);
    assert.equal(await readFile(join(target, 'ok.txt'), 'utf8'), 'ok');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('restoreWorkspaceFiles falls back to built-in exclusions without the workspace module', async () => {
  const target = await mkdtemp(join(tmpdir(), 'session-kit-target-'));
  try {
    const archive = pluginZipWithWorkspaces({
      sessions: [{ header: makeHeader('ws-src'), events: [] }],
      workspaces: [{ path: '/source/ws', archivePath: 'workspaces/abc', sessionIds: ['ws-src'], bytes: 0, files: 0, skipped: 0 }],
      files: {
        'workspaces/abc/.env': Buffer.from('SECRET=1'),
        'workspaces/abc/.ssh/id_rsa': Buffer.from('KEY'),
        'workspaces/abc/kept.txt': Buffer.from('kept'),
      },
    });
    const deps = makeImportDeps({ persistence: makePersistence() });
    const result = await importArchive({}, { buffer: archive, cwd: target, restoreWorkspaceFiles: true, deps });
    assert.equal(result.restoredFiles, 1);
    assert.equal(await exists(join(target, '.env')), false);
    assert.equal(await exists(join(target, '.ssh')), false);
    assert.equal(await readFile(join(target, 'kept.txt'), 'utf8'), 'kept');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('restoreWorkspaceFiles rejects zip-slip entries before writing anything', async () => {
  const target = await mkdtemp(join(tmpdir(), 'session-kit-target-'));
  const parent = join(target, '..');
  try {
    for (const name of [
      'workspaces/abc/../../evil.txt',
      'workspaces/abc/C:/evil.txt',
      'workspaces/abc//absolute.txt',
    ]) {
      const archive = pluginZipWithWorkspaces({
        sessions: [{ header: makeHeader('slip-src'), events: [] }],
        workspaces: [{ path: '/source/ws', archivePath: 'workspaces/abc', sessionIds: ['slip-src'], bytes: 0, files: 0, skipped: 0 }],
        files: { [name]: Buffer.from('evil') },
      });
      const writes = { written: [] };
      const deps = makeImportDeps({ persistence: makePersistence(), writes, workspaceFiles: makeRestoreSafety() });
      await assert.rejects(
        () => importArchive({}, { buffer: archive, cwd: target, restoreWorkspaceFiles: true, deps }),
        (error) => error.code === 'zip-slip',
        `entry ${name} must be rejected`,
      );
      assert.deepEqual(writes.written, [], 'no session is created for a rejected archive');
    }
    assert.equal(await exists(join(parent, 'evil.txt')), false);
    assert.equal(await exists(join(target, 'C:', 'evil.txt')), false);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('subagent transcripts are never imported', async () => {
  const mainHeader = makeHeader('main-1');
  const childHeader = { ...makeHeader('child-1'), origin: 'subagent', parentSession: 'main-1', delegationDepth: 1 };
  const archive = pluginZipWithWorkspaces({
    sessions: [{ header: mainHeader, events: [] }, { header: childHeader, events: [] }],
  });
  const deps = makeImportDeps({ persistence: makePersistence() });
  const result = await importArchive({}, { buffer: archive, deps });
  assert.equal(result.sessions.length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('跳过 1 个子代理会话')));
  assert.equal(deps.calls.written.length, 1);

  const onlyChildArchive = pluginZipWithWorkspaces({ sessions: [{ header: childHeader, events: [] }] });
  await assert.rejects(
    () => importArchive({}, { buffer: onlyChildArchive, deps: makeImportDeps({ persistence: makePersistence() }) }),
    (error) => error.code === 'no-session' && /子代理/u.test(error.message),
  );
});

test('restoreWorkspaceFiles is off by default and leaves the target untouched', async () => {
  const target = await mkdtemp(join(tmpdir(), 'session-kit-target-'));
  try {
    const archive = pluginZipWithWorkspaces({
      sessions: [{ header: makeHeader('ws-src'), events: [] }],
      workspaces: [{ path: '/source/ws', archivePath: 'workspaces/abc', sessionIds: ['ws-src'], bytes: 0, files: 0, skipped: 0 }],
      files: { 'workspaces/abc/a.txt': Buffer.from('abc') },
    });
    const deps = makeImportDeps({ persistence: makePersistence(), workspaceFiles: makeRestoreSafety() });
    const result = await importArchive({}, { buffer: archive, cwd: target, deps });
    assert.equal(result.restoredFiles, 0);
    assert.equal(result.restoredBytes, 0);
    assert.ok(result.warnings.some((warning) => warning.includes('未选择恢复')));
    assert.equal(await exists(join(target, 'a.txt')), false);
    assert.equal(result.sessions.length, 1);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('restore uses the real lib/workspace-files.js exclusion rules (guarded)', async (t) => {
  let workspaceFiles;
  try {
    workspaceFiles = await import('../lib/workspace-files.js');
  } catch {
    t.skip('lib/workspace-files.js is not available yet');
    return;
  }
  const target = await mkdtemp(join(tmpdir(), 'session-kit-target-'));
  try {
    const archive = pluginZipWithWorkspaces({
      sessions: [{ header: makeHeader('real-ws'), events: [] }],
      workspaces: [{ path: '/source/ws', archivePath: 'workspaces/rk', sessionIds: ['real-ws'], bytes: 0, files: 0, skipped: 0 }],
      files: {
        'workspaces/rk/ok.txt': Buffer.from('ok'),
        'workspaces/rk/.env': Buffer.from('SECRET=1'),
        'workspaces/rk/node_modules/dep.js': Buffer.from('x'),
      },
    });
    const deps = makeImportDeps({ persistence: makePersistence(), workspaceFiles });
    const result = await importArchive({}, { buffer: archive, cwd: target, restoreWorkspaceFiles: true, deps });
    assert.equal(result.restoredFiles, 1);
    assert.equal(await readFile(join(target, 'ok.txt'), 'utf8'), 'ok');
    assert.equal(await exists(join(target, '.env')), false);
    assert.equal(await exists(join(target, 'node_modules')), false);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

