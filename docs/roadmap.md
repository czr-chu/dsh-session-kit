# Roadmap

Shipped through 0.14.1:

- session/workspace browsing, search, sorting, progressive per-group rendering,
  archived badges and selection;
- session detail (storage size across retained generations, format status,
  archived state);
- full, compact and compressed multi-session ZIP export, attachments, optional
  whole-workspace trees, and multi-workspace backup (one ZIP per workspace);
- new-session import with post-write verification, optional workspace file
  restore, archived/pinned replay, duplicate preflight and NDJSON progress;
- archive/unarchive and delete-to-trash (single and batch); trash listing,
  restore and purge; opt-in permanent deletion;
- experimental, selectable per-session related-file handling on delete;
- legacy-format migration through DSH's official persistence chain (single and
  batch);
- copy-then-trash move of sessions to existing or newly registered workspaces;
- safe session compression (compact/compressed) with new-id replacement and
  source-to-trash recovery;
- whole-workspace archive/restore: archive member sessions, write a restore
  record, remove only the workspace registration, and restore later without
  moving files;
- DeepSeek public share-link import into a chosen workspace;
- read-only attachment reference report (missing/unverifiable);
- one agent tool (`session_kit`) covering the same operations;
- public-release documentation, security policy, CI and issue templates;
- standard-schema `Config` validation, bundle icon and localized detail documents;
- official-style tsdown/CSS Modules client bundle, reproducible artifact and CI
  format gate;
- two-column Sessions/Tools panel layout with responsive stacking.

Next:

- add a CI job against a pinned DSH checkout so the guarded real-backend cases run;
- add browser smoke tests (Playwright or equivalent) for the panel, archive,
  trash, move and share-import flows;
- add route-level success tests for `/export` and `/import`;
- optional LLM-summarized compact mode on top of the structural compact export;
- per-session touched-files export (the derivation helper exists for deletion);
- streaming archive production for very large workspaces;
- publish to npm/npmmirror with signed provenance under an available name;
- npm/GitHub release automation.
