# 架构决策目录

[当前运行架构](runtime.md)描述现状；下面的 ADR 解释各项选择的背景与演变。

| 决策 | 日期 | 状态与适用范围 |
| --- | --- | --- |
| [ADR-001：独立分支与个人文档](decisions/001-private-branch.md) | 2026-11-20 | 已采纳；上游对应关系另由同步记录维护 |
| [ADR-002：DSH 内嵌控制中心](decisions/002-retired-dsh-control-center.md) | 2026-11-20 | 已废弃；由 ADR-006 和 ADR-007 取代 |
| [ADR-003：推理依赖裁剪](decisions/003-inference-dependencies.md) | 2026-11-20 | 裁剪方向保留；早期默认值与删除清单已有演变 |
| [ADR-004：并发与 HTTP MCP 默认值](decisions/004-concurrency-and-mcp.md) | 2026-11-20 | 已采纳 |
| [ADR-005：仓库裁剪](decisions/005-repository-trimming.md) | 2026-11-20 | 已采纳；同步时结合裁剪边界筛选路径 |
| [ADR-006：本地运维并入控制平面](decisions/006-local-ops-control-plane.md) | 2026-11-21 | ops 架构保留；DSH 入口由 ADR-007 取代 |
| [ADR-007：Magpie 统一管理入口](decisions/007-magpie-management.md) | 2026-11-23 | 已采纳；管理进程独立生命周期 |
| [ADR-008：工作准则（Working Rules）独立子系统](decisions/008-working-rules.md) | 2026-11-24 | 已采纳；独立于 bank directives 的全局/项目准则 |

## 新增决策的格式

每项决策独立存为 `decisions/NNN-英文主题.md`，并更新上表。

```markdown
# [ADR-NNN] 决策标题

- 日期：YYYY-MM-DD
- 状态：提议 / 已采纳 / 已废弃 / 部分被替代
- 背景：需求与原有问题。
- 方案：最终选择及理由。
- 影响范围：组件、接口与配置。
- 与上游差异：后续同步需要保留或适配的内容。
- 验证依据：相关测试或实测。
- 替代关系：被哪项决策取代，或取代哪项决策。
```

验证次数、某轮测试结果及上游提交清单不在 ADR 中持续追加，分别写入同步批次或维护文档。
