# ADR-014：心智模型直接消费增量事实

- 日期：2026-11-27
- 状态：已采纳
- 背景：普通 delta 刷新先运行多轮 reflect 并生成候选文档，再把本轮事实交给另一个 LLM 生成编辑操作。候选正文不会传给编辑模型，重复生成增加耗时与 token。旧的快速路径依赖特定 decision provider，超过 200 条变化又退回 reflect。
- 方案：delta 默认直接按 `(updated_at, id)` 分页读取 scope 时间窗口内的变更；每个编辑批次最多 200 条事实，并按约 4096 个事实 token 拆分。每批编辑前一批的结果，全部成功后才保存文档和时间水位。单条超大事实独立处理，提示仍无法完整容纳时拒绝刷新，不能截断后推进水位。
- 默认策略：普通 mental model 与控制平面表单默认 delta；首次生成、主题改变、全部证据消失或显式 full 仍走完整重建。自动刷新默认最小间隔 300 秒，显式刷新不等待，模型可用 0 关闭间隔。
- 观测：刷新响应补充 `usage`、`llm_call_count`、`delta_read` 与 `delta_batches`，编辑、撤回及结构修正重试纳入汇总；启用 `keep_trace` 后包含这些调用的时间线。底层 provider 重试和失败请求的实际费用仍以操作关联的 LLM 请求记录为准。
- 影响范围：MemoryEngine、memories store 的窗口分页接口、编辑调用计量、模型默认触发策略与控制平面表单。
- 与上游差异：`MENTAL_MODEL_DELTA_USE_DECISION_MODEL` 保留配置兼容但不再控制 delta 路径；`MENTAL_MODEL_DELTA_GATE_MAX_MEMORIES` 改为数据库页大小与每批事实数量上限。不能列举窗口的 store 暂保留原 reflect 路径。
- 验证依据：直接增量、同时间戳分页、跨批失败原子性、空窗口零调用、指令透传、调用计量及原有 delta/dry-run 回归测试。真实操作的测量结果单独记录，不作为 ADR 的永久性能承诺。
- 替代关系：替代旧的 decision-model delta gate；全量 reflect 和独立撤回检查保留。
