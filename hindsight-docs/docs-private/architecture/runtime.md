# 当前运行架构

## 组件职责

| 组件 | 职责 | 主要实现 |
| --- | --- | --- |
| coding-agents | 编码代理记忆采集、检索与 stdio MCP 工具 | `hindsight-integrations/coding-agents/src/` |
| Magpie 插件 | 状态显示、启动、停止、重启、打开管理界面 | `src/magpie.ts`、`src/core/magpie-process.ts`、`hindsight-integrations/magpie/page/` |
| 控制平面 | 记忆库界面及 `/local` 本地设置 | `hindsight-control-plane/` |
| embed CLI | Profile、配置和进程生命周期的统一实现 | `hindsight-embed/hindsight_embed/` |
| API | retain、recall、reflect、知识库及后台任务 | `hindsight-api-slim/` |
| Linux 同步中继 | v3 对象级同步中继，维护因果对象日志、SHA-256 附件与设备凭据 | `hindsight-sync-server/` |

启用多端同步后，每台设备继续使用本地 PostgreSQL。Linux 中继与记忆 API 独立部署，后台调度器与
`hindsight-admin sync` 按对象级增量日志与内容寻址附件同步变更。部署和冲突处理见 [Linux 记忆库同步服务](../maintenance/linux-sync.md)。

表中 `src/` 与 `magpie/` 简写相对于 coding-agents 包。

## 本地管理调用链

1. Magpie 页面通过 options bridge 传递显式操作，宿主调用 embed CLI。
2. 完整控制平面在系统浏览器打开；Magpie 沙箱页面保留进程状态与控制按钮。
3. 控制平面 `/local` 通过服务端 `src/lib/ops.ts` 调用 `hindsight-embed ops`，不在 Node 中重写平台进程管理；页面读模型用一次 `ops snapshot` 按 section 分组取回（诊断类后置），写操作仍逐条调用。
4. 本地运维路由验证 loopback Host、Origin 与 ops token；令牌不能通过公开 GET 接口获取。
5. 多端同步的配置入口是 `/sync`：登录由运行中的 daemon 完成，状态目录/自动同步/检查间隔由 `ops sync-settings` 写入 profile `.env`；`/local` 不再包含同步标签页。

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
| HTTP MCP | 保留功能，默认关闭；支持多库、单记忆库和单知识库端点，coding-agents 的 stdio MCP 同时保留 |
| 记忆嵌入 | `local`，由原生 llama.cpp 服务提供；不是原先的 Python 模型栈 |
| 记忆重排 | `rrf` |
| 决策模型 | 默认关闭。启用后，召回、整合初筛、Reflect 和页面刷新共享决策客户端实现 |
| 知识库 | 默认关闭；嵌入默认 `text` |
| 知识库文本分段 | `512` tokens，随 2026-11-23 上游移植调整 |
| 云端依赖 | `boto3`、`litellm`、`obstore` 为可选 cloud extra |

配置的事实来源为 `hindsight-api-slim/hindsight_api/config.py`；Provider 行为以 `engine/embeddings.py`、`engine/cross_encoder.py` 和 `engine/providers/` 为准。Profile 环境变量可覆盖默认值。

心智模型默认 delta：直接分页读取上次水位之后的事实，按批生成结构化编辑，跳过多轮 reflect 与候选正文生成。自动刷新默认合并间隔为 300 秒，显式刷新立即执行；首次生成与 full 模式仍运行 reflect。见 [ADR-014](decisions/014-direct-delta-refresh.md)。

本地设置可选 Antigravity 作为 API 的 LLM 后端。服务进程通过同一系统用户已登录的 `agy` 执行模型调用。Antigravity 编码代理的记忆 hook 仍走 Coding Agents 集成。

HTTP MCP 通过 `HINDSIGHT_API_MCP_ENABLED=true` 启用；知识库工具还需 `HINDSIGHT_API_ENABLE_KB=true`。每库 `mcp_server_instructions` 配置连接初始化说明（最多 4000 字符），知识库搜索可通过 `enable_reranking` 覆盖服务端默认值。

## 工程知识与经验

Coding Agents 默认使用按项目隔离的共享库。项目身份取自主仓库目录名（Unicode NFC、转小写，
标签和文档 ID 使用 URI 编码），不含本地路径短校验。同名工作区跨机器共用项目身份；用户负责
为不等价的工作区命名不同名称。Linked worktree 仍取主仓库名。项目页面文件夹只显示归一化名称。
既有带路径短码的标签、文档 ID 和页面目录不会自动重写，其内容仍可通过跨项目查询或管理界面访问。
对话写入通过 `conversation` 策略由服务端提取有来源的工程结论，允许普通任务产出零条。
项目决策、约束和具体修复归为世界事实。同一次排障中，已验证且能指导后续诊断、验证或改用替代方案的方法
可以另存为经历，记录适用条件、方法和验证依据。同一结论只保留一次。
`hindsight_ingest_document` 从显式提交的文档提取有依据的知识。默认关闭后台代码巡检、
Git 历史导入和历史会话导入。

共享模式下，宿主 Stop Hook 通过现有异步 retain API 提交已完成的对话片段并立即返回。服务端把
提取和写入登记为后台 retain 操作，供 worker 执行。模型较慢时不再占用 Hook 的 30 秒时限；
操作可在活动列表查看状态，失败后可从操作记录重试。相同会话片段使用幂等操作 ID，
重送不会登记第二个任务。

Coding Agents 的自动注入只走检索路径：`autoInject` 默认 `recall`（可选 `pages`、`none`），
在首个提示注入一次，不调用子 LLM。`hindsight_reflect` 仍是显式工具，调用时使用服务端子 LLM，
不参与自动召回；页面刷新、consolidation 与 retain 提取属于后台记忆维护。
服务端默认关闭重排（`enable_reranking: false`），召回直接使用 RRF 融合顺序，
跳过 cross-encoder 和 recall decision model。显式启用重排后才使用对应服务端模型配置。

事实时间区分 `mentioned_at`（来源提及时间）与 `occurred_start/end`（事件发生范围），
召回工具与自动注入均透传。会话写回保留各轮来源时间，提取按来源支持的精度记录已确认决策、
变更和验证事件；未知时间保留为空，不以入库时间补齐。明确的旧值、新值、适用范围与替代时间
保存在结论中；发生时间不等于规则有效期，也不凭较新的记录时间自动归档旧事实。

实体列表、详情、关系图和实体时间线统一从当前可见记忆统计：包含直接关联的事实，以及通过
来源事实继承实体的 Observation。没有可见关联的注册实体不计入页面总数。对象同步拉取、
重建基线、冲突应用和冲突恢复会在事务内按每批受影响库重建本地实体计数与共现缓存；
这些内部缓存保留直接 postings 的口径，页面不再将缓存当作实时统计。

工程共享库默认启用按结论合并 Observation。后台合并在当前项目范围内比较已有结论，
把支持同一决策、约束或排障经验的事实合成一条，后续同主题补充更新原条目。
常规实现过程可以跳过，适用版本或条件不同的规则分别保留。配置项
`consolidation_group_by_conclusion` 支持库级设置和 scope 策略覆盖。现存 Observation
如需重新生成，可以从保留的原始事实执行 Observation 重建。

Control Plane 的“AI 整理记忆”页面按当前库、可选项目标签、主题和用户指令召回事实并生成整理预览。
预览包含原文与新结论，用户勾选后才执行重写、归档或合并。应用和撤销都会重新检查记录版本，
归档记录保留原内容并退出默认召回。宿主 Agent 只额外获得 `hindsight_recall` 和
`hindsight_edit_memory`：前者直接召回世界/经历事实，后者在用户明确要求后用召回时的原文与状态
校验版本，并执行重写、归档或恢复。AI 批量生成整理计划仍只在 Control Plane 中运行。

## 工作准则（Working Rules）

Working Rules 独立于按库隔离的 `directives`（后者仅用于服务端 `reflect`），存储全局（`global`）及项目级（`project`）持久行为准则，对应数据表 `working_rules`（Alembic 迁移 `e7a1b2c3d4f5`）与服务接口 `/v1/default/working-rules`。

- 容量与固定预算由 `HINDSIGHT_API_WORKING_RULES_LIMIT_BYTES`（默认 `14336`）、`HINDSIGHT_API_WORKING_RULES_PINNED_LIMIT_CHARS`（默认 `3072`）与 `HINDSIGHT_API_WORKING_RULES_ENTRY_MAX_BYTES`（默认 `8192`）控制。超出总量时仅归档非固定条目（`is_archived = TRUE`，`archive_reason = 'capacity_overflow'`），不会自动转存为记忆库事实。
- 同一租户的规则写入在事务中串行执行，容量和正文去重基于锁内的规则状态。PostgreSQL 迁移 `f42c9a8e613b` 会移除限制规则正文长度的旧索引。
- PostgreSQL 整库备份包含工作准则。恢复旧备份时保留目标库已有规则。
- 服务端数据库与 Control Plane 全局页 `/[locale]/working-rules` 为唯一管理入口；不维护本地 Markdown 双写文件，仅通过 `/v1/default/working-rules/export` 按需导出 Markdown。已归档条目可在 Control Plane 中恢复（Restore）或显式转存到指定记忆库（Promote）。
- Control Plane 提供“AI 整理”页签，调用 `/organize/preview` 与 `/organize/apply`。应用时在同一事务中校验 `expected_revision` 并执行选中的提案。
- Coding Agents 在 `SessionStart` 注入按 `project_id` 和 Git 分支过滤后的规则。后续提示钩子在投影 `revision` 变更时注入替代规则块，也会明确清除已变为空的规则集。MCP/DSH 暴露 `hindsight_working_rules` 与 `hindsight_manage_working_rules`。

详见 [ADR-008：工作准则独立子系统](decisions/008-working-rules.md)。
