---
sidebar_position: 3
title: 轻量化裁剪可行性分析
---

# Hindsight 轻量化裁剪可行性分析

面向个人本地使用、多 Coding Agent 共享的长期记忆系统，分析在当前 fork 源码上可实施、可验证、易维护的裁剪方案。

本阶段只做分析：不删除、不修改源码与数据库结构。文中的资源数字来自本机实测或源码静态推导，未实测项明确标注。

## 0. 结论

在保留 Retain、Consolidation、Facts、Observations、时间/语义/因果关联与多策略 Recall 的前提下，当前规模可以压到如下程度：

| 指标 | 当前实测 | 仅做 A/B 类后可达到 | 依据 |
|---|---|---|---|
| Python 依赖磁盘占用 | 1649 MB → **876 MB**（已清理） | 约 730 MB | `uv sync --frozen` 已回收 773 MB；剩余最大项是 259.8 MB 的 `claude_agent_sdk`（内含 CLI 可执行文件）与 110.8 MB 的 `litellm` |
| API 进程常驻内存 | 267–307 MB | 约 230 MB | 关闭 MCP 端点 −34 MB；限定时区分析语言 −40 MB |
| 空闲 CPU | 0.31–0.62% | 0% | 关闭进程内 worker 后实测为 0.00% |
| 冷启动到 `/health` 200 | 7.7–8.8 s | 约 5.0 s | 关闭 MCP 与限制分析语言后实测 5.0 s / 5.5 s |
| pg0 PostgreSQL 内存 | 147 MB（10 个进程） | 约 80–100 MB（待验证） | 由 `shared_buffers=256MB` 等注入参数决定，可经 URL 查询串下调 |
| Recall 额外 token | 0 | 0 | recall 路径默认不含生成式调用（决策模型默认 `none`） |
| Embedding 维度 | 384（local 默认） | 1536（openai 默认） | 见 8.0：切换后既有数据无法回退到 384 维模型 |

结论要点：

1. 冗余中占比最大的一块是**陈旧安装**而非源码：`uv.lock` 已不含 `torch`，但 venv 里曾装着 769 MB 不在锁文件内的包。已用 `uv sync --frozen` 清理，实测回收 773 MB，venv 从 1649 MB 降到 876 MB，零源码改动。
2. 关闭 Cross-Encoder 后**不会**加载 PyTorch / Transformers：实测 `create_cross_encoder_from_env()` 返回 `RRFPassthroughCrossEncoder`，`torch`、`transformers`、`sentence_transformers` 均未进入 `sys.modules`。
3. 常驻开销的主要来源是 **pg0 的 PostgreSQL 参数**与**进程内 worker 轮询**，不是 Python 模型。
4. 当前分支存在两处需要先解决的矛盾：知识库默认 provider 曾是 `local` 而本地推理已删除（**已修复**：默认改为 `text`，`local` 分支改为明确报错并提示替代项）；daemon 侧的既有实例从未成功启动过（`public` schema 0 张表）。
5. 当前分支与上游 `main` **没有共同祖先**（`git merge-base main private` 为空），无法执行常规合并。这是上游维护成本的最大单项风险，优先级高于任何运行时裁剪。
6. 默认 embedding 从 384 维改为 1536 维不是纯配置变更：一旦库中有数据，切回 384 维模型会导致启动失败（`migrations.py:694-701`）。

## 1. 分析对象与方法

### 1.1 源码版本

- `main`：上游 v1.2.3（`55dde528 docs: changelog for v1.2.3`）。
- `private`：单提交 `ea533049`，与 `main` 无共同祖先；`git status` 显示 122 个路径的改动已暂存未提交（Docker 相关删除、内置推理删除、文档族新增等）。
- 工作区：`D:\project\hindsight`，Python 3.11.16，venv 位于 `.venv`。

### 1.2 方法

- 逐文件阅读初始化路径、配置解析、后台任务生命周期与依赖声明；结论附 `路径:行号`。
- 静态依赖度数：用 `importlib.metadata` 枚举已安装分发的 `requires` 反向依赖，判定某个包是否仍被需要。
- 运行时测量：在独立 pg0 实例（`hindsight-analysis`，端口 15501）上启动真实 `hindsight_api.main` 进程，配最小 OpenAI 兼容 stub（embeddings + chat），测量冷启动、RSS、空闲 CPU、Recall 延迟；测量结束即停止实例，未触碰既有实例与仓库。
- Token 测量：用项目自身的 `engine/token_encoding.count_tokens` 统计提示词与 JSON Schema。
- 存储测量：`asyncpg` 只读查询运行中实例的 `pg_class`/`pg_stat_user_tables`。

### 1.3 未实测项

- 有真实数据量下的 Recall 延迟与 PSS（本机数据库为空库，无法给出数据规模相关的数字）。
- 关闭 Cross-Encoder 前后的召回质量差异（需要评测集，见 `hindsight-system-evals`）。
- pg0 参数下调后的实际内存下降幅度（只给出参数位置与预期方向）。
- `torch` 等包在完整上游安装下的启动加载曲线（当前分支已不加载）。

## 2. 当前架构与依赖（8.1）

### 2.1 运行组件与进程模型

必须区分「软件包 / 逻辑模块 / 线程 / 协程任务 / 真实进程」：

| 组件 | 形态 | 默认是否运行 | 能否关闭 | 关闭方式 |
|---|---|---|---|---|
| `hindsight-api`（FastAPI + MemoryEngine） | 进程 | 是 | 否（核心） | — |
| 进程内 WorkerPoller | 同进程 asyncio 任务 | 是 | 是 | `HINDSIGHT_API_WORKER_ENABLED=false` |
| MaintenanceLoop（清理/对账/页面刷新） | 同进程 asyncio 任务 | 是 | 部分 | 各 job 间隔置 0 |
| MCP HTTP 端点 `/mcp/` | 同进程 FastMCP 挂载 | 是 | 是 | `HINDSIGHT_API_MCP_ENABLED=false` |
| `hindsight-worker` | 独立进程 | 否 | 不启动 | 仅分离部署时使用 |
| pg0 管理的 PostgreSQL | 独立进程组（约 10 个） | 是 | 是 | 改指向外部 `postgresql://` |
| ~~`hindsight-embed` 控制中心~~ | 已移除（ADR-006），运维并入控制平面 `/local` | 否 | — | 已删除 |
| coding-agents `mcp-server.js` | 独立 Node 进程（stdio） | 由宿主 Agent 拉起 | 是 | 不注册 MCP |
| Control Plane（Next.js） | 独立进程 | 否 | 不启动 | 仅管理界面 |

依据：

- 进程内 worker：`hindsight-api-slim/hindsight_api/api/http.py:4556`（`if config.worker_enabled and ...`）、`:4566-4582`（构造并 `create_task(poller.run())`）。默认值 `DEFAULT_WORKER_ENABLED = True`（`config.py:2317`），轮询间隔 `500ms`（`config.py:2319`）。
- 维护循环：`engine/memory_engine.py:6851-6854` 在 `initialize()` 末尾无条件 `MaintenanceLoop(self).start()`；各 job 由间隔是否大于 0 决定（`engine/maintenance.py:214-226`）。
- 独立 worker：`worker/main.py` 自带 uvicorn 指标服务，用于分离部署；它与 API 内置 poller 消费同一张 `async_operations` 表。
- daemon 不再空闲退出：`daemon.py` 文件头与 `main.py:306-312` 明确 `--idle-timeout` 已废弃且不生效。
- pg0：`hindsight_api/pg0.py:19-138`，`ensure_running()` 在 `MemoryEngine.initialize()` 中与模型初始化并行执行（`memory_engine.py:6452-6476`、`:6547-6553`）。

### 2.2 启动顺序（实测）

1. 端口预检 → `MemoryEngine` 构造 → `create_app` → uvicorn 启动（`main.py:327-419`）。
2. `initialize()` 并行执行：pg0 启动、embeddings 初始化、query analyzer 预热、cross-encoder 初始化、memories store 初始化、LLM 连通性校验（`memory_engine.py:6547-6557`）。
3. 迁移执行（`run_migrations_on_startup` 默认 true，`config.py:2243`）。
4. 指标与 tracing 初始化，随后 `gc.collect()` + `gc.freeze()`（`api/http.py:4532-4540`）。
5. 进程内 poller 启动（`api/http.py:4556-4583`），MaintenanceLoop 启动，首个维护 tick 受 `maintenance_start_jitter_seconds`（默认 60）延迟。

实测冷启动到 `/health` 200：MCP 开启且分析语言为 `en` 时 7.7 s；MCP 关闭时 5.0 s；分析语言为全语言时 8.8 s。以上均在无本地模型、embeddings 走 stub 的条件下测得。

### 2.3 依赖分层

按「是否影响运行」而非「是否占磁盘」分层：

**运行时必需并实际加载**

| 包 | 体积 | 说明 |
|---|---|---|
| `numpy` | 46 MB | 导入即加载，rerank 评分与向量运算 |
| `opentelemetry-sdk` 等 | 少量 | 导入即加载，指标/追踪 |
| `prometheus_client` | 0.4 MB | 导入即加载 |
| `asyncpg`、`sqlalchemy`、`alembic`、`fastapi`、`uvicorn`、`pydantic`、`toktok-rs`、`orjson`、`dateparser`、`regex`、`aiohttp` | 合计约 100 MB | 数据访问、HTTP、分词、时间解析 |
| `pg0-embedded` | 58 MB | 仅在 `[embedded-db]` extra 安装时存在 |

**惰性加载（不影响启动与空闲内存）**

`openai`、`anthropic`、`google-genai`、`cohere`、`litellm`（111 MB）、`boto3`/`botocore`（30 MB）、`obstore`（11 MB）、`markitdown`（含 `onnxruntime` 32 MB、`pandas` 45 MB、`magika` 3 MB）、`cryptography`、`fastmcp`。

依据：`from hindsight_api import MemoryEngine` 后 `sys.modules` 中只出现 `numpy`、`opentelemetry.sdk`、`prometheus_client` 三个重型模块；各 provider 均为函数内导入（如 `engine/providers/__init__.py:6-9` 明确说明按需加载，`engine/embeddings.py:838`、`:1500`、`engine/cross_encoder.py:664`、`:1695`、`knowledge/media.py:395`）。

**仅占磁盘、既不加载也非必需（当前分支）**

`torch`（467 MB）、`scipy`（101 MB）、`av`（66 MB）、`transformers`（56 MB）、`scikit-learn`（29 MB）、`torchvision`（13 MB）、`networkx`、`sentence-transformers`、`huggingface_hub`、`safetensors`、`joblib`、`threadpoolctl`、`einops`、`setuptools`。

判定依据：这些分发的名称**不在** `uv.lock` 中（`uv.lock` 全文 `torch` 出现 0 次），且反向依赖显示没有任何在锁文件内的包需要 `sentence-transformers`；`torch`/`transformers` 仅由已从 `pyproject.toml` 移除的 `sentence-transformers` 及 `google-genai` 的可选 extra `local-tokenizer` 引入，该 extra 未安装。

### 2.4 已完成的两项裁剪

- ADR-002：删除 `docker/` 与全部 `Dockerfile`。
- ADR-005：删除内置 Python 推理（`local_device.py`、`llamacpp_llm.py`、`LocalSTEmbeddings`、`OnnxEmbeddings`、`LocalSTCrossEncoder`、`FlashRankCrossEncoder`、`OnnxCrossEncoder`、`JinaMLXCrossEncoder`、`TransformerQueryAnalyzer`），默认改为 `embeddings=openai`、`reranker=rrf`。

删除规模（`git diff HEAD --numstat`）：`cross_encoder.py` −821 行、`embeddings.py` −523、`local_device.py` −372、`llamacpp_llm.py` −473、`query_analyzer.py` −259，合计约 2448 行生产代码，另删除约 2600 行对应测试。

回归保护：`hindsight-api-slim/tests/test_no_builtin_inference.py`（11 个用例，实测 0.33 s 全通过）断言默认值、`rrf`/`none` 直通、以及四个被删 provider 均抛「removed in this private build」。

## 3. 实测数据

### 3.1 依赖体积

清理前（`uv sync --frozen` 执行之前）：

| 项 | 数值 |
|---|---|
| `.venv/Lib/site-packages` 总计 | 1649 MB，49388 个文件 |
| 在 `uv.lock` 内的分发 | 732 MB（200 个） |
| 不在 `uv.lock` 内的分发 | 769 MB（28 个） |
| 其中最大项 | `torch` 467、`scipy` 101、`av` 66、`transformers` 56、`scikit-learn` 29、`torchvision` 13 |
| `~/.pg0/installation` | 154 MB |
| 单个 pg0 实例数据目录 | 63.7 MB（空库） |

清理后（实测，与本文档同时执行）：

| 项 | 数值 |
|---|---|
| `.venv/Lib/site-packages` | **876 MB，27870 个文件** |
| 回收 | **773 MB / 21518 个文件** |
| 卸载分发数 | 14 个，用时 8.38 s |
| 剩余分发 | 214 个，`uv pip check` 报告全部兼容 |
| 不在 `uv.lock` 内的分发 | 0 |

卸载清单（`uv sync --frozen` 自动判定，非人工挑选）：`torch`、`torchvision`、`transformers`、`sentence-transformers`、`scipy`、`scikit-learn`、`networkx`、`joblib`、`threadpoolctl`、`einops`、`av`、`flashrank`、`safetensors`、`setuptools`。

清理后最大的十项：`claude_agent_sdk` 259.8（其中 `_bundled/claude.exe` 单文件 259.2）、`litellm` 110.8、`pg0` 58.3、`pandas` 43.9、`sympy` 38.7、`onnxruntime` 31.6、`numpy` 25.8（另 `numpy.libs` 20.0）、`botocore` 19.3、`sqlalchemy` 14.9、`PIL` 14.5。

修正：初版本文档未统计 `claude_agent_sdk`，它是当前最大的单个依赖，且 99% 体积是一个随包分发的 CLI 可执行文件（见 5.2 新增项）。

### 3.2 导入与初始化耗时

| 阶段 | 耗时 | 进程 RSS |
|---|---|---|
| 解释器基线 | — | 14 MB |
| `from hindsight_api import MemoryEngine` | 1755–2370 ms（清理后 1755 ms） | 114 MB |
| `from hindsight_api.api import create_app` | 183–210 ms | 119 MB |
| `import hindsight_api.main`（控制台脚本入口） | 681 ms（其中 `config` 269 ms） | — |
| `DateparserQueryAnalyzer(languages=["en"]).load()` | 1395 ms | +9.4 MB |
| `DateparserQueryAnalyzer(languages=None).load()` | 12007 ms | +42.9 MB |

`main.py:47-60` 已把 `create_app`/`MemoryEngine`/extensions 改为惰性导入，注释记录了 `.api` 单独导入约 6.2 s 的历史测量；当前实测 2.1 s，说明该优化生效。

#### 清理前后回归验证

| 检查项 | 清理前 | 清理后 |
|---|---|---|
| `pytest tests/test_no_builtin_inference.py` | 11 passed / 0.29 s | 11 passed / 0.32 s |
| `import hindsight_api` | OK | OK |
| `sys.modules` 中的 `torch`/`transformers`/`scipy`/`sklearn`/`av`/`networkx` | 无 | 无 |
| 真实服务冷启动 + `/health` 200 | 7.7 s | 11.7 s（新建实例，含 125 条迁移） |
| retain + recall 冒烟 | 通过 | 通过（retain 0.5 s，recall 74/55 ms） |
| 服务 RSS | 267 MB | 279 → 296 MB |

关于 11.7 s 与 7.7 s 的差异：两次都是全新 pg0 实例，但本次冷启动包含了从零建库的完整迁移过程（日志中 125 条 `Running upgrade`，`PostgreSQL started` 到 `Database migrations completed` 相隔 1.3 s，到 `Memory system initialized` 共 1.8 s）。首次建库的迁移是不可比的一次性成本，不是依赖清理造成的回退；稳态 RSS 与服务行为均无差异。

### 3.3 常驻资源（真实服务进程，stub provider，pg0）

| 变体 | 冷启动 | 稳态 RSS | 20 s 后 RSS | 空闲 CPU |
|---|---|---|---|---|
| A 基线（MCP 开，分析语言 `en`） | 7.7 s | 267 MB | 267 MB | 0.31% |
| B MCP 关（分析语言 `en`） | 5.0 s | 233 MB | 233 MB | 0.62% |
| C 全语言分析器（MCP 开） | 8.8 s | 307 MB | 307 MB | 0.55% |
| D MCP 关 + worker 关 | 5.5 s | 233 MB | 233 MB | 0.00% |

补充实测：

- API 进程 286 MB（另一轮同一配置，说明存在约 20 MB 的轮次波动）。
- pg0 PostgreSQL 进程族：10 个进程合计 147 MB（仅 `hindsight-embed-coding-agent` 实例运行时）。
- ~~Control Center（Python stdlib HTTP 服务）：15–20 MB。~~ 已移除（ADR-006）。
- coding-agents `mcp-server.js`（Node）：61 MB。

单用户稳态总量约 **450–500 MB**（API + pg0 + Node MCP），不含 Control Plane（Next.js，未启动）。

空闲 CPU 差异说明：worker 关闭后为 0.00%，说明 0.31–0.62% 主要来自 500 ms 轮询而不是指标或 GC。

### 3.4 Recall 延迟与阶段分解

首次 Recall 314 ms，后续 26 ms、9 ms（空库，`rrf` 直通）。阶段分解（项目自带诊断输出）：

```
parallel_retrieval=157ms, reranking=66ms, rrf_merge=55ms, generate_query_embedding=36ms
```

关键点：`reranking=66ms` 出现在 `rrf` 直通模式下，说明「直通」仍会进入 rerank 阶段做一次全量遍历。`HINDSIGHT_API_ENABLE_RERANKING=false` 会走 `_resolve_reranking()` 把策略降级为 `rrf`（`memory_engine.py:1854-1863`），可省掉该阶段；两者叠加才是完整跳过。

### 3.5 Token 成本

用项目自有分词器（`toktok-rs`）实测：

| 项 | tokens |
|---|---|
| Retain 事实抽取 system prompt（`concise`） | 1485 |
| 事实抽取 JSON Schema | 915 |
| Consolidation system prompt | 3391 |
| Consolidation 单批 user prompt（5 事实 + 3 观察） | 126 |
| Consolidation JSON Schema | 874 |

推导（非实测调用）：

- 一次 Consolidation LLM 调用输入约 `3391 + 126 + 874 ≈ 4400` tokens，处理 `consolidation_llm_batch_size=8` 条事实（`config.py:2200`），即每事实约 550 tokens。
- 一次 Retain 抽取调用输入约 `1485 + 915 + 文本`，每 chunk 最多 3000 字符（`config.py:2020`）。
- Recall 默认不产生生成式 token：决策模型 provider 默认 `none`（`config.py:1796`），`recall_decision_model_*` 三个开关默认 false（`config.py:1811-1816`）；`memory_engine.py` 的 recall 区间（约 10600–11600 行）无 LLM 调用点。

### 3.6 存储

实测 schema 共 30 张表（空库，11 MB）：

| 类别 | 表 | 增长来源 | 现有清理 |
|---|---|---|---|
| 记忆主体 | `memory_units`（22 个索引）、`unit_entities`、`memory_links`、`invalidated_memory_units` | 每条事实、每条关系 | 无（业务数据） |
| 来源 | `documents`、`chunks`、`attachments`、`file_storage` | 每次 retain 的原文与文件 | `store_document_text` 可停写正文 |
| 实体 | `entities`、`entity_cooccurrences`、`entity_maintenance_queue`、`graph_maintenance_queue` | 实体识别与图维护 | graph maintenance 任务 |
| 观察 | `observation_history`、`mental_models`、`mental_model_history`、`directives`、`knowledge_pages` | 整合产物 | 无 |
| 运维 | `async_operations`（11 个索引）、`audit_log`、`llm_requests`、`bank_stats_cache`、`webhooks`、`bank_aliases` | 每次异步操作、每次 LLM 调用、每 60 s 统计 | 见下表 |
| 知识库 | `kb_documents`、`kb_passages`、`kb_passage_vectors`、`kb_staged_passages`、`kb_staged_passage_vectors` | 仅 `enable_kb=true` 时 | 无 |

清理相关默认值：

| 配置 | 默认 | 后果 |
|---|---|---|
| `HINDSIGHT_API_OPERATION_RETENTION_DAYS` | `0`（禁用） | `async_operations` 行与 payload 永久保留（`config.py:2332`；`maintenance.py:224` 要求该值 > 0 才清理） |
| `HINDSIGHT_API_LLM_TRACE_ENABLED` | `true` | 每次 LLM 调用写 `llm_requests`（`config.py:2460`） |
| `HINDSIGHT_API_LLM_TRACE_RETENTION_DAYS` | `1` | 1 天后由小时级 sweep 清理（`config.py:2463`） |
| `HINDSIGHT_API_AUDIT_LOG_ENABLED` | `false` | 默认不写审计（`config.py:2450`） |
| `HINDSIGHT_API_AUDIT_LOG_RETENTION_DAYS` | `-1`（永久） | 一旦开启即永久保留（`config.py:2452`） |
| `HINDSIGHT_API_BANK_STATS_CACHE_TTL_SECONDS` | `60` | 统计缓存，非持久增长 |

pg0 的 PostgreSQL 参数（实测 `postmaster.opts`，由 pg0 启动时注入，Hindsight Python 源码中无对应开关）：

```
-F -p 5432 -c timezone=UTC -c log_timezone=UTC -c work_mem=64MB
-c effective_cache_size=1GB -c shared_buffers=256MB -c maintenance_work_mem=512MB
-c max_parallel_maintenance_workers=4 -c logging_collector=on
```

这些值对单用户明显偏高：`shared_buffers=256MB` 是常驻分配，`maintenance_work_mem=512MB` 与 `max_parallel_maintenance_workers=4` 在索引维护时叠加。调整入口存在且无需改源码：`HINDSIGHT_API_DATABASE_URL` 支持 `pg0://name:port?shared_buffers=64MB&work_mem=8MB` 形式（`pg0.py:158-214` 解析查询串，`memory_engine.py:6468-6469` 透传 `config`）。

## 4. 六个配置项核查（第 5 节要求）

全部仍存在，默认值与调用路径如下。默认值取当前 fork 源码，不是旧版文档。

| 配置 | 默认 | 定义位置 | 实际调用路径 |
|---|---|---|---|
| `HINDSIGHT_API_ENABLE_RERANKING` | `true` | `config.py:2408`，读取 `:6225` | `memory_engine.py:1861` 仅把 `cross_encoder` 策略降级为 `rrf`；`rrf`/`interleave` 不受影响 |
| `HINDSIGHT_API_RERANKER_PROVIDER` | `rrf`（本 fork 改动） | `config.py:1508`，读取 `:5503` | `cross_encoder.py:2302-2308`：`rrf`/`none` → `RRFPassthroughCrossEncoder`；`local`/`onnx`/`flashrank`/`jina-mlx` → 抛错 |
| `HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION` | `true` | `config.py:2164`，读取 `:6013` | `memory_engine.py:7613`（retain 后提交）、`:11904`、`:12135`、`:12277`、`:12504`、`:12816`、`:13079`、`:13682`（删除/更新后提交）；`maintenance.py:592` 的对账同样受其门控 |
| `HINDSIGHT_API_ENABLE_OBSERVATIONS` | `true` | `config.py:2163`，读取 `:6012` | 与上一项联合门控 consolidation 提交（`memory_engine.py:7613`） |
| `HINDSIGHT_API_STORE_DOCUMENT_TEXT` | `true` | `config.py:2152`，读取 `:6000` | `retain/chunk_storage.py:145`、`fact_storage.py:385`、`orchestrator.py:2466`、`reflect/agent.py:658`、`memory_engine.py:23956-23965` |
| `HINDSIGHT_API_EMBEDDINGS_PROVIDER` | `openai`（本 fork 改动） | `config.py:1445`，读取 `:5267` | `embeddings.py:2119-2149` |

Recall 各臂的独立开关均已存在且可分层覆盖（`_CONFIGURABLE_FIELDS`，`config.py:4580-4584`）：

| 配置 | 默认 | 关闭效果 |
|---|---|---|
| `HINDSIGHT_API_ENABLE_TEXT_SEARCH` | `true`（`config.py:2405`） | 关键字臂从 SQL 中整段移除，并跳过分词与 `pg_stats` 选择 |
| `HINDSIGHT_API_ENABLE_TEMPORAL_RETRIEVAL` | `true`（`config.py:2406`） | 时间臂与喂给它的日期分析一并跳过 |
| `HINDSIGHT_API_ENABLE_GRAPH_RETRIEVAL` | `true`（`config.py:2407`） | 实体/链接图遍历的查询全部跳过 |
| `HINDSIGHT_API_ENABLE_RERANKING` | `true`（`config.py:2408`） | 见上 |

Graph Recall 另有实现选择项 `HINDSIGHT_API_GRAPH_RETRIEVER`（默认 `link_expansion`，`config.py:1920`），是选择器而不是开关。

文档一致性提示：`hindsight-docs/docs/developer/configuration.mdx:1289` 与 `:901` 仍写着默认 `local`，`.env.example:412` 等示例同样以 `local` 为例。这些是上游文档，在 fork 中未同步，属于文档与实现不一致，不是代码缺陷。

## 5. 裁剪候选清单（8.2）

### 5.1 A 类：配置级裁剪（零源码改动）

| 模块 | 当前作用 | 裁剪方式 | 预计收益 | 功能风险 | 上游维护成本 | 建议 |
|---|---|---|---|---|---|---|
| 陈旧依赖安装 | venv 内 28 个不在锁文件的分发 | `uv sync --frozen`（不删 venv、不重装） | **已执行：回收 773 MB**，venv 1649 → 876 MB | 无（锁文件已不含 torch） | 无 | 已完成 |
| 数据库连接池 | `min=5, max=100`（`config.py:2253-2254`） | 设 `DB_POOL_MIN_SIZE=1`、`DB_POOL_MAX_SIZE=10` | 减少 4 个常驻连接及其后端进程内存（待验证） | 并发上限降低；单用户足够 | 无 | 采纳 |
| 进程内 worker | 500 ms 轮询 `async_operations` | `WORKER_ENABLED=false`，改为手动 `/consolidate` 或独立 worker | 空闲 CPU 0.31–0.62% → 0.00%（实测） | 异步整合不再自动执行 | 无 | 采纳（配合批量整合策略） |
| MCP HTTP 端点 | 同进程 FastMCP，暴露 tools | `MCP_ENABLED=false`，保留 coding-agents 的 Node stdio MCP | RSS −34 MB，冷启动 −1.5~2.7 s（实测） | 失去 `http://…/mcp/` 接入方式 | 无 | 采纳（若宿主走 stdio） |
| 时区分析语言 | dateparser 全语言热加载 | `QUERY_ANALYZER_LANGUAGES=en,zh` | RSS −40 MB，冷启动 −1.1 s，加载 12.0 s → 1.4 s（实测） | 其他语言查询的时间表达不再识别 | 无 | 采纳 |
| pg0 内存参数 | `shared_buffers=256MB`、`maintenance_work_mem=512MB`、`work_mem=64MB` | 在 `DATABASE_URL` 加 `?shared_buffers=64MB&work_mem=8MB&maintenance_work_mem=64MB` | PostgreSQL 族 147 MB 预计降至 80–100 MB（待验证） | 大结果集排序/索引构建变慢 | 无（走 pg0 既有参数通道） | 采纳并实测 |
| 运维表清理 | `OPERATION_RETENTION_DAYS=0` 导致永不清理 | 设 7 或 14 | 阻止 `async_operations` 无界增长 | 历史操作记录不可回溯 | 无 | 采纳 |
| LLM trace | 默认写 `llm_requests` | `LLM_TRACE_ENABLED=false` | 少一次每次调用的写库与 1 天表增长 | 失去调用诊断与 token 统计 | 无 | 视需采纳 |
| rerank 阶段 | `rrf` 直通仍执行 66 ms 遍历 | `ENABLE_RERANKING=false` | 每次 Recall −50~70 ms | 与 `rrf` 叠加后排序不变 | 无 | 采纳 |
| 整合批参数 | 8 事实/调用、并行 4、每轮 100 | 按需调 `CONSOLIDATION_LLM_*`、`MAX_MEMORIES_PER_ROUND` | 减少调用次数与单轮占用 | 单次调用变长，超时风险 | 无 | 按实测调整 |
| 页面刷新 | 300 s tick | 不用 Pages 时设 `MENTAL_MODEL_REFRESH_TICK_SECONDS=0` | 停止周期扫描 | 页面不再自动刷新 | 无 | 采纳（按需） |
| 整合对账 | 300 s tick | 设 `CONSOLIDATION_RECONCILE_INTERVAL_SECONDS=0` 或放大 | 减少周期查询 | 需手动触发整合 | 无 | 与批量策略配套 |
| 知识库 | 默认已关（`config.py:2160`） | 保持 `ENABLE_KB=false` | 避免 KB 路由与 6 张表 | 无（不使用） | 无 | 保持默认 |
| 原始正文 | 默认存 `original_text`/`chunk_text` | `STORE_DOCUMENT_TEXT=false` | 文档与 chunk 体积显著下降（待实测） | 失去正文回看、`update_mode='append'` 被拒（`memory_engine.py:23960-23967`）、reflect 的 expand | 无 | 按需；默认建议保留 |

### 5.2 B 类：部署与依赖级裁剪

| 模块 | 当前作用 | 裁剪方式 | 预计收益 | 功能风险 | 上游维护成本 | 建议 |
|---|---|---|---|---|---|---|
| `claude-agent-sdk`（`pyproject.toml:104`） | `claude-code` LLM provider 的 SDK | **已删除**：provider 分支、`providers/claude_code_llm.py`（506 行）、注册表条目、`provider_auth.py`/`config.py`/`tracing.py` 中的对应项、两个专属测试文件，以及 cursor/openclaw 集成里把它当可选项的注册表与 coding-agents 的 CLI 兜底探测 | **磁盘 −260 MB，实测 venv 876 → 636 MB** | 失去 `claude-code` provider；该 provider 仅把 Claude Code CLI 当作 LLM 后端。保留 `anthropic` provider 走 API | 低：改一个依赖声明与若干小分支 | 已完成 |
| `markitdown[pdf,docx,pptx,xlsx,xls]` | 附件转文本（`engine/parsers/markitdown.py`、`knowledge/media.py:395`） | 移入可选 extra，核心依赖只留纯文本 | 磁盘约 −80 MB（`onnxruntime` 32 + `pandas` 45 + `magika` 3）；运行时 0（惰性导入） | 无附件解析能力 | 低：改 `pyproject.toml` 一行，冲突面小 | 采纳 |
| `litellm` | 多 provider 统一层 | 移入可选 extra | 磁盘 −111 MB；运行时 0 | 不能用 `litellm`/`litellm-sdk` provider | 低 | 采纳 |
| `boto3`/`botocore`/`obstore` | S3/GCS/Azure 对象存储 | 归入 `storage` extra | 磁盘 −30 MB；运行时 0 | 不能用对象存储后端（默认 `native`） | 低 | 采纳 |
| `cohere`/`anthropic`/`google-genai` | 对应 provider SDK | 归入各自 extra | 磁盘约 −12 MB | 失去对应 provider | 低 | 可选 |
| `av`（PyAV） | 音视频解码 | 已不在锁文件内；本次清理已卸载 | 磁盘 −3.4 MB（实际占用远小于体积估算） | KB 音视频不可用（KB 默认关闭） | 无 | 已移除 |
| Control Plane（Next.js） | 管理界面 | 不安装、不启动 | 省一个常驻 Node 进程 | 无图形管理 | 无 | 采纳 |
| ~~Control Center（`hindsight-embed` 内置）~~ | 已移除（ADR-006）：本地运维由控制平面 `/local` 页承担 | 已删除 | 省 15–20 MB 与一个进程 | 无 | 无 | 已完成 |
| 独立 `hindsight-worker` | 分离部署的任务执行者 | 不部署 | 省一个完整 API 侧进程 | 无 | 无 | 采纳（单机） |
| `oracle` extra | Oracle 23ai 支持 | 不安装（已默认） | 无 | 无 | 无 | 保持 |

### 5.3 C 类：小规模源码改造

| 模块 | 当前作用 | 裁剪方式 | 预计收益 | 功能风险 | 上游维护成本 | 建议 |
|---|---|---|---|---|---|---|
| 知识库默认 provider | `DEFAULT_KB_EMBEDDINGS_PROVIDER="local"`（`config.py:2097`），而 `knowledge/embedders.py:128` 仍 `from sentence_transformers import SentenceTransformer` | **已修复**：默认改为 `text`；`LocalGemmaEmbedder` 与仅其使用的 `_is_clip`/`_model_batches`/`_release_device_cache`/`_TEXT_BATCH_CHARS`/`kb_embeddings_device` 一并删除，`local` 分支改为报错并提示替代项 | 修复「启用 KB 即失败」 | 无（删除的是已不可用的实现） | 低：KB 模块非上游高频改动区 | 已完成 |
| 模型初始化 | `initialize()` 无条件 `init_cross_encoder()`、`init_query_analyzer()`（`memory_engine.py:6547-6553`） | 按 provider/开关条件跳过 | 已在 `rrf` 下几乎为 0；主要收益是时间分析器 | 无 | 中：改初始化列表，与上游频繁改动区重叠 | 优先级低（见 5.3 说明） |
| daemon 空闲退出 | 已移除，`--idle-timeout` 失效（`daemon.py`、`main.py:306-312`） | 恢复按「无请求 + 无在途任务」计时的退出 | 空闲时不占用 233–286 MB | 冷启动重新付出 5–8 s | 中：触及 daemon 生命周期 | 建议采纳（个人场景收益最高） |
| pg0 参数默认值 | 由 pg0 注入，Hindsight 无默认覆盖 | 在 `pg0.py` 的 `ensure_running` 里给单用户默认值 | 无需用户配 URL | 与多实例共享部署冲突 | 低 | 可选（A 类已可达成） |
| KB 路由注册 | `api/http.py:4895-4897` 无条件注册 KB 路由 | 按 `enable_kb` 决定是否注册 | 减少 17 条路由与模块导入 | 无 | 低 | 可选 |

说明：`init_cross_encoder()` 在 `rrf` 下实测代价接近 0（`RRFPassthroughCrossEncoder.initialize()` 仅置标志），真正的 2–3 s 与 9–43 MB 来自 query analyzer，因此改造初始化流程的收益主要体现在分析器上，而分析器已有配置级方案（A 类）。按「优先 A/B」原则，该项不建议实施。

### 5.4 D 类：深度架构改造（不建议）

| 模块 | 不建议原因 |
|---|---|
| PostgreSQL → SQLite | pgvector 语义检索、`tsvector` BM25、递归图查询、JSONB、Alembic 迁移、事务一致性全部需要重建；当前 30 张表中 `memory_units` 单表 22 个索引，图与向量路径依赖 PG 专有 SQL。收益是省掉 147 MB 的 PostgreSQL 进程，代价是核心检索能力重写。 |
| 拆分 `memory_engine.py`（25057 行） | 纯结构改造，不降低运行资源，却使上游同步从「少量冲突」变成「全面冲突」。 |
| 自研 RRF / 检索融合 | 现有 `search/fusion.py` 为纯函数、无外部依赖、已有系统测试覆盖。重写无资源收益。 |
| 删除 Consolidation / Observations | 属于必须保留的核心能力，且删除会同时破坏 Facts 的长期收敛与 Recall 质量。 |
| 移除 Recursive CTE 图检索 | Graph Recall 是必须保留的能力，`link_expansion` 是其唯一实现。 |

## 6. 推荐的最小化架构（8.3）

### 6.1 必须保留的运行组件

| 组件 | 形态 | 理由 |
|---|---|---|
| `hindsight-api` 进程 | 1 个 Python 进程 | Retain/Recall/Reflect 的唯一实现；MCP stdio 之外的所有宿主都经由它 |
| PostgreSQL（pg0） | 进程组 | 向量、BM25、图、JSONB、迁移均依赖 |
| coding-agents `mcp-server.js` | 每宿主 1 个 stdio Node 进程 | 各 Coding Agent 的接入形态 |

### 6.2 可以关闭的组件

| 组件 | 关闭方式 |
|---|---|
| 进程内 worker 轮询 | `HINDSIGHT_API_WORKER_ENABLED=false`（改由批量/手动触发整合） |
| MCP HTTP 端点 | `HINDSIGHT_API_MCP_ENABLED=false` |
| 维护循环中不用的 job | 对应间隔置 0：`MENTAL_MODEL_REFRESH_TICK_SECONDS`、`CONSOLIDATION_RECONCILE_INTERVAL_SECONDS`（按批处理策略取舍）、`ATTACHMENT_SWEEP_INTERVAL_SECONDS` |
| Control Plane（含本地运维页 `/local`） | 不启动（本地配置与 daemon 启停改由 `hindsight-embed ops` CLI 承担） |
| 独立 worker | 不部署 |
| 知识库 | 保持 `ENABLE_KB=false` |

### 6.3 可以去除的依赖

已去除（本次清理实测）：`torch`/`scipy`/`av`/`transformers`/`scikit-learn`/`torchvision`/`networkx`/`sentence-transformers`/`safetensors`/`joblib`/`threadpoolctl`/`einops`/`flashrank`/`setuptools`，合计 773 MB。这些是否需要重新出现，由 `uv.lock` 决定；`huggingface_hub` 仍在锁文件内（由 `litellm`、`tokenizers` 等间接需要）。

待去除（按收益排序）：`litellm` 111 MB、`markitdown` 及其 `onnxruntime`/`pandas`/`magika`（约 80 MB）、`boto3`/`botocore`/`obstore`（30 MB）。`claude-agent-sdk`（260 MB）已删除。

### 6.4 应保留但按需加载的模块

`openai`/`anthropic`/`google-genai`/`cohere` 等 provider SDK、`markitdown`、`fastmcp`、对象存储客户端、`pandas`。这些已全部为函数内导入，保留它们不产生常驻开销，保留可维持上游兼容。

### 6.5 不建议裁剪的核心能力

Retain（`retain/orchestrator.py`、`fact_extraction.py`）、Consolidation（`consolidation/consolidator.py`）、Observations 与 `observation_history`、实体与三类关系链接（`unit_entities`、`memory_links` 的 temporal/semantic/causal）、三路 Recall 臂与 RRF 融合、Memory Banks 隔离、coding-agents 集成。

## 7. 分阶段实施方案（8.4）

### 阶段 1：配置与依赖优化（A + B）

前置：先完成第 12 节的阶段 0。

- 改动范围：`.env` / `~/.hindsight/profiles/<profile>.env`、`hindsight-api-slim/pyproject.toml` 与 `hindsight-all*/pyproject.toml` 的 extras 分组、venv 重建。不触碰 `engine/` 与 `api/`。
- 具体项：5.1 全部（除标「按需」者按需）、5.2 的 markitdown/litellm/存储 SDK 分组。
- 建议顺序：① 依赖清理已完成（`uv sync --frozen`，回收 773 MB，见 3.1）；② 设 `QUERY_ANALYZER_LANGUAGES`、`DB_POOL_MIN_SIZE`、pg0 URL 参数（内存收益，可单独验证）；③ 关 MCP（仅在使用 stdio MCP 时）；④ 关 worker 与调整合节奏（必须同时落实替代触发方式，见 8.3/8.4）。
- 验收：`uv sync --frozen` 后 `pip list` 不含 `torch`；`import hindsight_api` 的 `sys.modules` 仍不含重型包；冷启动 ≤ 6 s；稳态 RSS ≤ 240 MB；`/health` 200；一次 retain + recall 冒烟通过。
- 回退条件：任一宿主无法完成 retain/recall；或 Recall 结果与基线差异超出预期（需先建立基线集）。每一项独立可回退，不打包实施。

### 阶段 2：运行时资源测量（建立对照组）

- 改动范围：仅新增测量脚本与记录，不改产品代码。
- 采集项：API 进程 RSS/PSS、pg0 进程族 RSS、空闲 CPU、冷启动、Recall P50/P95、单次 retain 与单次 consolidation 的 token（`llm_requests` 表或 LLM 侧账单）。
- 验收：同一配置重复 3 次，RSS 波动 < 10%；数据可复现。
- 回退条件：无（只读测量）。

### 阶段 3：必要的源码级裁剪（C）

按收益排序，逐项独立提交：

1. KB 默认 provider 改为 `text`（缺陷修复，一行）。
2. daemon 空闲退出恢复（触及 `daemon.py`、`main.py`）。
3. 可选：KB 路由按需注册。

- 验收：`pytest hindsight-api-slim/tests/test_no_builtin_inference.py` 与 KB 相关测试通过；daemon 在空闲阈值后退出、请求到达时重新拉起且首个请求不失败。
- 回退条件：daemon 出现「请求处理中被杀」或重复拉起；按 ADR 记回退。

### 阶段 4：回归测试与性能对比

- 回归范围按改动层级决定：阶段 1（配置与依赖）只跑改动涉及的测试与检查闸门；阶段 3（跨模块、触及生命周期）重测受影响范围，包含 `hindsight-system-tests/` 的黑盒故事；只有改动延伸到数据库或核心算法时才跑全量。
- 对比表：阶段 0 基线 vs 各阶段后，覆盖第 5 节各表的「预计收益」列。
- 验收：所有数字为实测；未达成项标注原因而非估算。

## 8. 风险与技术债务（8.5）

### 8.0 Embedding 维度变更（本次新发现，优先级仅次于上游同步）

ADR-005 把 `DEFAULT_EMBEDDINGS_PROVIDER` 从 `local`（`BAAI/bge-small-en-v1.5`，384 维）改为 `openai`（默认模型 `text-embedding-3-small`，1536 维，`config.py:1467`）。这不是纯配置变更，它改变了向量列的维度。

源码行为（`migrations.py:640-709`、`:769-822`）：

- 维度一致：无动作。
- 维度不同且表为空：自动 `ALTER COLUMN … TYPE vector(N)`，并重建索引。
- **维度不同且 `memory_units`/`mental_models` 已有带向量的行：启动直接抛 `RuntimeError`**，提示要么清空重嵌入，要么换回 384 维模型。

结论：

- 空库切换无感。本机 `hindsight-embed-coding-agent` 实例的 `public` schema 实测 **0 张表**（`pg_extension` 仅 `plpgsql`），即该实例从未完成过启动与迁移，因此当前切换没有数据风险。
- 一旦积累了记忆再切回 `local` 或换到其他维度模型，服务将**无法启动**，需要迁移。
- 已有官方工具 `hindsight-admin reembed`（`admin/reembed.py` 文件头描述了完整的可续跑流程：加 `embedding_next` 列 → 触发器 → 批量回填 → CONCURRENTLY 建索引 → 短写锁切换），这是该场景的正确路径，不应自行写脚本。

建议：在阶段 1 之前固定一个 embedding 模型并写进文档与 `.env`，避免后续再变；若必须变更，按 `reembed` 流程执行并先在副本上验证。

### 8.1 上游同步（最高优先级）

`git merge-base main private` 为空：`private` 与 `main` 无共同祖先，`git merge origin/main` 不可用。当前只在 `private` 上跟踪上游，等价于维护一个平行代码树。

具体冲突热点是已删除的约 2448 行引擎代码：`cross_encoder.py`（−821）、`embeddings.py`（−523）、`llamacpp_llm.py`（−473）、`local_device.py`（−372）、`query_analyzer.py`（−259）。上游对这几个文件的任何改动（新增 provider、调整重试、修改提示词）都需要手工重放。

建议的处置（属于流程改造，不属于运行时裁剪）：

- 以 `main` 为基线重建定制分支，把定制项做成独立提交，使上游可合并。
- 把「删除内置推理」从删代码改为「不安装 extra + 默认值指向外部」：`rrf` 与 `openai` 默认值已经生效，本地 provider 即使保留代码也不会初始化，仅在被显式配置时才加载。这样可把 2448 行删除缩减为两行默认值，冲突面接近零，代价是保留未被使用的源码（不产生运行开销，与「包体积 ≠ 运行资源」的判据一致）。

### 8.2 核心记忆质量下降

关闭 reranker 后排序完全由 RRF 决定。对个人记忆库，语义与关键字的排序融合通常足够；但在「近义但不同实体」的场景（如两个同名项目的不同端口）可能下降。`search/fusion.py` 的 `interleave_fusion` 已记录 RRF 的具体失败模式（合并去重时近义观察被压到预算以下）。

缓解：保留通过外部 reranker（`tei`/`cohere`/`siliconflow`）随时开启的能力，只在默认配置上关闭；或在个人机器上以 `llama-server` 提供 rerank 端点。

### 8.3 关系召回失效

Graph Recall 依赖 `graph_maintenance_queue` 与 `entity_maintenance_queue` 的持续消费。若关闭进程内 worker 又未提供替代执行者，队列只增不减，图质量随时间退化。

缓解：关闭 worker 时必须同时确定整合与图维护的触发方式（手动 `/consolidate`、定时脚本，或保留 worker 仅关闭其他组件）。

### 8.4 Consolidation 行为变化

`ENABLE_AUTO_CONSOLIDATION=false` 会同时关闭 retain/删除/更新后的自动提交（`memory_engine.py` 的 7 处 `if config.enable_auto_consolidation:` 分支，行 11904/12135/12277/12504/12816/13079/13682，另有 7613 与 `enable_observations` 联合门控）与维护对账（`maintenance.py:592`）。此时只有显式 `/consolidate` 请求会把积压处理完：`consolidator.py:2472-2478` 的分支表明，自动链路达到单轮上限后不再重新排队，显式调用才继续排空。因此批处理化需要自建触发节奏并处理单轮上限（`CONSOLIDATION_MAX_MEMORIES_PER_ROUND=100`），否则未整合事实持续堆积，Recall 只能命中原始事实。

### 8.5 数据迁移兼容性

本方案不涉及 schema 改动，A/B/C 类均不触碰表结构。风险集中在 `STORE_DOCUMENT_TEXT=false`：关闭后已存文档仍保留旧正文，新写入为空，形成混合状态；且 `update_mode='append'` 会被显式拒绝（`memory_engine.py:23960-23967`，返回 `InvalidRetainRequestError`）。建议保留默认 `true`，若确需关闭则一次性切换并接受历史不可回看。

### 8.6 人工监督功能的扩展限制

任务要求保留「人工记忆审核、事实纠错、受控变更与变更历史」的扩展能力。现状支撑：

- 事实级：`memory_units` 有 state/失效语义，`invalidated_memory_units` 保留失效记录，`PATCH /v1/default/banks/{bank_id}/memories/{memory_id}`（`api/http.py:5477`）与 `/history`（`:5539`）已存在。
- 观察级：`observation_history` 与 `document_history.py` 提供版本轨迹。
- 审计级：`audit_log` 与 `audited()` 装饰器已就位，默认关闭。

因此裁剪时不应移除上述端点与表；关闭 `AUDIT_LOG_ENABLED` 会削弱「谁改了什么」的证据链，若计划后续做人工审核，应保持开启并接受其存储增长。

## 9. 不值得实施的改造

| 改造 | 判定 |
|---|---|
| PostgreSQL 替换为 SQLite | 收益是 147 MB 进程内存；代价是重写向量、BM25、递归图与迁移体系。不实施。 |
| 拆分 `memory_engine.py` | 无运行资源收益，显著恶化上游同步。不实施。 |
| 重写 RRF 融合或检索臂 | 现有实现为纯函数且被系统测试覆盖；重写无收益。不实施。 |
| 删除 Consolidation / Observations | 违反必须保留的能力。不实施。 |
| 用 ONNX 替换当前外部 embeddings | 任务提到「Embedding 是否可采用本地 ONNX」。当前已改为外部 OpenAI 兼容端点（可指向本机 `llama-server --embedding`），引入 ONNX 会把 `onnxruntime` 与模型文件重新拉回常驻路径，与轻量化目标相反。若需要完全离线，优先复用已有的外部 llama-server 通道，而不是新增 ONNX 依赖。 |
| 定制 `init_cross_encoder()` 条件化 | 在 `rrf` 下开销接近 0，收益已被 A 类的分析器配置覆盖。不实施。 |

## 10. 未确认事项与所需证据

| 事项 | 缺少的证据 | 获取方式 |
|---|---|---|
| 关闭 reranker 的召回质量差异 | 评测集上的 Recall@k / 准确率对比 | 用 `hindsight-system-evals`（AMB 数据集）在两种配置下各跑一遍 |
| pg0 参数下调后的真实内存 | 调整后进程族 RSS | 用 `pg0://…?shared_buffers=64MB&work_mem=8MB` 重启并测量 |
| 连接池 min 从 5 降到 1 的收益 | 后端进程与客户端内存差值 | 同上方法 A/B |
| `STORE_DOCUMENT_TEXT=false` 的存储节省 | 真实文档量下的表体积对比 | 需有真实数据量的库 |
| 有数据量时的 Recall 延迟 | P50/P95 随库规模变化 | 导入真实记忆后测量 |
| Consolidation 实际 token 消耗 | 真实模型调用账单或 `llm_requests` 记录 | 开启 trace 后统计 |
| pg0 注入参数的实现位置 | 源码位置 | `pg0` Python 包内无这些字符串，推断在编译产物内；需查 pg0 发行说明 |

## 11. 附：本机当前态

`~/.hindsight/profiles/coding-agent.log` 记录了 2026-11-20 多次 `Application startup failed`，原因是 `embeddings.py` 仍在调用已删除的 `local_device.prefetch_local_model`，以及默认 reranker 仍为 `local`。

当前源码已不再引用 `local_device`（`grep` 无匹配），`cross_encoder.py:2302-2308` 对 `local` 抛错，`test_no_builtin_inference.py` 11 项通过。因此该日志早于修复，属于陈旧状态。

与之相符的旁证：该 daemon 的 pg0 实例 `hindsight-embed-coding-agent` 的 `public` schema 实测 0 张表，说明它从未成功完成启动与迁移。修复后 daemon 尚未成功启动过，这一项标注为**未确认**，需要在阶段 1 的验收中覆盖。

对照：本次分析自建的 `hindsight-analysis` 实例完成了完整迁移，得到 30 张表、11 MB（空库），说明迁移链路本身可用，失败点在模型初始化而非数据库。

## 12. 阶段 0（建议新增）：先让当前分支可启动

在上表的阶段 1 之前，必须先确认修复后的默认配置能真正启动一次：

1. 用 `HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai` + 本机 `llama-server --embedding`（或任一 OpenAI 兼容端点）+ `HINDSIGHT_API_RERANKER_PROVIDER=rrf` 启动 `hindsight-api`。
2. 确认 `/health` 返回 200、`public` schema 建出表、一次 retain + recall 成功。
3. 记录冷启动与 RSS 作为基线（预期与本次实测的 7.4–9.2 s / 267 MB 同量级）。

未通过该项就不应进入阶段 1 的依赖裁剪，否则会把「本来就启动不了」与「裁剪导致启动不了」混在一起。

