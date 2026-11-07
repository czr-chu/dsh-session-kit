# Architecture

dsh-session-kit is a DeepSeek Harness plugin bundle (host half + browser half)
that manages, exports and re-imports conversations.

## Host half

`index.js` registers /session-kit routes on the composed WebServer, fenced by
the Connection trust check exactly like the shipped open-in-app plugin, plus a
`session_kit` agent tool. It owns no storage of its own.

```text
index.js                 routes + agent tool + config
lib/sessions.js          DSH service seam: list/read/title/mint/attach/write
lib/compact.js           conversation-only ("compact") log synthesis
lib/workspace-files.js   touched-file derivation + safe workspace tree walk
lib/export.js            multi-session ZIP: manifest, session folders, attachments, workspaces
lib/import.js            archive preflight, new-session creation, workspace restore
lib/manage.js            archive/unarchive, delete-to-trash with lineage and registry cleanup
lib/format.js            canonical session JSONL + attachment ref helpers
lib/zip.js               dependency-free ZIP reader/writer
lib/attachments.js       attachment packing/restore
```

Every DSH capability is read through `ctx.get(...)` (sessionQuery,
sessionPersistence, sessions, attachments, workspaceRegistry, agentPresets,
workingDirectory), so the bundle has no @deepseek-ai runtime imports.

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
Subagent-origin transcripts are skipped. With `restoreWorkspaceFiles`, the
archived workspace trees are extracted under the selected directory after
path-traversal/absolute-path/symlink rejection; existing files are skipped.