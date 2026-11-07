# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.10.x | Yes |
| 0.9.x | Security fixes only |
| < 0.9 | No |

The plugin runs inside DeepSeek Harness and only reads services the host
exposes; keep DSH itself up to date as well.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Report it privately through
GitHub Security Advisories:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (private vulnerability reporting).
3. Include: affected version/tag, DSH version, deployment shape (Web, Desktop or
   headless), reproduction steps, and the impact you observed.

If private reporting is unavailable, contact the maintainer listed in the
repository profile and ask for a private channel. Please give us a reasonable
window to fix the issue before publishing details. We will acknowledge a report,
confirm the affected versions, and coordinate a fix and disclosure.

Reports that include a minimal synthetic reproduction are the fastest to
handle. **Never include** real session content, credentials, tokens, cookies,
absolute user paths, or unsanitized screenshots in a report; redact them.

## Security model

The detailed model lives in [docs/security.md](docs/security.md). Summary:

- **Local plugin, explicit actions.** Routes are fenced by the host's
  Connection service; nothing is exported, archived, migrated or deleted unless
  the user (or an explicitly asked agent tool) requests it.
- **Bounded exports.** Only the selected conversations, their referenced
  attachments, and (optionally) their workspace trees are packed; archive sizes
  are capped and oversize is rejected.
- **Sensitive-file exclusion.** Workspace walks skip VCS metadata, dependency
  and build caches, and credential-shaped paths (for example `.env*`,
  `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, `.ssh`, `.aws`).
  Symlinks are never followed.
- **Import is untrusted input.** Manifests and checksums are validated; entries
  with `..`, absolute paths, drive letters or symlinks are rejected during
  workspace restore; existing files and sessions are never overwritten.
- **Deletion defaults to a trash move.** Session directories (and selected
  files, if any) move under `$DSH_HOME/session-kit-trash`; nothing is erased.
  Permanent delete is opt-in, needs a separate second confirmation, and cannot
  be undone.
- **Related-file deletion is experimental.** The file list is derived from
  session events and is inherently approximate: shell redirections, PTC/script
  outputs and text-only mentions are invisible, and a file shared with other
  sessions may be moved too. The UI shows this risk and requires confirmation.
- **Format migration is delegated.** Old logs are upgraded only through DSH's
  official persistence migration chain; the plugin never decodes or rewrites a
  session artifact, and a refused migration leaves the source untouched.
- **Share import is restricted.** Only `chat.deepseek.com/share/<id>` links or
  bare share ids are accepted; arbitrary URL fetching is refused. Requests have
  a timeout and a response-size cap.

## Repository hygiene

This repository must never contain session data, exported archives,
credentials, API keys, cookies, browser storage, absolute paths from a real
machine, real conversation titles, or unsanitized screenshots. Test fixtures are
synthetic. See [CONTRIBUTING.md](CONTRIBUTING.md#privacy-rules) for the rules
applied to contributions.
