# 0009 — Destructive session rewrites: workspace move and compression

Date: 2026-11-28
Status: accepted
Scope: `lib/move.js`, `lib/compress.js`, `index.js`, `src/client/index.js`

## Context

Two requested operations change or replace committed session storage:

- **Move a session to another workspace**, including registering a new
  workspace at an existing directory.
- **Compress a session** with either `compact` (main conversation only) or
  `compressed` (all events and tool structure, bounded payloads).

DSH binds a session to a workspace through the immutable header `cwd`, and a
session log generation is immutable. There is no supported in-place rewrite.
Both operations therefore follow the same replace-with-a-copy pattern:

1. preflight the source (not live/running, not a subagent transcript, current
   format version);
2. write a new session with a fresh id;
3. read the copy back through the session query;
4. attach it to the workspace;
5. only then move the source directory into `session-kit-trash`.

The source remains recoverable from the trash until the user purges that
operation. The new id means old bookmarks and links stop working.

## Decision

### Workspace move

- The dialog offers **Existing workspace** or **New workspace**.
- A new workspace path must be absolute, already exist, be a directory, and not
  already be registered. The plugin canonicalizes it with `realpath` and
  refuses a registered path with `workspace-exists`; it never silently reuses
  a workspace this request did not create.
- The workspace registration is created only after path validation and current
  format detection. If every session in the batch is skipped, the registration
  created by this request is removed again (the directory and files are kept).
- Active/live, running, subagent and legacy sessions are skipped before any
  write. A failed copy leaves its source untouched.

### Compression

- `compact`: user messages and final answers only (the existing lossy
  conversation spine).
- `compressed`: every event/type/seq and tool structure is kept; streamed
  delta arrays (`stream`, `chunks`, `deltas`) are emptied and oversized
  strings are truncated with an explicit marker.
- Compression is a **replacement**, not an in-place edit: it creates a new id
  and moves the source to the trash. The UI and API state this before the
  operation.
- The source's `cwd` is preserved, so the replacement rejoins the same
  workspace. Archived/pinned state is replayed best effort and reported as a
  warning rather than failing an already-written copy.

### Two-stage confirmation

Both operations use two dialogs:

1. **Configure.** Choose destination/mode and review the exact source list and
   consequences. The primary button is **Continue**.
2. **Danger confirmation.** A red dialog spells out the new id, source-to-trash
   behavior, lossiness and old-id link breakage. The final button is disabled
   until the user checks an explicit "I understand" checkbox. Busy state disables
   both dialogs' controls; Escape/Cancel closes without changes.

The Host independently requires `confirm: true` for `/move` and
`/compress`; a client cannot skip the server-side confirmation. The browser
guards (running/live/legacy) are an early warning only; the backend remains the
authority and never stops an agent automatically.

## Audit of earlier high-risk surfaces

| Surface | Confirmation before this change | Audit result |
| --- | --- | --- |
| Permanent delete | Delete dialog then a separate red permanent-delete dialog | Already two-stage; no change |
| Delete with related files | Delete dialog then separate files/confirmation dialog | Already two-stage; no change |
| Move | One red dialog | Upgraded to two-stage with explicit checkbox |
| Compress | New | Two-stage from the start |
| Trash purge | One red danger dialog, requires server `confirm:true` | Still a single dialog but irreversible; a future UX pass should apply the same two-stage consent. Documented as a follow-up, not silently treated as equivalent. |
| Workspace archive | One confirmation; removes registration only, writes a restore record, logs/files stay | Recoverable through the archive record; one confirmation is acceptable |

Moves and compressions create new ids; restoring the source from trash brings
the old id back. Neither operation deletes workspace files.

## Alternatives considered

- **Rewrite the same id in place.** Rejected: DSH log generations are immutable
  and the supported persistence API offers no replacement; doing it by hand
  would bypass persistence locks, liveness and migration guarantees.
- **Copy only, never trash the source.** Safer but does not fulfill compression;
  it would leave duplicate sessions and no reclaimed space. The trash copy is
  the compromise: reclaimable only after an explicit purge.
- **Create the new workspace only after the first successful copy.** Rejected
  for a simpler rule: validate first, create once, remove the empty registration
  if nothing moved. A crash can leave an empty registration, never a moved
  session without a workspace.
