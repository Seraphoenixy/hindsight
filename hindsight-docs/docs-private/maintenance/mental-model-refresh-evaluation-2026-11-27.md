# 心智模型刷新改进实测（2026-11-27）

## 结果

在北京时间 16:10–16:11，工程知识与经验库的两张过期页面刷新成功，随后一次无变更刷新也成功。运行来源为用户切换的 `workbuddy/deepseek-v4.1-flash`，仍经过本机 Magpie `:3425` 代理。

后台刷新专用配置：`HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_REASONING_EFFORT=none`，`HINDSIGHT_API_MENTAL_MODEL_REFRESH_LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}`。此前测试 Trae CN 的同类关闭参数无效；新来源最小请求返回 `reasoning_tokens=0`，完整刷新操作汇总也为 0。

| 操作 | 实际执行总耗时 | 刷新计算耗时 | LLM 调用 | 输入 / 输出 tokens | 推理 tokens | 结果 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Component map | 14.7 秒 | 3.127 秒 | 2 | 24,444 / 68 | 0 | 已写入，delta |
| Key decisions and rationale | 24.4 秒 | 9.030 秒 | 2 | 25,928 / 1,782 | 0 | 已写入，delta |
| Component map，无新增事实再次刷新 | 约 0.52 秒（提交至完成） | 0.004 秒 | 0 | 0 / 0 | 0 | 保留正文，无新增事实 |

两张页面各读取 1 条变更事实，均跳过 reflect。Component map 撤回 16 条失效证据，应用 2 个编辑；本轮新事实编辑输出零操作。Key decisions 撤回 13 条失效证据，共应用 5 个编辑。无跳过的编辑，水位已推进，页面均不再过期，旧失败状态已清除。

“刷新计算耗时”来自 `result_metadata.refresh_duration_ms`，覆盖读取、撤回和补丁生成；总耗时另包含保存文档、嵌入等。两张页面的嵌入请求分别用了 11.547 秒和 15.375 秒。Key decisions 的操作曾在旧模型上排队和执行，故不能拿该操作原始 `created_at` 到 `completed_at` 的差值当作新来源执行耗时；本表按 worker 在新配置下最后一次开始执行到完成计算。

## 操作记录

- Component map：`7d8f9992-1056-4a6e-a04a-419edefc8663`。
- Key decisions：`0382906a-3406-4a59-bcdf-e58f14b7296d`。
- 无变更复测：`805ee249-d6cd-4689-a770-f324d39a6d43`。
- 旧来源失败复测：`60c2a3ea-fe1b-4e25-b0c8-73ad88bde9e4`，仍在 300 秒被取消，其中撤回调用约 155.7 秒并返回“输出全部耗在推理上”，随后编辑调用也未完成。失败响应没有报告 token，不能按 0 成本处理。

成功操作永久保留 `refresh_mode`、`refresh_duration_ms`、`llm_call_count`、输入/输出/推理 tokens、`usage_complete` 和 `delta_batches`。完整请求与操作 JSON 保存于本机 `C:/Users/chenhou/.codex/mental-refresh-review/`；该目录包含页面内容与请求正文，不提交进仓库。

## 对改进的判断

旧流程的多个完整 reflect 阶段各有 9–10 次 LLM 调用、约 4.9–5.5 万输入 token，之后还要支付撤回与编辑调用。新流程整轮为 2 次 LLM 调用、约 2.4–2.6 万输入 token；无变更窗口为零调用。原有 token 记录对失败调用不完整，因此不计算精确费用下降百分比。

代码改变和模型来源改变同时发生，不能把全部加速归因于代码。Trae CN 即使传 `none`、`thinking.disabled` 仍推理；单独修复增量路径后仍超时。Workbuddy 实测关闭推理后，撤回与编辑调用各用约 1.3–5.6 秒。

仍有可见成本：撤回和编辑各读取一次现有完整文档，所以只有 1 条新增事实时仍约 2.5 万输入 token；这不是全量历史检索重算。页面保存后的本地嵌入已经成为此次主要耗时。章节定位和减少全文嵌入不在这轮实现范围内。

## 验证

- 207 项后端检查通过，7 项需真实模型或特定运行条件的测试未启用。
- 9 项控制平面触发设置测试通过。
- 仓库 `scripts/hooks/lint.sh` 通过，保留原有未提交内容，并撤回 lint 对无关文件的格式调整。
- 按仓库 code-review 清单复核增量分页、scope 隔离、失败不推进水位、空窗口零调用、指令透传和操作成本持久化；无新增必须修复项。
- OpenAPI 已重新生成验证，输入和输出 trigger 的默认模式均为 `delta`；产物保存在实测目录。

实现决策见 [ADR-014](../architecture/decisions/014-direct-delta-refresh.md)。
