# 当前运行架构

## 组件职责

| 组件 | 职责 | 主要实现 |
| --- | --- | --- |
| coding-agents | 编码代理记忆采集、检索与 stdio MCP 工具 | `hindsight-integrations/coding-agents/src/` |
| Magpie 插件 | 状态显示、启动、停止、重启、打开管理界面 | `src/magpie.ts`、`src/core/magpie-process.ts`、`magpie/page/` |
| 控制平面 | 记忆库界面及 `/local` 本地设置 | `hindsight-control-plane/` |
| embed CLI | Profile、配置和进程生命周期的统一实现 | `hindsight-embed/hindsight_embed/` |
| API | retain、recall、reflect、知识库及后台任务 | `hindsight-api-slim/` |

表中 `src/` 与 `magpie/` 简写相对于 coding-agents 包。

## 本地管理调用链

1. Magpie 页面通过 options bridge 传递显式操作，宿主调用 embed CLI。
2. 完整控制平面在系统浏览器打开；Magpie 沙箱页面保留进程状态与控制按钮。
3. 控制平面 `/local` 通过服务端 `src/lib/ops.ts` 调用 `hindsight-embed ops`，不在 Node 中重写平台进程管理。
4. 本地运维路由验证 loopback Host、Origin 与 ops token；令牌不能通过公开 GET 接口获取。

常用本地配置为 API `9077`、控制平面 `19077`、Profile `coding-agent`。这些是本地集成常用值，具体实例仍以插件选项、Profile 与进程状态为准，不与通用 API 开发端口混淆。

## 生命周期

- 管理进程独立于 Magpie，宿主退出或重载后继续运行。
- 插件重新加载时只观察状态，不自动撤销用户的停止操作。
- Windows Job Object 环境下，由 embed 的 `_ui_broker.py` 经本机同用户 WMI 创建一次性启动器；不安装服务或计划任务。
- DSH 只保留原生记忆集成，不再提供管理侧栏、客户端 bundle 或管理启动入口。
- 编码代理会话启动不自动启动管理界面。

设计理由见 [ADR-006](decisions/006-local-ops-control-plane.md) 与 [ADR-007](decisions/007-magpie-management.md)。

## 默认配置与依赖

| 项目 | 当前值或行为 |
| --- | --- |
| 全局 LLM 并发 | `2` |
| retain / consolidation LLM 并发 | 分别为 `1` / `1` |
| HTTP MCP | 默认关闭；coding-agents 的 stdio MCP 独立保留 |
| 记忆嵌入 | `local`，由原生 llama.cpp 服务提供；不是原先的 Python 模型栈 |
| 记忆重排 | `rrf` |
| 知识库 | 默认关闭；嵌入默认 `text` |
| 知识库文本分段 | `512` tokens，随 2026-11-23 上游移植调整 |
| 云端依赖 | `boto3`、`litellm`、`obstore` 为可选 cloud extra |

配置的事实来源为 `hindsight-api-slim/hindsight_api/config.py`；Provider 行为以 `engine/embeddings.py`、`engine/cross_encoder.py` 和 `engine/providers/` 为准。Profile 环境变量可覆盖默认值。
