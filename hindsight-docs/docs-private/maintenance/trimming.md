# 仓库裁剪边界

本页用于判断上游改动的适用范围；原始设计理由见 [ADR-005](../architecture/decisions/005-repository-trimming.md)。历史体积统计只代表当时测量，不作为当前大小保证。

## 保留的核心组件

| 路径 | 用途 | 同步原则 |
| --- | --- | --- |
| `hindsight-api-slim/` | 记忆引擎、API、知识库 | 优先吸收正确性、性能与平台修复 |
| `hindsight-embed/` | 本地 CLI、Profile、守护进程、ops | 保留本地配置和 Windows 独立启动能力 |
| `hindsight-control-plane/` | 记忆管理及本地运维界面 | 保留 `/local` 和访问控制 |
| `hindsight-integrations/coding-agents/` | 编码代理记忆与 Magpie 插件 | 保留原生记忆集成与统一管理入口 |
| `hindsight-clients/typescript/` | 本地保留的 SDK | API 变更涉及已生成接口时同步检查 |
| `hindsight-dev/` | 保留的开发工具 | 核对脚本引用，避免重新依赖已删除目录 |
| `hindsight-docs/docs/` | 上游核心文字文档 | 按保留功能同步 |
| `hindsight-docs/docs-private/` | 个人维护文档 | 独立维护，不由上游覆盖 |

HTTP MCP 属于保留功能：包括多库 `/mcp/`、单记忆库 `/mcp/{bank_id}/`、单知识库 `/mcp/kb/{bank_id}/`、每库初始化说明及知识库搜索重排选项。默认关闭，按需启用；Coding Agents stdio MCP 同时保留。

## 已裁剪的内容

- 部署与监控：`docker/`、`helm/`、`monitoring/` 及相应辅助脚本。
- 上游流水线与发布：`.github/`、发布、基准和站点生成脚本。
- 非核心集成：coding-agents 之外的第三方集成与 `hindsight-extensions/`。
- 客户端与包装：Go、Rust、Python 客户端、Rust CLI、all 系列包装和非核心元包。
- 大型验证资源：`hindsight-system-tests/`、`hindsight-system-evals/`、`hindsight-integration-tests/`。
- 文档站点资源：Docusaurus 构建、侧边栏、博客、指南、版本快照、多媒体、站点生成资源。

这些目录中的上游提交通常跳过。若同一提交也修改保留组件，只过滤已裁剪路径，不因此漏掉核心修复。反之，不因引入测试或文档而整批恢复依赖链。

## 运行依赖的边界

- 不恢复 Python 内置 PyTorch、SentenceTransformers、ONNX 或 llama-cpp-python 模型栈。
- `local` 现在可以表示托管的原生 llama.cpp；不能仅凭 Provider 名称认定旧模型栈已恢复。
- `cloud` extra 与默认安装分开；存储惰性导入边界需要保留。
- 视频处理仍需要用户另行安装 PyAV；本轮验证安装过 `av`，没有将其加入默认运行依赖。
- 测试需要额外依赖时，优先使用适当测试替身或测试环境安装，不为通过测试恢复重型运行依赖。

## 同步时必须检查

1. 新增依赖是否重新引入被裁剪模型栈或云端库。
2. 测试与构建脚本是否引用已删除包、文档生成器或资源。
3. 配置变动是否覆盖 `2/1/1` 并发、HTTP MCP 默认关闭或 Magpie 独立生命周期。
4. 是否将旧 DSH 侧栏、7878 控制中心或会话自动启动界面重新带回。
5. 被过滤测试覆盖的能力是否已由保留测试验证；未验证的限制写入同步批次。
