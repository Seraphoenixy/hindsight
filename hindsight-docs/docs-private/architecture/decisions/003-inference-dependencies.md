# [ADR-003] 移除内置 Python 推理与重型云端/第三方适配器，改为外部推理 + 零模型 RRF

> 历史决策记录：下文保留最初裁剪时的方案。当前 `local` 嵌入已改用托管原生 llama.cpp，`llamacpp_llm.py` 亦保留为原生服务适配；当前默认值见[运行架构](../runtime.md)，不能用此处的历史删除清单判断现状。

- **日期**：2026-11-20
- **状态**：已采纳
- **背景**：内置 `local-ml`（PyTorch / `transformers` / `sentence-transformers`）、`local-onnx`、`llama-cpp-python`、`claude-code` CLI Provider 以及 `litellm` / `boto3` / `obstore` 体积庞大（或引入 CLI 隔离与 HF 下载风险）；而个人本地已有原生 C++ `llama-server.exe` 与主流原生 LLM Provider（`openai`、`deepseek`、`openai-codex`、`anthropic`、`gemini` 等）可用。
- **方案**：
  - **依赖精简**：精简 `hindsight-api-slim/pyproject.toml` 与 `hindsight-all/pyproject.toml`，移除 `local-ml` / `local-onnx` / `local-llm` / `claude-agent-sdk`；将 `boto3`、`obstore`、`litellm` 移至可选 `[project.optional-dependencies].cloud`（`storage/base.py` 中 `obstore` 改为惰性导入 `_obstore()`）；`all` 仅保留 `embedded-db`（`pg0-embedded`）；`hindsight-embed/daemon_embed_manager.py` 本地启动改为 `--extra embedded-db`。
  - **默认推理配置**：`config.py` 默认 `DEFAULT_EMBEDDINGS_PROVIDER = "openai"`、`DEFAULT_RERANKER_PROVIDER = "rrf"`、`DEFAULT_KB_EMBEDDINGS_PROVIDER = "text"`。
  - **删除实现与保留明确报错**：删除 `local_device.py`、`llamacpp_llm.py`、`claude_code_llm.py`、`litellm_llm.py`、`litellm_router_llm.py`、`LocalSTEmbeddings`、`OnnxEmbeddings`、`LiteLLMSDKEmbeddings`、`LocalSTCrossEncoder`、`FlashRankCrossEncoder`、`OnnxCrossEncoder`、`JinaMLXCrossEncoder`、`LiteLLMSDKCrossEncoder`、`TransformerQueryAnalyzer` 及对应测试；清理 `providers/__init__.py`、`provider_auth.py`、`tracing.py`、`test_hook_llm_registry_parity.py`；在 `embeddings.py`、`cross_encoder.py`、`llm_wrapper.py` 中对已移除 Provider 给出明确报错（并为 `openai` Embeddings 增加配置 `base_url` 时免 API Key 支持，在 Reranker 中支持 `none` 作为 `rrf` 别名）。
- **影响范围**：`hindsight-api-slim/`、`hindsight-all/pyproject.toml`、`hindsight-embed/daemon_embed_manager.py`、`uv.lock`。
- **与上游差异**：上游默认依赖完整本地推理、CLI Provider 与 `litellm` / 云存储包；本分支裁剪后 `hindsight-api-slim[embedded-db]` + `hindsight-embed` 运行时 `site-packages` 降至约 `273.4 MB`（116 个包）。
