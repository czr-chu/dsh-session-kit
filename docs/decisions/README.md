# Decision records

Short, durable notes for changes where a future reader would otherwise have to
guess *why* the code behaves the way it does: lineage handling, streaming
archive production, trash restore rules, export file scope, and anything that
changes the archive format or a safety policy.

Rules:

- One file per decision: `NNNN-<short-slug>.md`, four digits, monotonically
  increasing (`0001-`, `0002-`, …). Never renumber.
- Write it in the same commit as the change.
- Keep it to one screen: context, decision, alternatives rejected,
  consequences, verification, rollback.
- If a later change supersedes it, add a new record and mark the old one
  `Status: superseded by NNNN` instead of editing history.

Template: [change-documentation.md §3](../change-documentation.md#3-decision-record-template).

| ID | Title | Status | Affects |
| --- | --- | --- | --- |
| 0001 | [压缩（compressed）导出模式](0001-compressed-export-mode.md) | 已采纳 | `lib/compressed.js`, `lib/export.js`, `lib/import.js`, `index.js`, `src/client/index.js` |
| 0002 | [回收站操作清单、恢复与永久清理](0002-trash-operations.md) | 已采纳 | `lib/manage.js`, `lib/trash.js`, `index.js`, `src/client/index.js` |
| 0003 | [把会话迁移到另一个工作区（copy-then-trash）](0003-workspace-move.md) | 已采纳 | `lib/move.js`, `index.js`, `src/client/index.js` |
| 0004 | [多工作区备份：每个工作区各自一个 ZIP](0004-multi-workspace-backup.md) | 已采纳 | `index.js`, `src/client/index.js` |
| 0005 | [面板可用性：渐进分页、排序与可访问性](0005-panel-usability.md) | 已采纳 | `src/client/index.js`, `src/client/styles.module.css` |
| 0006 | [导入连续性、重复预检、NDJSON 进度与附件引用报告](0006-import-continuity-and-attachment-report.md) | 已采纳 | `lib/export.js`, `lib/import.js`, `lib/attachment-report.js`, `index.js`, `src/client/index.js` |
