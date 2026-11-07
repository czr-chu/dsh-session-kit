# Session manager for DeepSeek Harness

dsh-session-kit adds a **Session manager** panel and a `session_kit` agent tool
to DeepSeek Harness. It is built for moving conversations between machines,
keeping usable local backups, and managing sessions without editing DSH's
on-disk format by hand.

## What you can do

- Browse sessions grouped by workspace, search titles/ids/cwds, filter active
  or archived, and open a row for storage size, format status, archived state
  and the derived related-file list.
- Export selected sessions as one ZIP. **Compact** keeps the visible
  conversation and the final answer of each turn; **full** keeps the complete
  event log and attachments. Add optional whole-workspace trees with sensitive
  and build paths excluded.
- Import an archive as **new** sessions and optionally restore its workspace
  files. Existing sessions are never overwritten.
- Archive/unarchive, delete to `$DSH_HOME/session-kit-trash`, or explicitly
  erase permanently after a separate confirmation.
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
- Exports contain conversation content and may contain workspace files; review
  an archive before sharing it. Never commit session data or credentials.
- Workspace export skips VCS metadata, dependency/build caches, symlinks and
  credential-shaped files, but it is not a substitute for a security review.

## Install

```sh
dsh plugin --profile web add github:czr-chu/dsh-session-kit#v0.8.1
```

Restart `dsh web` after installing or upgrading. The plugin has no
`@deepseek-ai/*` runtime dependency; it reads DSH capabilities through the
composed service registry.
