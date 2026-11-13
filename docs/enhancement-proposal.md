# 改造建议（基于 v0.11.0 源码精读）

本文档是一次只读代码审阅的产物：四个并行审阅分别覆盖 Host 入口、归档管线、会话管理/数据访问、浏览器面板，结论均在对应行号核实。

**状态（2026-11-14）：本文的候选套餐已全部落地为 0.12.0，实施顺序与结果见 [plan-2026-11.md](plan-2026-11.md)。** 套餐 1（A1/A3/A5/A6/A9/A12/B10/C1）、压缩导出（P2）、多工作区备份（P3）、会话迁移（P4）、回收站（P5）、面板可用性（P6）、导入连续性与附件报告（P7）均已完成；测试 313 个（304 通过 / 9 跳过）。下文保留审阅时的基线与行号，作为决策背景，不再代表当前状态。

## 0. 基线与环境

| 项 | 值 |
| --- | --- |
| 仓库 | `~/Documents/deepseek-harness/default-workspace/dsh-session-kit`，tag `v0.11.0`，HEAD `904c95e` |
| 安装方式 | profile `desktop` 已改为 `link:` 软链到本仓库（`dsh plugin` 语义等同于本地目录安装） |
| 测试基线 | `npm test`：246 个用例，237 通过 / 0 失败 / 9 跳过（跳过的都是需要 DSH checkout + tsx 的真实后端用例） |
| 构建基线 | `npm run build:client` 产物与仓库内 `lib/client.js` **逐字节一致**（CI 有该 gate） |
| 构建环境坑 | DSH 自带的 runtime node 是 hardened 签名，**无法** `dlopen` rolldown 的 ad-hoc 签名原生模块；必须用 `/opt/homebrew/opt/node@24/bin/node`（v24.18.0）执行 `npm run build`。测试不受影响。 |

本机真实数据：`~/.dsh/sessions` 共 8.5 MB、2 个 workspace、6 个会话，单个会话是 `session.v4.jsonl.zstd` + `session.lock`，适合做手工回归。

## 1. 架构速览

```
index.js                 12 条 /session-kit/* 路由 + 1 个 session_kit 工具 + Config
lib/sessions.js          ctx 服务缝（sessionQuery / sessionPersistence / workspaceRegistry）与列目录
lib/export.js            多会话 ZIP 构建（manifest / 校验和 / 附件 / 工作区树 / 备份）
lib/import.js            归档预检、新会话生成、工作区/附件还原
lib/manage.js            归档/取消归档、移入回收站、永久删除、批次
lib/format.js            规范 JSONL、header 重建、附件引用
lib/compact.js           精简模式（只保留对话主干）
lib/zip.js               零依赖 ZIP 读写（deflate，全内存）
lib/workspace-files.js   触碰文件推导 + 安全树遍历
lib/workspace-backup.js  单 workspace 备份编排
lib/deepseek-share.js    分享链接抓取与转换
lib/session-files.js     删除前的相关文件预览
src/client/index.js      → tsdown → lib/client.js（CJS 闭包，注册 main 面板 + sidebar row）
```

三条关键事实，决定了后续所有改动的成本：

1. **每个能力写了两遍**：路由 handler 与工具 action 各自实现校验/选项合并（`handleManage` 830-873 ↔ `runManageTool` 1683-1722，export/import/share/migrate/files 同样成对）。加一个开关要改两处，两处已经出现行为漂移（见 A1/A4/A5）。
2. **归档是全内存的**：`buildArchive` 返回 `Buffer`（`lib/export.js:852-859`），zip writer `Buffer.concat`（`lib/zip.js:644-678`），路由 `res.end(data)`（`index.js:1268-1278`）；`maxExportBytes` 在**构建完成之后**才检查（`:845-850`）。`docs/architecture.md:50` 写的 "streams it" 与实际不符。
3. **能力声明是硬编码的**：`/info` 的 `capabilities` 全部写死 `true`（`index.js:451-469`），只有 `attachments` 是真探测（`:470`）。`docs/feature-matrix.md` 里 "稳定" 的判定标准是自动化覆盖，不是声明。

## 2. 一致性与正确性问题（建议先清）

| # | 现象 | 证据 | 影响 | 改法 | 规模 |
| --- | --- | --- | --- | --- | --- |
| A1 | 工具 `export` 的 `includeAttachments` 参数被忽略，永远用配置值 | schema `index.js:1554`，调用处 `:1621` 传 `settings.includeAttachments` | 工具描述与行为不符，agent 无法关闭附件打包 | 改为 `booleanFlag(args.includeAttachments, settings.includeAttachments)` | S |
| A2 | `/info` 声称 `migrate/workspaceBackup/shareImport/...` 全支持，模块缺失时仍为 `true` | `index.js:451-469`；实际缺失走 `SessionPortFormatError('unavailable')`（`:503`） | 客户端无法真正做特性检测，缺模块时只在调用时报 503 | 用已加载的 module override / 懒加载结果生成 capabilities | S |
| A3 | 批次全失败时 `unavailable` 映射成 500，而不是 503 | `statusForManageCode` `index.js:625-629`，仅识别 not-found/active | 服务不可用与内部错误不可区分 | 直接复用 `statusOf` 或补 `unavailable` 分支 | S |
| A4 | 路由删除不传 `confirm` 也会把会话移入回收站；工具删除强制 `confirm:true` | 路由 `index.js:840-858` 只在 `permanent`/`removeFiles` 时校验；工具 `:1689-1695` 无条件校验 | 同一动作两套安全策略，客户端发什么就执行什么 | 统一策略（建议路由也要求 confirm，或明确文档化为"移入回收站不算破坏性"） | S |
| A5 | `'all'` 语义四处不同 | 路由 manage 拒绝（`:832` `allowAll:false`）、工具 archive 接受（`:1703`）、工具 export 缺省即 all（`:1612`）、路由 export 必须显式 `'all'`（`:1241-1247`） | 调用方难以预测；报错信息不一致 | 抽一个 `parseSessionScope(args, {allowAll})` 供两侧共用 | S |
| A6 | `handleImport` 没收到 `overrides`，文档宣称的模块 seam 无法 stub 导入 | 调用 `index.js:537-539`，签名 `:1361`；`lib/export.js` 等还是静态 import（`:41-44`） | 路由级 import 测试无法注入假后端 | 补参数；顺带统一懒加载策略 | S |
| A7 | 请求体读取无 abort/超时；客户端断开后导出仍会算完 | `readRequestBody` `index.js:1384-1395` 无 `req.aborted`/`close`；导出无 `signal` | 大工作区导出会空转占用内存 | 加 `AbortSignal` 贯通 `buildArchive`；超时/断开快速失败 | M |
| A8 | 工具 `list` 只渲染 80 条，超出无提示 | `index.js:1904-1921` | agent 以为拿到了全量 | 追加 "还有 N 条，用 workspaceId 过滤" 之类尾注 | S |
| A9 | trust 栅栏拒绝时返回空 body | `index.js:434-439` `res.end()` | 客户端拿不到 code 无法分支 | 返回 `{ok:false,code:'forbidden'}` JSON | S |
| A10 | 英文界面里会冒出 Host 的中文错误文案 | 客户端 `errorMessageOf` 优先取 `message`（`src/client/index.js:1008-1017`），Host 文案全中文（`index.js:1812+`） | 中英混排 | Host 返回稳定 `code`，客户端按 code 查本地化文案 | M |
| A11 | 面板 UI 只有中/英；8 个 `locale/*.json` 只是插件目录元数据 | `locale/*.json` 仅 `meta.*`；`src/client/index.js:3404` 只注册 zh/en，回退文案是中文（`:525-528`） | 其他语言用户看到中文或 key | 补 locale 文件或明确只支持 zh/en | M |
| A12 | header 重建只保留 10 个字段，其余静默丢弃 | `lib/format.js:77-90` | 未来 DSH header 加字段会丢 | 改成 `{...header, type:'session'}` 白名单式覆盖 | S |
| A13 | compact 模式下附件/触碰文件从**压缩后**事件推导 | `lib/export.js:517`、`:629` | 只在 tool/result 里出现的附件在 compact 包里不会被打包（但 compact 本来就有损，属语义边界） | 从原始事件收集引用，再与 compact 事件求交 | M |
| A14 | 配置两层严格度不一：`validate` 拒绝未知键，`resolveSettings` 静默忽略 | `index.js:84-86` vs `:333-335` | 用户改错键时无提示 | 让 resolve 走一次 validate 或记日志 | S |

## 3. 功能增强候选

### B1. 按会话「相关文件」导出（推荐起手）
- **现状**：`collectTouchedFiles` 已实现且被测试（`lib/workspace-files.js:586`，`test/workspace-files.test.mjs:349/400/411`），但**没有任何生产调用者**；导出仍是无条件整树（`lib/export.js:658`）。`deriveTouchedFiles` 只用来填 manifest 的 `touchedFiles` 元数据（`:588`、`:629-641`）。
- **方案**：`buildArchive` 增加 `workspaceScope: 'all' | 'touched'`，touched 走 `collectTouchedFiles(seeds)`；manifest 记录 scope；UI 三选一（整树 / 仅相关文件 / 不含文件）；工具加同名参数。
- **影响**：`test/export.test.mjs:436`、`:501` 两处断言需改；`docs/feature-matrix.md:32`、README「Known limitations」需同步。
- **规模**：M（后端改动小，成本在选项贯通与文档）。

### B2. 回收站管理（list / restore / purge）
- **现状**：只写不读。`deleteSession` 返回 `trashedPath`（`lib/manage.js:947-956`），操作目录无耐久 manifest（只有文件清单 `files-manifest.json`，`:578-598`），README 明确「Trash is not cleaned automatically」。
- **方案**：删除时写 `operation.json`（时间、会话 id→目录、文件清单、原 workspace）；新增 `lib/trash.js` + `/session-kit/trash{,/restore,/purge}` + 工具 action `trash_list/trash_restore/trash_purge`；面板加「回收站」卡片，支持逐条恢复、按时间清理。
- **恢复语义**：把会话目录 rename 回原 workspace 目录（需原路径校验，参照 `lib/manage.js:304-346` 的安全校验），再由 registry 重新挂载。
- **影响**：`test/manage.test.mjs:701/252/739/528` 固定了当前目录布局；新增路由要进 `/info` 与客户端 feature 检测。
- **规模**：M-L。

### B3. 永久删除时清理附件对象存储
- **现状**：只删会话目录与勾选文件，附件 blob 永久滞留（`lib/manage.js:699-717`；`lib/attachments.js` 只有 collect/restore，无 delete 接缝）。
- **阻塞点**：DSH 的 attachments 服务没有暴露删除 API，需要先确认可用方法；且要跨会话扫描引用（`collectAttachmentRefs` `lib/format.js:149`）避免误删共享附件。
- **规模**：L（且带外部 API 不确定性）。

### B4. 导入时恢复「已归档 / 已置顶」状态
- **现状**：manifest 不记录状态，导入只 `attachToWorkspace`（`lib/import.js:690`）；`pinnedSessionIds` 只用于列表徽标（`lib/sessions.js:298`）。
- **方案**：manifest.sessions 增 `archived`/`pinned`；导入后调 `registry.archiveSession` / `pinSession`（`archiveSession` 已在 `lib/manage.js:105` 用过；`pinSession` 仅 `unpinSession` 被调用过（`:408`），需确认存在）。
- **规模**：M。

### B5. 子代理血缘导出/导入
- **现状**：`headerLineOf` 已保留 `parentSession/origin/delegationDepth`（`lib/format.js:84-88`），`subagentLogEntryName` 已写好但**无人调用**（`:72`）；导出跳过子代理（`lib/export.js:484-487`），导入硬编码 `isSeeded:false, delegationDepth:0`（`lib/import.js:668-676`）。
- **方案**：导出可选打包 `subagents/`，manifest 记录血缘；导入做 id 重映射、按拓扑序写入、条件性恢复父子关系。
- **影响**：`test/import.test.mjs:790`、`test/export.test.mjs:540` 与 `docs/architecture.md:152-159` 的「永不导入」契约都要改，属语义变更，需要你拍板。
- **规模**：L。

### B6. 流式归档（大工作区）
- **现状**：见 §1 第 2 条，全内存 + 事后检查上限。ZIP 本地头已带完整 CRC/尺寸、日期固定（`lib/zip.js:54-56`），所以**只需缓存中央目录**就能流式写；瓶颈是 `manifest.json` 目前是第一个 entry 却依赖全部校验和（`lib/export.js:841`），需要改成「清单最后写」或两遍扫描。
- **影响**：`data: Buffer` 返回契约（`:852-859`）与 3 个调用点；`test/export.test.mjs:163/189-204/226` 的整包断言改为流式断言；`/import` 侧若要配套需流式解包。
- **规模**：L-XL。

### B7. LLM 摘要式 compact
- 在结构性 compact 之上增加摘要层。会破坏当前「固定 DOS 时间 + 确定性字节」的可复现承诺（`lib/zip.js:54-56`），且需要模型 seam（`lib/export.js:463` 只取了 attachments 服务）。**规模**：L，且需求边界要先定（谁付费、摘要存哪、丢失什么）。

### B8. 面板体验（可拆成独立小项）
- 虚拟滚动/分页：`buildGroups` 全量渲染（`src/client/index.js:912-966, 2113-2325`）。
- 服务端搜索/排序：现在纯客户端字符串匹配（`:891-895`），`/list` 不支持参数（`index.js:519-527`）。
- 选择集语义 bug 级体验：`select all` 只作用于当前筛选后的可见项，但选中项在切换筛选后仍保留（`:1256-1258, 2417, 2427`），容易误删。
- 勾选一行触发 2 个请求（`:1301-1304` → `session-detail` + `session-files`）。
- 文案中英混排（见 A10）；主题 token 有 6 个未使用项，品牌/危险按钮把 `T.bgBase` 当前景色（`:1093, 1096`）。
- 对话框无焦点陷阱/焦点恢复/遮罩点击关闭（`:1147-1149, 1175`）。
- **规模**：每项 S-M，合计 M。

### B9. 文件选择 UX
- 加过滤框、"只选弱证据"、证据文本不截断（现在截到 140 字符 `:1785`）、按根分组、skipped 明细不封顶 8 条（`:1488`）。**规模**：S-M。

### B10. 工具补 `detail` 动作
- `session-detail` 只有路由没有工具动作（`index.js:1055-1085`）；agent 想看存储大小/格式状态只能走面板。**规模**：S。

### B11. 重复导入预检/去重
- 同一归档可重复导入产生重复会话（`lib/import.js:582-585` 只查包内重复）。可加「按源 id/内容哈希提示已存在」。**规模**：M。

### B12. 批量进度
- 500 条批次一次性返回（`index.js:670-787`），无进度。可改 NDJSON 流式逐条回传，面板显示进度条。**规模**：M。

## 4. 工程质量（roadmap 已列）

| # | 项 | 说明 | 规模 |
| --- | --- | --- | --- |
| C1 | `/import`、`/export` 路由级成功路径测试 | 目前只有手工 smoke（`docs/feature-matrix.md:48`） | M |
| C2 | 浏览器冒烟（Playwright） | 面板无自动化测试，F2/F16 只能手工回归 | L |
| C3 | CI 固定 DSH checkout 跑真实后端用例 | 现在 9 个 guarded 用例在 CI 里跳过 | M |
| C4 | npm 发布 + provenance + release 自动化 | roadmap 未完成项 | S |
| C5 | 文档一致性检查脚本 | 校验每条路由在 `docs/architecture.md` 有行、每个工具 action 在 README 有说明、每个 `locale` key 中英对齐；`npm run doc:check` 进 CI | S-M |

## 5. 推荐路线

**套餐 1「低风险一致性修复」**（约 1-2 天，最适合先做）
A1 + A3 + A5 + A6 + A9 + A12 + B10 + C1。不新增用户可见行为，只让路由/工具/文档三者对齐，并补上最缺的路由测试。风险最低，也为后面所有改动打底。

**套餐 2「把已有能力接上」**（约 2-3 天，用户可感知）
B1（相关文件导出）+ B9（文件选择 UX）+ A4/A10。`collectTouchedFiles` 已经写好测好，只是没接线，性价比最高。

**套餐 3「回收站闭环」**（约 3-5 天）
B2 + 删除写 manifest + 面板卡片。解决 README 里「回收站不自动清理、也没法恢复」这个实际痛点。

**套餐 4「架构升级」**（约 1-2 周）
B6 流式归档（先做 B1 的 scope 抽象），附带 A7 abort 贯通。

**不建议现在做**：B3（缺 DSH 删除 API）、B5（语义契约变更）、B7（需求未定义）。

## 6. 验证与交付约定

1. 每次改动后：`npm test`（含 246 用例）、`npm run format:check`。
2. 动了客户端：用 homebrew node 24 跑 `npm run build:client`，确认 `git diff --stat lib/client.js` 只含预期改动（CI 会对产物做 diff gate）。
3. 面板验证：重启 DSH（host 行不会热更）→ 刷新页面；手工回归清单建议覆盖：列表/搜索/筛选、详情、导出 compact+full、导入、归档/恢复、删除到回收站、永久删除二次确认、分享导入（需公网）。
4. 文档同步：`CHANGELOG.md`、`docs/feature-matrix.md` 状态列、README「Known limitations」、`docs/architecture.md`。
5. 提交粒度：一个套餐一个 PR/commit，避免把一致性修复和语义变更混在一起。

## 7. 文档交付规范（强制）

每个改动必须同提交更新文档，规范见 [change-documentation.md](change-documentation.md)（已同步进 `CONTRIBUTING.md`）。要点：

| 层 | 位置 | 判据 |
| --- | --- | --- |
| 代码契约 | 模块头注释 | 职责 / 输入输出 / **失败码** / **明确不做什么** |
| 函数契约 | 导出函数的 JSDoc | 参数单位、返回形状、抛出的 code |
| 接口 | `docs/architecture.md` + 工具 description/schema | 路由/动作表两侧措辞一致 |
| 能力矩阵 | `docs/feature-matrix.md` | 状态、实现位置、**测试名证据**、已知限制 |
| 用户文档 | `README.md` + `README.zh.md` + 专题页 | 功能、配置表、限制 |
| 变更记录 | `CHANGELOG.md` | Added/Changed/Fixed/Security |
| 决策记录 | `docs/decisions/NNNN-*.md` | 仅语义变更：血缘、流式、回收站恢复规则、文件范围 |
| 本地化 | `locale/*.json` + 客户端 zh/en 字典 | 同一 key 集，双语同步 |

另外两条硬规则：新能力必须进 `/info` 的 `capabilities` 并在客户端做特性检测（否则面板取不到）；模块头必须写明"不做什么"（如"永不导入子代理日志""不清理附件 blob"），这是给后来模型减少误解的关键。
