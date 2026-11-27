# DSH Market listing

The [DSH market](https://awesome-dsh-plugin.com/) is generated from the
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
catalog. Listing does **not** require an npm package: a GitHub-only entry may omit
`npm`, and the market installs it with the repository URL.

## Status

- Repository: <https://github.com/czr-chu/dsh-session-kit>
- Topics: `dsh-plugin`, `dsh`, `deepseek-harness`
- Manifest: `dsh.bundle.patch` points at `cordis.patch.yml`
- Recommended install: `dsh plugin --profile web add github:czr-chu/dsh-session-kit#v0.14.1`
- npm: **not published** under this name (see below)
- Catalog PR: <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15048> (merged 2026-11-13)
- Catalog entry: `data/plugins/czr-chu__dsh-session-kit.yml`
- Catalog update needed: the merged entry still pins `tarball` to v0.13.0; change it to the floating asset below so the DSH Market can offer updates

## Catalog entry

Current merged entry (update pending):

```yaml
tarball: https://github.com/czr-chu/dsh-session-kit/releases/download/v0.13.0/dsh-session-kit-0.13.0.tgz
```

Replace that line with the floating, stable asset name:

```yaml
tarball: https://github.com/czr-chu/dsh-session-kit/releases/latest/download/dsh-session-kit.tgz
```

The full entry should be:

Fork `awesome-dsh-plugin/awesome-dsh-plugin`, edit
`data/plugins/czr-chu__dsh-session-kit.yml`:

```yaml
url: https://github.com/czr-chu/dsh-session-kit
name: czr-chu/dsh-session-kit
category: session
description:
  en: 'Session manager for DSH: export in full, compact or compressed form, back up workspaces as per-workspace ZIPs, restore deleted sessions from a reversible trash, move sessions into existing or new workspaces, compress sessions into smaller new-id copies, check attachment references, and archive/restore a whole workspace without moving its files.'
  zh: 'DSH 会话管理：全量/精简/压缩导出，按工作区打包备份，回收站恢复误删会话，迁移到已有/新建工作区，把会话压缩为更小的新 id 副本，检查附件引用是否可解析，以及不移动文件地归档/恢复整个工作区。'
icon: https://raw.githubusercontent.com/czr-chu/dsh-session-kit/main/assets/icon-512.png
tarball: https://github.com/czr-chu/dsh-session-kit/releases/latest/download/dsh-session-kit.tgz
```

Open a PR against `main`. After merge the catalog regenerates; the market reads
it on open, usually within a day. Direct edit link:
<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/edit/main/data/plugins/czr-chu__dsh-session-kit.yml>.

## Why the Market showed no update

The DSH Market updates GitHub-only archives only when the catalog entry has a
**floating release asset**:

```text
https://github.com/<owner>/<repo>/releases/latest/download/<stable-asset>.tgz
```

A version-pinned URL such as
`.../releases/download/v0.13.0/dsh-session-kit-0.13.0.tgz` is a fixed archive.
The Market has no npm identity to compare for this plugin and intentionally
does not guess one; the pinned entry therefore showed the installed version
but no update. The same applies to a `link:` install, which the Market reports
as a linked checkout and does not offer to update.

The release workflow now uploads both:

```text
dsh-session-kit-<version>.tgz   versioned, reproducible archive
dsh-session-kit.tgz             stable alias for releases/latest/download/
```

After the catalog entry points at the stable alias, the Market can:

1. resolve `releases/latest` to the newest tag;
2. read `package.json` at that tag and compare `version`;
3. offer the update with the stable alias as the install target.

Until the catalog update is merged, existing Market-installed copies still use
their pinned spec and will not show an update. The CLI/GitHub-tag install path
is unaffected.

## Why GitHub-only (npm naming)

| Name | npm state | Decision |
| --- | --- | --- |
| `dsh-session-kit` | 6.10.1, unrelated `ltxlong/dsh-session-kit` | cannot use |
| `dsh-session-manager` | 0.7.6, `hkkz9522/dsh-session-manager`, same session-manager domain | cannot use; would be confused with a competitor |
| `dsh-session-toolkit` / `-backup` / `-port` / `-vault` / `-archive`, `dsh-workspace-kit` | all already registered | cannot use |
| `@czr-chu/dsh-session-kit` | free at the time of writing | possible later, but needs the npm scope and a publish token |

GitHub installation works with the current `package.json` name: npm resolution is
not involved, so **no rename is needed**. If a scoped package is published later,
set the catalog entry's `npm` field and keep the GitHub `url` as the source.

## Icon

`assets/icon-512.png` (512×512) and `assets/icon-256.png` (256×256) are rendered
from `icon.svg`. The catalog entry points at the raw 512 px PNG; the GitHub CDN
serves it with `Content-Type: image/png`.
