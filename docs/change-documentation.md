# Change documentation policy

This repository is read by people **and by coding models that do not share the
author's conversation context**. A change is not finished until the documents
below are updated **in the same commit**. Documentation is part of the
deliverable, not a follow-up.

## 1. What counts as a behavior change

Any of the following makes this policy binding:

- a new or removed route under `/session-kit/*`, or a new/removed
  `session_kit` tool action or parameter;
- a new config key, default, limit or constant that changes what users get;
- a change to the archive format (`manifest`, folder layout, checksums) or to
  import/restore semantics;
- a changed safety policy (what requires `confirm`, what is permanent, what is
  excluded, what is skipped);
- a changed status code, error code, or user-visible failure mode;
- a UI flow change in `src/client/`.

Pure refactors with identical observable behavior only need the normal PR
description and a `CHANGELOG` entry under `Changed` if the code structure moved.

## 2. Required documentation layers

| Layer | Where | What must be written | When |
| --- | --- | --- | --- |
| Code contract | module header block of every touched `lib/*.js` / `index.js` | responsibility, inputs, outputs, **failure codes**, and an explicit **"does not do"** list | any change to that module's contract |
| Function contract | JSDoc on exported functions | `@param` types and units, `@returns` shape, thrown `code`s | new or changed export |
| Interface | `docs/architecture.md` (route table, data-flow diagram, archive layout) + the tool `description`/`parameters` in `index.js` | one row per route/action, same wording on both sides | new/changed route or tool action |
| Capability matrix | `docs/feature-matrix.md` | status (稳定 / 稳定（受限）/ 实验性), implementation location, **test evidence by test name**, known limitations | any capability added, promoted or demoted |
| User docs | `README.md` (Features, Configuration, Known limitations) and the topical page (`docs/workspace-backup.md`, …) | behavior + config table row + explicit limitation | user-visible behavior or config |
| Changelog | `CHANGELOG.md` | entry under `Added` / `Changed` / `Fixed` / `Security` with the user-visible effect | always |
| Decision record | `docs/decisions/NNNN-<slug>.md` | context, decision, alternatives rejected, consequences, rollback, verification | semantic changes: lineage, streaming, trash restore rules, file scope |
| Localized strings | `locale/*.json` (plugin metadata) and the `zh`/`en` dictionaries in `src/client/index.js` | both locales, same key set | any new UI string |

Cross-cutting rule: **the client must be able to feature-detect a new
capability**. Add it to `/info` `capabilities` and to the client's gating code;
a capability that only exists in the handler is unreachable in the panel.

## 3. Decision record template

Create `docs/decisions/NNNN-<short-slug>.md` (four digits, monotonic) only for
changes where a future reader would ask "why on earth is it like this?":

```markdown
# 0007 — Restore archived state on import

- Status: accepted
- Date: YYYY-MM-DD
- Affects: `lib/import.js`, `lib/export.js`, `docs/architecture.md`

## Context
What problem forced a decision, with the constraint that mattered
(format version, DSH API gap, backwards compatibility of archives).

## Decision
The rule in one paragraph, stated so it can be tested.

## Alternatives rejected
- Option B — why not (cost, risk, contract break).

## Consequences
What becomes impossible, lossy, or slower. Archive compatibility notes.

## Verification
Test names and the manual step that proves it.

## Rollback
How to revert safely, including what happens to archives written meanwhile.
```

## 4. Tests are the executable documentation

- Test names are full sentences describing the contract
  (`delete moves a session into the trash directory without touching the source
  workspace`), not `test manage 3`.
- Every new route gets at least one route-level test through the third `apply`
  argument seam; every new `lib` export gets a direct test.
- Guarded cases that need the DSH checkout must say so in their skip message.
- If a test encodes a limitation (caps, exclusions, refusal), name the constant
  and the reason in the assertion message.

## 5. Rules that make docs readable by a model without the conversation

- **No implicit units.** Bytes vs MiB, seconds vs milliseconds, counts vs
  sizes: put the unit in the name or the comment, and document the cap as a
  named constant near its definition.
- **Negative spec is mandatory.** Each module header ends with what it
  deliberately does not do (e.g. "never imports subagent transcripts",
  "never overwrites an existing session", "does not clean attachment blobs").
- **One error-code table.** New codes are added to the `statusOf` mapping
  (`index.js`) *and* to the code list in the module header that throws them.
- **Prefer symbols over prose pointers.** Refer to `buildArchive`,
  `collectTouchedFiles`, `statusForManageCode` — not "the export function".
- **Record environment gotchas** in `CONTRIBUTING.md` (build tooling, platform
  quirks), never only in a chat log.
- **Keep `README.md` and `README.zh.md` in step** when a feature row changes.

## 6. Review checklist

Paste into the PR description and tick:

```markdown
- [ ] Code contract updated (module header + JSDoc, incl. failure codes)
- [ ] docs/architecture.md route/tool table and archive layout updated
- [ ] docs/feature-matrix.md row added/updated with test-name evidence
- [ ] README (+ README.zh.md) features/config/limitations updated
- [ ] CHANGELOG.md entry written
- [ ] Decision record added (semantic changes only)
- [ ] /info capability + client feature detection wired
- [ ] zh/en UI dictionaries updated together, same key set
- [ ] npm test, npm run format:check, and build artifact diff clean
```

## 7. Enforcement

Today the gate is review plus `npm run format:check`, the test suite and the CI
artifact diff. A stricter check (script that fails when a route lacks an
`architecture.md` row or a tool action lacks a README entry) is proposed as
C5 in [enhancement-proposal.md](enhancement-proposal.md); add it before the
route/tool surface grows further.
