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
## Session management (0.3.0)

### lib/manage.js (NEW)

```js
export async function archiveSession(ctx, sessionId, { stopActivity = false } = {})
// workspaceRegistry.archiveSession(sessionId, { stopActivity }); live/running
// sessions reject with code 'active' unless stopActivity is true.

export async function unarchiveSession(ctx, sessionId)
// workspaceRegistry.unarchiveSession(sessionId); idempotent.

export async function deleteSession(ctx, sessionId, { trashDir } = {})
// -> { sessionIds: string[], trashedPath: string }
// Refuses live sessions (ctx.sessions.get(id)) and running agents. Collects the
// session and every subagent descendant (parentSession chain restricted to
// origin='subagent'); user-visible fork/seeded children are preserved.
// verifies each backend location is a session directory named encodeSegment(id)
// under a '--project--' / '_no-cwd' directory, then moves all directories under
// <DSH_HOME>/session-kit-trash/<ISO stamp>/ (rename, EXDEV copy+rm fallback).
// Detaches each id from every workspace, unpins and unarchives it. Refuses the
// whole operation before moving anything if any target is live.
// Errors: 'not-found', 'active', 'unsafe-location', 'delete-failed'.
```

### list entries

`listSessionEntries` adds `archived: boolean` and `pinned: boolean` from
`workspaceRegistry.archivedSessionIds` / `pinnedSessionIds`; archived sessions
remain in the list (marked), not hidden.

### Routes

- POST /session-kit/archive  body `{ "sessionIds": [..], "stopActivity"?: false }`
- POST /session-kit/unarchive body `{ "sessionIds": [..] }`
- POST /session-kit/delete    body `{ "sessionIds": [..] }`
-> `{ ok: true, results: [{ sessionId, ok, error? }], archivedSessionIds? }`
Delete is a trash move; nothing is permanently erased. Batch cap 500.
GET /session-kit/list response sessions include the two new booleans.

### Agent tool

`session_kit` actions add:
- `archive` / `unarchive`: `sessionIds` required;
- `delete`: `sessionIds` required and `confirm: true` required (moves to trash).

### Client

Rows show an "archived" badge and a dimmed style; toolbar/filter:
- search input matches title/id/cwd/workspace (already present; keep),
- status filter: all / active / archived,
- per-row and batch actions: archive, unarchive (only archived), delete with a
  confirmation dialog that names the sessions and says they move to
  `session-kit-trash`,
- after each action refresh the list and show per-session failures.
## Session format migration (0.4.0)

DSH reads released historical generations through its own migration chain and
publishes the current generation lazily: `SessionPersistence.open(id, 'write')`
runs the official `prepareStoredMigration` + `publishStoredMigration` path before
granting the write handle. Released generations are never deleted.

### lib/migrate.js (NEW)

```js
export async function listLegacySessionIds(ctx)
// -> Promise<string[]> from persistence.list() snapshots whose
//    formatStatus === 'migration-required' (current logs are skipped).

export async function migrateSession(ctx, id)
// -> { sessionId, status: 'migrated' | 'current', fromVersion?: number,
//      toVersion: number }
// Refuses live/running sessions (code 'active'); missing -> 'not-found'.
// Reads persistence.stat(id); a current snapshot resolves without writing.
// A historical snapshot is migrated ONLY through
// persistence.open(id, 'write') + close(), then verified with a second stat
// (formatStatus must be current). The source generation is left untouched.
// Failures throw code 'migration-failed' with the official refusal message;
// the original log remains readable.
```

### List entries

`listSessionEntries` adds `formatStatus` (`'current' | 'migration-required'`,
when reported) and `legacy: boolean` (true exactly for `migration-required`).
Archived-merged snapshots expose their stat formatStatus too.

### Routes

- POST /session-kit/migrate body `{ "sessionIds": string[] | "all", "confirm"?: true }`
  -> `{ ok: true, results: [{ sessionId, ok, status, error? }], migratedCount,
       legacyRemaining }`; batch cap 100; `all` expands the legacy ids and
  requires `confirm: true`. Per-id failures stay in results; a total failure
  follows the same status mapping as the other management routes.
- GET /session-kit/list sessions include `formatStatus` / `legacy`.
- /info capabilities add `migrate`; expose `legacyCount` in /list or /info
  diagnostics is optional.

### Agent tool

`session_kit` action `migrate`:
- `sessionIds` explicit ids, or `'all'` (requires `confirm: true`).
- Returns a text summary with per-session success/failure.

### Client

- Legacy rows show a "旧格式 vN" / "Legacy format" badge (from `legacy`).
- Toolbar shows "旧格式 N" and a batch "升级旧格式" button; each legacy row has
  an "升级格式" action.
- Confirmation explains it uses DSH's official migration, keeps the old
  generation, and never changes a failed session.
- After running, refresh the list and show per-id success/failure.
## Delete with related workspace files (0.5.0)

DSH does not keep a complete "files this session touched" index. The plugin can
only derive a **best-effort** list from session events plus the workspace root:

- `deliverables/presented.files[].path` (strong),
- `tool/result.data.meta.{path,cwd,diffs[].path}` (strong),
- `tool/*.data.arguments.{file_path,path,target,dest,files[].path}` (weak: the
  model asked for it, the file may never have been written),
- `working-directory/change.data.cwd` (context for relative paths).

Derivation includes the selected session and its `origin:'subagent'` descendants
(the same closure the delete already moves), resolves relative paths against the
session cwd, keeps only existing regular files under that session's workspace
root, rejects symlinks and paths outside the root, and de-duplicates across
sessions. It is inherently approximate: shell redirections, PTC scripts, and
files only mentioned in text are not discoverable. The UI must state this and
require an explicit second confirmation.

### lib/session-files.js (NEW)

```js
export async function deriveSessionFilePlan(ctx, sessionIds)
// -> { files: [{ path, relative, root, bytes, evidence: string[],
//                weak: boolean, sessionIds: string[] }],
//      skipped: [{ path, reason }], warnings: string[], totalBytes }
// Reads each session and its subagent descendants from persistence, runs
// workspace-files.deriveTouchedFiles, filters to existing regular files under
// the workspace root (or cwd when no workspace owns it), excludes DSH_HOME and
// the trash root.
```

### deleteSession options and result

```js
deleteSession(ctx, sessionId, {
  trashDir,
  removeFiles = false,   // also move derived workspace files to trash
  filePlan,              // optional precomputed plan from deriveSessionFilePlan
})
// -> { sessionIds, trashedPath,
//      filesMoved, filesSkipped, filesBytes, filesTrashPath?, fileWarnings }
// Files move first under <trashedPath>/files/<encoded-root>/<relative path>
// with a files-manifest.json (original absolute paths + evidence). Any file
// move failure rolls the moved files back and aborts before session directories
// move; a later session move failure rolls both back. Files are never erased.
```

### Routes / tool

- POST /session-kit/session-files body `{ sessionIds: string[] }`
  -> `{ ok: true, files, skipped, warnings, totalBytes }` (preview; batch cap 100).
- POST /session-kit/delete body `{ sessionIds, confirm: true, removeFiles?: boolean }`
  -> adds the file-move stats above. Without `removeFiles` behavior is unchanged.
- `session_kit` delete action accepts `removeFiles`; `confirm:true` still required.
  A new `files` action previews the derived plan.

### Client

- Delete confirmation gains a checkbox "同时移走该会话涉及的文件（移到回收站）"
  (default off). Checking it loads the preview and shows count/size plus a
  warning that derivation is best-effort and shared files may be affected.
- The final confirmation is a **second dialog** that lists the files (bounded)
  and requires a separate confirm button before POST /delete with
  `removeFiles:true`.
- Result shows moved/skipped file counts and warnings.
