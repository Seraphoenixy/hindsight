---
sidebar_position: 2
title: 定制化决策记录 (ADR)
---

# 定制化决策记录

用于按条目记录 `private` 分支的重要设计决策与背景，方便后续回溯。

## 模板

```markdown
### [ADR-001] 标题

- **日期**：YYYY-MM-DD
- **状态**：提议 / 已采纳 / 已废弃
- **背景**：需要解决什么问题，为什么上游默认实现不满足需求？
- **方案**：具体采取了什么实现方式？
- **影响范围**：涉及哪些目录、服务、配置或依赖？
- **与上游差异**：后续参考或同步上游时需要注意哪些冲突点？
```

---

### [ADR-001] 建立独立 `private` 分支与隔离文档族

- **日期**：2026-11-20
- **状态**：已采纳
- **背景**：`main` 分支需要保持与上游一致；同时个人定制开发需要一套独立的文档空间沉淀设计思路，且不干扰上游原有 `docs/` 结构。
- **方案**：
  - 创建无上游历史提交的 `private` 分支作为定制开发主线。
  - 在 `hindsight-docs/docs-private/` 下存放独立定制文档（ADR 与轻量化裁剪分析）。
- **影响范围**：`hindsight-docs/docs-private/`。

---

### [ADR-002] `daemon` 自动拉起本地控制中心与 DSH 桌面端状态页面

- **日期**：2026-11-20
- **状态**：已废弃（由 ADR-006 取代：控制中心已移除，运维并入控制平面）

- **背景**：上游 `coding-agents` 在 `daemon` 模式下只拉起 `9077` API 服务，默认不启动 Control Center，且 DSH 桌面端没有直观的状态与控制界面。
- **方案**：
  - 新增 `hindsight-integrations/coding-agents/src/core/control-center.ts`，并在 `daemon-start.ts` 中随 `daemon` 启动并发拉起本地 Control Center（`7878`）。
  - 新增 `hindsight-integrations/coding-agents/src/dsh-client.ts`（通过 `package.json` 的 `./client` 与 `dsh.client.platform: "web"` 暴露），在 DSH 桌面端侧边栏注册 `Hindsight` 面板，实时展示 `9077` / `7878` / `19077` 在线状态并内嵌本地控制中心与记忆库管理页面。
  - `cordis.patch.yml` 的行名使用路径 `./dist/dsh.js`，不使用包名的 `/dsh` 子路径。原因：`@deepseek-ai/dsh-client-modules` 仅当行名能解析到包根时才为该包建立浏览器端行（`exactPackageSpecifier()` 对带子路径的 scoped specifier 返回 `undefined`），子路径会使 Host 半边正常加载而浏览器半边被静默跳过，侧栏不出现且无报错。路径型行名由 `anchorInsertedPluginNames()` 锚定为 `file://` URL，扫描时从该模块向上找到本包 `package.json`，从而读到 `dsh.client` 与 `exports["./client"]`。
- **影响范围**：`hindsight-integrations/coding-agents/src/core/control-center.ts`、`daemon-start.ts`、`dsh-client.ts`、`dsh-bundle.test.ts`、`react.d.ts`、`tsup.config.ts`、`package.json`、`cordis.patch.yml`。
- **回归保护**：`src/dsh-bundle.test.ts` 断言行名可被扫描、指向存在的 Host 入口，且客户端包只以包名注册工厂（`ClientModuleSystem.register()` 仅剥离尾部 `/client`，id 不匹配会得到无法被任何图行导入的孤立模块）。

---

### [ADR-003] 移除内置 Python 推理与重型云端/第三方适配器，改为外部推理 + 零模型 RRF

- **日期**：2026-11-20
- **状态**：已采纳
- **背景**：内置 `local-ml`（PyTorch / `transformers` / `sentence-transformers`）、`local-onnx`、`llama-cpp-python`、`claude-code` CLI Provider 以及 `litellm` / `boto3` / `obstore` 体积庞大（或引入 CLI 隔离与 HF 下载风险）；而个人本地已有原生 C++ `llama-server.exe` 与主流原生 LLM Provider（`openai`、`deepseek`、`openai-codex`、`anthropic`、`gemini` 等）可用。
- **方案**：
  - **依赖精简**：精简 `hindsight-api-slim/pyproject.toml` 与 `hindsight-all/pyproject.toml`，移除 `local-ml` / `local-onnx` / `local-llm` / `claude-agent-sdk`；将 `boto3`、`obstore`、`litellm` 移至可选 `[project.optional-dependencies].cloud`（`storage/base.py` 中 `obstore` 改为惰性导入 `_obstore()`）；`all` 仅保留 `embedded-db`（`pg0-embedded`）；`hindsight-embed/daemon_embed_manager.py` 本地启动改为 `--extra embedded-db`。
  - **默认推理配置**：`config.py` 默认 `DEFAULT_EMBEDDINGS_PROVIDER = "openai"`、`DEFAULT_RERANKER_PROVIDER = "rrf"`、`DEFAULT_KB_EMBEDDINGS_PROVIDER = "text"`。
  - **删除实现与保留明确报错**：删除 `local_device.py`、`llamacpp_llm.py`、`claude_code_llm.py`、`litellm_llm.py`、`litellm_router_llm.py`、`LocalSTEmbeddings`、`OnnxEmbeddings`、`LiteLLMSDKEmbeddings`、`LocalSTCrossEncoder`、`FlashRankCrossEncoder`、`OnnxCrossEncoder`、`JinaMLXCrossEncoder`、`LiteLLMSDKCrossEncoder`、`TransformerQueryAnalyzer` 及对应测试；清理 `providers/__init__.py`、`provider_auth.py`、`tracing.py`、`test_hook_llm_registry_parity.py`；在 `embeddings.py`、`cross_encoder.py`、`llm_wrapper.py` 中对已移除 Provider 给出明确报错（并为 `openai` Embeddings 增加配置 `base_url` 时免 API Key 支持，在 Reranker 中支持 `none` 作为 `rrf` 别名）。
- **影响范围**：`hindsight-api-slim/`、`hindsight-all/pyproject.toml`、`hindsight-embed/daemon_embed_manager.py`、`uv.lock`。
- **与上游差异**：上游默认依赖完整本地推理、CLI Provider 与 `litellm` / 云存储包；本分支裁剪后 `hindsight-api-slim[embedded-db]` + `hindsight-embed` 运行时 `site-packages` 降至约 `273.4 MB`（116 个包）。

---

### [ADR-004] 收紧默认 LLM 并发上限并默认关闭 HTTP `/mcp/` 端点

- **日期**：2026-11-20
- **状态**：已采纳
- **背景**：上游默认全局 LLM 并发上限为 `32` 且 `retain` / `consolidation` 无独立默认限制，后台任务易打爆个人额度或触发 429；同时个人场景下 `coding-agents` 通过 stdio 运行 `mcp-server.js`，服务端默认挂载 HTTP `/mcp/` 端点会额外占用约 34 MB 内存与冷启动时间。
- **方案**：修改 `hindsight-api-slim/hindsight_api/config.py`：
  - 将 `DEFAULT_LLM_MAX_CONCURRENT` 从 `32` 调整为 `2`，新增 `DEFAULT_RETAIN_LLM_MAX_CONCURRENT = 1` 与 `DEFAULT_CONSOLIDATION_LLM_MAX_CONCURRENT = 1`（通过 `_env_int_or` 作为未设环境变量时的默认值）；`DEFAULT_LLM_TIMEOUT` 保持 `120.0`、`DEFAULT_LLM_MAX_RETRIES` 保持 `3`。
  - 将 `DEFAULT_MCP_ENABLED` 由 `True` 改为 `False`（仍可通过 `HINDSIGHT_API_MCP_ENABLED=true` 显式开启）。
- **影响范围**：`hindsight-api-slim/hindsight_api/config.py`、`hindsight-api-slim/tests/test_llm_per_op_concurrency.py`。
- **与上游差异**：上游默认 `DEFAULT_LLM_MAX_CONCURRENT = 32`、`retain`/`consolidation` 并发默认不限、`DEFAULT_MCP_ENABLED = True`。

---

### [ADR-005] 面向个人本地使用全面裁剪仓库非核心目录与构建配置

- **日期**：2026-11-20
- **状态**：已采纳
- **背景**：上游仓库包含容器编排、K8s、监控栈、多租户扩展、48 个第三方集成、大型系统评测集、多语言客户端、PyPI 元包及完整的 Docusaurus 官网与配图，对个人本地开发与打包发布冗余度过高。
- **方案**（保留 `hindsight-api-slim`、`hindsight-embed`、`hindsight-control-plane`、`hindsight-integrations/coding-agents`、`hindsight-clients/typescript`、`hindsight-dev` 及核心文档）：
  - **容器与部署/监控**：移除 `docker/`、`.dockerignore`、`Dockerfile*`、`helm/`、`scripts/dev/monitoring/`、`scripts/dev/start-monitoring.sh`、`monitoring/`。
  - **CI/CD、发版与跑分脚本**：移除 `.github/`、`.cursor-plugin/`、`scripts/benchmarks/` 及发版/集成校验/文档生成等非本地脚本（`release*.sh`、`check-integration-*.sh`、`generate-docs-skill.sh`、`sync-cookbook.sh`、`test-doc-examples.sh`、`update-docs-version.sh`、`smoke-test-slim.sh`、`run-upgrade-tests.sh`、`test-hermes-compat.sh`、`triage-labels.py`、`start-docs.sh`、`start-oracle.sh` 等）；移除 `hindsight-dev/` 中 `generate_changelog.py`、`generate_llms_full.py`、`sync_cookbook.py` 及对应脚本入口与单测。
  - **集成、评测、多端包装与元包**：移除 `hindsight-integrations/` 下除 `coding-agents/` 外的 47 个集成目录；移除 `hindsight-extensions/`、`cookbook/`、`skills/`、`hindsight-system-tests/`、`hindsight-system-evals/`、`hindsight-integration-tests/`、`hindsight-all/`、`hindsight-all-npm/`、`hindsight-cli/`、`hindsight-clients/{go,rust,python}/`；移除空壳 PyPI 元包 `hindsight-api/`、`hindsight-all-slim/`（同步修改根 `package.json`、`pyproject.toml`、`hindsight-dev/pyproject.toml` 与 `uv.lock`）。
  - **文档站点精简**：清理 `hindsight-docs/` 下全部 413 个多媒体文件（约 161.2 MB），以及 `guides/`、`blog/`、`versioned_docs/`、`versioned_sidebars/`、`versions.json`、`examples/`、`figures/`、`docs-integrations/`、`scripts/`、`plugins/`、`src/`、`static/` 与 Docusaurus 构建配置文件，仅留纯 Markdown 文档 `docs/`、`docs-private/` 与 `README.md`。
- **影响范围**：仓库顶层结构、`package.json`、`pyproject.toml`、`hindsight-dev/`、`hindsight-docs/`、`hindsight-integrations/`、`scripts/`、`uv.lock`。
- **与上游差异**：上述目录与包装包均可在需要时从上游 `main` 恢复；后续参考上游时忽略对应已移除路径的变更。

---

### [ADR-006] 移除 `hindsight-embed` 控制中心，本地运维并入控制平面

- **日期**：2026-11-21
- **状态**：已采纳（取代 ADR-002 的控制中心部分）
- **背景**：ADR-002 让 `coding-agents` 在 `daemon` 模式下自动拉起 `hindsight-embed` 控制中心（7878），并在 DSH 面板内嵌。该控制中心与控制平面（19077）是同一个本地记忆栈上的两套界面：两套 URL、两套访问令牌、两个需各自守护的进程，而用户调整的 LLM 与服务配置位于不显示记忆库的那一套里。其职责拆分后，没有一项需要独占常驻进程：`.env` 读写、daemon 启停与日志本来就是 `hindsight-embed` 的 CLI 能力。
- **方案**：
  - **Python 侧**：删除 `hindsight_embed/control_center/{server.py,lifecycle.py,static/,ui/}`（stdlib HTTP 服务端、token、7878 端口、Preact SPA）。保留 `settings.py`（设置目录的唯一来源）、`providers.py`、`service.py`，包更名为 `hindsight_embed/ops/`；新增 `ops/auth.py`（`~/.hindsight/ops.token`）与 `ops/cli.py`（每条命令输出一个 JSON 文档，写操作从 stdin 读请求文档）。`hindsight-embed control` 保留为显式退役提示，不再委托给 `hindsight-cli`。`configure --web` 改为启动控制平面并打开其 `/local` 页。
  - **控制平面**：新增 `src/lib/ops.ts`（子进程调用 `hindsight-embed ops`，短 TTL 只读缓存）、`src/lib/ops-token.ts`、`src/lib/local-access.ts`、`src/lib/local-route.ts`、`src/lib/local-api.ts`、`src/app/api/local/**` 路由与 `src/app/[locale]/local/page.tsx` + `src/components/local-settings-panel.tsx`。页面为服务端组件，令牌以 prop 注入客户端组件，浏览器不通过 fetch 获取令牌。
  - **访问控制**：`/api/local/*` 同时要求 loopback `Host`、loopback（或缺席）`Origin`、以及 `X-Hindsight-Ops-Token` 匹配 `ops.token`。拒绝一律返回 404，不向无权限调用方确认该面存在。
  - **coding-agents**：`core/control-center.ts` 更名 `core/control-plane.ts`，`ensureControlCenterStarted`/`stopControlCenter`/`controlCenterToolSpec` 分别更名 `ensureControlPlaneStarted`/`stopControlPlane`/`controlPlaneToolSpec`，改为以 `ui start --hostname 127.0.0.1` / `ui stop` 驱动；`dsh.ts` 的 7879 触发端点保留（浏览器半边无法起进程），DSH 面板两个页签改为同一应用的两个页面（`/` 与 `/local`）。
  - **不重写进程管理**：`daemon_embed_manager.py` 保留为唯一实现。它包含 Node 无等价物的平台行为（`GetExtendedTcpTable`/`NtQueryInformationProcess` 内核查询、避免弹出控制台的 detach 标志组合、跨平台 profile 文件锁），并承载 24 个上游缺陷编号与约 139 个用例。
- **影响范围**：`hindsight-embed/`（`hindsight_embed/ops/`、`cli.py`、`pyproject.toml`、`tests/test_ops.py` 取代 `tests/test_control_center.py`）、`hindsight-control-plane/`（`src/lib/`、`src/app/api/local/`、`src/app/[locale]/local/`、`src/components/local-settings-panel.tsx`、`src/components/bank-selector.tsx`、10 个 `src/messages/*.json`）、`hindsight-integrations/coding-agents/`、`.env.example`、`hindsight-docs/docs/sdks/embed.md`、`README.md`。
- **回归保护**：`hindsight-embed/tests/test_ops.py`（服务层、设置目录、令牌、JSON 命令面）、`hindsight-control-plane/tests/lib/local-access.test.ts`（门禁判定）、`tests/lib/ops-contract.test.ts`（真实子进程端到端契约）、`tests/messages/*`（10 语言键集一致）、`src/core/control-plane.test.ts`（并发合并、settled 重查、127.0.0.1 绑定、profile 传参）。
- **与上游差异**：上游 `hindsight-embed` 自带 7878 控制中心与 `control` 子命令；本分支以 `ops` 子命令与控制平面 `/local` 页取代，`control` 仅保留退役提示。上游 `coding-agents` 无控制平面拉起逻辑；本分支新增。


### [ADR-007] Magpie 作为统一管理入口

- **日期**：2026-11-23
- **状态**：已采纳（调整 ADR-006 的宿主入口，保留其控制平面与 ops 架构）
- **方案**：在 coding-agents/magpie 提供可独立安装的 Magpie 页面插件，构建时将宿主适配器打包为独立模块。宿主复用 embed CLI 启动 loopback 控制平面，页面保留管理入口，通过 options bridge 将显式点击交给宿主，在系统浏览器打开现有 UI。配置与记忆管理继续由同一控制平面承担。
- **DSH**：移除浏览器 bundle、client manifest、侧栏、管理命令与启动预热；保留原生记忆生命周期和记忆工具。所有 coding-agent 会话不再自动启动 UI，管理入口由 Magpie 承担。
- **边界**：不新增 HTTP 桥，不通过 Magpie web 代理本地运维，不迁移记忆采集到模型网关。首次实现支持本机桌面与本机 web；远程浏览器明确提示不支持。
- **验证**：宿主启动成功/失败、非法端口、DSH 无 client 声明、既有 DSH 记忆流程及控制平面生命周期测试。

- **沙箱兼容修正**：直接导航仍继承 iframe 的 opaque origin，实测导致 localStorage SecurityError、API CORS 失败及加载错误。保留 Magpie 沙箱与本地运维门禁，完整 UI 改在正常浏览器上下文运行；宿主持久记录点击请求，避免后续重载重复弹出。已用真实 Chromium 沙箱与 API 请求验证。

- **进程控制与独立生命周期**：Magpie 页面显示管理进程、Profile、端口、后端健康和检查时间，提供启动/停止/重启/打开操作。状态经插件自身隐藏资源目录传递，避免本地插件源码监视器因状态刷新重启宿主。操作请求以排他回执防止重载重复执行；加载插件只观测，不撤销用户的停止操作。
- **Windows 宿主退出**：Magpie 的 Job Object 会回收整个插件进程树，普通 detached 标志不足以保留管理界面。embed 在检测到 Job 绑定时通过同用户本机 WMI 创建一次性启动器，使 UI 脱离 Magpie 的 Job；无新常驻服务、无计划任务。临时环境文档在启动前删除。实测宿主退出和重载后原 UI PID 保持不变，显式停止和再启动均有效。
