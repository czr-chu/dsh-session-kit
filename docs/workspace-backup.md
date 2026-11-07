# Workspace backup and restore

DSH groups sessions by **workspace**, a named project directory. Files belong to
that directory, not to an individual conversation. Workspace backup follows
that model: one ZIP contains every main session in one workspace plus the whole
workspace file tree, collected once.

Use it when a workspace is one project. If one workspace mixes unrelated
projects, split them into separate directories/workspaces first; per-session
file ownership cannot be recovered reliably from DSH's event log.

## Create a backup

In the Web/Desktop panel choose **Workspace backup → Workspace**, then click
**Back up workspace**. The agent tool exposes the same operation:

```text
session_kit action=export_workspace workspaceId=<workspace-id>
```

Route: `POST /session-kit/export-workspace` with
`{ "workspaceId": "...", "mode": "full" | "compact", "includeAttachments": true, "includeSubagents": false }`.

The archive layout extends the normal session archive:

```text
manifest.json                     sessions + workspace files + checksums
README.md                         restore instructions
sessions/<id>/session.v4.jsonl    one folder per main session in the workspace
sessions/<id>/meta.json
workspaces/<key>/...              the whole workspace tree, once
```

`manifest.backup` records `{ kind: 'workspace', workspaceId, title, path }`.
Only that workspace root is packed; a session whose cwd lies outside it is
reported as a warning and its outside tree is not added. Sensitive files,
VCS/dependency/build caches and symlinks follow the same exclusion rules as
normal workspace export.

## Restore a backup

In the panel open **Import → Archive**, choose the workspace ZIP, select the
**Target workspace** (or leave it at the current/default directory), and enable
**Restore workspace files**. The plugin:

1. validates the archive and restores its `workspaces/` tree into the target
   directory without overwriting existing files;
2. creates every imported session as a **new** session with the target cwd;
3. attaches the new sessions to the selected target workspace;
4. verifies each written session by reading it back.

A workspace backup can also be imported with the CLI/route by supplying
`workspaceId` and `cwd`:

```text
POST /session-kit/import?workspaceId=<target-workspace-id>&cwd=<target-path>&restoreWorkspaceFiles=1
```

The target workspace must already exist (create it in DSH first). Existing
files are skipped with a warning; existing sessions are never overwritten.
Archived/pinned state is not restored — imported sessions are new and visible.

## Limits

- A workspace with no main sessions cannot be exported as a session archive;
  back up the directory with normal filesystem tooling instead.
- The backup contains user files; review it before sharing. Secrets that match
  the normal exclusion patterns are skipped, but this is not a security audit.
- Workspace files are collected in memory; very large trees are bounded by
  `maxExportBytes` / `workspaceMaxBytes`.
- Per-session related-file deletion remains experimental and is not the backup
  mechanism.
