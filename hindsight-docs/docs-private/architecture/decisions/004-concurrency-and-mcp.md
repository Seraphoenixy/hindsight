# [ADR-004] 收紧默认 LLM 并发上限并默认关闭 HTTP `/mcp/` 端点

- **日期**：2026-11-20
- **状态**：已采纳
- **背景**：上游默认全局 LLM 并发上限为 `32` 且 `retain` / `consolidation` 无独立默认限制，后台任务易打爆个人额度或触发 429；同时个人场景下 `coding-agents` 通过 stdio 运行 `mcp-server.js`，服务端默认挂载 HTTP `/mcp/` 端点会额外占用约 34 MB 内存与冷启动时间。
- **方案**：修改 `hindsight-api-slim/hindsight_api/config.py`：
  - 将 `DEFAULT_LLM_MAX_CONCURRENT` 从 `32` 调整为 `2`，新增 `DEFAULT_RETAIN_LLM_MAX_CONCURRENT = 1` 与 `DEFAULT_CONSOLIDATION_LLM_MAX_CONCURRENT = 1`（通过 `_env_int_or` 作为未设环境变量时的默认值）；`DEFAULT_LLM_TIMEOUT` 保持 `120.0`、`DEFAULT_LLM_MAX_RETRIES` 保持 `3`。
  - 将 `DEFAULT_MCP_ENABLED` 由 `True` 改为 `False`（仍可通过 `HINDSIGHT_API_MCP_ENABLED=true` 显式开启）。
- **影响范围**：`hindsight-api-slim/hindsight_api/config.py`、`hindsight-api-slim/tests/test_llm_per_op_concurrency.py`。
- **与上游差异**：上游默认 `DEFAULT_LLM_MAX_CONCURRENT = 32`、`retain`/`consolidation` 并发默认不限、`DEFAULT_MCP_ENABLED = True`。
