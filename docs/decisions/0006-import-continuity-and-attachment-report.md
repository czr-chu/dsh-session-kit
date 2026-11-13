# 0006 — Import continuity, duplicate preflight, progress stream and the attachment reference report

- Status: accepted
- Date: 2026-11-13
- Scope: P7 (B4, B11, B12, B3′)

## Context

Round-tripping a conversation through export/import lost two facts that the
workspace registry owns: whether the session was **archived** and whether it was
**pinned**. The planner also could not tell whether an archive contained
conversations that already exist locally, long imports gave the browser no
progress, and the attachment store has no delete/GC API, so "orphan attachment
cleanup" could only be a read-only diagnosis.

## Decision

### B4 — preserve archived/pinned through export and import

- The exporter writes `archived: true` / `pinned: true` into both
  `manifest.json` sessions and each `sessions/<id>/meta.json`, using the flags
  already present on `listSessionEntries` rows.
- The importer carries those flags next to each parsed document and, after the
  post-write verification, re-applies them to the **new** session id through
  `workspaceRegistry.archiveSession(id, { stopActivity: false })` and
  `pinSession(id)`. Each re-application is try/catch: the bytes are already
  imported, so a registry failure becomes a per-session warning, never a
  rollback.
- Flags are optional; archives without them import exactly as before.

### B11 — duplicate preflight and `skipDuplicates`

- Before writing anything, the importer lists local session ids
  (`persistence.list()`, tolerant of a missing/failing listing) and compares them
  with each document's **source** header id.
- Default: every duplicate adds a warning (`会话 … 在本机已存在；本次导入会创建
  新 id 的副本`) and the copy is still imported. This is a warning, not a
  refusal, because copying a known conversation under a new id is a legitimate
  use.
- `skipDuplicates: true` (HTTP query `?skipDuplicates=1`, tool argument, panel
  checkbox) filters those documents out and adds one summary warning. If every
  document is filtered the import fails with `no-session` rather than silently
  importing nothing.
- The comparison is against the source id; imported sessions always receive a
  fresh id, so it cannot be used to overwrite anything.

### B12 — NDJSON progress

- `POST /session-kit/import?progress=ndjson` switches the route to
  `application/x-ndjson`. One JSON object per line:
  `{event:"session", index, total, sessionId, mode, verified, warnings}` for each
  committed session, then `{event:"done", ok:true, ...result}` or
  `{event:"error", ok:false, code, message}`.
- Headers are written before the archive is committed, so a failure after that
  point is reported as a final `error` line and the connection ends normally.
- The default (non-streaming) response is unchanged. The panel keeps the JSON
  path; NDJSON exists for browser code and API clients that want incremental
  feedback without a job store.

### B3′ — read-only attachment reference report

- `lib/attachment-report.js` scans up to 300 sessions (newest first) and, for
  each image/file reference in the log, checks the provider's host path with
  `stat()`.
- Outcomes are `ok`, `missing` (host path does not exist / is not a file), or
  `unverifiable` (no attachment service, no host-path method, or empty path —
  the report never reads bytes just to prove they exist).
- `GET /session-kit/attachment-report?limit=&includeSubagents=1` and the
  `attachment_report` tool action return
  `{scannedSessions, sessionTotal, limit, truncated, totalReferences, missing,
  unverifiable, warnings}`. Nothing is deleted, rewritten or repacked.
- This is deliberately **not** an orphan listing: the store is append-only and
  exposes no enumeration API in the supported DSH surface, so the report answers
  the safe question ("which references no longer resolve?") rather than guessing
  at unreferenced blobs.

## Alternatives considered

- **Persist flags in a sidecar index at export time** — rejected: `meta.json` and
  `manifest.json` already exist per session and are the natural carriers.
- **Treat duplicates as an error by default** — rejected: legitimate
  "import as a copy" workflows exist; warnings keep the default non-destructive.
- **Server-sent events / WebSocket job stream** — rejected: NDJSON over the
  existing POST response needs no new route family or job store.
- **Enumerate the attachment store and diff** — impossible through the supported
  interface; a plugin-side scan of DSH internals would be version-fragile and
  risks treating live files as orphans.

## Consequences

- Old archives remain valid (missing flags simply mean "not archived/pinned").
- A restored archived session stays visible in the panel's archived filter and a
  restored pin survives a restart, matching the source workspace.
- Streaming changes only the response representation; the commit semantics,
  caps and error codes are the same.
- The attachment report is cheap (stat per reference, at most 300 sessions) but
  can report `unverifiable` on backends without host paths; that is surfaced,
  not hidden.

## Verification

- `test/export.test.mjs` — manifest/meta carry archived+pinned.
- `test/import.test.mjs` — flags re-applied to the new id, progress entries,
  duplicate warning, `skipDuplicates` → `no-session` when everything is skipped.
- `test/index-import.test.mjs` — `skipDuplicates` forwarding, NDJSON session and
  error events.
- `test/attachment-report.test.mjs` — ok/missing/unverifiable classification,
  truncation, invalid limit.
- `test/index-attachment-report.test.mjs` — query parsing, 503/403, tool text and
  invalid limit.
- Full suite: 313 tests, 304 pass, 9 guarded skips; `npm run format:check` clean;
  client bundle rebuilt.

## Rollback

Revert the `meta`/`manifest` flag spread and `restoreRegistryState`, the
duplicate preflight block, and the `progress=ndjson` branch; the report is a new
route/tool/file, so deleting it restores the previous surface. No stored data
format changed: flags are additive JSON fields and new sessions keep normal ids.
