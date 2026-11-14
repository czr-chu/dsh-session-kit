# 0008 — Tools panel tabs and dangerous-action guards

Date: 2026-11-14
Status: accepted
Scope: `src/client/index.js`, `src/client/styles.module.css`, `test/client-build.test.mjs`

## Context

The browser panel stacked six tool cards in one 340px column: export,
workspace backup, workspace archive, import, trash and attachment check. The
workspace archive card also carries a list of every archived workspace, so the
column became long enough that the lower cards were hard to reach.

Two different "archive" actions were also presented without enough separation.
The archive button in the session selection bar archives the selected
**sessions**; the workspace archive card archives every session in a workspace
and then removes the workspace registration. Selecting a workspace did not
make the difference obvious.

The backend already refuses to archive or delete a session while its agent is
running (`assertNotActive` in `lib/manage.js`), and the move path skips active
or legacy sessions. The browser only learned about that after submitting, so
the controls looked usable when the operation was guaranteed to fail.

## Decision

1. **Five tools tabs.** The right column becomes `Export`, `Workspaces`,
   `Import`, `Trash` and `Checks`. Export keeps export plus workspace backup;
   Workspaces holds the whole-workspace archive; Checks holds the attachment
   report. Only one tab body is rendered at a time, so the column stays short.
2. **Session and workspace archive are named apart.** The selection bar and
   row actions say "Archive session" / "Unarchive"; the Workspaces tab keeps
   "Archive whole workspace" and its hint explicitly says it archives every
   session and removes the workspace registration.
3. **Block dangerous actions before submitting.** Sessions that are running or
   open (`live`) disable archive, delete and move, with the reason shown in the
   selection bar, the row tooltip and a notice if the action is still invoked.
   Legacy sessions disable move (matching `lib/move.js`). A workspace with a running member
   cannot be archived as a whole. Backend checks remain the authority; this is
   an additional, earlier guard.
4. **No auto-stop.** The guard never stops an agent to make an operation
   possible. The user must stop it explicitly, which keeps the destructive path
   intentional.

## Alternatives considered

- **Accordion cards.** Collapsing cards reduces height but keeps six competing
  headers and still hides the workspace archive among them. Tabs express the
  task grouping better.
- **A separate route or window.** Too large for the problem; the panel already
  has a modal/dialog vocabulary.
- **Automatically stopping the agent.** Rejected: archiving or deleting a
  running session must not silently interrupt work.
- **Only reporting the backend error.** Rejected: the controls should not look
  available when the action cannot succeed.

## Consequences

- Switching tabs adds one click; the default Export tab is the most common
  entry point.
- The browser guard uses `running`, `live` and `legacy` from
  `GET /session-kit/list`. The backend error path remains necessary for states
  the catalog does not expose.
- The tab state is local and resets when the panel reloads.

## Verification

- `test/client-build.test.mjs` asserts the tab wiring, `dangerMessages` /
  `refuseDangerous`, the workspace-archive guard and the selection guard.
- `npm run lint` covers free identifiers in the client source.
- `npm test` (331 tests), `npm run build:client`, `npm run format:check`.
- Manual smoke still required before release: open the panel on DSH
  0.2.2-rc.3, switch all five tabs, select a running session and confirm
  archive/delete/move are disabled; select a workspace with a running member
  and confirm its archive button is disabled. The build and source tests do not
  exercise layout or a real browser.

## Rollback

Remove the tab wrapper and render the cards in their previous order; remove
the guard helpers and the disabled/title expressions. No route, storage or
manifest format changes are involved.
