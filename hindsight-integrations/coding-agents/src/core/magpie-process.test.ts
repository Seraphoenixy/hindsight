import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";
import { executeProcessRequest, publishProcessState, type ProcessRequest } from "./magpie-process";
import {
  ensureControlPlaneStarted,
  isControlPlaneHealthy,
  stopControlPlane,
} from "./control-plane";
import { isServerHealthy } from "./daemon";
import { runEmbedOps } from "./embed-ops";
import { openManagementPage } from "./management-browser";
import { inspectMagpieLlm, syncMagpieLlm } from "./magpie-llm";
import { inspectHosts, runHostInstaller } from "./magpie-hosts";

const state = vi.hoisted(() => ({ home: "", running: false }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => state.home,
}));
vi.mock("./control-plane", () => ({
  ensureControlPlaneStarted: vi.fn(),
  stopControlPlane: vi.fn(),
  isControlPlaneHealthy: vi.fn(),
}));
vi.mock("./daemon", () => ({ isServerHealthy: vi.fn() }));
vi.mock("./embed-ops", () => ({ runEmbedOps: vi.fn() }));
vi.mock("./management-browser", () => ({ openManagementPage: vi.fn() }));
vi.mock("./magpie-llm", () => ({
  inspectMagpieLlm: vi.fn(),
  syncMagpieLlm: vi.fn(),
}));
vi.mock("./magpie-hosts", async (original) => ({
  ...(await original<typeof import("./magpie-hosts")>()),
  runHostInstaller: vi.fn(),
}));
const cfg = resolveConfig({ daemonProfile: "coding-agent" });
let file: string;
beforeEach(() => {
  vi.resetAllMocks();
  state.home = mkdtempSync(join(tmpdir(), "hs-magpie-process-"));
  state.running = false;
  file = join(state.home, "runtime-state.js");
  vi.mocked(isControlPlaneHealthy).mockImplementation(async () => state.running);
  vi.mocked(isServerHealthy).mockResolvedValue(true);
  vi.mocked(runEmbedOps).mockResolvedValue({ ok: true });
  vi.mocked(inspectMagpieLlm).mockResolvedValue({
    status: "synced",
    mode: "follow",
    hostModel: "codearts/deepseek-v4.1-flash-1017",
    configuredModel: "codearts/deepseek-v4.1-flash-1017",
    provider: "openai-responses",
    models: ["codearts/deepseek-v4.1-flash-1017"],
    restartRequired: false,
    message: "已跟随 Magpie 当前模型",
    checkedAt: Date.now(),
  });
  vi.mocked(syncMagpieLlm).mockResolvedValue({
    status: "updated",
    mode: "fixed",
    hostModel: "codearts/deepseek-v4.1-flash-1017",
    configuredModel: "codearts/glm-5.3-flash",
    provider: "openai-responses",
    models: ["codearts/deepseek-v4.1-flash-1017", "codearts/glm-5.3-flash"],
    restartRequired: false,
    message: "已同步 Magpie 的模型，并重启记忆服务",
    checkedAt: Date.now(),
  });
  vi.mocked(stopControlPlane).mockImplementation(async () => {
    state.running = false;
    return true;
  });
  vi.mocked(ensureControlPlaneStarted).mockImplementation(async () => {
    state.running = true;
    return {
      running: true,
      port: 19100,
      url: "http://127.0.0.1:19100",
      localUrl: "http://127.0.0.1:19100/local",
    };
  });
});
afterEach(() => rmSync(state.home, { recursive: true, force: true }));
const request = (action: ProcessRequest["action"]): ProcessRequest => ({
  id: "1795380000000-abcdefghij",
  action,
});
it("publishes live state without starting or stopping either service", async () => {
  const snapshot = await publishProcessState(cfg, 19100, file);
  expect(snapshot).toMatchObject({
    running: false,
    daemonHealthy: true,
    profile: "coding-agent",
    operation: null,
  });
  expect(readFileSync(file, "utf8")).toContain("window.hindsightProcessState = ");
  expect(ensureControlPlaneStarted).not.toHaveBeenCalled();
  expect(stopControlPlane).not.toHaveBeenCalled();
});
it.each(["start", "stop", "restart", "open"] as const)(
  "executes %s once even with concurrent host replays",
  async (action) => {
    state.running = true;
    await Promise.all([
      executeProcessRequest(cfg, 19100, request(action), file),
      executeProcessRequest(cfg, 19100, request(action), file),
    ]);
    await executeProcessRequest(cfg, 19100, request(action), file);
    expect(stopControlPlane).toHaveBeenCalledTimes(
      action === "stop" || action === "restart" ? 1 : 0
    );
    if (action === "stop" || action === "restart")
      expect(stopControlPlane).toHaveBeenCalledWith(cfg, { port: 19100 });
    expect(ensureControlPlaneStarted).toHaveBeenCalledTimes(action === "stop" ? 0 : 1);
    expect(openManagementPage).toHaveBeenCalledTimes(action === "open" ? 1 : 0);
    const snapshot = await publishProcessState(cfg, 19100, file, request(action));
    expect(snapshot.running).toBe(action !== "stop");
    expect(snapshot.operation?.phase).toBe("done");
  }
);
it("reports a failed stop and does not launch a competing process", async () => {
  state.running = true;
  vi.mocked(stopControlPlane).mockResolvedValue(false);
  await executeProcessRequest(cfg, 19100, request("restart"), file);
  const snapshot = await publishProcessState(cfg, 19100, file, request("restart"));
  expect(snapshot.operation?.phase).toBe("failed");
  expect(ensureControlPlaneStarted).not.toHaveBeenCalled();
});
it("reports startup failures without losing the process controls", async () => {
  vi.mocked(ensureControlPlaneStarted).mockRejectedValue(new Error("embed unavailable"));
  await executeProcessRequest(cfg, 19100, request("start"), file);
  expect((await publishProcessState(cfg, 19100, file, request("start"))).operation).toMatchObject({
    phase: "failed",
    message: "embed unavailable",
  });
});
it("makes an interrupted request actionable after its host exits", async () => {
  const dir = join(state.home, ".hindsight", "magpie", "requests");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, request("start").id + ".json"),
    JSON.stringify({ ...request("start"), ownerPid: 2147483647, phase: "running", message: "" })
  );
  expect((await publishProcessState(cfg, 19100, file, request("start"))).operation?.phase).toBe(
    "failed"
  );
});
it("rejects malformed requests before running lifecycle commands", async () => {
  await expect(
    executeProcessRequest(cfg, 19100, { id: "../bad", action: "start" }, file)
  ).rejects.toThrow("Invalid");
  expect(ensureControlPlaneStarted).not.toHaveBeenCalled();
});
it("applies a page-selected LLM model without touching the UI lifecycle", async () => {
  const sync = {
    id: "1795380000000-abcdefghij",
    action: "sync-llm" as const,
    model: "codearts/glm-5.3-flash",
  };
  await executeProcessRequest(cfg, 19100, sync, file);
  expect(syncMagpieLlm).toHaveBeenCalledWith(cfg, {
    mode: "fixed",
    model: "codearts/glm-5.3-flash",
    force: true,
    restart: true,
    noCache: true,
  });
  expect(ensureControlPlaneStarted).not.toHaveBeenCalled();
  expect(stopControlPlane).not.toHaveBeenCalled();
  expect((await publishProcessState(cfg, 19100, file, sync)).operation).toMatchObject({
    phase: "done",
    message: "已同步 Magpie 的模型，并重启记忆服务",
  });
});
it.each(["daemon-start", "daemon-stop", "daemon-restart"] as const)(
  "controls the memory daemon with %s without touching the UI lifecycle",
  async (action) => {
    await executeProcessRequest(cfg, 19100, request(action), file);
    expect(runEmbedOps).toHaveBeenCalledWith(cfg, [action, "--profile", "coding-agent"]);
    expect(ensureControlPlaneStarted).not.toHaveBeenCalled();
    expect(stopControlPlane).not.toHaveBeenCalled();
    expect((await publishProcessState(cfg, 19100, file, request(action))).operation).toMatchObject({
      phase: "done",
    });
  }
);
it("reports memory daemon errors from ops", async () => {
  vi.mocked(runEmbedOps).mockResolvedValue({ ok: false, message_zh: "启动失败" });
  await executeProcessRequest(cfg, 19100, request("daemon-start"), file);
  expect(
    (await publishProcessState(cfg, 19100, file, request("daemon-start"))).operation
  ).toMatchObject({
    phase: "failed",
    message: "启动失败",
  });
});
it("toggles global host injection in coding-agent.json while preserving existing fields", async () => {
  const prevConfigEnv = process.env.HINDSIGHT_CONFIG;
  delete process.env.HINDSIGHT_CONFIG;
  try {
    const cfgDir = join(state.home, ".hindsight");
    const cfgFile = join(cfgDir, "coding-agent.json");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgFile, JSON.stringify({ serverMode: "daemon", apiPort: 9077 }));

    expect((await publishProcessState(cfg, 19100, file)).injection).toMatchObject({
      enabled: true,
      configPath: cfgFile,
    });
    expect(
      (await publishProcessState(cfg, 19100, file)).injection.hosts.some(
        (h) => h.name === "antigravity-cli"
      )
    ).toBe(true);

    const disableReq = { id: "1795380000001-abcdefghij", action: "injection-disable" as const };
    await executeProcessRequest(cfg, 19100, disableReq, file);
    expect(JSON.parse(readFileSync(cfgFile, "utf8"))).toEqual({
      serverMode: "daemon",
      apiPort: 9077,
      disabled: true,
    });
    expect(await publishProcessState(cfg, 19100, file, disableReq)).toMatchObject({
      injection: { enabled: false, configPath: cfgFile },
      operation: { phase: "done", message: "已暂停宿主注入" },
    });

    const enableReq = { id: "1795380000002-abcdefghij", action: "injection-enable" as const };
    await executeProcessRequest(cfg, 19100, enableReq, file);
    expect(JSON.parse(readFileSync(cfgFile, "utf8"))).toEqual({
      serverMode: "daemon",
      apiPort: 9077,
      disabled: false,
    });
    expect(await publishProcessState(cfg, 19100, file, enableReq)).toMatchObject({
      injection: { enabled: true, configPath: cfgFile },
      operation: { phase: "done", message: "已开启宿主注入" },
    });

    const hostDisableReq = {
      id: "1795380000003-abcdefghij",
      action: "host-disable" as const,
      host: "antigravity-cli",
    };
    await executeProcessRequest(cfg, 19100, hostDisableReq, file);
    expect(JSON.parse(readFileSync(cfgFile, "utf8"))).toEqual({
      serverMode: "daemon",
      apiPort: 9077,
      disabled: false,
      harnesses: { "antigravity-cli": { disabled: true } },
    });

    const hostUninstallReq = {
      id: "1795380000004-abcdefghij",
      action: "host-uninstall" as const,
      host: "antigravity-cli",
    };
    await executeProcessRequest(cfg, 19100, hostUninstallReq, file);
    expect(runHostInstaller).toHaveBeenCalledWith("uninstall", "antigravity-cli");

    const hostInstallReq = {
      id: "1795380000005-abcdefghij",
      action: "host-install" as const,
      host: "claude-code",
    };
    vi.mocked(runHostInstaller).mockResolvedValueOnce({
      warnings: [
        "codex: add `hooks = true` under your existing [features] section in ~/.codex/config.toml",
      ],
    });
    await executeProcessRequest(cfg, 19100, hostInstallReq, file);
    expect(runHostInstaller).toHaveBeenCalledWith("install", "claude-code");
    expect(
      (await publishProcessState(cfg, 19100, file, hostInstallReq)).operation?.message
    ).toContain("add `hooks = true`");

    await expect(
      executeProcessRequest(
        cfg,
        19100,
        { id: "1795380000006-abcdefghij", action: "host-uninstall", host: "unknown-host" },
        file
      )
    ).rejects.toThrow("Invalid host");
  } finally {
    if (prevConfigEnv === undefined) delete process.env.HINDSIGHT_CONFIG;
    else process.env.HINDSIGHT_CONFIG = prevConfigEnv;
  }
});
