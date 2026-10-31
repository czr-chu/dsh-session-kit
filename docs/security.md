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
