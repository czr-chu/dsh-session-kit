# 0001 — Compressed export mode (`compressed`)

- Status: accepted
- Date: 2026-11-13
- Affects: `lib/compressed.js`, `lib/export.js`, `lib/import.js`, `index.js`, `src/client/index.js`

## Context

`full` archives every byte of a session log and can be very large; `compact`
keeps only the conversation spine and loses tool calls, reasoning and runtime
records. Users asked for a middle mode that keeps the structure of the session
(tool calls, results, turn/step pairing) but bounds the size of the heavy
payloads. The archive must still import as a normal DSH session, because the
import path refuses logs that are not valid v4.

## Decision

`compressed` is a **structure-preserving, payload-bounding** transform:

1. Every event keeps its `type`, `seq`, `time`, position and every other
   envelope field. No event is dropped, so `seq` stays dense and turn/step
   pairing stays intact.
2. Arrays under `stream`, `chunks` and `deltas` are replaced with `[]`. The
   message or tool-call object around them is kept.
3. Strings longer than `maxStringBytes` (default 8 KiB, UTF-8) are cut on a
   code-point boundary and suffixed with
   `…[dsh-session-kit compressed: 已截断，原长 N 字符，上限 M 字节]`.
4. If an event is still larger than `maxEventBytes` (default 16 KiB) after the
   first pass, the string budget is halved and the event is pruned again (up to
   six times, floor 256 bytes). Arrays and required keys keep their shape, so a
   reader never sees a broken envelope.
5. The header is cloned verbatim (lineage fields included), unlike `compact`,
   which rebuilds a root header.
6. The log is stored as `sessions/<id>/session.compressed.v<n>.jsonl`; the
   manifest records `mode: "compressed"`. Import treats it as a normal v4 log
   (the `compressed` log name is accepted by `modeFromLogName`).

## Alternatives rejected

- **Higher ZIP compression level** — the payload is already deflate; JSON logs
  gain little, and CPU cost is paid on every export.
- **Drop event types instead of truncating** — breaks turn/step pairing and
  referential integrity (a tool result without its call), so the result could
  fail replay.
- **Drop attachments or workspace files only** — already available as
  independent switches (`includeAttachments`, `includeWorkspaceFiles`); the
  user's need was a mode, not another toggle.
- **LLM-summarized compact** — a different, non-deterministic feature; still a
  candidate (B7) but unrelated to byte bounds.

## Consequences

- Lossy: the tail of very large tool results, tool arguments and message bodies
  is gone; streamed reasoning is gone. The archive is not byte-identical to the
  source and cannot restore the dropped tails.
- Still a valid v4 log, so import, replay and continuation work unchanged.
- Deterministic for a fixed input and budget pair, so the committed build
  artifact and archive checksums stay reproducible.

## Verification

- `test/compressed.test.mjs` — invariants above (event/seq preservation, header
  clone, marker text, budget tightening, input validation).
- `test/export.test.mjs` — `compressed mode keeps every event under
  session.compressed.v4.jsonl`.
- `test/index-export.test.mjs` — the route forwards `mode: "compressed"` and the
  tool schema lists all three modes.

## Rollback

The mode is additive. Removing it means dropping `'compressed'` from
`EXPORT_MODES`, `EXPORT_MODE_VALUES`, the tool enum, the client card and the
`modeFromLogName` pattern; existing compressed archives would then import only
as bare-log archives (still valid logs), so no data migration is required.
