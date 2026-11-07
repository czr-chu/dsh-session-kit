# Privacy and repository data audit

This page records what this repository may contain, what it must never contain,
and the audit performed before the repository became public.

## Policy

The repository contains source code, tests, synthetic fixtures, documentation and
a sanitized screenshot only. It must never contain:

- session logs, exported archives, `$DSH_HOME` data, attachments, cookies or
  browser storage;
- API keys, tokens, passwords, private keys or `.env` files;
- real conversation titles/content or real session ids;
- absolute paths from a real machine (for example `/home/<user>/...`,
  `C:\\Users\\<user>\\...`) in source, docs, build output or screenshots;
- unsanitized screenshots of the user's real sessions.

Synthetic fixture paths such as `/home/u/...`, `/home/sessions/...` and
`/tmp/...` are allowed; they contain no real files.

## Audit performed

Scope:

- every tracked file in the current tree;
- all commits, branches and tags (full `git log -p --all`);
- pre-rewrite history backup, to check commits no longer reachable from refs;
- published GitHub Release assets;
- the README screenshot (PNG strings/metadata);
- workflows and package metadata.

Patterns checked included token-shaped strings (`ghp_`, `github_pat_`,
`sk-`, `AIza`, `xox[baprs]-`), private-key blocks, assigned API-key
variables, Authorization/Bearer values, real-machine home paths, known real
session titles/ids, archives and session-file extensions.

Result: **no credentials, private keys, API tokens, real session content,
real session ids or real file contents were found.** Test fixtures contain
synthetic paths and synthetic session data only.

## Historical finding and remediation

An early 0.9.0 build artifact embedded a build-machine absolute path in its CSS
virtual module id. This was a build reproducibility bug as well as a privacy
issue. It never included credentials, session content or user files.

Remediation:

1. The build now uses package-relative CSS paths and class hashes; a committed
   artifact regression test rejects home-directory paths.
2. The repository history was rewritten to redact the path from all commits and
   tags; `main` and all tags were force-pushed.
3. Current tags and the current Release assets were scanned and are clean.
4. `SECURITY.md` documents the policy and the residual-cache caveat.

A pre-rewrite commit object may still be served by GitHub's dangling-object cache
until GitHub Support purges it. It contains only a local build path, not secrets
or session data. If you find an older SHA exposing it, report it privately
through GitHub Security Advisories with the SHA so it can be coordinated with
GitHub Support.

## Ongoing checks

```bash
# tracked files only, no network
npm run privacy:check

# build artifact guard (also part of the test suite)
node --test test/client-build.test.mjs
```

CI runs the privacy scan, formatting, build/artifact diff, tests and pack check.
Contributors must keep fixtures synthetic and must not attach real logs,
screenshots, paths, credentials or user data to issues or pull requests.
