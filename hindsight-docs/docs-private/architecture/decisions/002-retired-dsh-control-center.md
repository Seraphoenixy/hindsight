# [ADR-002] `daemon` 自动拉起本地控制中心与 DSH 桌面端状态页面

> 已废弃。当前管理入口与独立进程生命周期见 [ADR-007](007-magpie-management.md)。

- **日期**：2026-11-20
- **状态**：已废弃（由 ADR-006 取代：控制中心已移除，运维并入控制平面）

- **背景**：上游 `coding-agents` 在 `daemon` 模式下只拉起 `9077` API 服务，默认不启动 Control Center，且 DSH 桌面端没有直观的状态与控制界面。
- **方案**：
  - 新增 `hindsight-integrations/coding-agents/src/core/control-center.ts`，并在 `daemon-start.ts` 中随 `daemon` 启动并发拉起本地 Control Center（`7878`）。
  - 新增 `hindsight-integrations/coding-agents/src/dsh-client.ts`（通过 `package.json` 的 `./client` 与 `dsh.client.platform: "web"` 暴露），在 DSH 桌面端侧边栏注册 `Hindsight` 面板，实时展示 `9077` / `7878` / `19077` 在线状态并内嵌本地控制中心与记忆库管理页面。
  - `cordis.patch.yml` 的行名使用路径 `./dist/dsh.js`，不使用包名的 `/dsh` 子路径。原因：`@deepseek-ai/dsh-client-modules` 仅当行名能解析到包根时才为该包建立浏览器端行（`exactPackageSpecifier()` 对带子路径的 scoped specifier 返回 `undefined`），子路径会使 Host 半边正常加载而浏览器半边被静默跳过，侧栏不出现且无报错。路径型行名由 `anchorInsertedPluginNames()` 锚定为 `file://` URL，扫描时从该模块向上找到本包 `package.json`，从而读到 `dsh.client` 与 `exports["./client"]`。
- **影响范围**：`hindsight-integrations/coding-agents/src/core/control-center.ts`、`daemon-start.ts`、`dsh-client.ts`、`dsh-bundle.test.ts`、`react.d.ts`、`tsup.config.ts`、`package.json`、`cordis.patch.yml`。
- **回归保护**：`src/dsh-bundle.test.ts` 断言行名可被扫描、指向存在的 Host 入口，且客户端包只以包名注册工厂（`ClientModuleSystem.register()` 仅剥离尾部 `/client`，id 不匹配会得到无法被任何图行导入的孤立模块）。
