# Feature matrix

Evidence for dsh-session-kit <code>0.10.3</code>, collected 2026-11-07 by reading
the code and running the repository test suite. Line numbers point at the source
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
| F4 | 删除到回收站（含 subagent 后代，保留用户 fork/seeded 子会话） | 稳定 | <code>lib/manage.js</code>, <code>index.js</code> | <code>test/manage.test.mjs</code>、<code>test/index-manage.test.mjs</code>、<code>test/index-files.test.mjs</code> | 回收站不自动清理；附件对象存储不随会话删除清理 |
| F5 | 永久删除（显式 opt-in，二次红色确认，无回收站） | 稳定（高风险，无回滚） | <code>lib/manage.js</code>（<code>deleteSession</code> 的 permanent 分支）、<code>index.js</code>, <code>src/client/index.js</code> | <code>test/manage.test.mjs</code>、<code>test/index-detail.test.mjs</code> | 不可恢复；失败时仅报告已删/未删项；无附件存储清理 |
| F6 | 相关文件推导、预览、逐文件勾选、移入回收站 | 实验性 | <code>lib/session-files.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/session-files.test.mjs</code>（4）、<code>test/index-files.test.mjs</code>（15）、<code>test/manage.test.mjs</code> | best-effort：shell 重定向、PTC/脚本产物、正文提及不可见；共享文件会影响其他会话；敏感文件若被推导到也会处理 |
| F7 | 会话详情：存储大小（含所有代际）、格式状态、归档状态、相关文件列表 | 稳定（相关文件列表为实验性） | <code>lib/sessions.js</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/sessions.test.mjs</code>（20）、<code>test/index-detail.test.mjs</code>（15） | 大小按后端目录统计后回退 snapshot；文件列表同 F6 的近似性 |
| F8 | 旧格式迁移（官方迁移链，单条/批量） | 稳定（受限：官方可能拒绝） | <code>lib/migrate.js</code>, <code>index.js</code> | <code>test/migrate.test.mjs</code>（9）、<code>test/index-migrate.test.mjs</code>（17） | 不强制转换；拒绝时源文件不变；开发期真实数据 38 个 v3-only 中 36 成功、2 个被官方拒绝 |
| F9 | 精简（compact）导出 | 稳定 | <code>lib/compact.js</code>, <code>lib/export.js</code> | <code>test/compact.test.mjs</code>（16）、<code>test/export.test.mjs</code>（13） | 有损：丢弃工具调用、推理流、chunk、job、subagent 等 |
| F10 | 全量导出、manifest、附件、按会话文件夹打包 | 稳定 | <code>lib/export.js</code>, <code>lib/zip.js</code>, <code>lib/attachments.js</code> | <code>test/export.test.mjs</code>（13）、<code>test/import.test.mjs</code>（20） | 内存中构建 ZIP，默认 1 GiB 上限；无流式产出 |
| F11 | 整工作区文件随包导出（敏感/构建目录排除，符号链接不跟随） | 稳定（受限） | <code>lib/workspace-files.js</code>, <code>lib/export.js</code> | <code>test/workspace-files.test.mjs</code>（13）、<code>test/export.test.mjs</code> | 目前只支持整树，不支持只挑 touched files；受 maxExportBytes/workspaceMaxBytes 与内存约束 |
| F12 | ZIP / 裸 JSONL 导入为新会话；可选恢复工作区文件 | 稳定 | <code>lib/import.js</code>, <code>index.js</code> | <code>test/import.test.mjs</code>（20）；无 <code>/import</code> 路由级测试 | 不保留父/子会话血缘；子代理日志永不导入；要求格式版本一致（当前 v4） |
| F13 | 子代理策略：默认不导出、永不导入 | 稳定 | <code>lib/export.js</code>, <code>lib/import.js</code> | <code>test/export.test.mjs</code>、<code>test/import.test.mjs</code> | 子代理转录不单独导出/导入；不恢复血缘 |
| F14 | DeepSeek 分享链接导入（可选目标工作区） | 稳定（受限：仅公开链接；网络测试为 mock） | <code>lib/deepseek-share.js</code>/<code>:178</code>/<code>:337</code>/<code>:520</code>, <code>index.js</code>, <code>src/client/index.js</code> | <code>test/deepseek-share.test.mjs</code>（9，全部 mock 网络）、<code>test/index-share.test.mjs</code>（15） | 只能是 <code>chat.deepseek.com/share/&lt;id&gt;</code> 或裸 id；60 s 超时、32 MiB 响应上限；真实联网未自动化 |
| F15 | Agent 工具 <code>session_kit</code>：list/export/import/archive/unarchive/delete/migrate/files/import_share | 稳定 | <code>index.js</code>（action enum 与 schema） | 各 <code>test/index-*.test.mjs</code> 中的 tool 用例 | 工具可在 <code>confirm:true</code> 下执行破坏性操作，没有插件级人工审批 UI |
| F16 | 客户端面板整体（徽标、搜索、详情、删除/迁移对话框、分享卡片） | 稳定（受限：客户端无自动化测试） | <code>src/client/index.js</code> → 构建为 <code>lib/client.js</code> | 无仓库内自动化测试；0.10.3 在 DSH 0.2.2 做了真实浏览器面板/样式冒烟 | 无自动化浏览器测试；深层交互仍需手工回归 |
| F17 | HTTP 路由信任栅栏、批量上限、错误映射 | 稳定 | <code>index.js</code>, <code>index.js</code> | route-level 测试覆盖 archive/unarchive/delete/migrate/files/session-detail/import-share 与 403/503/400 分支 | <code>/export</code> 与 <code>/import</code> 有手工 0.10 成功路径 smoke；尚无仓库内自动化路由测试 |

## Cross-cutting notes

- Test totals: 16 files, 224 tests. Plain <code>node --test</code> runs 219 and
  skips 5 guarded cases that need a DSH checkout through <code>tsx</code>; with
  <code>tsx</code> the same 224 all pass. See <code>docs/self-assessment.md</code>.
- Chat UI behavior is not part of the automated suite; treat F2/F16 as manually
  verified only.
- Evidence is intentionally conservative: a feature is "稳定" only where the
  repository has automated coverage for its core path; otherwise it is marked
  limited, experimental or client-manual.