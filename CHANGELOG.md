# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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