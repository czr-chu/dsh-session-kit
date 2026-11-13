# DSH Market listing

The [DSH market](https://awesome-dsh-plugin.com/) is generated from the
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
catalog. Listing does **not** require an npm package: a GitHub-only entry may omit
`npm`, and the market installs it with the repository URL.

## Status

- Repository: <https://github.com/czr-chu/dsh-session-kit>
- Topics: `dsh-plugin`, `dsh`, `deepseek-harness`
- Manifest: `dsh.bundle.patch` points at `cordis.patch.yml`
- Recommended install: `dsh plugin --profile web add github:czr-chu/dsh-session-kit#v0.12.0`
- npm: **not published** under this name (see below)

## Submit the catalog entry

Fork `awesome-dsh-plugin/awesome-dsh-plugin`, add
`data/plugins/czr-chu__dsh-session-kit.yml`:

```yaml
url: https://github.com/czr-chu/dsh-session-kit
name: czr-chu/dsh-session-kit
category: session
description:
  en: 'Session manager for DSH: export in full, compact or compressed form, back up workspaces as per-workspace ZIPs, restore deleted sessions from a reversible trash, move sessions between workspaces, and check attachment references.'
  zh: 'DSH 会话管理：全量/精简/压缩导出，按工作区打包备份，回收站恢复误删会话，跨工作区迁移，并检查附件引用是否可解析。'
icon: https://raw.githubusercontent.com/czr-chu/dsh-session-kit/main/assets/icon-512.png
```

Open a PR against `main`. After merge the catalog regenerates; the market reads
it on open, usually within a day.

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
