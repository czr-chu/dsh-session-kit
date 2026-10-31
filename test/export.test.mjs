/**
 * Unit tests for lib/export.js.
 *
 * Everything runs against a mocked helper module (the documented `deps` seam),
 * so these tests need neither a DSH process nor `lib/sessions.js`; one guarded
 * case exercises the real helper module when it is present.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildArchive, defaultExportDirectory } from '../lib/export.js';
import { parseSessionLog, safeSessionIdSegment, serializeSessionLog } from '../lib/format.js';
import { readZipEntries } from '../lib/zip.js';

const IMAGE_ID = 'img-1';
const FILE_DIGEST = 'a'.repeat(64);
const FILE_ID = 'sha256:' + FILE_DIGEST;

/** sha256 hex of a Buffer. */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Synthesize one valid-ish V4 event list with an image and a file reference. */
function makeEvents(sessionId) {
  return [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 11,
      data: {
        content: [
          { type: 'text', text: `hello ${sessionId}` },
          {
            type: 'image',
            attachment: { attachmentId: IMAGE_ID, mediaType: 'image/png', bytes: 3, width: 2, height: 2 },
          },
          {
            type: 'file',
            attachment: { attachmentId: FILE_ID, name: `${sessionId}.txt`, bytes: 3 },
          },
        ],
        source: { kind: 'user' },
      },
    },
    {
      type: 'session/title',
      seq: 2,
      time: 12,
      data: { title: `标题-${sessionId}`, messageSeqs: [], source: { kind: 'user' } },
    },
    { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

/** One stored session document as lib/sessions.js readSessionDoc returns it. */
function makeDoc(id, { version = 4, events = makeEvents(id) } = {}) {
  return {
    header: { version, id, createdAt: 1000, cwd: '/work/ws', isSeeded: false, delegationDepth: 0 },
    events,
    inheritedEventCount: 0,
  };
}

/** Mock attachment service that yields fixed bytes. */
function makeAttachments() {
  const reads = [];
  return {
    reads,
    imageHostPath: () => undefined,
    fileHostPath: () => undefined,
    async readImage(ref) {
      reads.push(['image', ref.attachmentId]);
      return { data: new Uint8Array([1, 2, 3]) };
    },
    async *readFileStream(ref) {
      reads.push(['file', ref.attachmentId]);
      yield new Uint8Array([4, 5, 6]);
    },
  };
}

/**
 * Mock helper module matching the lib/sessions.js shape used by export.js.
 * @param {object} facts - docs, index entries, attachments, compactSession.
 * @returns {object} helper module.
 */
function makeDeps({ docs, indexEntries = [], attachments = makeAttachments(), compactSession } = {}) {
  return {
    async detectFormatVersion() {
      return 4;
    },
    async readSessionDoc(ctx, id) {
      const doc = docs[id];
      if (doc === undefined) throw new Error(`session not found: ${id}`);
      return structuredClone(doc);
    },
    async listSessionEntries() {
      return indexEntries;
    },
    servicesOf() {
      return { attachments };
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
    ...(compactSession !== undefined ? { compactSession } : {}),
  };
}

/** Build an entry-name -> entry map from an archive buffer. */
function entryMap(data) {
  return new Map(readZipEntries(data).map((entry) => [entry.name, entry.data]));
}

test('full archive carries per-session folders, manifest, README, meta and attachments', async () => {
  const attachments = makeAttachments();
  const deps = makeDeps({
    docs: { s1: makeDoc('s1'), s2: makeDoc('s2') },
    indexEntries: [
      { id: 's1', title: '会话一', cwd: '/work/one', workspaceId: 'ws-1', createdAt: 1000, updatedAt: 2000, formatVersion: 4, eventCount: 4 },
      { id: 's2', title: '会话二', cwd: '/work/two', createdAt: 1500, updatedAt: 2500, formatVersion: 4, eventCount: 4 },
    ],
    attachments,
  });
  const built = await buildArchive({}, { sessionIds: ['s1', 's2'], mode: 'full', deps, now: 1730000000000 });

  assert.equal(built.sessionCount, 2);
  assert.equal(built.eventCount, 8);
  assert.equal(built.attachmentCount, 3, 'one image plus one per-session file (distinct names)');
  assert.match(built.filename, /^session-kit-2-sessions-\d{8}-\d{6}\.zip$/u);
  assert.deepEqual(built.warnings, []);

  const entries = entryMap(built.data);
  assert.ok(entries.has('manifest.json'));
  assert.ok(entries.has('README.md'));
  for (const id of ['s1', 's2']) {
    const segment = safeSessionIdSegment(id);
    assert.ok(entries.has(`sessions/${segment}/session.v4.jsonl`), `missing log for ${id}`);
    assert.ok(entries.has(`sessions/${segment}/meta.json`), `missing meta for ${id}`);
  }
  assert.ok(entries.has(`attachments/media/${IMAGE_ID}.png`));
  assert.ok(entries.has(`attachments/files/${FILE_DIGEST.slice(0, 2)}/${FILE_DIGEST}/s1.txt`));

  const manifest = JSON.parse(Buffer.from(entries.get('manifest.json')).toString('utf8'));
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.kind, 'dsh-session-kit');
  assert.equal(manifest.mode, 'full');
  assert.equal(manifest.createdAt, new Date(1730000000000).toISOString());
  assert.equal(manifest.source.sessionFormatVersion, 4);
  assert.equal(manifest.source.compression, 'deflate');
  assert.equal(manifest.sessions.length, 2);
  const first = manifest.sessions.find((session) => session.id === 's1');
  assert.equal(first.title, '会话一');
  assert.equal(first.cwd, '/work/one');
  assert.equal(first.workspaceId, 'ws-1');
  assert.equal(first.updatedAt, 2000);
  assert.equal(first.eventCount, 4);
  assert.equal(first.log, 'sessions/s1/session.v4.jsonl');
  assert.equal(first.logSha256, sha256(Buffer.from(entries.get(first.log))));
  assert.deepEqual([...first.attachments].sort(), [IMAGE_ID, FILE_ID].sort());
  assert.equal(manifest.attachments.length, 3);
  const imageFact = manifest.attachments.find((fact) => fact.kind === 'image');
  assert.equal(imageFact.path, `attachments/media/${IMAGE_ID}.png`);
  assert.equal(imageFact.mediaType, 'image/png');

  // Every checksum covers an actual entry, and the manifest itself is excluded.
  assert.equal(manifest.checksums.algorithm, 'sha256');
  assert.equal(manifest.checksums.files['manifest.json'], undefined);
  for (const [name, expected] of Object.entries(manifest.checksums.files)) {
    assert.ok(entries.has(name), `checksum names missing entry ${name}`);
    assert.equal(sha256(Buffer.from(entries.get(name))), expected, `checksum mismatch for ${name}`);
  }
  assert.ok(manifest.checksums.files['README.md']);
  assert.ok(manifest.checksums.files[first.log]);

  // The packed log is canonical JSONL with the source header.
  const logText = Buffer.from(entries.get(first.log)).toString('utf8');
  const parsed = parseSessionLog(logText);
  assert.equal(parsed.header.id, 's1');
  assert.equal(parsed.events.length, 4);
  assert.equal(logText.length > 0 && logText.endsWith('\n'), true);

  // README mentions both sessions and the layout.
  const readme = Buffer.from(entries.get('README.md')).toString('utf8');
  assert.match(readme, /manifest\.json/u);
  assert.match(readme, /sessions\//u);
});

test('single-session archive is named after its title and keeps the title in meta', async () => {
  const deps = makeDeps({
    docs: { one: makeDoc('one') },
    indexEntries: [{ id: 'one', title: '我的备份', createdAt: 1000, updatedAt: 1000, formatVersion: 4, eventCount: 4 }],
  });
  const built = await buildArchive({}, { sessionIds: ['one'], deps, now: 1730000000000, includeAttachments: false });
  assert.equal(built.filename, '我的备份-session-kit.zip');
  const entries = entryMap(built.data);
  const meta = JSON.parse(Buffer.from(entries.get('sessions/one/meta.json')).toString('utf8'));
  assert.equal(meta.title, '我的备份');
  assert.equal(meta.mode, 'full');
  assert.equal(meta.log, 'sessions/one/session.v4.jsonl');
  assert.deepEqual(meta.attachments, [], 'attachments disabled, so none are claimed');
});

test('compact mode stores the compacted log under session.compact.v4.jsonl', async () => {
  const compactSession = ({ header, events }) => ({
    header: { ...header, isSeeded: false },
    events: [
      { type: 'user/message', seq: 0, time: events[0].time, data: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant/message', seq: 1, time: events[0].time, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] }, stream: [] } },
    ],
  });
  const deps = makeDeps({ docs: { c1: makeDoc('c1') }, compactSession });
  const built = await buildArchive({}, { sessionIds: ['c1'], mode: 'compact', deps, now: 1730000000000, includeAttachments: false });
  assert.equal(built.manifest.mode, 'compact');
  assert.equal(built.eventCount, 2);
  const entries = entryMap(built.data);
  assert.ok(entries.has('sessions/c1/session.compact.v4.jsonl'));
  assert.equal(entries.has('sessions/c1/session.v4.jsonl'), false);
  const parsed = parseSessionLog(Buffer.from(entries.get('sessions/c1/session.compact.v4.jsonl')).toString('utf8'));
  assert.equal(parsed.events.length, 2);
  assert.equal(built.manifest.sessions[0].mode, 'compact');
});

test('rejects an empty selection and an unknown mode', async () => {
  const deps = makeDeps({ docs: { s1: makeDoc('s1') } });
  await assert.rejects(
    () => buildArchive({}, { sessionIds: [], deps }),
    (error) => error.code === 'missing-sessions',
  );
  await assert.rejects(
    () => buildArchive({}, { sessionIds: ['s1'], mode: 'tiny', deps }),
    (error) => error.code === 'invalid-mode',
  );
});

test('rejects an archive larger than maxExportBytes', async () => {
  const deps = makeDeps({ docs: { s1: makeDoc('s1') } });
  await assert.rejects(
    () => buildArchive({}, { sessionIds: ['s1'], deps, maxExportBytes: 10 }),
    (error) => error.code === 'too-large',
  );
});

test('surfaces a missing session as not-found and bad maxExportBytes as invalid-argument', async () => {
  const deps = makeDeps({ docs: {} });
  await assert.rejects(
    () => buildArchive({}, { sessionIds: ['nope'], deps }),
    (error) => error.code === 'not-found',
  );
  await assert.rejects(
    () => buildArchive({}, { sessionIds: ['s1'], deps, maxExportBytes: -1 }),
    (error) => error.code === 'invalid-argument',
  );
});

test('unreadable attachments degrade to warnings instead of failing the export', async () => {
  const attachments = {
    reads: [],
    imageHostPath: () => undefined,
    fileHostPath: () => undefined,
    async readImage() {
      throw new Error('store offline');
    },
    async *readFileStream() {
      throw new Error('store offline');
    },
  };
  const deps = makeDeps({ docs: { s1: makeDoc('s1') }, attachments });
  const built = await buildArchive({}, { sessionIds: ['s1'], deps });
  assert.equal(built.attachmentCount, 0);
  assert.equal(built.warnings.length, 2);
  assert.match(built.warnings.join('\n'), /读取失败/u);
  const manifest = JSON.parse(Buffer.from(entryMap(built.data).get('manifest.json')).toString('utf8'));
  assert.deepEqual(manifest.attachments, []);
  assert.deepEqual(manifest.sessions[0].attachments, []);
});

test('defaultExportDirectory honors the explicit, environment and home defaults', () => {
  assert.equal(defaultExportDirectory('/tmp/dsh-home'), '/tmp/dsh-home/session-kit/exports');
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/env-home';
    assert.equal(defaultExportDirectory(), '/tmp/env-home/session-kit/exports');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('buildArchive works through the real lib/sessions.js helper module (guarded)', async (t) => {
  let helpers;
  try {
    helpers = await import('../lib/sessions.js');
  } catch {
    t.skip('lib/sessions.js is not available yet');
    return;
  }
  const id = 'session-real';
  const header = { version: 4, id, createdAt: 1000, cwd: '/tmp/ws', isSeeded: false, delegationDepth: 0 };
  const events = makeEvents(id);
  const attachments = makeAttachments();
  const sessionQuery = {
    async listSessions() {
      return [{ header, live: false, persisted: true, formatStatus: 'current' }];
    },
    async readSession() {
      return { session: header, events, inheritedEventCount: 0 };
    },
    async readTitle() {
      return undefined;
    },
  };
  const ctx = {
    get(service) {
      if (service === 'sessionQuery') return sessionQuery;
      if (service === 'sessions') return { get: () => undefined, async flush() {} };
      if (service === 'attachments') return attachments;
      if (service === 'workspaceRegistry') return { list: () => [] };
      if (service === 'workingDirectory') return { defaultDirectory: '/tmp' };
      return undefined;
    },
  };
  const built = await buildArchive(ctx, { sessionIds: [id], now: 1730000000000 });
  assert.equal(built.sessionCount, 1);
  assert.equal(typeof helpers.detectFormatVersion, 'function');
  const manifest = JSON.parse(Buffer.from(entryMap(built.data).get('manifest.json')).toString('utf8'));
  assert.equal(manifest.sessions[0].id, id);
  assert.equal(manifest.sessions[0].eventCount, events.length);
  assert.equal(Buffer.from(entryMap(built.data).get(manifest.sessions[0].log)).toString('utf8'), serializeSessionLog(header, events));
});
