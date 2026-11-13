# 0003 — 把会话迁移到另一个工作区（copy-then-trash）

- 状态：已采纳（2026-11-13）
- 影响范围：`lib/move.js`、`index.js`、`src/client/index.js`、`lib/manage.js`（复用删除到回收站）

## 背景

DSH 的工作区归属由**会话日志头里的 `cwd`** 决定：
`WorkspaceEntity.attachSession` 要求 `header.cwd` 的 realpath 等于工作区目录
（`dsh-workspace/src/entity.ts:139-144`）。日志一旦写成，`cwd` 就是持久化
事实，插件既不能原地改写一个历史会话的归属，也不能让同一个会话同时属于两个
工作区。

用户要的是「把一个会话移动到指定工作区」：迁走后它只出现在目标工作区，
原工作区不再列出它；同时不能因此丢对话。

## 决策

### 1. 一次迁移 = 复制 + 读回验证 + 把源移入回收站

`lib/move.js` 的 `moveSessions(ctx, { workspaceId, sessionIds, trashDir })`
对每个源会话按顺序执行：

1. **预检**：源是活动会话（`sessions.get` 命中，或 `agents.get` 状态为
   running）、子代理转录（`header.origin === 'subagent'`）、或旧格式
   （`header.version !== 当前版本`）时直接跳过，**不写任何副本**；
2. **复制成新会话**：`mintSessionId` 生成新 id，头写
   `version/createdAt/cwd=目标 workspace.path/isSeeded:false/delegationDepth:0`，
   `agentPreset` 只在本机 `agentPresets.resolve` 成功时保留（失败降级为警告），
   事件逐条保留，delivery 标记改写到新 id，end-seed 的 `inherited` 标记清除；
3. **读回验证**：通过 `sessionQuery.readSession(newId)` 读回，读不到就报
   `verify-failed`，**源会话保持原样**；
4. **挂回目标工作区**：`attachToWorkspace`（`registry.get(...).attachSession`）；
5. **重放状态**：源会话的 archived / pinned 尽量在新 id 上重放，失败只记警告；
6. **把源移入回收站**：复用 `deleteSession`（含子代理后代、写
   `operation.json`、清理 registry 成员关系）。只有这一步失败时，
   `sourceTrashed: false` 且保留新副本，绝不回删已经写好的副本。

结果形状：

```json
{
  "target": { "workspaceId": "ws-2", "path": "/…/ws2", "title": "…" },
  "moved": [{ "sourceId": "s1", "sessionId": "s1-new", "sourceTrashed": true, "eventCount": 42 }],
  "skipped": [{ "id": "s2", "reason": "active", "message": "…" }],
  "warnings": ["…"]
}
```

批量**不是原子的**：逐条容错，前面的会话已经迁走时，后面的失败只进
`skipped`。请求上限 `MAX_MOVE_SESSIONS = 100`。

### 2. 迁移是「新会话」，不是改归属

旧 id 的链接、书签、其他工具里的引用在迁移后失效；恢复回收站里的源会话
会带回旧 id。这是 DSH 的存储模型决定的，面板与工具文案都明确提示，不假装
是原地重命名。

### 3. 传输契约

- 事件完整复制（`full` 语义），不做 compact/compressed 截断；
- 子代理转录**不复制**：它们随源目录进回收站（与导入「永不导入子代理日志」
  的策略一致）；
- 附件按内容寻址共享：事件里的附件引用在新会话继续解析，不复制字节；
- 工作区相关文件不移动，只改会话存储位置；
- `cwd` 由目标工作区决定，源会话原来的 `cwd` 不再写入新头。

### 4. 入口与安全确认

- HTTP：`POST /session-kit/move`，body `{ workspaceId, sessionIds, confirm: true }`；
  `confirm` 不是 `true` 时返回 400 `confirm-required`；
- 工具：`session_kit action=move`，`workspaceId` 必填，`sessionIds` 不接受 `all`，
  `confirm:true` 必填；
- 面板：选中会话 → 「迁移到工作区」→ 目标工作区下拉框（默认第一个）→
  确认对话框列出会话标题，确认后调用路由并清空选择；
- 目标工作区必须是已存在的真实目录（`stat().isDirectory()`），否则
  `workspace-not-found`。

## 备选方案

1. **就地改 `header.cwd` 并让注册表重新 attach**：违反 DSH 的工作区归属模型
   （realpath 必须匹配），会制造「列表里有、工作区打不开」的会话；而且旧
   `cwd` 的历史上下文被伪造。否决。
2. **只复制不删源（跨工作区副本）**：用户要的是移动；两份会话会互相分叉，
   且都没有提示。否决。
3. **直接 `rename` 会话目录到目标工作区的项目目录**：目录名只编码会话 id，
   项目目录由 `cwd` 决定；绕过 attach/验证等于绕过真实归属。否决。
4. **复制后永久删除源**：用户明确要求可回滚，否决；源进回收站。

## 后果

- 目标工作区出现新 id 的会话，源工作区不再列出旧会话（源已进回收站）。
- 旧 id 失效；需要旧 id 时从回收站恢复源操作。
- 活动会话必须先在 UI 关闭/停止，否则被跳过而不是强杀。
- 子代理转录留在回收站的源目录里，不会出现在新会话下；附件字节不重复。
- 迁移与删除共享回收站清单，因此该操作可被 `trash_restore` 还原。
- 扩展字段（除规范头字段外）不随迁移复制：新头是重建的最小头，与导入一致。

## 验证

- `test/move.test.mjs`（8）：完整迁移（新 id/cwd/事件/delivery、attach、
  archived+pinned 重放、源目录消失、`operation.json` 的 `rootSessionId`）、
  seeded→unseeded、活动会话跳过且不写副本、子代理+旧格式跳过原因、
  读回失败时源保留且没有回收站目录、回收站失败 `sourceTrashed:false`、
  未知工作区、空参数/超上限。
- `test/index-move.test.mjs`（4）：路由 `confirm`/`workspaceId`/`sessionIds`
  校验与 `trashDir` 转发、503/403 栅栏、工具枚举/描述/中文摘要、工具拒绝分支。
- 全量：`npm test` 298 tests / 289 pass / 9 skip（skip 需要 DSH checkout + tsx）。

## 回滚

删除 `lib/move.js`、`POST /session-kit/move`、工具 `move` 动作与面板入口即可。
已经完成的迁移留在磁盘上：新会话是普通 v4 会话，旧会话在回收站，二者都不依赖
本功能继续存在。
