# Security model

## What leaves the machine

Only what the user selects for export reaches the archive:

- session logs (canonical JSONL) for the selected main conversations,
- attachment bytes referenced by those logs (images/files uploaded into the conversation),
- optionally, the whole workspace tree(s) of those conversations.

`$DSH_HOME` credentials (`.credentials.yaml`), provider upload indexes, caches,
telemetry ids and any other machine state are never read.

## Workspace file exclusions

The workspace walker never reads these into an archive:

- directories: `.git`, `node_modules`, `.venv`, `venv`, `dist`, `build`,
  `.next`, `target`, `__pycache__`, `.cache`, `.pnpm-store`, `.yarn`,
  `.idea`, `.vscode`, `.ssh`, `.aws`, `.gnupg`,
- files matching: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.keystore`,
  `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `.git-credentials`,
  `credentials*`, `secrets*`, `.DS_Store`.

Symlinks are not followed. Oversized files and files above the configured caps
are skipped with warnings, and every skip is reported in the export result and
manifest. Hosts and users should still review an archive before sharing it:
conversation text itself is user content and is exported verbatim.

## Import safety

Archives are untrusted input. The importer validates the manifest and its
sha256 checksums, rejects entries with `..`, absolute paths, drive letters or
symlinks when restoring workspace files, and refuses same-version mismatches,
duplicate ids and archives over the configured limits. It never overwrites an
existing session; workspace file conflicts are skipped with a warning.

## Repository policy

This repository contains source, tests and design notes only. It must never
contain `$DSH_HOME` data, credentials, API keys, exported archives, cookies, or
absolute user paths from a real machine beyond generic documentation. Test
fixtures are synthetic.
## Archive metadata

The manifest records the source workspace absolute paths so a user can map an
archive back to the machine it came from, plus workspace-relative touched and
presented file paths. It never records credential values, and generated
archives are excluded from this repository (`.gitignore`).
## Session deletion

Delete is a move, not an erase: the session directory (plus `origin: 'subagent'`
descendants) is moved under `$DSH_HOME/session-kit-trash/<timestamp>/` and the
workspace registry is cleaned. Before moving, the plugin refuses live/running
sessions and verifies that every backend location is a real session directory
named after the encoded session id under a canonical project directory, without
following symlinks. A move failure rolls back already-moved directories. Users
who want permanent erasure delete the trash folder themselves.
## Format migration

Migration is delegated to DSH's official persistence seam. The plugin never
decodes, re-encodes, or rewrites a session artifact; it opens the session for
write only to trigger the official prepare/publish path, closes it, and verifies
the published generation with `stat`. Released generations are retained. When
the official migration refuses an old log (unresolved tool calls, unsupported
historical subagent descriptor, corruption), the source stays byte-identical and
the failure is reported to the user rather than forced.
## Related-file deletion

The optional delete-with-files flow moves only derived workspace files that
currently exist as regular files under the owning workspace root. Symlinks,
paths outside the root, the Harness home, session storage and the trash are
never moved. Files go to `<trash>/files/...` with a manifest; nothing is
erased, and a failed file move rolls back before session directories move. The
derivation cannot see shell redirections, PTC/script outputs, or text-only
mentions, and a file shared with other sessions is moved too; the UI states
these risks and requires an explicit second confirmation.
