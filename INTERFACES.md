# dsh-session-kit 0.1.0 — module interfaces

All host modules are ESM JavaScript, no build step, no third-party runtime
dependencies. The plugin reads DSH services through `ctx.get(...)` only (like a
bundle-installed plugin must), so it does not import @deepseek-ai packages.

## lib/format.js (already present, derived from dsh-session-port, MIT)

Exports (do not rename):
- `SessionPortFormatError` (code, message)
- `serializeSessionLog(header, events) -> string` canonical JSONL with trailing newline
- `parseSessionLog(text) -> { header, events }`
- `validateEvents(events, knownTypes?) -> number` (seq must be 0..N-1)
- `collectAttachmentRefs(events) -> { images: Map, files: Map }`
- `rewriteAttachmentRefs(events, replacements) -> events`
- `rewriteDeliveryIdentity(events, sessionId, sessionFormatVersion) -> events`
- `rewriteSeedMarkers(events) -> events`
- `sessionLogFileName(version)`, `findRootLogEntry(entries)`, `isZipBuffer(buffer)`
- `imageEntryName(ref)`, `fileEntryName(ref)`, `parseAttachmentEntryName(name)`
- `sanitizeFileName(raw, fallback)`, `fileEntryLeafName(raw)`, `headerLineOf(header)`
- `safeSessionIdSegment(id)`, `subagentLogEntryName(id, version)`

## lib/zip.js (already present, derived, MIT)

- `readZipEntries(buffer, options?) -> Array<{ name, data: Uint8Array, ... }>`
- `writeZipEntries(entries, options?) -> Buffer` where entries are `{ name, data }`
- `crc32(buffer)`

## lib/sessions.js (NEW)

```js
export function servicesOf(ctx)
// -> { sessionQuery, sessionPersistence, sessions, attachments,
//      workspaceRegistry, agentPresets, workingDirectory }

export async function detectFormatVersion(ctx, configured)
// -> Promise<number>; configured override, else max header version of stored
//    sessions, else 4.

export async function readSessionDoc(ctx, id)
// -> Promise<{ header, events, inheritedEventCount }>
// Flush the live session through ctx.sessions.flush(live) when present, then
// read via ctx.sessionQuery.readSession(id). Throw a readable Error when the
// session does not exist. Header is cloned.

export async function listSessionEntries(ctx, { signal } = {})
// -> Promise<Array<{
//      id, title, cwd, workspaceId, workspaceTitle,
//      createdAt, updatedAt, running, formatVersion, eventCount
//    }>>
// Source: ctx.sessionQuery.listSessions(); running: ctx.agents?.get(id)?.status
// === 'running'; title: ctx.sessionQuery.readTitle(id) (tolerate failures and
// undefined); workspaceId: the workspace whose sessionIds contains the id via
// ctx.workspaceRegistry.list(). eventCount may be 0 when unavailable (cheap
// listing; do not read every log). cwd may be undefined for legacy sessions.

export async function listWorkspaceEntries(ctx)
// -> Array<{ workspaceId, title, path, sessionIds }> from workspaceRegistry.list()

export async function resolveTargetDirectory(ctx, { requestedCwd, sourceCwd })
// -> Promise<string>; first absolute existing directory among requestedCwd,
//    sourceCwd, workingDirectory.defaultDirectory, process.cwd().

export async function mintSessionId(persistence)
// -> Promise<string> 'session-<uuid>' guaranteed unused

export async function attachToWorkspace(ctx, { sessionId, workspaceId, cwd })
// -> Promise<{ workspaceId?, warning? }>; resolveByPath(cwd) fallback; never throws.

export function foldTitle(events)
// -> last session/title title string or undefined

export async function writeNewSession(persistence, header, events, inheritedEventCount = 0)
// -> Promise<{ id }>; create -> append(events) (single batch) -> flush -> close.
// Caller supplies an already-rewritten id/header; no lineage.

export function sessionHeaderToSummary(header)
// -> { id, cwd, createdAt, isSeeded, parentSession, origin, agentPreset }
```

## lib/compact.js (NEW)

```js
export function compactSession({ header, events })
// -> { header, events }
// Header keeps version/id/createdAt/cwd/isSeeded/agentPreset; drops
// parentSession/origin/delegationDepth (compact archive is standalone).
// Events are renumbered seq 0..N-1. The output carries only the conversational
// spine:
//   1. each session-level config event the source has, in source order:
//      permission/preset, sandbox/mode, approval/policy, model/selection
//   2. first request/header and first request/context (model config)
//   3. one session/title event (when the source has one)
//   4. per top-level turn, in order:
//        turn/start { turn }
//        step/start { turn, step: 1 }
//        user/message { ...data, surfaceOp: 'append' } for each real user message
//        assistant/message { turn, step: 1, message: <text/image/file blocks only>,
//                            stream: [] }  (only when text/blocks exist)
//        step/end { turn, step: 1 }
//        turn/end { turn, reason: { kind: 'completed' | 'interrupted' } }
//   Drop: assistant/chunk, reasoning-chunks, text-chunks, tool-call-chunks,
//   tool/call, tool/result, job/*, subagent/*, agent/inbox/*,
//   working-directory/change, deliverables/presented, workspace/*, session/title
//   duplicates, session/end-seed, approval/*, request retries.
// Assistant message content keeps {type:'text'} blocks and image/file blocks;
// tool_use/tool_result/reasoning blocks are dropped. The assistant message keeps
// its id/source when present; 'source.kind' must stay model/system as-is.
// User message keeps its id/source/content (text/image/file blocks).
// The result must be a log that DSH can import as a NEW unseeded session and
// re-open with ctx.sessionQuery.readSession(); verify in tests.
// Keep events ordered by source occurrence; turn numbers are the source turn
// numbers when >= 1, otherwise sequential from 1.
```

## lib/export.js (NEW)

```js
export async function buildArchive(ctx, {
  sessionIds,                 // non-empty array; 'all' is expanded by index.js
  mode = 'full',              // 'full' | 'compact'
  includeAttachments = true,
  maxExportBytes,             // optional safety cap, throw code 'too-large'
  signal,
})
// -> Promise<{ filename, data: Buffer, manifest, warnings: string[],
//              sessionCount, eventCount, attachmentCount }>
// Archive layout (ZIP):
//   manifest.json
//   README.md
//   sessions/<safeSessionId>/session.v4.jsonl        (mode=full)
//   sessions/<safeSessionId>/session.compact.v4.jsonl(mode=compact)
//   sessions/<safeSessionId>/meta.json
//   attachments/media/<attachmentId>.<ext>
//   attachments/files/<2>/<digest>/<name>
// manifest v1:
//   { manifestVersion:1, kind:'dsh-session-kit', createdAt,
//     source:{ sessionFormatVersion, compression, dshVersion? },
//     mode, sessions:[{ id, title, cwd, workspaceId, createdAt, updatedAt,
//       formatVersion, eventCount, log:'sessions/<id>/...jsonl', logSha256,
//       attachments:[ids] }], attachments:[{id, kind, bytes, mediaType?, name?, path}],
//     checksums:{ algorithm:'sha256', files:{...} } }
// Attachments use the same media/ + files/ layout as DSH's built-in export.

export function defaultExportDirectory(dshHome?)
// -> <DSH_HOME>/session-kit/exports
```

## lib/import.js (NEW)

```js
export async function importArchive(ctx, {
  buffer, cwd, workspaceId, maxImportBytes = 512*1024*1024, signal,
})
// -> Promise<{ sessions: Array<{ sessionId, title, eventCount, mode, verified,
//              warnings: string[] }>, warnings: string[] }>
// Accepts: ZIP produced by buildArchive or by DSH's built-in session-log export
// (manifest optional; then pick sessions/*/session*.jsonl or the root log), or a
// bare .jsonl. Every imported session becomes a NEW session:
//   - mint id, drop parentSession/origin/delegationDepth, isSeeded:false
//   - cwd = resolveTargetDirectory(ctx, { requestedCwd: cwd, sourceCwd: header.cwd })
//   - rewrite delivery markers + inherited end-seed marker
//   - restore archive attachments into ctx.attachments, rewriting refs
//   - create -> append -> flush -> close, then attach to workspace when possible
//   - verify via ctx.sessionQuery.readSession(newId); failure -> verified:false +
//     warning, never throw after the session was written
// Version gate: archive header.version must equal the running format version
// (detectFormatVersion), else throw code 'format-version' with a readable message.
// Enforce maxImportBytes and a 100-session cap.

export async function readImportFile(path, { cwd, maxImportBytes })
// -> Promise<{ buffer, filename, resolved }> for the agent tool.
```

## index.js (NEW)

Plugin host entry:
```js
export const name = 'dsh-session-kit'
export const inject = ['tools', 'sessionQuery', 'sessionPersistence']
export function apply(ctx, config) { ... }
```
Routes (registered via ctx.inject(['webServer','connection']) exactly like
dsh-session-port index.js; use connection.requestRejection(req) as the fence):
- GET  /session-kit/info
- GET  /session-kit/list
- POST /session-kit/export   (JSON body { sessionIds: string[]|'all', mode, includeAttachments? })
- POST /session-kit/import   (raw archive body; query cwd, workspaceId, filename)
Errors: JSON { ok:false, code, message }, status 400/404/413/500/503.
Export response: application/zip + content-disposition attachment; also
x-session-kit-filename (percent-encoded), x-session-kit-warnings (percent-encoded JSON).
Agent tool 'session_kit' actions:
- list: summarize workspaces/sessions as text
- export: { mode?, sessionIds?: string[]|'all' } -> write ZIP under defaultExportDirectory(), return path
- import: { path, cwd? } -> readImportFile + importArchive, return summary text

Config fields: maxImportBytes, maxExportBytes, includeAttachments, defaultMode.
Unknown config keys are ignored.

## client.js (NEW)

window.__ModuleLoader__.load({ id: 'dsh-session-kit', factory(require) {...} })
Using only require('react') and host fetch to /session-kit/* (same origin).
Registrations:
- sidebar global panel row under slots 'sidebar.panellist' (id 'session-kit')
- main panel id 'session-kit' rendered when the row is opened
Panel: workspace groups + session rows with checkbox, search, select all/none,
mode radio (精简 compact / 全量 full), optional attachments toggle, Export button
(downloads ZIP returned by POST /export), Import button (file picker -> POST /import).
After import, refresh session list via ctx.get('sessions')?.refresh?.() and show
imported ids. No window.__DSH_* internals except the documented client services
(ctx.get('sessions'), ctx.get('workspaces'), ctx.get('uiWorkspace'), ctx.get('locale')).
Keep no @deepseek-ai/* runtime imports.

## Test expectations

- test/compact.test.mjs: compact a synthesized source event list; assert drops,
  seq contiguity, and validity via real persistence import + readSession when
  available (guard with try/import + skip).
- test/sessions.test.mjs: pure helper tests (foldTitle, sessionSummary).
- test/export.test.mjs: buildArchive with mocked ctx/services; inspect ZIP via
  readZipEntries; manifest checks; mode full vs compact; attachments.
- test/import.test.mjs: import an archive built in the test into a real
  session-persistence-jsonl root under test/tmp, then list/open it; test
  format-version rejection, bad zip, duplicate ids.
- Real-backend helper: test/support/real-context.mjs (Lead writes it):
  createTempContext() -> { ctx, root, cleanup } using the repo's tsx source
  imports is NOT available from a standalone plugin; tests may instead import
  '@deepseek-ai/dsh-session-persistence-jsonl' only when run from the repo
  (node --import tsx/esm). If that import fails, skip with a message.
## Workspace file support (0.2.0)

### lib/workspace-files.js (NEW)

```js
export const DEFAULT_EXCLUDED_DIRS        // .git, node_modules, .venv, dist, build, ...
export const DEFAULT_SENSITIVE_PATTERNS    // .env*, *.pem, *.key, .npmrc, .ssh, ...
export function isSensitivePath(relPath)   // -> boolean
export function isExcludedDir(relPath)     // -> boolean
export function deriveTouchedFiles(events, sessionCwd)
// -> { paths: Set<string> (absolute), presented: Set<string>,
//      toolTargets: Set<string>, cwdHints: Set<string> }
export function workspaceArchiveKey(rootPath)
// -> 'workspaces/<safe-encoded-path>' (stable, one folder per workspace root)
export async function collectWorkspaceTree(rootPath, {
  excludeDirs, excludePatterns, maxFiles, maxFileBytes, maxTotalBytes,
})
// -> { files: [{ absPath, relPath, size, archivePath }],
//      totalBytes, warnings: string[], skipped: [{ path, reason }] }
// Never follows symlinks; skips excluded/sensitive/oversized files with a warning.
```

### Export options (lib/export.js buildArchive)

```js
buildArchive(ctx, {
  sessionIds, mode, includeAttachments,
  includeSubagents = false,        // skip subagent transcript sessions by default
  includeWorkspaceFiles = false,   // add the whole workspace tree(s)
  workspaceExclude = [],           // extra dir/name globs
  workspaceMaxBytes,                // optional cap for the workspace part
  maxExportBytes, signal,
})
// archive adds:
//   workspaces/<workspaceArchiveKey>/<relPath...>
// manifest adds:
//   workspaces: [{ path, archivePath, sessionIds, bytes, files, skipped }]
//   sessions[].touchedFiles / presentedFiles / workspaceKey?
// Sensitive files are never read into the archive; skips are reported as warnings.
```

### Import options (lib/import.js importArchive)

```js
importArchive(ctx, {
  buffer, cwd, workspaceId, restoreWorkspaceFiles = false,
  maxImportBytes, signal,
})
// Subagent-origin sessions are never imported (reported as warnings).
// restoreWorkspaceFiles=true extracts manifest workspaces under cwd with
// path-traversal, absolute-path and symlink rejection; existing files are
// skipped with a warning. Imported sessions then record cwd as their cwd.
```

### Routes / tool additions

- POST /session-kit/export body additionally accepts
  `includeWorkspaceFiles`, `includeSubagents`, `workspaceExclude`.
- POST /session-kit/import query additionally accepts `restoreWorkspaceFiles=1`.
- session_kit tool: export accepts `includeWorkspaceFiles`/`includeSubagents`;
  import accepts `restoreWorkspaceFiles` (boolean).
### Additional helper

`collectTouchedFiles(paths, { rootPath, ...collectOptions })` collects only the
given absolute paths through the same exclusions/budget rules as
`collectWorkspaceTree`; the current export uses whole workspace trees, this
helper is available for a future per-session touched-files mode.
