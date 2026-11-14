# 0007 整个工作区归档与恢复

## 背景

DSH 以工作区作为项目容器：一个工作区下挂多个会话，会话的 `header.cwd`
realpath 必须等于工作区路径。DSH 只提供**会话级**归档
（`WorkspaceRegistry.archiveSession` / `unarchiveSession`，状态是全局集合），
没有工作区级归档 API；`registry.delete(id)` 只删除工作区注册，目录和会话日志
都留在磁盘上，这些会话随后失去分组、落到未命名工作区。用户需要“整个项目先
收起来，之后原样恢复”，而不是删除目录或导出 ZIP。

## 决策

新增 `lib/workspace-archive.js`，把“工作区归档”定义为**归档成员会话 + 移除
工作区注册**，不移动、不删除、不复制任何文件：

1. 解析工作区，记录标题、路径、顺序、每个会话的 `archived` / `pinned`
   前置状态。
2. 在 `<DSH_HOME>/session-kit-workspace-archive/<archiveId>/record.json`
   原子写入恢复清单（kind `dsh-session-kit-workspace-archive`，version 1）。
   先写清单再动注册状态，避免出现“工作区已消失但没有记录”。
3. 逐个调用官方 `archiveSession(id)`；已经是归档状态的会话跳过。任一失败
   （包括活动会话被官方拒绝）就回滚本次新归档的会话并删除清单，工作区保持
   不变。
4. 最后调用 `registry.delete(id)` 移除工作区注册；失败同样回滚会话并删除
   清单。

恢复时校验清单与目录，复用同路径工作区或 `registry.create(path,title)`
重建，然后逐个 `attachSession`。只对清单里“本次归档前未归档”的会话调用
`unarchiveSession`，保留用户原本就归档的会话；原本置顶的会话重新置顶。
**只有所有会话都 attach 成功才删除清单**；否则把 `restoredAt`、
`pendingSessionIds`、`lastWarnings` 写回清单，保留为 `partial` 供重试。

清单根目录可由 `archiveRoot` 覆盖（测试用）。`archiveId` 只能是一段目录名，
且必须位于清单根内；删除清单时不跟随符号链接。

## 备选与否决

- **只调用 `registry.delete`**：会话会掉进未命名工作区，丢失项目分组，正是
  用户要避免的现象。
- **归档时打包 ZIP**：工作区备份已经能做；归档应保持原地、可快速恢复，不应
  复制工作区文件。
- **移动目录到归档区**：会破坏 DSH 的路径/工作区映射，且大目录移动代价高、
  跨卷易失败。
- **停止活动会话后强行归档**：会打断正在运行的任务；改为拒绝并整体回滚。
- **恢复时把所有会话都 unarchive**：会把用户原本就归档的会话错误地放出来。

## 后果

- 工作区 id 在恢复后通常会变化（注册被重建）；会话 id、日志和文件不变。
- 归档当前正在使用的工作区会让 DSH 离开该工作区（主面板随工作区消失）；
  需要从其他工作区、或新建工作区后打开“会话管理”查看记录并恢复。
- 会话的全局归档状态属于 DSH；恢复只撤销本次归档造成的状态。
- 不处理子代理转录、附件字节和工作区文件；它们本来就不随工作区注册变化。
- 活动会话、目录缺失、attach 失败都不会静默成功：分别回滚 / 保留清单 /
  标记 partial。
- 清单最多列出 500 条（`MAX_WORKSPACE_ARCHIVES`），超过时列表截断并给出
  warning；单条记录不会自动过期。

## 验证

- `test/workspace-archive.test.mjs`（6）：完整归档、活动会话回滚、恢复重建与
  只撤销本次归档、目录缺失保留清单、attach 失败 partial、列表含损坏记录。
- `test/index-workspace-archive.test.mjs`（6）：三条路由的参数/转发/503/403，
  工具 enum、描述、中文摘要与缺参拒绝。
- 隔离 DSH 0.2.2-rc.3 环境用真实 registry 做过归档 → 列表 → 恢复的 API e2e；
  headless Chrome 打开面板、归档当前工作区、确认 DSH 离开该工作区且无
  console error。
- 全量 `npm test` 326 tests / 317 pass / 9 skip；`npm run format:check`。

## 回滚

删除 `lib/workspace-archive.js`、三条路由、三个 tool action、面板卡片与
`workspaceArchive` module seam 即可；清单目录是新增的，不影响既有会话/工作区
数据。已归档的工作区可用 `workspace_restore` 或手工重建工作区后 attach 恢复。
