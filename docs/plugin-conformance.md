# Third-party plugin conformance

dsh-session-kit is an **external DSH plugin bundle**: a package installed into a
profile with `dsh plugin`, not a package inside the DeepSeek Harness monorepo.
Those are two different standards; this page records the one this project
targets, the official sources it follows, and what it deliberately does not do.

## Scope: external bundle, not first-party package

The authoritative guides for installable third-party plugins are shipped with
DSH in the `cordis-plugin-development` skill:

- `references/host-plugin.md` — bundle manifest, `cordis.patch.yml`, locale and
  icon resources, Host export forms, `Config`, installation and observation.
- `references/ui-plugin.md` — `dsh.client`, the `./client` factory, slot and
  locale registration, effects and cleanup.
- `templates/decoration/` — the reference bundle: plain-JS `index.js` and
  `client.js`, locale files, an SVG icon, and the same manifest fields used here.

The repository-level rules in the DSH checkout's `AGENTS.md`,
`packages/AGENTS.md` and `packages/client/AGENTS.md` apply to packages developed
**inside that monorepo**. They require strict TypeScript, the shared
`clientBundle()` tsdown preset, the workspace test harness, monorepo
registration and the repository CI/HMR process. None of those is an install
prerequisite for a third-party bundle.

## Canonical structure

A third-party UI bundle has this shape:

```text
package.json          # name/version/type, exports, files, dsh.bundle, dsh.client,
                      # optional peerDependencies and icon
cordis.patch.yml      # inserts the Host row(s) into the profile composition
index.js              # Host half: name/inject/Config/apply
client.js or lib/client.js  # browser half: __ModuleLoader__.load({ id, factory })
locale/*.json         # meta.title / meta.description per language
icon.svg              # package-local artwork (or ./icon export)
README.md, LICENSE
```

The browser half may be hand-written (as in the official decoration template) or
compiled with a bundler. This project compiles it with tsdown + Lightning CSS so
the committed artifact has the same closure-factory handoff, source map, CSS
Module injection and `dsh.client` contract; the source lives in
`src/client/`. Both forms are supported by the external-plugin contract.

## Checklist and current status

| Requirement | Status |
| --- | --- |
| `dsh.bundle.patch` and a patch file inserted in `cordis.patch.yml` | Yes |
| Function Host plugin exporting `name` / `inject` / `Config` / `apply`, no default export | Yes |
| Registrations and optional services owned by `ctx.effect` / `ctx.inject` | Yes |
| `dsh.client.platform: "web"` and a `./client` export | Yes |
| Closure-factory handoff with the package name as `id` | Yes |
| Slots and locale registered through the Client services | Yes |
| Theme tokens and CSS Modules; no iframe or second app root | Yes |
| `meta.title` / `meta.description` locale files | Yes, 8 languages |
| Valid original SVG icon, inside `files` | Yes, 420-byte SVG |
| Every runtime file, patch, locale and icon in `files` | Yes; verified with `npm pack --dry-run` |
| Unknown or invalid row config fails at activation | Yes, standard-schema `Config` |
| Peer range for the DSH runtime | Yes, optional `@deepseek-ai/dsh` peer |

The project additionally ships a built-artifact regression test and a CI
`format:check` gate. It uses JavaScript rather than TypeScript because the
external template does, and because the Host/client seams are consumed through
`ctx.get(...)` and the module table rather than imported DSH packages.

## Not required for a third-party plugin

- TypeScript/TSX source, `clientBundle()`, the DSH vitest/jsdom harness, and
  monorepo package registration;
- DSH repository CI/HMR wiring;
- an npm scope or first-party package name.

Those become relevant only if the same code is proposed as a first-party package
inside DeepSeek Harness.

## Maintenance when DSH changes

1. Read the installed `cordis-plugin-development` skill and its references; do
   not infer new rules from a single API.
2. Reinstall against the current DSH release and open the panel in a real
   browser; verify the slots, locale, icon, Config and theme tokens.
3. Rebuild the committed client artifact (`npm ci && npm run build:client`)
   and keep the artifact diff; CI performs the same check.
4. Run the self-contained and tsx test tiers; state which real-backend cases ran.
5. Pack the package and inspect the file list; install the tarball into a fresh
   profile before tagging a release.
6. Update this page when the official external-plugin contract changes.

## Maintenance process

- **Source of truth:** installed DSH package docs and `cordis-plugin-development`
  references, not guessed APIs.
- **Display parity:** locale metadata and icon are release artifacts; verify them
  with the packed file list and the Plugins page.
- **Compatibility:** peer/engine range is `>=0.2.1-rc.3 <0.3.0-0`; the current
  release has been exercised on DSH 0.2.2-rc.1.
- **Privacy:** no real sessions, credentials, absolute user paths or unscreened
  screenshots belong in the repository, issues or release notes.
