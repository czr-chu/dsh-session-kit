# Install and upgrade

## Requirements

- **DeepSeek Harness `0.2.1-rc.3` or newer.** The plugin declares `engines.dsh`;
  a DSH build outside that range refuses to install/activate the bundle.
- **Node.js 22+** for the plugin itself (the shipped DSH CLI requires Node 24.9+).
- A **Web or Desktop** deployment for the session-manager panel. A headless
  deployment still gets the `session_kit` agent tool but no browser UI.
- A GitHub-compatible `git` on the target machine for git-based installs.

## Install from the public repository (recommended)

```bash
# pinned release tag — reproducible and easy to audit
dsh plugin --profile web add github:czr-chu/dsh-session-kit#v0.9.4

# or track the main branch (not recommended for production)
dsh plugin --profile web add github:czr-chu/dsh-session-kit

# confirm the bundle row is present
dsh plugin --profile web list --depth 0
```

Then **restart `dsh web`** and refresh the page. The sidebar gains a
**Session manager** row and the `session_kit` agent tool becomes available.

DSH installs the package into `$DSH_HOME/profiles/web` and reads the bundle row
from `cordis.patch.yml`; published packages contain the built `lib/client.js`, so no build step or npm install is required for installation. A local checkout that edits `src/client/` must run `npm ci && npm run build:client` before restarting DSH.

## Install from npm (after publishing)

The package is not published to npm yet. Once it is:

```bash
# default registry
dsh plugin --profile web add dsh-session-kit

# npmmirror mirror
npm_config_registry=https://registry.npmmirror.com dsh plugin --profile web add dsh-session-kit
```

## Private fork (optional)

Private forks install the same way, but the target machine's git must already be
authenticated to GitHub. DSH does not store GitHub credentials.

```bash
# SSH (the machine needs a working GitHub key)
dsh plugin --profile web add git+ssh://git@github.com/<your-org>/dsh-session-kit.git#v0.9.4

# HTTPS (a git credential helper must already hold a token)
dsh plugin --profile web add https://github.com/<your-org>/dsh-session-kit.git#v0.9.4
```

Never paste a token into a command line or commit it anywhere; use the platform
credential helper instead.

## Linked checkout (development only)

```bash
dsh plugin --profile web add <path-to-local-checkout>
```

A linked checkout picks up source edits on the next DSH restart, which is handy
while iterating but not intended for production installs.

## Upgrade, uninstall and restart

```bash
# upgrade to a newer pinned tag (replace <newer-tag>, e.g. #v0.9.4)
dsh plugin --profile web add github:czr-chu/dsh-session-kit#<newer-tag>
# or, for a registry/git install:
dsh plugin --profile web update dsh-session-kit

# remove the plugin
dsh plugin --profile web remove dsh-session-kit
```

**Restart `dsh web` after install, upgrade or removal** — bundle rows are not
hot-reloaded in the browser. A page refresh is enough once the server restarted.

## Verify the install

1. `dsh plugin --profile web list --depth 0` shows `dsh-session-kit`.
2. The sidebar contains **Session manager**; opening it lists sessions grouped by
   workspace (main conversations only, archived rows marked).
3. In a headless deployment, ask the agent to call the `session_kit` tool with
   `action=list`.

## Custom plugin index (optional, experimental)

DSH can browse a static plugin index (Settings → Plugins → custom indexes).
An entry may point at the public repository and a pinned commit:

```json
{
  "name": "dsh-session-kit",
  "versions": [
    {
      "version": "0.9.4",
      "source": {
        "type": "git",
        "url": "https://github.com/czr-chu/dsh-session-kit",
        "commit": "<full commit sha of the v0.9.4 tag>"
      }
    }
  ]
}
```

For a private repository, plain `https` index entries cannot authenticate; use
the `git+ssh` install command above or publish the package to a registry.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Install refused with an engines/version message | The running DSH is older than the declared `engines.dsh` range; upgrade DSH or use an older plugin tag. |
| No Session manager row after install | `dsh web` was not restarted, or the installed profile is not the one being served. |
| Git install fails to authenticate | The target machine has no valid SSH key/credential helper for the private fork. |
| Share import fails with `share-fetch`/`share-api` | The deployment cannot reach `chat.deepseek.com`, or the share link was deleted/private. |

## Uninstall and data

Removing the plugin does not delete your sessions, exports or trash directories.
`$DSH_HOME/session-kit-trash` is only removed when you delete it yourself.
