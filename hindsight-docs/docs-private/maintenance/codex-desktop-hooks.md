# Codex Desktop 的 hook 注入与记忆写入排查

日期：2026-11-26
对象：`hindsight-integrations/coding-agents` 的 `codex` harness；本机 Codex Desktop `26.1120.50957`、内置 `codex-cli 0.171.0-alpha.13.2`。

## 结论

1. Codex Desktop 的插件与 hook 是两条独立的注入路径：插件在会话启动时静态装配技能、MCP 服务器和可选的 hook 清单；用户 hook 由 `~/.codex/hooks.json` 提供，按事件逐次启动进程。
2. “会话结束不写记忆”的主因不是 retain 代码，而是 **Codex 的 hook 信任门**。非 managed hook 未经过 review/trust 时会被整体跳过，命令不执行、不报错、也不产生任何 Hindsight 日志。
3. 次因是事件选型。安装器只注册了 `Stop`，而 Codex 的 `Stop` 是“单轮结束”，不是会话结束；真正表示主线程结束的是 `SessionEnd`，当前完全没有注册。
4. 第三层是失败不可见。`runRetainHook` 在缺少 `transcript_path`、bank 解析失败等路径上直接 `return`，不写 diag；`SessionEnd` 又只有 1 秒（上限 3 秒）的同步预算，未来接入不能直接跑完整 retain。

## 1. Codex Desktop 的两套注入机制

### 1.1 插件（plugin）

- 在 `~/.codex/config.toml` 中以 `[plugins."<name>@<marketplace>"]` 启用，例如 `[plugins."unified-computer-use@openai-bundled"]`。
- 插件缓存位于 `~/.codex/plugins/cache/<marketplace>/<name>/<version>/`，清单是 `.codex-plugin/plugin.json`。
- 清单可以声明 `skills`、`mcpServers`、`hooks`。`hooks` 可以是路径、路径数组或内联对象；默认回退到插件根目录的 `hooks/hooks.json`。
- 装配发生在会话启动时，属于“能力注入”：技能目录、MCP 连接、hook 注册。没有“每轮回调”这类常驻机制。
- 插件自带的 hook 同样需要 review/trust；插件更新改动脚本后会重新要求 review。`unified-computer-use` 就是通过清单注册 `Stop`、`SubagentStop`、`Interrupt` 的 `mcp_tool` hook 做回合清理。

### 1.2 用户 hook（本项目使用的方式）

- 位置：系统级（Windows 为 `%ProgramData%\OpenAI\Codex\hooks.json`）、用户级 `$CODEX_HOME/hooks.json`（默认 `%USERPROFILE%\.codex\hooks.json`）、受信任项目的 `.codex/hooks.json`。
- 开关：`[features] hooks = true`；`codex_hooks` 是旧别名。
- 本项目安装器写了三条用户 hook：`SessionStart`、`UserPromptSubmit`、`Stop`。

官方事件语义与本项目的对应关系：

| 事件 | 触发时机 | 本项目是否注册 |
| --- | --- | --- |
| `SessionStart` | 会话或子代理开始 | 是 |
| `UserPromptSubmit` | 每次提交用户提示 | 是 |
| `Stop` | **单轮**结束（可返回 `decision: "block"` 继续该轮） | 是 |
| `SessionEnd` | **主线程结束**：归档/删除仍打开的会话、Codex 正常退出，或会话在无客户端连接下空闲 30 分钟 | **否** |
| `Interrupt` | 主线程中断当前轮 | 否 |

关键限制（官方文档）：

- 非 managed hook 必须逐条 review/trust。Codex 按 hook 当前哈希记录信任；新增或改动会被标记为待审核并跳过。
- CLI 用 `/hooks` 审核；Desktop 在输入框选择 **Review hooks**，或打开 **Settings > Hooks**。
- 普通 hook 默认 600 秒超时；`SessionEnd` 和 `Interrupt` 默认 1 秒、上限 3 秒，且强制同步执行。
- 会话结束时，Codex 会取消尚未完成的 background hook；因此“后台异步 hook”不能作为会话收尾的唯一保障。

## 2. 本机实测证据

### 2.1 配置现状

- `~/.codex/hooks.json` 与 11-20 的备份逐字节一致（SHA256 `E42530D2…B901`），说明内容没有在近期被改写。
- 本机找不到任何 hook 信任记录（`hooks.json.hook-trust`、`hook-trust.json`、状态库里都没有）。
- `[features] hooks = true` 已设置；MCP 服务正常启动（`[codex] control plane ready`）。

### 2.2 A/B 实验（决定性）

同一个 `hooks.json`、同一个 `codex.exe`、同一份配置，只改变信任开关：

```text
# 默认（需要已持久化的 hook 信任）
codex exec -C D:\tmp\hooks-probe --sandbox read-only --skip-git-repo-check "Reply with exactly OK"
→ 6.5 秒完成，没有任何 hook 输出
→ %TEMP%\hindsight-codex 无新文件；diag.jsonl 增量 0 字节

# 绕过信任（仅用于自动化）
codex exec ... --dangerously-bypass-hook-trust "Reply with exactly OK"
→ 终端依次打印 hook: SessionStart / UserPromptSubmit / Stop（各含 Completed）
→ 生成 01a216a5-…-hooks-probe.json 会话缓存
→ diag 依次出现 reflect_failed（20 秒超时）→ reflect_fallback_pages(3)
  → pages_ok(3) → retain_ok(turns=2, 23ms)
```

结论：recall、注入、写回三段逻辑都正常；默认路径下它们根本没有被执行。

实验走的是 `codex exec`，与 Desktop 共用同一套 hooks/trust 实现；Desktop 的审核入口是 **Settings > Hooks**，限制相同。Desktop 侧的逐轮行为仍需在信任恢复后实测。

### 2.3 Desktop 现场

- 今天共 6 个 rollout 段、10 次 `task_complete`，`plugin.log`/`diag.jsonl`/`usage.jsonl` 里只有 1 次 `retain_ok`（13:39:48，session `01a2165b`）。
- 该会话的 cursor 指向真实 Desktop rollout，说明写回链路可用；但这次写入既不对应 `task_complete`（13:37:29），也不对应归档（13:50:39），触发源无法从现有日志还原，不能当作常规路径在工作的证据。
- 所有 Desktop 会话都没有 `UserPromptSubmit` 的产物：没有 `%TEMP%\hindsight-codex\<session>.json` 会话缓存，没有 `inject_*` diag，也没有 `usage.jsonl` 行。
- 因此“会话结束没写记忆”不是偶发失败，而是 hook 从未进入执行阶段。

### 2.4 文档缺口

`hindsight-integrations/coding-agents/README.md` 的 Codex 段落只写了“3 hooks + `codex_hooks = true`”，没有提 review/trust。TraeCode 段落反而明确写了“装完还要在 Settings 里启用 hook”。Desktop 用户按 README 安装后，会得到“看起来装好了、实际完全静默”的状态。

## 3. 根因分层

### 3.1 信任门（主因）

Codex 把用户 hook 视为不可信扩展，必须先审核。未信任时：

- 不执行任何命令；
- 不写 Codex 日志，也不写 Hindsight 日志；
- 退出码/终端输出都没有异常。

这与现场完全吻合：配置齐全、MCP 可用、代码正确，但零执行。安装器无法代替用户写信任（这是安全边界），必须在安装后显式引导。

### 3.2 事件语义错配（设计问题）

本项目沿用了 Claude Code 的心智模型：`Stop` 当作“会话结束”。在 Codex 里：

- `Stop` 属于“during a turn”，每轮都会触发，并允许返回 `decision: "block"` 让模型继续；
- `SessionEnd` 才是主线程结束，覆盖归档、正常退出、30 分钟空闲三类场景。

后果：

- 即使信任恢复，归档一个会话也不会触发专门的收尾写入；只能依赖最后一轮 `Stop` 是否跑成功。
- 中断、异常退出、会话被归档前没有新轮次时，最后一段内容可能永远不落库。
- 每轮 `Stop` 都会完整读一遍 transcript 再 append-retain；长会话下这是不必要的重复 I/O。

### 3.3 静默失败与预算冲突

- `runRetainHook` 中 `if (!transcriptPath && !spec.journal) return;`、`deriveBankIdOrSkip` 返回 `null`、`sessionRetainBlocked` 等路径都不写 diag，排障时只能看到“没发生”。
- `SessionEnd` 强制同步且上限 3 秒。现有 retain 需要读 transcript、必要时启动 daemon、再走 HTTP；冷启动 daemon 远超 3 秒，直接挂 `SessionEnd` 会被杀在半途。

## 4. 建议

### 4.1 立即恢复（不改代码）

1. Desktop：打开 **Settings > Hooks**（或输入框的 **Review hooks**），逐条信任 Hindsight 的三条 hook。
2. CLI：运行 `/hooks` 完成同样审核。
3. 验证：新一轮对话后检查
   - `%TEMP%\hindsight-codex\<session>.json` 是否出现；
   - `~/.hindsight/coding-agents-logs/diag.jsonl` 是否出现 `inject_*`、`retain_ok`；
   - `usage.jsonl` 是否出现 `harness:"codex"` 行。

### 4.2 产品化改动（建议后续实施）

1. **安装后引导 + 健康信号**：installer 明确输出 review/trust 步骤；`hindsight_diagnose` 增加“hooks 最近一次执行时间”，超过 N 个会话无记录时直接提示“hook 未信任”。
2. **补 `SessionEnd`**：注册 `SessionEnd`（`timeout: 3`），但只做毫秒级的本地入队：把 `session_id`、`transcript_path`、`cwd` 追加到 spool，由 detached worker 完成真正的 retain。不能在该 hook 内直接起 daemon 或提交 HTTP。
3. **失败可见**：把 `runRetainHook` 的静默 `return` 改为 diag（`retain_skipped_no_transcript`、`bank_unresolved` 等），否则同类问题仍然无法从日志定位。
4. **写入策略**：`Stop` 继续做增量 append（60 秒预算，适合热路径），`SessionEnd` 做最终一致性收尾；两者共用 retain cursor 去重，避免重复写入。

### 4.3 不建议

- 用 `--dangerously-bypass-hook-trust` 常态化运行：绕过的是宿主安全边界，不是本项目的问题。
- 直接把 `SessionEnd` 接到现有 retain：3 秒预算下必然间歇失败，且失败时 transcript 可能已被清理。
- 依赖插件 manifest hooks 代替用户 hooks：同样要 review/trust，还引入插件缓存版本与更新重审的额外变量。

## 5. 尚未确认

- 13:39:48 那次唯一写入的触发源。它既不是轮次完成也不是归档，现有日志无法还原；可能与一次显式绕过信任的执行有关。
- Desktop 在信任恢复后是否逐轮触发 `Stop`（与 CLI 一致），需要信任后做一次真实会话验证。

## 复现命令

```powershell
$exe = "$env:LOCALAPPDATA\OpenAI\Codex\bin\05cc0fd428644ef6\codex.exe"
New-Item -ItemType Directory -Force D:\tmp\hooks-probe | Out-Null

# 默认：预期无 hook 输出、无新缓存文件
& $exe exec -C D:\tmp\hooks-probe --sandbox read-only --skip-git-repo-check "Reply with exactly OK"

# 绕过信任：预期打印 SessionStart / UserPromptSubmit / Stop
& $exe exec -C D:\tmp\hooks-probe --sandbox read-only --skip-git-repo-check `
  --dangerously-bypass-hook-trust "Reply with exactly OK"

Get-ChildItem "$env:TEMP\hindsight-codex" | Sort-Object LastWriteTime -Descending | Select-Object -First 5
Get-Content "$env:USERPROFILE\.hindsight\coding-agents-logs\diag.jsonl" -Tail 5
```
