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
import { openManagementPage } from "./management-browser";
import { inspectMagpieLlm, syncMagpieLlm } from "./magpie-llm";

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
vi.mock("./management-browser", () => ({ openManagementPage: vi.fn() }));
vi.mock("./magpie-llm", () => ({
  inspectMagpieLlm: vi.fn(),
  syncMagpieLlm: vi.fn(),
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
  const sync = { id: "1795380000000-abcdefghij", action: "sync-llm" as const, model: "codearts/glm-5.3-flash" };
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
