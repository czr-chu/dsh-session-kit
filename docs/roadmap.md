# Roadmap

Shipped through 0.10.2:

- session/workspace browsing, search, status filters, archived badges and selection;
- session detail (storage size across retained generations, format status, archived state);
- compact and full multi-session ZIP export, attachments, optional whole-workspace export;
- new-session import with post-write verification and optional workspace file restore;
- archive/unarchive and delete-to-trash (single and batch); opt-in permanent deletion;
- experimental, selectable per-session related-file handling on delete;
- legacy-format migration through DSH's official persistence chain (single and batch);
- DeepSeek public share-link import into a chosen workspace;
- one agent tool (`session_kit`) covering the same operations;
- public-release documentation, security policy, CI and issue templates;
- standard-schema `Config` validation, bundle icon and localized detail documents;
- official-style tsdown/CSS Modules client bundle, reproducible artifact and CI format gate;
- two-column Sessions/Tools panel layout with responsive stacking.

Next:

- add a CI job against a pinned DSH checkout so the guarded real-backend cases run;
- add browser smoke tests (Playwright or equivalent) for the panel, detail, file
  selection, permanent delete and share-import flows;
- add route-level success tests for `/export` and `/import`;
- optional LLM-summarized compact mode on top of the structural compact export;
- per-session touched-files export (the derivation helper exists for deletion);
- streaming archive production for very large workspaces;
- publish to npm/npmmirror with signed provenance;
- npm/GitHub release automation.
