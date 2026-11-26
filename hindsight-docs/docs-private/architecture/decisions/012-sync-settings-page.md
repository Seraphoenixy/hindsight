# [ADR-012] 多端同步设置独立成页

- **日期**：2026-11-26
- **状态**：已采纳
- **背景**：多端同步的设置原先混在控制平面 `/local` 的“同步”标签页里，包含两部分：登录中继（relay URL + 主密码，直连 daemon 的 `/v1/default/sync/connection`）和三个环境项（状态目录、自动同步、检查间隔，写入 profile `.env`）。这带来四个问题：
  1. `/local` 的设计前提是“本地服务停止时也能用”，而登录必须 daemon 在运行，页面在该场景下只能报错；
  2. 同一页里一半改动即时生效（登录）、一半要重启（环境项），保存后没有提示；
  3. 因为复用泛化的 `save-settings`，本地表单持有并接受它不再展示的同步键；
  4. `/sync` 本来就是同步的专属页（状态、冲突、设备），配置却不在那里。
- **方案**：
  - **目录拆分**：`ops/settings.py` 的 `SETTING_GROUPS` 只保留本地设置；同步的三个字段移入 `SYNC_SETTING_GROUP`。`save-settings` 只接受本地键，新增的 `save-sync-settings` 只接受同步键，两条写路径互相拒绝对方的键（测试覆盖）。
  - **独立命令与路由**：新增 `hindsight-embed ops sync-settings`（读）与 `save-sync-settings`（stdin 写），控制平面对应 `/api/local/profiles/<profile>/sync-settings`。两者仍走同一套 loopback + ops token 门禁。
  - **`/sync` 成为唯一入口**：页面服务端按 loopback 判定注入 ops token（非 loopback 部署不注入），客户端渲染“同步服务端”卡片（登录）、“同步设置”卡片（三个环境项）以及原有的状态/冲突/设备面板。
  - **`/local` 删除同步标签页**：`Tab` 类型、标签列表、渲染块、`syncPort` 与同步字段选择全部移除；仍保留 `group.id !== "sync"` 的过滤，以兼容旧 CLI 返回的合并目录。
  - **保留 ADR-009 的运行期约束**：登录仍由运行中的 daemon 完成（PAKE、设备凭据、唤醒调度器）。daemon 停止时 `/sync` 不再渲染连接表单，而是明确说明“登录不可用；下方设置仍可保存，下次启动生效”。旧 CLI 没有新命令时，页面回退到 `settings`/`save-settings` 读取同步组，功能不中断。
- **影响范围**：`hindsight-embed/hindsight_embed/ops/{settings,service,cli}.py`、`hindsight-embed/tests/test_ops.py`、`hindsight-control-plane/src/lib/{ops,local-api}.ts`、`src/app/api/local/profiles/[profile]/sync-settings/route.ts`、`src/app/[locale]/sync/page.tsx`、`src/components/{sync-view,sync-settings-panel,local-settings-panel}.tsx`、`tests/components/sync-settings-panel.test.tsx`、`tests/lib/ops-contract.test.ts`。
- **与上游差异**：上游没有本分支的 `ops` 命令面，也没有把同步设置独立成页；同步时不把本决策带入上游 UI 结构。
- **验证依据**：`test_ops.py`（同步组不在本地目录、两条写路径互斥、同步组独立读写）、`sync-settings-panel.test.tsx`（只提交改动字段、走 `/sync-settings` 端点、携带 ops token）、`ops-contract.test.ts`（真实子进程的文档形状）。构建后 `/sync` 与 `/local` 均通过 `next build`。
- **替代关系**：补充 ADR-006（本地运维归属）与 ADR-009（同步是 daemon 能力）；不改变 ADR-011 的读路径决策，`/sync` 不参与页面级快照。
