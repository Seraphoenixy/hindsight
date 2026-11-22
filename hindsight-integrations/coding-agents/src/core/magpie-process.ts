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
import { openManagementPage } from "./management-browser";

export interface ProcessRequest {
  id: string;
  action: "start" | "stop" | "restart" | "open";
}

interface Operation extends ProcessRequest {
  ownerPid: number;
  phase: "running" | "done" | "failed";
  message: string;
}

export interface ProcessState {
  profile: string;
  port: number;
  url: string;
  running: boolean;
  daemonHealthy: boolean;
  checkedAt: number;
  operation: Operation | null;
}

function receiptPath(request: ProcessRequest): string {
  if (!/^\d{13}-[a-z0-9]{6,16}$/.test(request.id)) throw new Error("Invalid process request");
  if (!["start", "stop", "restart", "open"].includes(request.action))
    throw new Error("Invalid process action");
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

/** Claim persistently: options are replayed when Magpie reloads its plugin host. */
export async function executeProcessRequest(
  cfg: Config,
  port: number,
  request: ProcessRequest,
  stateFile: string
): Promise<void> {
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  await publishProcessState(cfg, port, stateFile, request);
  try {
    if (request.action === "stop" || request.action === "restart") {
      await stopControlPlane(cfg, { port });
      if (await isControlPlaneHealthy(port)) throw new Error("管理界面仍在运行，停止未成功");
    }
    if (request.action !== "stop") {
      const started = await ensureControlPlaneStarted(cfg, "magpie", { port });
      if (!started.running) throw new Error("管理界面未能启动，请查看 profile 日志");
    }
    if (request.action === "open") await openManagementPage(port, request.id);
    operation.phase = "done";
    operation.message = {
      start: "管理界面已启动",
      stop: "管理界面已停止",
      restart: "管理界面已重启",
      open: "已在系统浏览器打开",
    }[request.action];
  } catch (error) {
    operation.phase = "failed";
    operation.message = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(receipt, JSON.stringify(operation), { mode: 0o600 });
  await publishProcessState(cfg, port, stateFile, request);
}
