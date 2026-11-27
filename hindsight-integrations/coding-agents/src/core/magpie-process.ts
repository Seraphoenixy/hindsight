import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import {
  ensureControlPlaneStarted,
  isControlPlaneHealthy,
  stopControlPlane,
} from "./control-plane";
import { isServerHealthy } from "./daemon";
import { runEmbedOps } from "./embed-ops";
import { openManagementPage } from "./management-browser";
import { inspectMagpieLlm, syncMagpieLlm, type LlmState } from "./magpie-llm";
import {
  inspectHosts,
  runHostInstaller,
  VALID_HOST_NAMES,
  type HostInjectionState,
} from "./magpie-hosts";
import { clearRetainBlocked } from "./session-cache";

export type ProcessAction =
  | "start"
  | "stop"
  | "restart"
  | "open"
  | "sync-llm"
  | "daemon-start"
  | "daemon-stop"
  | "daemon-restart"
  | "injection-enable"
  | "injection-disable"
  | "host-enable"
  | "host-disable"
  | "host-install"
  | "host-uninstall";

export interface ProcessRequest {
  id: string;
  action: ProcessAction;
  /** Page-selected model for `sync-llm`; omitted follows the host's current model. */
  model?: string | null;
  /** Target harness name for `host-*` actions. */
  host?: string;
}

interface Operation extends ProcessRequest {
  ownerPid: number;
  phase: "running" | "done" | "failed";
  message: string;
}

export interface InjectionState {
  enabled: boolean;
  configPath: string;
  hosts: HostInjectionState[];
}

export interface ProcessState {
  profile: string;
  port: number;
  url: string;
  running: boolean;
  daemonHealthy: boolean;
  llm: LlmState;
  injection: InjectionState;
  checkedAt: number;
  operation: Operation | null;
}

const VALID_ACTIONS = new Set<ProcessAction>([
  "start",
  "stop",
  "restart",
  "open",
  "sync-llm",
  "daemon-start",
  "daemon-stop",
  "daemon-restart",
  "injection-enable",
  "injection-disable",
  "host-enable",
  "host-disable",
  "host-install",
  "host-uninstall",
]);

function codingAgentConfigPath(): string {
  return process.env.HINDSIGHT_CONFIG || join(homedir(), ".hindsight", "coding-agent.json");
}

function readRawConfig(): Record<string, unknown> {
  const configPath = codingAgentConfigPath();
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeRawConfig(mutator: (raw: Record<string, unknown>) => void): void {
  const configPath = codingAgentConfigPath();
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("无法解析配置文件 " + configPath);
    }
  }
  mutator(raw);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = configPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, configPath);
}

function readInjectionState(): InjectionState {
  const configPath = codingAgentConfigPath();
  const raw = readRawConfig();
  const enabled = raw.disabled !== true;
  return {
    enabled,
    configPath,
    hosts: inspectHosts(raw, enabled),
  };
}

function writeInjectionEnabled(enabled: boolean): void {
  writeRawConfig((raw) => {
    raw.disabled = !enabled;
  });
}

function writeHostEnabled(host: string, enabled: boolean): void {
  writeRawConfig((raw) => {
    const harnesses =
      raw.harnesses && typeof raw.harnesses === "object" && !Array.isArray(raw.harnesses)
        ? (raw.harnesses as Record<string, Record<string, unknown>>)
        : {};
    const current =
      harnesses[host] && typeof harnesses[host] === "object" && !Array.isArray(harnesses[host])
        ? harnesses[host]
        : {};
    harnesses[host] = { ...current, disabled: !enabled };
    raw.harnesses = harnesses;
  });
}

function receiptPath(request: ProcessRequest): string {
  if (!/^\d{13}-[a-z0-9]{6,16}$/.test(request.id)) throw new Error("Invalid process request");
  if (!VALID_ACTIONS.has(request.action)) throw new Error("Invalid process action");
  if (
    request.action.startsWith("host-") &&
    (!request.host || !VALID_HOST_NAMES.has(request.host))
  ) {
    throw new Error("Invalid host");
  }
  return join(homedir(), ".hindsight", "magpie", "requests", request.id + ".json");
}

/** Probe the live processes, never infer their current state from a past command. */
export async function publishProcessState(
  cfg: Config,
  port: number,
  file: string,
  request?: ProcessRequest
): Promise<ProcessState> {
  const [running, daemonHealthy] = await Promise.all([
    isControlPlaneHealthy(port),
    isServerHealthy(cfg.apiUrl),
  ]);
  const llm = await inspectMagpieLlm(cfg, { daemonHealthy });
  let operation: Operation | null = null;
  if (request) {
    try {
      operation = JSON.parse(readFileSync(receiptPath(request), "utf8")) as Operation;
      if (operation.phase === "running") {
        try {
          process.kill(operation.ownerPid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            operation.phase = "failed";
            operation.message = "上次后台操作已中断，请重新操作";
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const state: ProcessState = {
    profile: cfg.daemonProfile,
    port,
    url: `http://127.0.0.1:${port}`,
    running,
    daemonHealthy,
    llm,
    injection: readInjectionState(),
    checkedAt: Date.now(),
    operation,
  };
  // Magpie allows a page to load its own scripts, but not to fetch a local API.
  // Publish only process metadata through that existing asset channel. Atomic
  // replacement prevents a page refresh reading half a JavaScript document.
  // The hidden runtime directory is excluded from Magpie's local-plugin source
  // watcher; a visible status file would restart the host on every poll.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + process.pid + ".tmp";
  writeFileSync(temporary, "window.hindsightProcessState = " + JSON.stringify(state) + ";\n", {
    mode: 0o600,
  });
  renameSync(temporary, file);
  return state;
}

const INSTANT_ACTIONS = new Set<ProcessAction>([
  "injection-enable",
  "injection-disable",
  "host-enable",
  "host-disable",
]);

/** Claim persistently: options are replayed when Magpie reloads its plugin host. */
export async function executeProcessRequest(
  cfg: Config,
  port: number,
  request: ProcessRequest,
  stateFile: string
): Promise<boolean> {
  const receipt = receiptPath(request);
  mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
  const operation: Operation = {
    ...request,
    ownerPid: process.pid,
    phase: "running",
    message: "正在执行",
  };
  try {
    writeFileSync(receipt, JSON.stringify(operation), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  if (!INSTANT_ACTIONS.has(request.action)) {
    await publishProcessState(cfg, port, stateFile, request);
  }
  try {
    if (request.action === "sync-llm") {
      const llm = await syncMagpieLlm(cfg, {
        mode: request.model ? "fixed" : "follow",
        model: request.model ?? null,
        force: true,
        restart: true,
        noCache: true,
      });
      if (!["synced", "updated"].includes(llm.status)) throw new Error(llm.message);
      operation.message = llm.message;
    } else if (
      request.action === "daemon-start" ||
      request.action === "daemon-stop" ||
      request.action === "daemon-restart"
    ) {
      // Cold daemon startup + stale-port clearing + pg0 init can exceed the 30s
      // default ops timeout; match boot.js's 120s operation budget.
      const stdout = await runEmbedOps(cfg, [request.action, "--profile", cfg.daemonProfile], {
        timeoutMs: 120_000,
      });
      // The CLI can exit successfully while reporting a failed daemon action in its JSON body.
      const res = JSON.parse(stdout) as { ok: boolean; message?: string; message_zh?: string };
      if (res.ok === false) {
        throw new Error(res.message_zh || res.message || "记忆服务操作失败");
      }
      operation.message = {
        "daemon-start": "记忆服务已启动",
        "daemon-stop": "记忆服务已停止",
        "daemon-restart": "记忆服务已重启",
      }[request.action];
    } else if (request.action === "injection-enable" || request.action === "injection-disable") {
      const enabled = request.action === "injection-enable";
      writeInjectionEnabled(enabled);
      if (enabled) clearRetainBlocked();
      operation.message = enabled ? "已开启宿主注入" : "已暂停宿主注入";
    } else if (request.action === "host-enable" || request.action === "host-disable") {
      const enabled = request.action === "host-enable";
      writeHostEnabled(request.host!, enabled);
      if (enabled) clearRetainBlocked(request.host!);
      operation.message = `${request.host}: ${enabled ? "已开启注入" : "已暂停注入"}`;
    } else if (request.action === "host-install" || request.action === "host-uninstall") {
      const mode = request.action === "host-install" ? "install" : "uninstall";
      const result = await runHostInstaller(mode, request.host!);
      const base = `${request.host}: ${mode === "install" ? "已完成安装" : "已完成卸载"}`;
      operation.message = result?.warnings?.length
        ? `${base}（注意：${result.warnings.join("；")}）`
        : base;
    } else {
      if (request.action === "stop" || request.action === "restart") {
        await stopControlPlane(cfg, { port });
        if (await isControlPlaneHealthy(port)) throw new Error("管理界面仍在运行，停止未成功");
      }
      if (request.action !== "stop") {
        const started = await ensureControlPlaneStarted(cfg, "magpie", { port });
        if (!started.running) throw new Error("管理界面未能启动，请查看 profile 日志");
      }
      if (request.action === "open") await openManagementPage(port, request.id);
      operation.message = {
        start: "管理界面已启动",
        stop: "管理界面已停止",
        restart: "管理界面已重启",
        open: "已在系统浏览器打开",
      }[request.action];
    }
    operation.phase = "done";
  } catch (error) {
    operation.phase = "failed";
    operation.message = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(receipt, JSON.stringify(operation), { mode: 0o600 });
  await publishProcessState(cfg, port, stateFile, request);
  return true;
}
