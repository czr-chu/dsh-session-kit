# Migration research notes (historical context)

> Historical design context from the initial feasibility study. Current behavior
> is documented in the README, `docs/architecture.md`, and
> `docs/feature-matrix.md`; this page is not maintained as an API reference.

This plugin started from a feasibility study of moving DeepSeek Harness
workspaces and conversations to another machine.

Findings that shaped the design:

- DSH had no built-in session import; the shipped session-log export is one-way
  and archives are not directly importable (the JSONL export is not the zstd
  physical format).
- A session's on-disk directory is derived from its header `cwd`. Moving a log
  without rewriting that `cwd` (and the matching directory name) makes DSH's
  session listing fail, so an importer must create sessions through the product
  API rather than copy files blindly.
- Workspace grouping lives in `$DSH_HOME/storages/workspace.json`; sessions with
  a missing cwd degrade to "Ungrouped" instead of disappearing.
- A session log alone is not enough to continue real work: the products the
  conversation created live in the workspace tree. This plugin therefore packs
  the workspace tree (with secret/build exclusions) and restores it on import.
- Most sessions on a busy machine are subagent transcripts; they are excluded by
  default and never imported, because they are fragments of a main conversation.
- Compact export keeps only the visible conversation so a new machine can
  understand the purpose and continue with the restored files, without carrying
  the full tool-call history.

Validation approach used during development:

- real JSONL persistence backend + product replay validation for compact logs,
- synthetic workspace trees to prove sensitive-file exclusion and zip-slip
  rejection,
- a disposable `DSH_HOME` + headless browser to drive the actual panel:
  select sessions, download the archive, import it, and restore workspace files.
