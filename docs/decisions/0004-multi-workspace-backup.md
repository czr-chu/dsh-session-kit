# 0004 — 多工作区备份：每个工作区各自一个 ZIP

- 状态：已采纳（2026-11-13）
- 影响范围：`index.js`、`src/client/index.js`、`docs/architecture.md`、`docs/feature-matrix.md`

## 背景

工作区备份（P3 / F18）最初一次只接受一个 `workspaceId`，面板是一个单选下拉框，
工具动作也只写一个 ZIP。用户需要「一次选择多个工作区导出」，并且明确要求
**每个工作区各自一个 ZIP**，而不是把所有工作区塞进同一个归档。

约束：

- 一个 HTTP 响应只能携带一个 ZIP，`POST /session-kit/export-workspace` 的既有
  契约（`content-type: application/zip` + `x-session-kit-filename`）不能改成
  多文件响应；
- 工作区备份的语义是「该工作区全部主会话 + 整棵工作区树，只打包一次」。
  如果把多个工作区合并成一个归档，两个工作区的同名文件、会话归属和
  `manifest.backup` 都会变得含混；
- 浏览器端一次用户手势后连续下载多个文件，可能触发浏览器的「允许多个下载」
  提示；这是可接受的行为，但必须在文档里说清楚。

## 决策

### 1. 面板：多选后逐个请求、逐个下载

`Workspace backup` 卡片从单选下拉框改成复选框列表（含「全选工作区」和已选数量），
`workspaceBackupIds` 保存选择集。点击备份后按选择顺序**串行**调用既有的
`POST /session-kit/export-workspace`，每个工作区一次请求、一个 ZIP、一次
`downloadBlob`。某个工作区失败不会中断其余工作区；结果通知分别列出
「已下载：<filename>」与「<工作区>：<错误>」，部分失败时标题变为
「已导出 N 个工作区，M 个失败」。

面板最多接受 `MAX_WORKSPACE_BATCH = 20` 个选择（Host 与工具共用该上限）。

### 2. 工具：`workspaceIds` 数组，逐个写文件

`session_kit action=export_workspace` 新增 `workspaceIds: string[]`：

- 非空数组优先于 `workspaceId`；两者都缺时报错仍包含 `workspaceId` 字样；
- 去空、trim、去重后最多 20 个，超过直接拒绝（不产生任何文件）；
- 逐个调用 `buildWorkspaceBackup` 并写入 `defaultExportDirectory()`，
  每个工作区一个文件；单个失败只记录该工作区，最后在文本里逐项列出；
- 全部失败时抛错并聚合原因；单个成功仍沿用原有「已备份工作区「…」到 …」
  文案，批量成功输出「已备份 N 个工作区（模式 …），每个工作区一个 ZIP：」；
- 同一批次内标题相同导致文件名相同（`workspace-<slug>-…zip`）时，第二个
  工作区在 `.zip` 前追加 `-<workspaceId>`，绝不覆盖同批次的另一个归档。

### 3. HTTP 路由保持单工作区

`POST /session-kit/export-workspace` 仍然一次请求一个 ZIP；批量是客户端/工具层
的循环，不引入容器 ZIP、嵌套 ZIP 或 tar 之类的第二种归档格式。这样：

- 已有消费者（包括 DSH 面板的旧版本）行为不变；
- 每个 ZIP 都是普通的工作区归档，可独立导入/校验；
- 失败粒度与工作区一致，不会出现「一个大包解压到一半」的状态。

## 备选方案

1. **一个容器 ZIP 里放多个 `<workspace>.zip`**：用户拿到的仍是一个文件，需要
   再解压一次才能得到各工作区的 ZIP；而且插件没有浏览器端解压能力。否决。
2. **把多个工作区合并成一个普通归档**：会话归属、同名工作区文件、
   `manifest.backup`（单数）都无法表达；导入时也无法按工作区恢复。否决。
3. **新增 `POST /session-kit/export-workspaces` 返回 multipart 或多个 ZIP**：
   HTTP 语义复杂、浏览器下载行为不可控，且与「每次一个 ZIP」的路由契约冲突。否决。
4. **服务端打包成 tar**：引入新的归档格式与解析器，偏离「归档就是 ZIP」的既有模型。否决。

## 后果

- 选择一个工作区时行为与之前完全一致（一次请求、一个 ZIP）。
- 选择多个工作区时，浏览器会连续触发多次下载；若浏览器拦截多文件下载，用户需要
  允许该站点的多个下载。面板会逐条报告每个文件的结果。
- 批量备份不是原子的：某个工作区失败时，已经下载/写出的 ZIP 仍然有效。
- 工具批量写入导出目录时，同一批次内的重名会自动加工作区 id 后缀；不同批次之间
  仍可能按时间戳/标题产生同名文件（后写覆盖先写，与单工作区行为一致）。
- 工作区没有可导出的会话时，该工作区单独失败并报告 `missing-sessions`，不影响其他。
- 归档格式、manifest 版本、导入路径均未改变。

## 验证

- `test/index-workspace.test.mjs`（16）：
  - 「writes one ZIP per workspace and reports per-item results」：`workspaceIds`
    去重/trim、`workspaceId` 被忽略、每个工作区各写一个文件且内容独立；
  - 「validates workspaceIds and keeps the single-id form」：空字符串项拒绝、
    21 个拒绝且零构建、空数组时回退到 `workspaceId`；
  - schema 断言 `workspaceIds` 为 string 数组；
  - 既有单工作区路由/工具用例保持通过。
- 全量：`npm test` 300 tests / 291 pass / 9 skip。
- 面板：多选、全选、部分失败通知为手工回归项（客户端无自动化测试）。

## 回滚

把面板恢复为单选下拉框、删除工具的 `workspaceIds` 解析与批量文本、
移除 `MAX_WORKSPACE_BATCH` 即可；HTTP 路由与归档格式未改动，已导出的 ZIP
不受影响。
