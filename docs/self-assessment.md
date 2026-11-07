# Public-release self-assessment

Self-check for dsh-session-kit <code>0.9.0</code> (2026-11-07). The check was
code-and-test plus limited real <code>dsh web</code> spot checks; no live
DeepSeek share API call and no real cross-machine restore. Evidence is marked
by source:

- **[本次运行]** — executed now from this checkout (Node v22.23.2).
- **[仓库自动化]** — tests committed in this repository.
- **[仓库记录]** — statements in this repository's docs, not re-executed here.
- **[未验证]** — not covered by this self-check or by an automated test.

## 1. Purpose and value

The plugin moves DSH conversations and the workspace products around them
between machines without hand-copying the physical session format:

- one multi-session ZIP with manifest/checksums, canonical JSONL logs,
  attachments and (optionally) a workspace tree;
- a compact "conversation spine" export that is much smaller but lossy by design;
- import as new standalone sessions, optionally restoring workspace files;
- safe-by-default management: archive/unarchive, delete-to-trash, opt-in
  permanent erase, and a best-effort related-file flow;
- legacy-format upgrade through DSH's official migration chain;
- DeepSeek public share-link import into a chosen workspace;
- one agent tool (<code>session_kit</code>) exposing the same host operations.

Value: less migration friction and less risk of corrupting or misplacing DSH
session artifacts, because all durable writes go through product services or the
canonical log format instead of copying on-disk zstd generations.

## 2. How this self-check was done

- Read <code>index.js</code>, the built <code>lib/client.js</code> and its source in <code>src/client/</code>, <code>lib/*.js</code>,
  package/bundle metadata, tests, and the repository docs.
- Ran the plugin tests with plain Node and with the DSH checkout via
  <code>tsx</code> (real JSONL persistence/product-replay cases).
- Ran syntax checks on every host file and parsed the locale/package JSON.
- Ran <code>npm pack --dry-run</code> to inspect the candidate publish payload.
- Started a disposable DSH web instance on a test <code>DSH_HOME</code> for
  limited manual browser spot-checks. Did **not** install from the packed
  tarball, call a live DeepSeek share endpoint, or touch the user's real
  <code>$DSH_HOME</code>.

## 3. Stability evidence

### 3.1 Test runs (本次运行)

From the plugin directory:

~~~bash
node --test test/*.test.mjs
~~~

Result: **222 tests, 217 passed, 0 failed, 5 skipped** (plain Node v22.23.2,
about 0.26 s). The five skips are guarded tests that need a DSH repository
checkout through <code>tsx</code>: compact-log product replay, two real JSONL
persistence import cases, a real released v3 migration fixture, and the
real-stored-session file-plan case.

From a DSH repository checkout:

~~~bash
node --import tsx/esm --test dsh-session-kit/test/*.test.mjs
~~~

Result: **222/222 passed, 0 skipped, 0 failed** (about 1.5 s). This run includes
the real persistence backend and product replay checks.

Other checks: <code>node --check</code> passes for <code>index.js</code>,
<code>src/client/index.js</code> and all <code>lib/*.js</code>; locale and package JSON
parse; <code>npm pack --dry-run</code> reports 36 files, 202.3 kB tarball including the built client bundle and source map.

### 3.2 Real-backend and end-to-end evidence

- **[本次运行]** A fresh disposable profile on DSH 0.2.1-rc.3 accepted
  <code>dsh plugin --profile web add link:...</code> (bundle auto-selected),
  booted, served <code>/session-kit/info</code>, and loaded the client panel
  with no console errors. A row with an unknown config key produced Cordis
  <code>ValidationError: invalid config: unknown config key</code> and the
  plugin stayed inactive, confirming the new Config schema is enforced.
- **[仓库自动化]** The <code>tsx</code> run exercises DSH's real JSONL
  persistence and replay paths (the five guarded cases above), including a real
  released v3 migration fixture.
- **[仓库记录]** <code>docs/research/migration-notes.md:31-34</code> records
  development validation with a disposable <code>DSH_HOME</code> and a headless
  browser driving the real panel (select sessions, download an archive, import
  it, restore workspace files). That predates the 0.5–0.7 UI additions
  (detail/file list, file selection, permanent delete, share card).
- **[仓库记录 / 交接信息]** A development run migrated 38 real v3-only sessions:
  36 succeeded, 2 were refused by the official migration with an unresolved
  tool-call error; the source files were unchanged. V0 samples were frequently
  refused because of the historical subagent descriptor version. These
  per-session logs are not kept in this repository and were not re-run here.
- **[仓库记录]** Real-data compact output was measured at roughly 0.4%–1.2% of
  the original log text; seven archived sessions were measured at about
  22.7 MB to 0.35 MB. These measurements are from development records, not this
  self-check.

### 3.3 Client build verification (0.9.0)

- **[本次运行]** <code>npm ci</code> + <code>npm run build:client</code> produced
  <code>lib/client.js</code> and its source map; two consecutive builds were
  byte-identical (sha256 equal).
- **[本次运行]** A disposable profile installed from the packed
  <code>dsh-session-kit-0.9.0.tgz</code> on DSH **0.2.2-rc.1** loaded the built
  bundle: the Session manager panel opened, its one plugin style tag
  was injected, the CSS-module page/content classes had the expected computed
  layout (860 px content, 18 px gap, card padding), and there were no console,
  page or request errors.
- The CSS Modules build replaces the former hand-written module factory; the
  published <code>./client</code> export now points at the generated artifact.

### 3.4 Browser verification scope

- There is **no automated browser test** in this repository: no client test
  files exist, and CI runs only <code>node --test</code> plus
  <code>npm pack --dry-run</code> (<code>.github/workflows/test.yml</code>).
- Manual spot-checks on a disposable DSH web instance (2026-11-07, test
  <code>DSH_HOME</code>, synthetic/test sessions) confirmed: the panel opens and
  lists sessions with archived/legacy badges; a session row opens its detail and
  shows the storage size (“645 B” in the test fixture) plus the experimental
  related-files summary; the delete dialog renders the experimental file option
  and permanent-delete option. The migration confirmation dialog was exercised
  in an earlier 0.4 check.
- Not exercised end-to-end in a real browser for this release: executing
  selectable file deletion, permanent erase, export download/import, and
  share-link import; the share card and those dialogs have mock-runtime smoke
  checks only. Treat those paths as beta quality.

### 3.5 Not covered by automation

- all <code>src/client/index.js</code> behavior (rendering, dialogs, keyboard/escape,
  i18n switching, large-list responsiveness);
- the success path of <code>POST /session-kit/export</code> and the whole
  <code>POST /session-kit/import</code> route at the HTTP layer (<code>/export</code>
  is only tested for the missing-arguments error);
- live DeepSeek share fetching and API drift;
- Node 24 execution of the real-backend suite (CI matrix includes Node 24, but
  the local runs in this check used Node 22);
- installation from the packed tarball, fresh-machine DSH boot, cross-machine
  restore, Windows/macOS filesystem behavior;
- accessibility and non-Chinese/English locales.

## 4. Feature status summary

The full matrix is in <code>docs/feature-matrix.md</code>. Summary:

- **Stable core**: session listing, archive/restore, delete-to-trash, full and
  compact export, attachments, import as new sessions, legacy migration through
  the official chain, and the HTTP route/tool surface.
- **Stable with documented limits**: whole-workspace export (whole tree, size
  caps, in-memory ZIP), permanent delete (irreversible, no rollback), legacy
  migration (official refusals are honoured), share import (public links only,
  network path mocked in tests).
- **Experimental**: derived related files for deletion — approximation, shared
  files and sensitive files may be affected, explicit second confirmation.
- **Limited by missing client automation**: the browser panel has no
  automated test coverage; its host-side operations are tested, the UI is not.

## 5. Known limitations and risks

### Data safety and security

1. **Related-file derivation is best-effort and experimental**
   (<code>lib/session-files.js:1-13</code>). Shell redirections, PTC/script
   outputs and files only mentioned in prose are invisible. A file shared with
   other sessions is affected too. The derivation excludes the Harness home,
   session storage and the trash, but it does **not** re-apply the export-time
   sensitive-file patterns; a sensitive file that events happen to reference can
   be moved. The UI marks this experimental and requires a second confirmation.
2. **Permanent delete has no rollback and no trash copy**
   (<code>lib/manage.js</code> permanent branch). A partial failure reports what
   was already erased; the data cannot be recovered.
3. **Exports contain user content.** Conversation text and attachments are
   exported verbatim, and the manifest records the source workspace absolute
   paths so an archive can be mapped back to its origin machine. Review an
   archive before sharing it; never commit archives or session data.
4. **Attachment content store is not cleaned by deletion.** Delete/permanent
   delete removes session directories and (optionally) derived workspace files,
   but the content-addressed attachment store is not garbage-collected. Orphan
   attachment objects and shared attachment bytes can remain under
   <code>$DSH_HOME</code>.
5. **The agent tool can perform destructive operations.** The
   <code>session_kit</code> schema requires <code>confirm:true</code> for
   destructive actions and explicit ids/selected files, but there is no
   plugin-level human approval dialog for an agent-initiated permanent delete;
   deployments rely on the surrounding DSH permission/approval model and should
   treat the tool as powerful.
6. **Trash folders accumulate.** Nothing cleans
   <code>$DSH_HOME/session-kit-trash</code>; disk usage grows until the user
   removes folders.

### Functional and format limits

7. **Compact export is lossy by design** (<code>lib/compact.js:1-30</code>):
   tool calls/results, reasoning, stream chunks, jobs, subagents and runtime
   records are dropped. It is not a byte-level backup.
8. **Imported sessions are standalone** (<code>lib/import.js:10</code>,
   <code>:571</code>, <code>:673</code>): no parent/seed lineage, and subagent
   transcripts are never imported. User-visible forks remain independent
   sessions.
9. **Format version is strict.** Import requires the archive log version to equal
   the running DSH version (currently v4,
   <code>lib/import.js:578</code>); there is no in-plugin cross-version
   conversion. Legacy logs must be upgraded by DSH's official migration first.
10. **Legacy migration can be refused.** The plugin only triggers DSH's official
    <code>open(id,'write')</code> migration and reports refusals; it cannot force
    a conversion. Historical v0 logs are often refused because of the old
    subagent descriptor.
11. **Share import is narrow and network-dependent.** Only
    <code>chat.deepseek.com/share/&lt;id&gt;</code> links or bare ids are accepted
    (no arbitrary URL fetching); the request has a 60 s timeout and a 32 MiB
    response cap (<code>lib/deepseek-share.js:31-35</code>). Private/deleted
    shares fail, API changes can break the mapping, and tests always mock the
    network.
12. **Workspace export packs the whole tree.** The checked-file selection exists
    only for deletion; a per-session touched-files export is future work. Large
    workspaces are limited by <code>maxExportBytes</code>/
    <code>workspaceMaxBytes</code> and by the in-memory build.
13. **Archive building is in memory.** <code>lib/export.js:792-800</code> builds
    the full ZIP buffer before returning it; defaults are a 1 GiB export cap and
    a 512 MiB import cap with at most 100 sessions
    (<code>index.js:246-253</code>, <code>lib/import.js:51-53</code>). Very large
    stores can be slow or fail with <code>too-large</code>; there is no streaming
    archive path yet.
14. **Listing is a full scan with no pagination.** <code>/session-kit/list</code>
    walks the persistence listing and the panel renders all groups; large stores
    can make the UI heavy. Titles use the projection cache so cold logs are not
    opened for every row (<code>lib/sessions.js:282</code>,
    <code>docs/architecture.md</code>).

### Environment and configuration

15. **DSH APIs are pre-stable.** The plugin reads services through
    <code>ctx.get(...)</code> and declares no <code>@deepseek-ai/*</code> runtime
    dependencies. A DSH upgrade can change service shapes and require a plugin
    update; the declared support floor is DSH <code>&gt;=0.2.1-rc.3</code> and
    session format v4.
16. **Node engine mismatch needs care.** The plugin declares
    <code>engines.node &gt;=22</code> (package.json) while the shipped DSH CLI
    requires Node 24.9+ (docs/install.md). This check ran on Node 22.23.2; the
    real-backend suite on Node 24 is not part of the local evidence here.
17. **UI defaults vs deployment config differ.** The panel sends explicit export
    options (workspace files on by default in the UI); the host config defaults
    differ (<code>includeWorkspaceFiles</code> defaults to false unless the
    caller sends it). Behavior is still bounded by server caps, but operators
    should set config intentionally.

### Release-engineering and documentation risks

18. **Client and route coverage gaps.** There are no <code>src/client/index.js</code>
    tests; <code>/export</code> has only an error-path route test and
    <code>/import</code> has no route-level test. The tested surface is strong at
    the lib layer, weaker at the browser/HTTP integration layer.
19. **CI does not run the real-backend suite or a browser.** CI
    (<code>.github/workflows/test.yml</code>) runs <code>npm ci</code>,
    <code>npm run build:client</code>, an artifact diff check,
    <code>node --test test/*.test.mjs</code> on Node 22/24 and
    <code>npm pack --dry-run</code>; the five real-backend cases still skip there,
    and no Playwright/browser job exists. There is also no release/publish workflow.
20. **Documentation drift remains a maintenance risk.** The 0.9.0
    public-release pass refreshed <code>docs/roadmap.md</code>, removed the
    nonexistent <code>docs/assets</code> entry from <code>package.json</code>,
    added issue templates and linked the self-assessment/feature matrix from the
    README. Future feature changes still need the same discipline.
21. **i18n surface is small.** Client dictionaries exist for Chinese and English
    only; other locales fall back to keys/local copy.

## 6. Release recommendation

**Recommend a public beta, not a 1.0 stable.** The transfer/export/import,
archive/trash, migration-delegation and share-import host paths have meaningful
automated coverage, and the destructive file flow is explicitly experimental
with confirmations. The gaps below should be closed or explicitly accepted in the
release notes before calling it stable.

Suggested pre-publication checklist:

1. **CI matrix**: add a <code>tsx</code> job against a pinned DSH checkout so the
   5 guarded real-backend cases run in CI, and run the same suite on Node 24.
2. **Browser smoke**: add a Playwright (or equivalent) job covering list/archive/
   delete-dialog/export/import and the newer detail/file-selection/permanent/
   share flows; at minimum, run a documented manual checklist on a disposable
   <code>DSH_HOME</code>.
3. **Route/client tests**: add route-level <code>/export</code> (success) and
   <code>/import</code> tests, plus a minimal client test harness or an
   explicitly accepted manual-QA policy.
4. **Packaging**: the nonexistent <code>docs/assets</code> entry was removed and
   the candidate <code>npm pack</code> payload was inspected; re-verify it in the
   release workflow, and decide whether both README files should ship.
5. **Docs**: <code>docs/roadmap.md</code> and README/install/Node requirements
   were aligned for 0.9.0; state the experimental/permanent-delete limits in the
   release notes.
6. **Real-world QA**: on a clean machine and a second DSH instance, install from
   the pinned tag, export a synthetic archive, import it in a different
   workspace, restore files, exercise archive/trash/permanent delete, and test
   one real public share link with non-sensitive content.
7. **Release mechanics**: tag <code>v0.9.0</code>, publish with provenance
   (<code>npm publish --provenance</code> or equivalent), attach release notes,
   and publish to the plugin index if intended.
8. **Security/privacy**: document archive privacy (conversation text,
   attachment bytes, workspace absolute paths in the manifest), the attachment
   store's non-GC behavior, and the power of the agent tool's destructive
   actions.

## 7. Conclusion

Core session management and migration behavior is suitable for a public beta:
the tested scope is broad, the destructive paths are explicit and bounded, and
the plugin keeps DSH's physical format out of the migration path. The main risks
are the intentionally experimental related-file feature, irreversible permanent
delete, the not-yet-automated browser/network surfaces, and memory/scale limits
of the ZIP build. Those are acceptable for a clearly labelled beta, provided the
release notes state them and the pre-publication checklist above is followed.