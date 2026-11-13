# 0002 — 回收站操作清单、恢复与永久清理

- 状态：已采纳（2026-11-13）
- 影响范围：`lib/manage.js`、`lib/trash.js`、`index.js`、`src/client/index.js`

## 背景

0.11.0 的删除只做一件事：把会话目录移动到
`<trashDir>/<timestamp>/`。目录名只有时间戳，原地没有任何结构化记录，
因此：

- 用户无法在面板里看到回收站里有什么、属于哪个会话、能否恢复；
- 恢复需要手工把目录 `mv` 回 `<sessionsRoot>/<project>/<encoded-id>/`，
  还要手工恢复归档/置顶状态，容易出错；
- 回收站只增不减，用户在面板里没有任何安全的清理入口（只能自己 `rm -rf`）。

同时，后续的会话迁移（P4）需要一个「源会话可回滚」的落点，删除到回收站
的语义必须先把清单和恢复能力补齐。

## 决策

### 1. 每次删除写一个操作清单

删除成功后，操作目录固定为：

```text
<trashDir>/<operationId>/
├── operation.json                 # 清单（本决策的核心契约）
├── <encoded-session-id>/...       # 主会话目录及 subagent 后代
├── files/<encoded-workspace>/...  # 可选：勾选的相关文件
└── files-manifest.json            # 可选：相关文件清单（既有格式）
```

`operation.json`（`lib/manage.js:TRASH_MANIFEST_*`）：

```json
{
  "kind": "dsh-session-kit-trash",
  "version": 1,
  "createdAt": "2026-11-13T00:00:00.000Z",
  "rootSessionId": "session-a",
  "sessionIds": ["session-a"],
  "sessionsRoot": "/…/sessions",
  "sessions": [
    {
      "id": "session-a",
      "trashedName": "session-a",
      "originalDir": "/…/sessions/--work--",
      "cwd": "/…/work",
      "createdAt": 1700000000000,
      "formatVersion": 4
    }
  ],
  "archived": ["session-a"],
  "pinned": [],
  "files": { "trashPath": "…/files", "manifestPath": "…/files-manifest.json" }
}
```

- 清单在**第一次移动目录之前**写入；任一目录移动失败触发回滚时清单一并删除，
  不会留下「清单指向已还原目录」的假操作。
- `sessionsRoot` 是删除时从后端位置反推的会话根目录。恢复时目标目录必须落在
  `sessionsRoot` 之内，防止清单被篡改后把目录写到任意位置。
- `archived` / `pinned` 是删除前从 workspace registry 读到的状态快照，恢复时
  按快照尽力重放。

### 2. 回收站是一个只读清单 + 两个显式动作

新增 `lib/trash.js`，三个入口：

| 函数 | 语义 | 默认安全边界 |
| --- | --- | --- |
| `listTrashOperations(ctx, { trashDir })` | 列出回收站操作、会话数、字节数、能否恢复 | 只读；最多 `MAX_TRASH_OPERATIONS=500` 个操作 |
| `restoreTrashOperation(ctx, { trashDir, operationId, sessionIds? })` | 把记录中的目录移回原位并重新 attach，恢复归档/置顶 | 目标已存在则跳过，**绝不覆盖**；路径必须落在 `sessionsRoot` 内 |
| `purgeTrashOperations(ctx, { trashDir, operationIds, confirm, olderThanDays? })` | 永久删除操作目录 | `confirm === true` 才执行；每个 id 必须是回收站根内的普通目录名 |

HTTP 与工具动作一一对应：`GET /session-kit/trash`、
`POST /session-kit/trash-restore`、`POST /session-kit/trash-purge`，以及
`session_kit` 的 `trash_list` / `trash_restore` / `trash_purge`。

### 3. 恢复语义

- 逐个会话：`mkdir originalDir` → `rename(trashPath, originalDir)` → 通过
  `workspaceRegistry.resolveByPath(originalDir).attachSession(id)` 重新挂回工作区。
- 跳过原因（`skipped[].reason`）：`target-exists`、`missing`、
  `no-original-location`、`unsafe-location`、`move-failed`。跳过不会中断其余会话。
- 局部恢复后清单被重写为剩余会话；全部恢复且无 `files/` 时删除空操作目录。
- 归档/置顶重放失败只记入 `warnings`，不让已经移动成功的目录回滚。

### 4. 兼容旧操作目录

没有 `operation.json` 的旧目录仍会出现在列表里，但
`restorable: false` 并带一条 `缺少清单` 警告；`trash_restore` 以
`trash-manifest-missing`（HTTP 409）拒绝。旧目录只能由 `purge` 清理，
或被用户手工还原。

## 备选方案

1. **只按目录名/时间戳列出**：无法知道会话 id 与原位置，恢复仍要人工，
   并且无法恢复归档/置顶状态。否决。
2. **恢复时扫描会话日志头重建清单**：日志可能已被截断或为旧格式，且无法
   还原 `originalDir`。否决。
3. **删除时立即永久删除**：用户要求可回滚的迁移（P4），否决。
4. **让 `purge` 同时清理附件对象存储**：`AttachmentStore` 只有 append，
   没有删除/GC API；越权直接改对象目录会破坏引用计数。附件清理降级为
   P7 的只读孤立附件报告，不在本决策内。

## 后果

- 回收站占用可见、可恢复、可清理；删除不再是一条不可逆的单向门。
- 恢复依赖 DSH 的 `attachSession`：如果目标工作区在删除后被移除，会话目录
  仍会还原，但不会挂回任何工作区（跳过记录 + 警告）。
- 子代理转录随目录一起移动/恢复，但导入侧仍然永不导入子代理日志。
- 回收站不会自动过期清理；`purge` 是唯一的删除入口，必须显式确认。
- 旧操作目录保持「可见但不可恢复」，不会阻塞新的删除流程。

## 验证

- `test/trash.test.mjs`：真实 delete → manifest → list → restore 端到端；
  目标已存在不覆盖；缺清单拒绝；`../outside` 路径拒绝；篡改
  `originalDir` 被 `sessionsRoot` 拦截；`purge` 必须 `confirm`、拒绝越界 id、
  `all` 与释放字节统计。
- `test/index-trash.test.mjs`：路由转发 `trashDir`、restore 必填
  `operationId` 且拒绝 `sessionIds: "all"`、purge 的 confirm/scope/
  `olderThanDays`、缺模块 503、栅栏 403（模块零调用）、工具动作枚举/文案/
  拒绝分支。
- 面板：Trash 卡片列出操作、逐操作恢复/清理、全部清理二次确认；
  手工回归覆盖恢复后列表刷新与归档状态。

## 回滚

删除 `lib/trash.js`、三条路由与三个工具动作、面板卡片即可；已写入的
`operation.json` 不影响旧版本（旧版本忽略未知文件），回收站目录仍可手工还原。
