# Architecture

dsh-session-kit is a DeepSeek Harness plugin bundle (host half + browser half)
that manages, exports and re-imports conversations.

## Host half

`index.js` registers /session-kit routes on the composed WebServer, fenced by
the Connection trust check exactly like the shipped open-in-app plugin, plus a
`session_kit` agent tool. It owns no storage of its own.

| Surface | Routes |
| --- | --- |
| Read | `GET /session-kit/info`, `GET /session-kit/list`, `POST /session-kit/session-detail`, `POST /session-kit/session-files`, `GET /session-kit/attachment-report` |
| Archive | `POST /session-kit/export`, `POST /session-kit/export-workspace`, `POST /session-kit/import`, `POST /session-kit/import-share` |
| Manage | `POST /session-kit/archive`, `POST /session-kit/unarchive`, `POST /session-kit/delete`, `POST /session-kit/migrate`, `POST /session-kit/move` |
| Trash | `GET /session-kit/trash`, `POST /session-kit/trash-restore`, `POST /session-kit/trash-purge` |

The tool exposes the same operations as actions: `list`, `export`,
`export_workspace`, `import`, `archive`, `unarchive`, `delete`, `migrate`,
`files`, `detail`, `import_share`, `trash_list`, `trash_restore`, `trash_purge`,
`move`, `attachment_report`. Routes and actions share one scope parser
(`parseSessionIdList`), so `sessionIds` is trimmed and de-duplicated everywhere
and `'all'` is accepted only where the action documents it. `detail` mirrors
`POST /session-kit/session-detail` for agents (same 100-id cap, same per-id
error tolerance, no writes).

A fenced rejection answers a JSON envelope
(`{ ok: false, code: 'forbidden' | 'unauthorized' }`) with the rejection status,
so a client can branch on `code`; every other failure uses the same
`{ ok, code, message }` shape. A batch that fails for every id reports the first
failure's status (404 not-found / 409 active / 503 unavailable / 500).

`index.js` resolves its helper modules through a test-only third `apply`
argument (never Loader config): `sessions`, `manage`, `migrate`, `files`,
`share`, `workspaceBackup`, `export`, `import`, `trash`, `move`, `attachmentReport`. A missing member means
"unavailable" for the routes that need it. Modules resolved *inside* another lib
module stay outside that seam: `lib/workspace-backup.js` imports
`lib/export.js`, and `lib/deepseek-share.js` imports `lib/import.js`, directly.

```text
index.js                 routes + agent tool + config
lib/sessions.js          DSH service seam: list/read/title/mint/attach/write
lib/compact.js           conversation-only ("compact") log synthesis
lib/workspace-files.js   touched-file derivation + safe workspace tree walk
lib/export.js            multi-session ZIP: manifest, session folders, attachments, workspaces
lib/workspace-backup.js  one workspace: all sessions + one file tree, manifest.backup
lib/import.js            archive preflight, new-session creation, workspace restore
lib/manage.js            archive/unarchive, delete-to-trash with lineage and registry cleanup
lib/move.js              copy a session into another workspace, verify, then trash the source
lib/trash.js             trash operation manifest inventory, restore and permanent purge
lib/format.js            canonical session JSONL + attachment ref helpers
lib/zip.js               dependency-free ZIP reader/writer
lib/attachments.js       attachment packing/restore
lib/attachment-report.js read-only missing/unverifiable attachment reference scan
```

Every DSH capability is read through `ctx.get(...)` (sessionQuery,
sessionPersistence, sessions, attachments, workspaceRegistry, agentPresets,
workingDirectory), so the bundle has no @deepseek-ai runtime imports.

## Browser half

`src/client/index.js` is bundled by tsdown into `lib/client.js`, the
`window.__ModuleLoader__.load({ id, factory })` artifact the DSH client module
system loads. Static styling lives in `src/client/styles.module.css` and is
compiled by Lightning CSS into the same factory; runtime button tones and
dynamic state stay as minimal inline styles. The panel registers through
`ctx.slots.inject` / `ctx.slots.register`, localizes through `ctx.locale`,
and talks to the Host only through the fenced `/session-kit/*` routes.
`npm run build:client` regenerates the committed artifact; CI rebuilds it and
fails when the artifact differs.

The panel loads the whole catalog once, groups sessions by workspace, and keeps
selection in a `Set`. Rendering is progressive: each group initially shows
`GROUP_PAGE_SIZE = 25` rows and a "show more" button grows every group window by
25; filtering/sorting changes reset it. A sort selector
(recent/created/title/path) orders sessions inside each group. Group checkboxes
select all filtered sessions, including rows the window has not rendered yet,
and the selection bar reports how many selected ids sit outside the current
filter. Dialogs trap Tab/Shift+Tab, close on Escape and use
`role="dialog"`/`aria-modal`. See
[decisions/0005](decisions/0005-panel-usability.md).

## Workspace backup

DSH's file-owning unit is the workspace, not the session. The Workspace backup
card and `session_kit action=export_workspace` resolve workspace ids through
`ctx.workspaceRegistry`, take every session the registry lists for each
(filtering missing ids), and call `buildArchive` with
`includeWorkspaceFiles: true` and
`backup: { kind: 'workspace', workspaceId, title, path }`. The collector is
pinned to that workspace root, so each archive contains one
`workspaces/<key>/` tree, not one tree per session.

One request produces one ZIP. The panel supports a multi-select of workspaces and
calls the route once per selected workspace, downloading each ZIP separately; the
tool accepts `workspaceIds` (max 20) and writes one file per workspace. A failed
workspace does not abort the rest; results are reported per workspace. The
route `POST /session-kit/export-workspace` itself stays single-workspace and
streams the ZIP with `x-session-kit-workspace*` headers. See
[decisions/0004](decisions/0004-multi-workspace-backup.md).

Restore uses the normal import path with a selected target workspace: the ZIP's
workspace tree is unpacked into the target cwd, sessions are created there, and
`attachToWorkspace` joins them to that workspace. A target workspace must exist
first; existing files are skipped, and archived/pinned state is not restored.

## Export model

One ZIP = one manifest plus per-session folders:

```text
manifest.json                      v1 manifest with sha256 checksums
README.md                          restore instructions
sessions/<id>/session.v4.jsonl     full mode
sessions/<id>/session.compact.v4.jsonl  compact mode
sessions/<id>/meta.json
attachments/media/<id>.<ext>
attachments/files/<2>/<digest>/<name>
workspaces/<encoded-workspace>/... whole workspace tree (optional)
```

Compact mode keeps the visible conversation only: user messages, image/file
blocks and the final assistant answer of each turn, plus session-level config,
model request context and one title event. Tool calls, tool results, reasoning,
stream chunks, jobs, subagent events and workspace events are dropped. Event
`seq` values are renumbered and the title's `messageSeqs` are remapped so the
result is a valid v4 log that DSH can replay and continue.

`compressed` sits between `full` and `compact` (`lib/compressed.js`): every
event keeps its type, order and `seq` (so the log is still valid v4), while
`stream`/`chunks`/`deltas` arrays become `[]` and strings over 8 KiB are cut
with a visible marker; an event still over 16 KiB has its string budget halved
and is pruned again. The header is cloned verbatim. The log is stored as
`sessions/<id>/session.compressed.v4.jsonl`; import treats it as a normal log.
See [decisions/0001](decisions/0001-compressed-export-mode.md).

The written header keeps the canonical fields in a fixed order and passes
through any other header field verbatim (`headerLineOf` in `lib/format.js`), so
an export does not drop metadata a newer DSH adds. Import does not propagate
those extra fields: it rebuilds a minimal header for the new session. The
manifest and each `sessions/<id>/meta.json` also carry the registry's
`archived`/`pinned` flags when set, so a round trip can restore them.

## Listing model

`/session-kit/list` never opens a cold session log. Titles come from the
projection cache (`sessionProjectionCache.cachedSnapshot`), including the
predecessor-title hint for checkpoints written before a format-generation
migration; live sessions use the title service's in-memory fold. Archived ids
from the registry are merged into the listing even when the session-query
corpus does not return them, so an archived conversation is always visible and
marked. The list endpoint is O(one persistence scan + rows), not O(rows × log).

## Management model

Archive state is the registry-global set (`workspaceRegistry.archiveSession` /
`unarchiveSession`); the panel lists archived sessions with an `archived` flag
instead of hiding them. Deleting a session never erases bytes: the session
directory and its subagent descendants are moved to
`<DSH_HOME>/session-kit-trash/<timestamp>/` after strict location validation
(jsonl backend, directory name equals the encoded session id, canonical project
directory, real non-symlink directory). User-visible fork/seeded children are
not part of the lineage closure and survive. Workspace membership, pins and the
archive flag are cleaned afterwards; cleanup failures are logged, not reported
as a failed delete.

Every delete also writes `operation.json` in the operation directory **before**
the first move: kind/version, `createdAt`, root session, one entry per moved
session (`originalDir`, `cwd`, `createdAt`, `formatVersion`), the derived
`sessionsRoot`, and the pre-delete `archived` / `pinned` snapshots. A failed move
rolls the whole batch back and removes the manifest, so a manifest always
describes a complete operation. `lib/trash.js` reads that manifest for the
Trash card and the `trash_list` action (`{trashDir}` only, up to 500
operations); a legacy directory without a manifest is listed but marked
`restorable: false` with a warning.

`trash_restore` validates the operation id as a plain directory name inside the
trash root, checks the manifest kind/version, and only moves a session back when
its recorded `originalDir` still lies inside the recorded `sessionsRoot`
(anti-tamper) and no live target exists; an existing target is skipped, never
overwritten. A restored directory is re-attached through
`registry.resolveByPath(...).attachSession(id)`, then archived/pinned state is
replayed best-effort. Partial restores rewrite the manifest; a fully restored
operation with no `files/` subtree is removed. `trash_purge` requires
`confirm: true`, accepts explicit ids or `all` (optionally `olderThanDays`) and
`rm -rf`s only validated operation directories, returning removed ids and freed
bytes. Attachments are not touched by purge (the attachment store has no delete
API), and subagent transcripts are never imported.

## Workspace move model

DSH derives workspace membership from the session header's `cwd`
(`WorkspaceEntity.attachSession` requires that realpath), so a session cannot be
re-labelled into another workspace in place. `POST /session-kit/move` (tool
action `move`) therefore performs a **copy-then-trash** move per session
(`lib/move.js`): preflight the source (skip live/running sessions, subagent
transcripts and older-format logs before any write), copy it as a new session
with `cwd` = destination workspace path, read the copy back through
`sessionQuery.readSession`, attach it to the destination, replay
archived/pinned state best-effort, and only then move the source directory into
the trash (the same `deleteSession` path and `operation.json` manifest as a
normal delete). A copy that cannot be read back leaves the source untouched; a
failed trash move keeps the copy and reports `sourceTrashed: false`. The batch
is per-session tolerant (100-session cap) and requires `confirm: true`.
Consequences: the moved session has a new id (old links stop working; restoring
the trash brings the old id back), event payloads are copied verbatim,
subagent transcripts are not copied (they travel with the source into the
trash), and attachment bytes stay shared through the content-addressed store.
See [decisions/0003](decisions/0003-workspace-move.md).

## Format migration model

DSH keeps released generations immutable and migrates lazily: reading an old
session transforms it in memory, and the current generation is published only by
`SessionPersistence.open(id, 'write')` (the same path a normal continued
conversation takes). This plugin's migrate action calls only that seam, closes
the handle immediately, and verifies the result with a second `stat`; it never
decompresses or re-encodes a log itself. The old generation stays on disk, and a
refusal from the official migration leaves the source unchanged and is reported
per session. `/session-kit/list` exposes `formatStatus` / `legacy` so the panel
can badge and batch-migrate old rows.

## Session detail and permanent delete

Clicking a row loads `POST /session-kit/session-detail` (storage size from the
backend-resolved session directory, all retained generations, locks excluded)
and `POST /session-kit/session-files` (the derived related-file preview), so the
row can show both the size and its best-effort file list without opening logs The delete dialog groups
derived files by session, preselects strong evidence only, and sends an explicit
`selectedFiles` list. A separate permanent-erase mode deletes the validated
session directories and selected files after a distinct red confirmation; it has
no rollback, never uses the trash, and reports which items were removed if a
failure occurs.

## Related-file deletion

`lib/session-files.js` derives a best-effort set of workspace files from the
selected session and its subagent descendants (presented deliverables, tool
result metadata, tool arguments, working-directory hints). The plan keeps only
existing regular files under the owning workspace root, rejects symlinks and
paths outside it, and excludes the Harness home, session storage and trash.
Delete moves those files first into the operation's
`<trash>/files/<encoded-root>/<relative>` tree with a `files-manifest.json`,
then moves the session directories; any failure rolls back the moved files and
aborts before the sessions move. This is an approximation, never a complete
touched-file index, and the UI requires a second confirmation.

## DeepSeek share import

`lib/deepseek-share.js` accepts only a `chat.deepseek.com/share/<id>` link or a
bare share id, fetches the public content API with a timeout and a byte cap,
normalizes fragments (REQUEST/RESPONSE/THINK/TOOL_* citations), builds a v4
session log with turn/step pairs and the share importer's event skeleton, then
hands the canonical JSONL to the existing import path. The chosen
`workspaceId` (or cwd) becomes the new session's cwd and attach target, so the
conversation lands in the requested workspace.

## Import model

Import always creates new sessions (never mutates or deletes existing ones).
The header is rewritten (new id, no parent/origin, cwd = chosen directory),
delivery markers and inherited end-seed markers are rewritten for the new owner,
attachments are restored into the content-addressed store, and each session is
read back through `sessionQuery.readSession` as a post-write verification.
Subagent-origin transcripts are skipped. Before writing, a duplicate preflight
compares each source id with `persistence.list()`: duplicates are still imported
as new-id copies with a warning, unless `skipDuplicates` filters them (all
filtered → `no-session`). After verification, `archived`/`pinned` carried by the
manifest or `meta.json` are re-applied to the new id through the workspace
registry; a registry failure is a per-session warning, never a rollback. With
`restoreWorkspaceFiles`, the archived workspace trees are extracted under the
selected directory after path-traversal/absolute-path/symlink rejection;
existing files are skipped.

`POST /session-kit/import?progress=ndjson` writes the same operation as
newline-delimited JSON: one `{event:"session", index, total, sessionId, mode,
verified, warnings}` line per committed session, then `{event:"done", ok:true,
...result}` or `{event:"error", ok:false, code, message}`. Headers are flushed
before the archive is committed, so late failures end with an `error` line. The
default response remains a single JSON object.

## Attachment reference report

`lib/attachment-report.js` is a read-only diagnostic. It scans up to 300
sessions (newest first), collects each log's image/file attachment references
and checks the provider's host path with `stat()`. Each reference is classified
`ok`, `missing` (path absent/not a file) or `unverifiable` (no attachment
service, no host-path method, or empty path); bytes are never read. It returns
`{scannedSessions, sessionTotal, limit, truncated, totalReferences, missing,
unverifiable, warnings}` through `GET /session-kit/attachment-report` and the
`attachment_report` tool action (limit ≤ 300, positive integer). It deletes,
rewrites and repacks nothing, and it is not an orphan enumeration: the
attachment store has no list/delete API in the supported surface, so only
references that no longer resolve can be reported safely.