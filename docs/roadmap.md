# Roadmap

Done:
- session/workspace browsing and selection (main conversations only by default),
- compact and full multi-session ZIP export,
- attachments, optional whole-workspace export,
- new-session import with post-write verification,
- optional workspace file restore,
- agent tool (`session_kit`).

Next:
- session search, status filter, archived badge,
- official-format migration for legacy sessions (badge, single/batch upgrade),
- archive/unarchive and delete-to-trash (single and batch),
- move session to another workspace and reorder,
- optional LLM-summarized compact mode (summary per turn) on top of the
  structural compact export,
- per-session file selection (only touched/presented files instead of the whole
  workspace tree; \`collectTouchedFiles\` already exists),
- streaming archive production for very large workspaces,
- publish to npm (npmmirror) with signed provenance and a documented security
  review.