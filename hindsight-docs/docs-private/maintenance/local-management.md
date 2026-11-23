# 本地管理排障

当前组件分工见[运行架构](../architecture/runtime.md)，用户安装入口见 [Magpie 插件说明](../../../hindsight-integrations/coding-agents/magpie/README.md)。以下保留已实测的故障原因与处理边界。

## Magpie 显示 “This page couldn’t load”

Magpie iframe 使用 `sandbox="allow-scripts"`，没有同源权限。即使把页面导航到本地 Next.js，仍继承 opaque origin，可能触发 localStorage SecurityError 与 API CORS 失败。

完整控制平面通过系统浏览器打开；插件页负责状态与操作。排查时不要通过放宽沙箱、CORS 或暴露 ops token 绕过问题。

相关实现：coding-agents 的 `src/core/management-browser.ts`、`magpie/page/boot.js`。

## `/local` 提示 hindsight-embed 无法启动

仅有 `hindsight-embed.exe` 名称并不保证控制平面进程的 PATH 可以找到它。

1. 检查管理界面的启动环境是否设置了正确的 `HINDSIGHT_CP_EMBED_COMMAND`。
2. 从 embed 启动界面时，默认传入当前 Python 解释器与 `-m hindsight_embed.cli`；自定义命令优先。
3. 控制平面还会查找 `VIRTUAL_ENV` 和祖先目录中的 `.venv`；不能只按 Next standalone 的当前目录判断仓库位置。
4. 使用 `/api/local/profiles`、配置与健康请求验证实际调用成功，同时保留访问门禁。

相关实现：`hindsight-control-plane/src/lib/ops.ts`、embed 的 `daemon_embed_manager.py`。

## Magpie 重载后管理进程消失

Windows 下 Magpie 的 Job Object 会回收宿主进程树，普通 detached 标志不足以保留 UI。检查 embed 是否经过 `_ui_broker.py` 的 WMI 启动路径。

- 验收标准是 UI 在 Magpie 宿主退出后仍保持原 PID 且健康，而不是简单要求 `IsProcessInJob` 返回 false；WMI 自身也可能使用 Job。
- 一次性启动器使用 Windows PowerShell 5，创建时使用 `CREATE_NO_WINDOW`。实测再叠加 `-WindowStyle Hidden` 会挂起，不能无验证地恢复该组合。
- 环境数据通过临时 JSON 传递，辅助进程读取后先删除再启动 UI，不能把凭据拼进 argv。
- 原生 Windows 终止使用 OpenProcess、TerminateProcess 和 WaitForSingleObject 等 API，避免旧 `os.kill(pid, 0)` 路径的兼容问题。

## 插件宿主反复重启或操作重复执行

- 状态文件必须位于插件隐藏目录 `magpie/page/.runtime/state.js`；普通可见文件会触发 Magpie 的递归源码监视器，造成重载循环。
- 显式操作通过 `~/.hindsight/magpie/requests/` 的排他回执去重；重载不应重放启动、重启或打开浏览器请求。
- 重载只探测，不自动启动；用户显式停止后应继续保持停止状态。

相关实现：coding-agents 的 `src/core/magpie-process.ts` 与 `src/magpie.ts`。

## 验证范围

插件行为使用 coding-agents 的 magpie、magpie-process、management-browser 和 control-plane 定向测试；Windows 启动与终止使用 embed 的 ui-broker 与 embed-manager 定向用例。生命周期问题还需在真实 Magpie 宿主验证退出、重载、停止和重启。

完整测试路径及安装命令以相应包说明为准；每轮结果写入对应同步批次。纯文档分类调整只需检查链接、内容迁移与差异，不默认运行代码测试。
