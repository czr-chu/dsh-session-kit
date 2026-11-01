# Install and upgrade

## Requirements

- DeepSeek Harness `0.2.1-rc.3` or newer (the plugin declares `engines.dsh`),
- Node.js 22+ for the plugin itself (the shipped DSH CLI requires Node 24.9+),
- a Web or Desktop deployment (the browser panel needs the web bundle; a
  headless deployment gets only the `session_kit` agent tool).

## Install on this machine (linked checkout)

```bash
dsh plugin --profile web add /absolute/path/to/dsh-session-kit
dsh plugin --profile web list --depth 0
```

A linked checkout means edits are picked up on the next DSH restart, which is
handy while iterating. Restart `dsh web` and refresh the page; the sidebar gets a
**Session manager** row.

## Install from GitHub

The repository is a complete plugin package (plain ESM, no build step).

```bash
# public repository
dsh plugin --profile web add github:czr-chu/dsh-session-kit

# pin a tag or commit
dsh plugin --profile web add github:czr-chu/dsh-session-kit#v0.2.0

# private repository over SSH (the target machine needs a working GitHub key)
dsh plugin --profile web add git+ssh://git@github.com/czr-chu/dsh-session-kit.git

# private repository over HTTPS (git credential helper must already hold a token)
dsh plugin --profile web add https://github.com/czr-chu/dsh-session-kit.git
```

The install runs `pnpm add` in `$DSH_HOME/profiles/web`, which clones the git
repository with the target machine's git/SSH credentials. Private repositories
therefore require the target machine to be authenticated to GitHub (SSH key or
credential helper); DSH itself does not store GitHub credentials.

## Install from npm / a mirror (after publishing)

```bash
# default registry
dsh plugin --profile web add dsh-session-kit

# npmmirror mirror
npm_config_registry=https://registry.npmmirror.com dsh plugin --profile web add dsh-session-kit
```

## Upgrade / remove

```bash
# re-add to refresh a git install (pin a tag for stability)
dsh plugin --profile web add github:czr-chu/dsh-session-kit
# or
dsh plugin --profile web update dsh-session-kit

dsh plugin --profile web remove dsh-session-kit
```

Restart `dsh web` after install/upgrade/remove (bundle rows are not hot-reloaded
by the browser). A refresh is enough once the server restarted.

## Custom plugin index (optional)

DSH can browse a static plugin index (Settings → Plugins → custom indexes,
experimental). An index entry may point at this git repository:

```json
{
  "name": "dsh-session-kit",
  "versions": [
    { "version": "0.2.0", "source": { "type": "git", "url": "https://github.com/czr-chu/dsh-session-kit", "commit": "<full sha>" } }
  ]
}
```

For a private repository, plain `https` index entries cannot authenticate; use
the `git+ssh` install command above instead, or publish the package to npm.
