# [ADR-013] Agent 召回不经过子 LLM

- **日期**：2026-11-26
- **状态**：已采纳
- **背景**：Coding Agents 的 hook 默认 `autoInject: "reflect"` 在首个提示执行一次低预算 reflect。该路径包含检索、决策模型证据判定、多轮工具调用和 closing 合成，全部依赖子 LLM。20 秒的 hook 预算无法覆盖该链路：低预算仍允许 5 轮迭代（`reflect_max_iterations=10 × 0.5`），实测 `工程知识与经验` 上一次低预算 reflect 为 151.9 秒，其中检索工具 0.883 秒、LLM 151 秒；同一库的 recall 为 0.227 秒，其中 embedding 0.211 秒、DB 与 RRF 融合 0.02 秒。结果是提示进入模型前固定增加约 20 秒，随后降级到页面/召回回退。
- **方案**：
  - 自动注入只允许检索源：`autoInject` 默认改为 `"recall"`，可选 `"pages"`、`"none"`；删除 `"reflect"` 值。
  - 移除 hook 内的 reflect 分支、失败回退和 reflect 专属诊断；`reflectTimeoutMs` 降级为 `reflectToolTimeoutMs` 的兼容别名，不再约束注入。
  - 旧配置中的 `autoInject: "reflect"` 迁移为 `"recall"` 并记录警告；`autoReflect: true` 同样迁移为 `"recall"`。
  - 显式 `hindsight_reflect` 工具保留：由 Agent 主动调用，使用服务端子 LLM，工具超时 330 秒；它不属于自动召回路径。
  - 页面刷新、consolidation、retain 提取仍可使用 LLM，它们属于后台记忆维护，不参与会话召回。
  - 服务端默认 `enable_reranking: false`、`reranker_provider: "rrf"`。未显式开启重排的召回跳过 cross-encoder 与 recall decision model，直接使用 RRF 融合顺序；全局决策模型配置不改变该默认路径。
  - Agent 客户端对自动注入与显式事实召回统一筛选：语义相似度至少 0.5 或有关键词命中，排除仅由图关系带入的候选；按语义相似度、关键词分数和记录时间排序后再应用数量限制。阈值可通过 `recallOptions.min_scores.semantic` 调整，不适用于未评估的 embedding 模型；显式召回候选预算为 12,000 tokens。
  - 自动注入保留 memory ID 与记录时间，指引要求区分历史默认值与当前代码/有效配置。记录时间不代表有效期；不自动改写或归档历史事实，不引入 LLM 冲突判定。
- **影响范围**：`hindsight-integrations/coding-agents/src/core/{config,hook,page-injection,session-start,runtime}.ts`、相关测试、README 与生成的 skill；`reflectTimeoutMs` 的运行时语义；默认注入行为。
- **配置覆盖**：默认关闭重排。环境、租户或库配置可显式设为 `enable_reranking: true`；此时服务端使用配置的 reranker 或 recall decision model。recall decision model 启用时会替换 reranker，因此单独配置 `rrf` 不能保证该显式重排路径不调用子 LLM。
- **与上游差异**：移除上游的 hook reflect 自动注入与 `autoInject: "reflect"` 模式；保留上游显式 reflect 工具和后台页面刷新。
- **验证依据**：`hook.test.ts`、`config.test.ts`、`runtime.test.ts`、`hook-lifecycle.test.ts` 通过；本机 `codex-hook.js` 对真实库执行一次注入耗时 680 ms，返回 `<hindsight_memory>` 召回块，未调用 reflect；`autoInject: "reflect"` 配置迁移测试覆盖；构建后的 `dist` 已同步到已安装运行时。
- **替代关系**：不改变 ADR-011 的读取分组与 ADR-012 的同步页面；取代 hook 内部以 reflect 作为默认注入源的设计。
