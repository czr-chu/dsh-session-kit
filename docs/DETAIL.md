# Session manager for DeepSeek Harness

dsh-session-kit adds a **Session manager** panel and a `session_kit` agent tool
to DeepSeek Harness. It is built for moving conversations between machines,
keeping usable local backups, and managing sessions without editing DSH's
on-disk format by hand.

## What you can do

- Use **Workspace backup** to pack one or several projects' sessions and whole file trees (one ZIP per workspace), and restore each through **Import → Archive → Target workspace**.
- Use **Workspace archive** to put a whole project away: archive its sessions, write a restore record, then remove only the workspace registration; the directory, logs and files stay in place and the workspace can be restored later from another workspace. The tools column is split into five tabs, and running sessions disable archive, delete and move.
- Browse sessions grouped by workspace, search titles/ids/cwds, sort by recent /
  created / title / directory, filter active or archived; long groups expand 25
  rows at a time and the selection bar reports ids hidden by the filter. Open a
  row for storage size, format status, archived state and the derived related-file
  list.
- Export selected sessions as one ZIP. **Compact** keeps the visible
  conversation and the final answer of each turn; **compressed** keeps every
  event but truncates oversized output; **full** keeps the complete event log
  and attachments. Add optional whole-workspace trees with sensitive and build
  paths excluded.
- Import an archive as **new** sessions and optionally restore its workspace
  files. Existing sessions are never overwritten. Archived/pinned flags travel
  with the archive and are re-applied best-effort; a duplicate preflight warns
  (or skips with **Skip duplicates**) and the API can stream NDJSON progress.
- Check attachment references read-only: the Attachment check card /
  `attachment_report` reports references whose host file is missing or cannot be
  verified, without deleting anything.
- Archive/unarchive, delete to `$DSH_HOME/session-kit-trash`, restore or
  permanently purge a trash operation from the Trash card, or explicitly erase
  permanently after a separate confirmation.
- Move selected sessions into another workspace (existing or newly registered
  at an absolute existing directory): the copy is written under a new id,
  verified, attached there, and the source is moved to the trash so the move
  stays reversible. A new workspace registration is removed again if every
  session is skipped.
- Compress selected sessions to a new-id `compact` copy (main conversation only)
  or `compressed` copy (all events/tool structure, stream deltas cleared,
  oversized strings truncated), then move the source to the trash. The source
  remains recoverable until its trash operation is purged. Move and compression
  use a two-stage dialog and require an explicit acknowledgement.
- Upgrade legacy logs through DSH's official migration chain; old generations
  are retained and refusals are reported.
- Import a public `chat.deepseek.com/share/<id>` conversation into a chosen
  workspace as a new session.

## Safety notes

- Related-file handling is experimental and best-effort: shell redirections,
  script outputs, and files only mentioned in text are not discoverable, and a
  shared file may be affected. The UI requires an explicit file selection and a
  second confirmation.
- Permanent delete has no trash copy and no rollback.
- Move and compression create new ids and trash the sources; old-id links stop
  working. A new workspace path must be an existing, unregistered directory; it
  is never created or reused implicitly.
- Exports contain conversation content and may contain workspace files; review
  an archive before sharing it. Never commit session data or credentials.
- Workspace export skips VCS metadata, dependency/build caches, symlinks and
  credential-shaped files, but it is not a substitute for a security review.

## Install

```sh
dsh plugin --profile web add github:czr-chu/dsh-session-kit#v0.14.1
```

Restart `dsh web` after installing or upgrading. The plugin has no
`@deepseek-ai/*` runtime dependency; it reads DSH capabilities through the
composed service registry.
