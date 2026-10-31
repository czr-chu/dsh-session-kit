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

## Import model

Import always creates new sessions (never mutates or deletes existing ones).
The header is rewritten (new id, no parent/origin, cwd = chosen directory),
delivery markers and inherited end-seed markers are rewritten for the new owner,
attachments are restored into the content-addressed store, and each session is
read back through `sessionQuery.readSession` as a post-write verification.
Subagent-origin transcripts are skipped. With `restoreWorkspaceFiles`, the
archived workspace trees are extracted under the selected directory after
path-traversal/absolute-path/symlink rejection; existing files are skipped.
