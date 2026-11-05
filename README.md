# dsh-session-kit

DeepSeek Harness 会话管理与迁移插件：浏览/选择会话，按“精简（compact）”或“全量”导出
会话与工作区文件，再在另一台 DSH 上导入为新的会话并恢复工作目录。

## 能力

- **会话管理面板（快速列表）**：标题直接读投影缓存（含跨格式代际的前代标题），不再为每行打开完整日志；
  按工作区分组列出主对话，搜索标题/id/目录，按全部/未归档/已归档筛选，全选/反选、多选；
  每行明确显示「已归档 / 未归档」，子代理会话默认隐藏。
- **归档状态完整可见**：已归档会话（包括不在查询语料里的旧归档）会合并进列表并标记；
- **归档 / 恢复 / 删除**：单条或批量归档、恢复；删除会把会话（含其 subagent 后代；用户 fork 的子会话保留）
  移动到 `$DSH_HOME/session-kit-trash/<时间戳>/`，不永久抹除；同时清理工作区归属、置顶和归档状态。
- **删除时移走相关文件（可选，二次确认）**：删除确认框可勾选“同时移走该会话涉及的文件（移到回收站）”；
  文件列表从会话事件尽力推导（presented、工具结果元数据、工具参数），勾选后先预览、再二次确认；
  文件移动到同一次回收站的 `files/` 子目录并生成 `files-manifest.json`，绝不 `rm -rf`。
- **精简导出（创新点）**：把会话压成“显示出来的对话”——只保留用户提问、图片/文件块和每轮最终
  助手回答，丢弃工具调用/结果、推理流、流式 chunk、任务/子代理事件；体积通常只有原日志的
  0.1%–1%，导入后仍是可继续对话的合法 DSH 会话。
- **全量导出**：保留完整事件日志与对话附件，用于完整备份。
- **工作区文件随包导出（可选，UI 默认开启）**：按会话涉及的每个工作区根目录收集整棵树，
  放进 ZIP 的 `workspaces/<key>/`；自动排除 `.git`、`node_modules`、构建产物、
  `.env`/密钥/凭据等敏感文件，符号链接不跟随。
- **按会话文件夹打包**：每个会话一个 `sessions/<id>/`，含日志、`meta.json`；
  顶层 `manifest.json`（sha256 校验、工作区映射、touched/presented 文件清单）+ `README.md`。
- **全导出 / 选择导出 / 子代理开关**：导出全部主对话或只勾选几个；子代理会话默认不导出。
- **导入**：本插件或 DSH 内置导出的 ZIP/JSONL → 新会话；可选把 `workspaces/` 安全解压到
  目标工作区（拒绝路径穿越/绝对路径/符号链接，已存在文件不覆盖），导入后会话 cwd 指向该目录。
- **旧格式升级（基于 DSH 官方迁移）**：列表标记“旧格式”会话，可单条或批量升级到当前格式；
  升级走官方 `persistence.open(id,'write')` 迁移链（与继续对话时的升级完全相同），旧代际文件保留，
  迁移失败的会话保持原样并在结果里给出官方原因。
- **Agent 工具**：`session_kit` 支持 list/export/import/archive/unarchive/delete（delete 必须显式确认，且只移入回收站）。

## 安装

```bash
dsh plugin --profile web add /absolute/path/to/dsh-session-kit
dsh plugin --profile web list --depth 0
# 重启 dsh web，刷新页面；侧栏出现 Session manager
```

插件声明了 `engines.dsh`，版本不满足时 DSH 会拒绝安装。发布到 npm/npmmirror 后
可直接 `dsh plugin --profile web add dsh-session-kit`。

## 包格式

```text
session-kit-<yyyymmdd-hhmmss>.zip
├── manifest.json
├── README.md
├── sessions/<sessionId>/
│   ├── session.compact.v4.jsonl   # 精简模式
│   ├── session.v4.jsonl           # 全量模式
│   └── meta.json
├── attachments/
│   ├── media/<attachmentId>.<ext>
│   └── files/<2>/<digest>/<name>
└── workspaces/<encoded-workspace>/
    └── <工作区相对路径…>            # 整棵工作区（排除敏感/构建缓存）
```

## 安全边界

- 只导出选中的会话、被引用的对话附件、以及可选的工作区文件；不读 `$DSH_HOME` 凭据、
  上传索引、缓存或遥测身份。
- 工作区文件排除：`.git`、`node_modules`、`.venv`、`dist`、`build` 等目录；
  `.env*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、`.netrc`、`credentials*`、
  `.ssh`、`.aws`、`.gnupg` 等敏感路径；符号链接不跟随，超限文件跳过并告警。
- 导入是新建会话：不覆盖/删除已有会话；工作区文件冲突时跳过已有文件并告警。
- 归档仍是用户内容（对话正文、工作区文件本身），分享前请自行复核。

## 已知限制

- 精简导出会丢失工具调用历史与文件卡片，只保留可见对话；需要完整历史用全量导出。
- 导入不保留子会话/fork 血缘；子代理日志永远不会被导入。
- 导入要求源/目标会话格式版本一致（当前 v4）；跨版本请先用对应版本 DSH 打开再导出。
- 工作区文件目前默认同步“整个工作区树”（已排除敏感/构建目录），暂不支持只挑 touched files；
  超大工作区受 1 GiB 导出上限约束，可调配置。
- 子代理会话默认隐藏；`includeSubagents: true` 可显式包含（但仍不会在导入时恢复血缘）。
- **删除相关文件只是 best-effort**：shell 重定向、PTC/脚本产物、仅在文本中提到的文件无法可靠发现；
  共享文件可能被一并移入回收站；敏感文件若被推导到也会移动（回收站内，可恢复），不会永久删除。
- 旧格式升级不是“强制转换”：DSH 的官方迁移会拒绝少数无法安全转换的旧日志（例如未闭合的 tool call、
  旧 subagent descriptor 版本），此时源文件不动、面板显示失败；这不是插件能绕过的。
- 删除不是永久擦除：会话目录被移到 `session-kit-trash`，需要彻底清理时手动删除该目录；用户 fork 出来的子会话不会被连带删除。
- 归档运行中的会话默认会被拒绝；agent 工具可用 `stopActivity` 先停止再归档。

## 实测（2026-10-31/11-01，DSH 0.2.1-rc.3）

- 测试：`node --import tsx/esm --test dsh-session-kit/test/*.test.mjs` → **168/168 通过**
  （含真实 JSONL 持久化后端、产品 replay、工作区文件/敏感排除/zip-slip/恢复、归档/删除/回收站、子代理血缘）。
- 真实数据（49 个主对话）：精简日志文本为原日志的 **0.4%–1.2%**；7 个主对话归档
  **22.7 MB → 0.35 MB**，全部导入 `verified: true`。
- 列表性能（真实 DSH 数据）：`/session-kit/list` **约 0.02–0.04 s**（3 个真实归档会话）/ 全量 58 个主对话仍在百毫秒级；
  旧实现每个会话都要读完整日志折叠标题，已移除。
- 官方迁移实测：38 个 v3-only 真实会话 36 个成功（约 95%，平均 0.29 s），2 个被官方以
  “step/end leaves unresolved tool call”拒绝且源文件不变；v0 样本中较多被旧 subagent descriptor 版本拒绝。
- 隔离 `DSH_HOME` 中真实 `dsh web` + 浏览器：导出/导入、工作区文件恢复、归档/恢复/删除
  （删除确认框、状态徽标、筛选、搜索计数）全部通过；无 console 错误。

## 开发与测试

```bash
node --test dsh-session-kit/test/*.test.mjs                 # 纯逻辑/模拟，2 个真实后端用例自动 skip
cd <repo> && node --import tsx/esm --test dsh-session-kit/test/*.test.mjs   # 含真实后端
```

## 许可

MIT。`lib/zip.js`、`lib/format.js`、`lib/attachments.js` 衍生自
[dsh-session-port](https://github.com/mswinandmc/dsh-session-port)（MIT），详见 `NOTICE`。