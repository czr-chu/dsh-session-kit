# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-11-08

### Added

- **Workspace-level backup/restore.** The panel's Workspace backup card and
  `session_kit action=export_workspace` pack one workspace's main sessions plus
  its whole file tree exactly once; `manifest.backup` records the workspace.
  Import can target a chosen workspace, restore files, create new sessions and
  attach them there.
- `POST /session-kit/export-workspace`, workspace metadata in `/info`, and
  workspace test coverage (core + route).
- `docs/workspace-backup.md` and README guidance on using one workspace per
  project.

### Changed

- Documentation now treats session-level touched-file editing as an experimental
  fallback; workspace backup is the primary project backup path.

## [0.10.5] - 2026-11-07

### Added

- `docs/privacy.md`: repository data policy, full audit scope, findings, the
  historical build-path remediation, and ongoing checks.
- `scripts/privacy-check.mjs` and `npm run privacy:check`; CI runs the scan.
- Explicit links from README, SECURITY, CONTRIBUTING and the conformance page.

## [0.10.4] - 2026-11-07

### Security

- Removed a build-machine absolute path from the repository history: an early
  tsdown artifact embedded it in the CSS virtual module id. All refs and tags
  were rewritten; the current release asset is clean.
- Added a build-artifact regression test that rejects home-directory absolute
  paths in the bundle or source map, and documented the incident/response in
  `SECURITY.md`.

## [0.10.3] - 2026-11-07

### Fixed

- CSS Module class hashes are derived from the package-relative stylesheet path,
  so `lib/client.js` is byte-identical across checkout paths and the CI
  artifact diff is stable. This also unblocks the automated GitHub Release
  tarball workflow.

## [0.10.2] - 2026-11-07

### Added

- `.github/workflows/release.yml`: on a version tag (or manual dispatch with an
  existing tag), rebuilds the client, runs tests, packs the plugin and creates a
  GitHub Release with the `.tgz` asset attached.
- Install documentation covers the Release asset URL, the Desktop/Web
  **Add plugin** dialog, and the repository requirements for Git installs.

## [0.10.1] - 2026-11-07

### Changed / removed

- Documentation refresh for 0.10.1: README quick-start now matches the
  Sessions/Tools layout and Archive/DeepSeek-share tabs.
- `SECURITY.md` supported-version table updated to the 0.10/0.9 lines.
- Removed the obsolete 0.1.0 `INTERFACES.md`; current behavior lives in the
  README, `docs/architecture.md`, `docs/feature-matrix.md` and package JSDoc.
- `docs/architecture.md` now documents the tsdown/CSS Modules browser build.
- Roadmap, conformance and research notes refreshed; stale source line numbers
  were removed so references do not rot with every refactor.
- Contributor guide describes the actual CI steps (install, build, format,
  artifact diff, tests, pack).

## [0.10.0] - 2026-11-07

### Changed

- Redesigned the Session manager panel for readability: a page header with
  summary chips, a two-column wide layout (Sessions on the left, Tools on the
  right), a contextual selection bar, an Export card with mode cards and
  options, and an Import card with Archive / DeepSeek share tabs. Narrow screens
  stack the columns. All existing actions, dialogs, aria labels and request
  bodies are unchanged.
- Added a sanitized panel screenshot to the README.

## [0.9.4] - 2026-11-07

### Added

- `docs/plugin-conformance.md`: the external-bundle versus monorepo-native
  scope, the official `cordis-plugin-development` sources, the canonical
  third-party package structure, a checklist, and the maintenance process.
- README/CONTRIBUTING links to the conformance page.

## [0.9.3] - 2026-11-07

### Added

- Display metadata now follows the official plugin checklist more closely:
  Japanese, Spanish, French, German, Russian and Portuguese `locale/*.json`
  files in addition to English and Chinese, plus an explicit `./icon` export.

### Changed

- Contributor guide documents the official display checklist: sentence-case
  titles, localized descriptions, original/ licensed icon, runtime files in
  `files`, and packed-file verification.

## [0.9.2] - 2026-11-07

### Changed

- Source formatting follows the DSH convention: no semicolons, single quotes,
  two-space indentation, trailing commas and 120-column lines.
- Added `.editorconfig`, `.gitattributes`, a Prettier configuration and a
  `format:check` CI gate. No behavior or bundle contract changes.

## [0.9.1] - 2026-11-07

### Fixed

- The CSS Modules build no longer embeds the build machine's absolute path in
  the client bundle or source map; the style tag id is package-relative.
- Added a committed-artifact regression test for the closure-factory handoff,
  CSS injection, source map and `./client` export.

### Changed

- Test totals: 224 tests (219 pass plain, 5 guarded skips).

## [0.9.0] - 2026-11-07

Official client build pipeline. No host API or user-facing feature changes.

### Added

- Browser half moved to `src/client/index.js` and `src/client/styles.module.css`
  and built with tsdown + lightningcss into `lib/client.js` (closure-factory
  handoff plus CSS Modules style injection).
- Pinned development build tooling (`tsdown@0.22.2`, `lightningcss@1.33.0`) and
  a committed, reproducible client artifact; CI rebuilds and diff-checks it.

### Changed

- `package.json` `./client` now resolves to the built `lib/client.js`;
  published files include the bundle and source map, not the hand-written file.
- Documentation and contributor guide describe the build step.

## [0.8.2] - 2026-11-07

### Changed

- The test-only helper-module injection moved from the public row config to a
  separate third `apply` argument. Loader YAML (and the `Config` schema) can no
  longer substitute helper modules.

## [0.8.1] - 2026-11-07

Compliance and public-release polish.

### Added

- Standard-schema `Config` export: unknown keys and wrong types now fail the
  plugin at startup instead of being silently defaulted.
- Bundle icon (`icon.svg`) and localized `meta.detail` documents
  (`docs/DETAIL.md`, `docs/DETAIL.zh.md`).
- `peerDependencies` for `@deepseek-ai/dsh` (`>=0.2.1-rc.3 <0.3.0-0`).

### Changed

- Version documented as 0.8.1.

## [0.8.0] - 2026-11-07

Public-release preparation. No functional changes.

### Added

- English and Chinese README files.
- `SECURITY.md`, `CONTRIBUTING.md`, GitHub Actions CI (Node 22/24) and GitHub
  issue templates for public contributions.
- `CHANGELOG.md` and a rewritten `docs/install.md` covering public GitHub,
  private-fork, linked-checkout and future npm installation paths.
- Public-release self-assessment and feature matrix (`docs/self-assessment.md`,
  `docs/feature-matrix.md`), plus a refreshed roadmap.

### Changed

- Installation documentation now defaults to the public repository and a
  pinned release tag (`github:czr-chu/dsh-session-kit#v0.8.0`).

### Security

- Repository policy documented: no session data, credentials, tokens, real
  conversation titles, absolute user paths or unsanitized screenshots may be
  committed or attached to issues/PRs.

## [0.7.0] - 2026-11-07

### Added

- DeepSeek share-link import: `POST /session-kit/import-share` and the
  `session_kit` `import_share` action, with an optional target workspace
  (`workspaceId`) or explicit `cwd`.
- `lib/deepseek-share.js`: accepts only `chat.deepseek.com/share/<id>` links or
  bare share ids, fetches the public share API with timeout/byte caps, maps
  fragments to canonical Session v4 events, and imports through the existing
  archive importer.
- Share import panel card in the web client (link/id input, workspace selector,
  optional title).

### Security

- No arbitrary URL fetching: only DeepSeek share content is requested.

## [0.6.1] - 2026-11-07

### Changed

- The session detail panel now shows the derived related files, so the delete
  dialog can be reviewed before opening it.

## [0.6.0] - 2026-11-07

### Added

- Session detail (storage size across retained generations, format status,
  archived state) via `POST /session-kit/session-detail` and the detail panel.
- Per-session grouped, individually selectable related files for delete.
- Permanent delete (explicit opt-in, separate second confirmation, no trash
  copy) in addition to the default trash move.
- Experimental labelling and risk copy for the derived-file feature.

### Changed

- `POST /session-kit/delete` accepts `selectedFiles` (required with
  `removeFiles:true`) and `permanent`; results report moved/removed file stats.

## [0.5.0] - 2026-11-05

### Added

- Related workspace files for a session can be previewed before deletion
  (`POST /session-kit/session-files` and the `session_kit` `files` action).
- Optional delete-with-files: selected files are moved under
  `<trash>/files/<encoded-root>/...` with a `files-manifest.json`, before the
  session directories move.
- Path safety: absolute paths, `..`, drive letters and symlink entries are
  rejected; sensitive/build-cache paths are skipped; nothing is ever `rm -rf`ed.

## [0.4.0] - 2026-11-02

### Added

- Legacy session-format migration through DSH's official persistence seam
  (`persistence.open(id, 'write')` prepare/publish), available as
  `POST /session-kit/migrate` and the `session_kit` `migrate` action.
- Legacy badges in the session list plus per-id migration results and a
  remaining-legacy counter; batch cap 100, `all` requires `confirm:true`.
- Released source generations are retained; a refused migration leaves the
  original log untouched.

## [0.3.1] - 2026-11-02

### Fixed

- Archived sessions that are absent from the query corpus are merged back into
  the list and marked as archived.

### Changed

- Session listing reads the projection cache instead of opening every log, so
  the panel stays fast on large stores.

## [0.3.0] - 2026-11-01

### Added

- Archive / unarchive / delete-to-trash for one session or a batch
  (`/session-kit/{archive,unarchive,delete}` plus `session_kit` actions).
- List search across title/id/cwd/workspace and an all/active/archived status
  filter; archived rows are clearly marked.
- Delete moves session directories (including `origin: 'subagent'`
  descendants) under `$DSH_HOME/session-kit-trash/<timestamp>/` after refusing
  live sessions and validating every storage location.

## [0.2.0] - 2026-11-01

### Added

- Optional workspace-file export: whole workspace trees under
  `workspaces/<key>/`, with `.git`, dependency/build caches, credentials and
  secret-shaped files excluded and symlinks skipped.
- Optional workspace-file restore on import with zip-slip protection and
  no-overwrite semantics.
- `includeSubagents` opt-in for export; subagent transcripts are never imported.

## [0.1.0] - 2026-11-01

### Added

- Initial plugin: session manager panel, compact/full export, archive import
  (this plugin's ZIP, DSH's built-in session-log export and bare JSONL),
  `manifest.json` with sha256 checksums, attachment packing/restore, and the
  `session_kit` agent tool (list/export/import).