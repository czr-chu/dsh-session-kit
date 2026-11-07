# Contributing

Thanks for helping improve dsh-session-kit. The **host half is plain ESM**; the browser half is compiled from `src/client/` with tsdown and CSS Modules into the committed `lib/client.js`. Runtime dependencies remain zero; build tooling is development-only.

## Development environment

- Node.js **22+** for the plugin's own tests (CI runs Node 22 and 24);
- `npm ci && npm run build:client` before testing or packaging client changes;
- DeepSeek Harness **0.2.1-rc.3+** to run the plugin in a real deployment
  (the DSH CLI itself requires Node 24.9+);
- a Web or Desktop deployment for the browser panel; a headless deployment can
  still exercise the `session_kit` agent tool.

## Running tests

The suite has two tiers:

```bash
# Pure logic and mocked-seam tests (no DSH checkout needed).
node --test test/*.test.mjs

# Same suite with the real DSH backend/persistence tests enabled.
# Run from a DeepSeek Harness checkout that contains this plugin directory:
node --import tsx/esm --test dsh-session-kit/test/*.test.mjs
```

Run `npm run format:check` before committing; the same check runs in CI.

The real-backend tests are guarded: without the DSH TypeScript sources (and
`tsx`) they self-skip, so the plain command stays green in any checkout. CI runs `npm ci`, `npm run build:client`, `npm run format:check`,
an artifact diff check, the plain suite on Node 22 and 24, and a pack check. Run
the `tsx` variant locally when touching persistence, migrations, imports or the
management modules.

Never make a test depend on a real `$DSH_HOME`, real sessions, network access or
a real `dsh web` process; use the test-only third `apply` argument for helper
module injection and temporary directories.

## Code structure

| Path | Responsibility |
| --- | --- |
| `index.js` | Host half: `/session-kit/*` routes, `session_kit` agent tool, module resolution, error mapping. |
| `src/client/index.js` | Browser half: session manager panel, detail/delete/import cards. |
| `lib/sessions.js` | Session listing/detail helpers, target-directory resolution, id minting, new-session writes. |
| `lib/export.js`, `lib/import.js` | Archive builder/importer (manifest, checksums, attachments, workspace files). |
| `lib/compact.js` | Compact ("visible conversation") export transform. |
| `lib/manage.js` | Archive/unarchive/delete-to-trash/permanent delete. |
| `lib/migrate.js` | Official DSH legacy-format migration wrapper. |
| `lib/session-files.js` | Best-effort related-file derivation for delete. |
| `lib/deepseek-share.js` | DeepSeek share-link fetch and v4 session builder. |
| `lib/format.js`, `lib/zip.js`, `lib/attachments.js` | Derived helpers from dsh-session-port (MIT; see `NOTICE`). |
| `tests/` | `node:test` suites; guarded cases self-skip without the DSH checkout. |

The plugin reads DSH only through `ctx.get(...)` services; do not import
`@deepseek-ai/*` packages into the shipped code.

## Privacy rules

Contributions must be safe to publish. **Do not commit or attach:**

- session logs, exported archives (`.zip`/`.jsonl`/`.zstd`), or `$DSH_HOME` data;
- credentials, tokens, cookies, `.env` files, keys or browser storage;
- real conversation titles or content that identifies a person;
- absolute paths from a real machine (`/home/<user>`, `C:\\Users\\<user>`, ...);
- unsanitized screenshots (redact titles, paths, workspace names and accounts).

Use synthetic fixtures with generic names (`/workspace/demo`, `session-example`).
`.gitignore` already excludes archives, secrets and local scratch data; keep it
that way. If you find data like this in an issue or PR, report it privately per
[SECURITY.md](SECURITY.md) instead of reposting it.

## Pull requests

- Keep a change focused; split independent features.
- Describe the behavior change, the user/model-visible effect, the tests added,
  and any security or privacy implication (especially for file paths, deletion,
  imports and share fetching).
- Run `node --test test/*.test.mjs` and, when relevant, the `tsx` suite above.
- Update package README/docs or `CHANGELOG.md` when behavior or installation
  changes.
- Do not commit build artifacts or local test residue.

## Style

- ESM only, no new third-party runtime dependencies (the plugin must stay
  installable from a plain workspace directory).
- Keep modules small and single-purpose; put shared behavior in `lib/*` rather
  than duplicating it in `index.js`.
- Export concise JSDoc on public functions and keep diagnostics actionable.
- Match the surrounding file's language conventions for comments and diagnostics;
  user-facing UI strings belong in `locale/*.json`.
- Prefer deterministic, filesystem-isolated tests.

## License

By contributing you agree that your contribution is licensed under the MIT
license of this project. `lib/zip.js`, `lib/format.js` and
`lib/attachments.js` are derived from
[dsh-session-port](https://github.com/mswinandmc/dsh-session-port) (MIT); keep
their attribution intact (see `NOTICE`).

## Official display checklist

Before installing or publishing a build, verify the plugin-manager display
metadata with the same expectations as the shipped plugin template:

- `locale/<language>.json` provides `meta.title` and `meta.description`;
  English title/description use sentence case. The bundle ships English,
  Chinese, Japanese, Spanish, French, German, Russian and Portuguese metadata.
- The icon is original or redistributable, stays inside the package, is a valid
  SVG/PNG/JPEG/WebP no larger than 256 KiB, and is listed in `files`.
- Runtime files, the patch, locale resources and the icon are all covered by
  `files`; run `npm pack --dry-run` and inspect the packed list.
- After installation, check the title, description and rendered icon in the
  Plugins page (or state that rendered display remains unverified).

The external-bundle scope, official references and release checklist are in
[docs/plugin-conformance.md](docs/plugin-conformance.md).
