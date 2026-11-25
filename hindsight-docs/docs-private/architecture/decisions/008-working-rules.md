# [ADR-008] 工作准则（Working Rules）独立子系统

- 日期：2026-11-24
- 状态：已采纳
- 背景：需要为跨项目及项目级编码代理提供独立于记忆库 `directives` 的持久工作准则，包含 UTF-8 容量控制、固定（pinned）预算、Git 分支过滤、语义增量编辑（`old_text`）及容量溢出归档能力。
- 方案：
  1. 保留现有按记忆库隔离的 `directives` 仅用于服务端 `reflect` 综合推理；新增全局与项目级统一的 `working_rules` 数据表、引擎服务 `WorkingRulesService` 与 `/v1/default/working-rules` HTTP 路由组。
  2. 以服务端数据库与 Control Plane（`/[locale]/working-rules`）为唯一管理与权威真源，不维护本地双写 Markdown 投影文件，仅提供按需 Markdown 导出接口与下载。
  3. 非固定（`pinned = false`）条目超出容量上限时按最低重要性和最旧更新时间进入已归档状态（`is_archived = TRUE`，`archive_reason = 'capacity_overflow'`），不自动转存为 `World` 或 `Experience` 记忆；仅支持在 Control Plane 中显式恢复（Restore）或转存到指定记忆库（Promote）。
  4. 编码代理（`hindsight-coding-agents`）在 `SessionStart`、提示钩子检测到 `revision` 变更时注入 `<hindsight_working_rules>`，并提供 MCP/DSH 工具 `hindsight_working_rules` 与 `hindsight_manage_working_rules`。
- 影响范围：
  - `hindsight-api-slim`：Alembic 迁移 `e7a1b2c3d4f5`、配置项（`HINDSIGHT_API_WORKING_RULES_LIMIT_BYTES`、`HINDSIGHT_API_WORKING_RULES_PINNED_LIMIT_CHARS`、`HINDSIGHT_API_WORKING_RULES_ENTRY_MAX_BYTES`）、`WorkingRulesService` 与 HTTP 路由。
  - `hindsight-dev/openapi.json`、`hindsight-clients/typescript`：OpenAPI 与 TypeScript SDK。
  - `hindsight-integrations/coding-agents`：客户端接口、会话注入、MCP/DSH 工具、`skill-src/preamble.md` 与 `skill/SKILL.md`。
  - `hindsight-control-plane`：`/api/working-rules/**` 代理路由、`/[locale]/working-rules` 管理页与 AI 整理预览/应用流程。
- 与上游差异：私有分支新增能力，后续上游同步需保留 `working_rules` 迁移链路与对应 API/前端扩展。
- 验证依据：后端 `tests/test_working_rules.py` 与 `tests/test_migration_shape.py`、编码代理 `vitest` 与构建、控制平面 `vitest` / `eslint` / `i18n:check` / `next build`。
- 替代关系：无。
