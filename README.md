# dsh-session-kit

DeepSeek Harness 会话管理与迁移插件：浏览/选择会话，按“精简（compact）”或“全量”导出，
再在另一台 DSH 上导入为新的会话。

## 能力

- **会话管理面板**：按工作区分组列出会话，搜索、全选/反选、多选。
- **精简导出（创新点）**：把会话压成“主对话”版本——只保留用户提问与每一轮的最终助手回答，
  丢弃工具调用/结果、推理流、流式 chunk、子会话等；体积通常只有原日志的一小部分，
  导入后仍是可继续对话的合法 DSH 会话。
- **全量导出**：保留完整事件日志与附件（图片/文件），用于完整备份。
- **按会话文件夹打包**：一个 ZIP 内每个会话一个文件夹（`sessions/<id>/`），
  附件放 `attachments/`，并带 `manifest.json` + `README.md` 说明关系与恢复方法。
- **全量/选择导出**：导出全部会话或只勾选几个。
- **导入**：把本插件导出或 DSH 内置导出的 ZIP/JSONL 导入为当前工作区的新会话（不覆盖已有会话）。
- **Agent 工具**：`session_kit` 支持 list/export/import，可用自然语言让 agent 导出会话。

## 安装

```bash
# Web / CLI 部署
dsh plugin --profile web add /absolute/path/to/dsh-session-kit

# 确认
dsh plugin --profile web list --depth 0
# 重启 dsh web，刷新页面
```

插件已在 `package.json` 声明 `engines.dsh`，版本不满足时 DSH 会拒绝安装。

## 包格式

```text
session-kit-<yyyymmdd-hhmmss>.zip
├── manifest.json
├── README.md
├── sessions/<sessionId>/
│   ├── session.compact.v4.jsonl   # 精简模式
│   ├── session.v4.jsonl           # 全量模式
│   └── meta.json
└── attachments/
    ├── media/<attachmentId>.<ext>
    └── files/<2>/<digest>/<name>
```

## 已知限制

- 导入一律创建**新会话**：新 id，不保留与子会话/fork 的血缘，cwd 以导入时选择的目录为准。
- 精简导出会丢失工具调用历史与文件卡片，只保留主对话文本；需要完整历史请用全量导出。
- **子代理会话默认不显示**（列表只列人类主对话）；需要时可在 API/工具里传 `includeSubagents: true`。
- **工作区文件实体不在归档内**：当前只打包“对话里上传的图片/文件附件”，不复制工作区里被工具读写/产出的文件。
  需要“每会话带文件”时应另外收集（本插件后续可扩展）。
- 导入要求源/目标会话格式版本一致（当前 v4）；跨版本请先用对应版本 DSH 打开再导出。
- 导出大小上限默认 1 GiB，导入上限 512 MiB，可在 profile 的 `cordis.patch.yml` 里调整。

## 实测（2026-10-31，DSH 0.2.1-rc.3）

- 单元/集成测试：`node --import tsx/esm --test dsh-session-kit/test/*.test.mjs` → **50/50 通过**
  （含真实 JSONL 持久化后端与产品 `Session.create` replay 校验）。
- 真实数据（本机 49 个主对话）：精简日志文本体积为原日志的 **0.4%–1.2%**；
  取 7 个主对话做归档：全量 **22.7 MB** → 精简 **0.35 MB**；全部导入后 `verified: true`、可重新打开。
- 在隔离 `DSH_HOME` 中安装并启动真实 `dsh web`：`/session-kit/{info,list,export,import}` 全部可用；
  浏览器里打开“Session manager”面板，勾选 → 导出 ZIP、选择文件 → 导入新会话均成功，无 console 错误。

## 开发与测试

```bash
# 纯逻辑/模拟测试
node --test dsh-session-kit/test/*.test.mjs

# 带真实 DSH 后端的测试（在仓库根执行）
node --import tsx/esm --test dsh-session-kit/test/*.test.mjs
```

## 许可

MIT。`lib/zip.js`、`lib/format.js`、`lib/attachments.js` 衍生自
[dsh-session-port](https://github.com/mswinandmc/dsh-session-port)（MIT），详见 `NOTICE`。
