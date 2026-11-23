# [ADR-006] 移除 `hindsight-embed` 控制中心，本地运维并入控制平面

> 本决策的控制平面与 ops 分工仍有效；DSH 面板及 7879 入口已由 [ADR-007](007-magpie-management.md) 移除。下文的 DSH 内容描述当时实现。

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
