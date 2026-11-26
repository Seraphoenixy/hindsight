# [ADR-011] 本地设置页读路径：按成本分组的快照读取

- **日期**：2026-11-26
- **状态**：已采纳
- **背景**：ADR-006 让控制平面通过 `hindsight-embed ops` 子进程执行本地运维，理由是生命周期操作依赖平台特定的进程管理，Node 重写会重现上游缺陷。这个理由对启停、杀端口进程成立，但页面把读操作也放进了同一条冷路径：`/local` 首屏要发 9 次调用（1 次 `profiles` 加 8 次并发 section），每次调用一个解释器加管理器导入，实测底噪 0.42–0.47 s；`local-models` 与 `embedding-check` 因为导入 `hindsight_api.engine` 达到 1.6–2.3 s。前端又把“快速配置”骨架屏绑在全部 8 个请求的 `Promise.all` 上，本机实测要 2.8–3.2 s 才显示有效配置。同时，`READ_CACHE_MS = 2000` 短于 4 s 的健康轮询，对轮询和首屏都不命中，缓存实际只在同一毫秒内的重复请求生效；任何写操作又会清空整表。
- **方案**：
  - **新增复合读命令**：`hindsight-embed ops snapshot [--include a,b,...]`，在一个进程里组装多个只读文档，返回 `{profile, sections, errors}`。section 目录集中在 `ops/service.py` 的 `SNAPSHOT_SECTIONS`，CLI 只负责路由与参数解析；不带 `--include` 时读取全部 section。单个 section 抛错写进 `errors`，不影响其它 section，退出码仍为 0（请求本身成功）；未知 section 或空 `--include` 是用法错误（退出码 2）。
  - **控制平面只发两次请求**：首屏用 `LOCAL_SNAPSHOT_CORE`（`config`、`settings`、`env`、`paths`、`reembed-status`，全是文件读），实测 0.44–0.46 s；第二组用 `LOCAL_SNAPSHOT_DIAGNOSTICS`（`health`、`local-models`），在表单可用之后异步加载。分组依据是**最坏情况成本**，不是面板归属：`health` 是带 2 s 超时的 loopback 探针，daemon 停止时它就是最慢的一段（实测 2.7 s），而页面恰恰要在这种时候还能打开；`local-models` 需要导入记忆引擎。
  - **`embedding-check` 不进入自动加载**：它要连数据库，且在实例 `postmaster.pid` 缺失时会 `pg_instance.start()` 再 `stop()`。2026-11-26 的验证中，一次由页面触发的检查之后，正在运行的 daemon 数据库失联（`~/.pg0/instances/...` 的 `start.log` 时间戳与该次调用吻合）。页面改为在打开“设置”标签页（以及每次保存、每次启动重建）时按需检查：那里才是维度不匹配需要提醒的地方。页面加载不允许有起停数据库的能力。
  - **兼容旧 CLI**：控制平面与 embed 可分别固定版本，新页面可能遇到没有 `snapshot` 子命令的 CLI。此时快照路由返回用法错误，页面回退到原有逐 section 路由（`loadSectionsLegacy`），慢但可用。新页面不依赖新 CLI。
  - **失败可解释**：快照的 `errors` 逐 section 返回，页面把首个失败显示为 `section: message`；不再把“未加载”和“失败”都折叠成 `null`。
  - **不引入常驻服务**：保留 ADR-006 “不重写平台进程管理”的边界，只把一次页面渲染的进程数从 9 降到 2。常驻 ops helper 作为备选保留，触发条件见下。
- **影响范围**：`hindsight-embed/hindsight_embed/ops/{service,cli}.py`、`hindsight-embed/tests/test_ops.py`、`hindsight-control-plane/src/lib/{ops,local-api}.ts`、`src/app/api/local/profiles/[profile]/snapshot/route.ts`、`src/components/local-settings-panel.tsx`、`tests/lib/ops-contract.test.ts`。
- **与上游差异**：上游 `hindsight-embed` 没有 `ops` 子命令，也没有 `snapshot`；同步时不要把 `SNAPSHOT_SECTIONS` 与上游 CLI 的改动混在一起，它是本分支控制平面的读模型。
- **验证依据**：`hindsight-embed/tests/test_ops.py`（section 顺序、默认全集、单 section 失败隔离、未知/空 `--include`）与 `hindsight-control-plane/tests/lib/ops-contract.test.ts`（真实子进程返回的文档形状、用法错误）。本机实测（daemon 健康）：首屏约 1.26 s（`profiles` 590 ms 加核心快照 674 ms），`profiles` 命中 2 s 缓存时约 0.60 s；健康态 `embedding-check` 单独调用仍需约 2.2 s，现在只在需要时发生。剩余成本：`profiles` 会探测每个 profile 的 daemon，DB 失联时约 1.5 s，属于同一问题的下一层。
- **后续触发条件**：
  - 若首屏预算需要收紧到 300 ms 以内，或本地页面的交互频率显著上升（每次交互仍是一个冷进程），再评估常驻 ops helper；它必须是控制平面的私有子进程，只监听 loopback 并复用同一令牌门禁，不新增用户可见入口。
  - 健康轮询（4 s）与日志轮询（2 s）目前仍是每次一个冷进程，属于同一问题的剩余部分；若改为浏览器直连 daemon 或纳入热路径，应另立决策。

## 替代关系

补充 ADR-006 的调用链：生命周期与写操作仍走子进程，只读的页面投影改为一次快照。ADR-006 关于“不在 Node 中重写平台进程管理”和“访问门禁”的结论不变。
