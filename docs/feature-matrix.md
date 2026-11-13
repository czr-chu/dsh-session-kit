# Feature matrix

Evidence for dsh-session-kit <code>0.12.0</code>, refreshed 2026-11-14 by
reading the code and running the repository test suite. Line numbers point at the source
as of this check; tests are the authoritative coverage.

## Status legend

- **稳定** — implemented; core logic has automated tests (unit/integration or
  route-level); no known correctness gap for the documented use.
- **稳定（受限）** — works, but a documented environmental, format or size
  constraint applies.
- **实验性** — best-effort or high-risk behavior; clearly labelled in the UI and
  not guaranteed to be complete.
- **稳定（受限：客户端无自动化测试）** — UI behavior exists and the host-side
  operation is tested, but no automated browser test covers the interaction.

## Matrix

| ID | 功能 | 状态 | 实现位置 | 自动化/验证证据 | 已知限制 |
| --- | --- | --- | --- | --- | --- |
| F1 | 会话列表：按工作区分组、归档合并、子代理默认隐藏 | 稳定 | <code>lib/sessions.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/sessions.test.mjs</code>（20）、<code>test/index-manage.test.mjs</code>（/list 用例） | 全量扫描，无分页/虚拟滚动 |
| F2 | 搜索标题/id/cwd/工作区名；全部/未归档/已归档筛选；全选/反选 | 稳定（受限：客户端无自动化测试） | <code>src/client/index.js</code> | 无仓库内自动化测试；开发期临时 mock-runtime 冒烟未入库 | 匹配与分组只在浏览器端；大列表全量渲染 |
| F3 | 归档 / 恢复（单条与批量） | 稳定 | <code>lib/manage.js</code>, <code>lib/manage.js</code>, <code>index.js</code>, <code>index.js</code> | <code>test/manage.test.mjs</code>（33）、<code>test/index-manage.test.mjs</code>（19） | 运行中会话需 <code>stopActivity</code>；归档状态来自 workspace registry |
| F4 | 删除到回收站（含 subagent 后代，保留用户 fork/seeded 子会话） | 稳定 | <code>lib/manage.js</code>, <code>index.js</code> | <code>test/manage.test.mjs</code>、<code>test/index-manage.test.mjs</code>、<code>test/index-files.test.mjs</code>、<code>test/trash.test.mjs</code> | 删除时写 <code>operation.json</code> 清单；回收站需手动清理（<code>trash_purge</code>）；附件对象存储不随会话删除清理 |
| F5 | 永久删除（显式 opt-in，二次红色确认，无回收站） | 稳定（高风险，无回滚） | <code>lib/manage.js</code>（<code>deleteSession</code> 的 permanent 分支）、<code>index.js</code>, <code>src/client/index.js</code> | <code>test/manage.test.mjs</code>、<code>test/index-detail.test.mjs</code> | 不可恢复；失败时仅报告已删/未删项；无附件存储清理 |
| F6 | 相关文件推导、预览、逐文件勾选、移入回收站 | 实验性 | <code>lib/session-files.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/session-files.test.mjs</code>（4）、<code>test/index-files.test.mjs</code>（15）、<code>test/manage.test.mjs</code> | best-effort：shell 重定向、PTC/脚本产物、正文提及不可见；共享文件会影响其他会话；敏感文件若被推导到也会处理 |
| F7 | 会话详情：存储大小（含所有代际）、格式状态、归档状态、相关文件列表 | 稳定（相关文件列表为实验性） | <code>lib/sessions.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/sessions.test.mjs</code>（20）、<code>test/index-detail.test.mjs</code>（15） | 大小按后端目录统计后回退 snapshot；文件列表同 F6 的近似性 |
| F8 | 旧格式迁移（官方迁移链，单条/批量） | 稳定（受限：官方可能拒绝） | <code>lib/migrate.js</code>, <code>index.js</code> | <code>test/migrate.test.mjs</code>（9）、<code>test/index-migrate.test.mjs</code>（17） | 不强制转换；拒绝时源文件不变；开发期真实数据 38 个 v3-only 中 36 成功、2 个被官方拒绝 |
| F9 | 精简（compact）与压缩（compressed）导出 | 稳定（压缩为新增，见 decisions/0001） | <code>lib/compact.js</code>, <code>lib/compressed.js</code>, <code>lib/export.js</code> | <code>test/compact.test.mjs</code>（16）、<code>test/compressed.test.mjs</code>（6）、<code>test/export.test.mjs</code>（15）、<code>test/index-export.test.mjs</code>（8） | compact 有损：丢弃工具调用、推理流、chunk、job、subagent 等；compressed 保留全部事件结构，但有损：流式增量置空、超长字符串截断（默认 8 KiB/串、16 KiB/事件） |
| F10 | 全量导出、manifest、附件、按会话文件夹打包 | 稳定 | <code>lib/export.js</code>, <code>lib/zip.js</code>, <code>lib/attachments.js</code> | <code>test/export.test.mjs</code>（15）、<code>test/import.test.mjs</code>（21）、<code>test/index-export.test.mjs</code>（8，路由选项/ZIP 头）、<code>test/format.test.mjs</code>（3，header 保真） | 内存中构建 ZIP，默认 1 GiB 上限；无流式产出 |
| F11 | 整工作区文件随包导出（敏感/构建目录排除，符号链接不跟随） | 稳定（受限） | <code>lib/workspace-files.js</code>, <code>lib/export.js</code> | <code>test/workspace-files.test.mjs</code>（13）、<code>test/export.test.mjs</code> | 目前只支持整树，不支持只挑 touched files；受 maxExportBytes/workspaceMaxBytes 与内存约束 |
| F12 | ZIP / 裸 JSONL 导入为新会话；恢复 archived/pinned；重复预检/skipDuplicates；NDJSON 进度；可选恢复工作区文件 | 稳定 | <code>lib/import.js</code>, <code>index.js</code> | <code>test/import.test.mjs</code>（21：flags/重复/进度）、<code>test/index-import.test.mjs</code>（7：query 解析/413/503/NDJSON/真实归档端到端） | 不保留父/子会话血缘；子代理日志永不导入；要求格式版本一致（当前 v4）；重复项默认仍导入（新 id），仅 skipDuplicates 时过滤 |
| F13 | 子代理策略：默认不导出、永不导入 | 稳定 | <code>lib/export.js</code>, <code>lib/import.js</code> | <code>test/export.test.mjs</code>、<code>test/import.test.mjs</code> | 子代理转录不单独导出/导入；不恢复血缘 |
| F14 | DeepSeek 分享链接导入（可选目标工作区） | 稳定（受限：仅公开链接；网络测试为 mock） | <code>lib/deepseek-share.js</code>/<code>:178</code>/<code>:337</code>/<code>:520</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/deepseek-share.test.mjs</code>（9，全部 mock 网络）、<code>test/index-share.test.mjs</code>（15） | 只能是 <code>chat.deepseek.com/share/&lt;id&gt;</code> 或裸 id；60 s 超时、32 MiB 响应上限；真实联网未自动化 |
| F15 | Agent 工具 <code>session_kit</code>：list/export/export_workspace/import/archive/unarchive/delete/migrate/files/detail/import_share/trash_list/trash_restore/trash_purge/move/attachment_report | 稳定 | <code>index.js</code>（action enum 与 schema） | 各 <code>test/index-*.test.mjs</code> 中的 tool 用例；<code>detail</code> 见 <code>test/index-detail.test.mjs</code> | 工具可在 <code>confirm:true</code> 下执行破坏性操作，没有插件级人工审批 UI；<code>detail</code> 上限 100 个 id |
| F16 | 客户端面板整体（徽标、搜索、排序、每组渐进分页、详情、删除/迁移/工作区迁移对话框、分享卡片、工作区备份（多选）、回收站卡片、附件引用检查卡片、导入跳过重复项、选择集提示） | 稳定（受限：客户端无自动化测试） | <code>src/client/index.js</code> → 构建为 <code>lib/client.js</code> | 无仓库内自动化测试；<code>test/client-build.test.mjs</code> 校验构建契约；0.11.0 曾在 DSH 0.2.2 做过浏览器冒烟，0.12.0 的面板改动（迁移/回收站/多选备份/附件检查/分页排序）未重新做浏览器冒烟 | 无自动化浏览器测试；深层交互仍需手工回归；服务端搜索/排序与虚拟滚动未实现（见 decisions/0005） |
| F18 | 工作区级备份：一个 workspace 的全部会话 + 整棵工作区树只打包一次；可多选工作区，每个工作区各自一个 ZIP；导入到目标 workspace | 稳定 | <code>lib/workspace-backup.js</code>, <code>lib/export.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/workspace-backup.test.mjs</code>（7，含真实后端）、<code>test/index-workspace.test.mjs</code>（16）；真实 DSH 手工 e2e | 目标 workspace 必须已存在；归档/置顶由导入按 manifest 尽力恢复；无会话的工作区单独失败；文件仍受排除/大小上限约束；工具批量上限 20 个；面板多选会连续触发多次下载 |
| F19 | 回收站管理：清单列表、按操作恢复、永久清理（单条/全部/按天数） | 稳定 | <code>lib/manage.js</code>, <code>lib/trash.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/trash.test.mjs</code>（6）、<code>test/index-trash.test.mjs</code>（6，路由 + 工具 + 503/403）；面板手工回归 | 旧操作目录（无 <code>operation.json</code>）可见但不可恢复，只能 purge 或手工还原；恢复依赖 <code>attachSession</code>，目标工作区不存在时目录还原但不挂回；不清理附件；不恢复子代理血缘 |
| F20 | 会话迁移到指定工作区（copy-then-trash：新 id + cwd=目标，读回验证后源进回收站） | 稳定（受限：产生新 id） | <code>lib/move.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/move.test.mjs</code>（8）、<code>test/index-move.test.mjs</code>（4：路由 + 工具 + 503/403）；面板手工回归 | 旧 id 失效；活动会话、子代理转录、旧格式会话跳过；子代理转录不复制；附件共享不复制字节；批量非原子，上限 100 |
| F21 | 附件引用只读检查：扫描最多 300 个会话，报告宿主文件缺失/无法验证的图片与文件引用 | 稳定（只读诊断） | <code>lib/attachment-report.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/attachment-report.test.mjs</code>（3）、<code>test/index-attachment-report.test.mjs</code>（5：路由/工具/503/403） | 只查“引用是否可解析”，不枚举孤儿附件（store 无列表/删除 API）；300 会话上限；无 hostPath 的后端记 unverifiable；不删除、不改写、不重打包 |
| F17 | HTTP 路由信任栅栏、批量上限、错误映射 | 稳定 | <code>index.js</code> | route-level 测试覆盖 <code>/export</code>、<code>/import</code>（含 NDJSON）、archive/unarchive/delete/migrate/files/session-detail/import-share/attachment-report 与 403/503/413/400 分支；栅栏拒绝返回 <code>{ok:false,code:'forbidden'}</code> | 批量全失败时按首个错误码映射 404/409/503/500 |

## Cross-cutting notes

- Test totals: 28 files, 313 tests. Plain <code>node --test</code> runs 304 and
  skips 9 guarded cases that need a DSH checkout through <code>tsx</code>. See
  <code>docs/self-assessment.md</code>; the audit there describes the 0.11.0
  line, not this working tree.
- Chat UI behavior is not part of the automated suite; treat F2/F16 as manually
  verified only.
- Evidence is intentionally conservative: a feature is "稳定" only where the
  repository has automated coverage for its core path; otherwise it is marked
  limited, experimental or client-manual.