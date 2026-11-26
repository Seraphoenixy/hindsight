import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./magpie";
import { executeProcessRequest, publishProcessState } from "./core/magpie-process";
import { autoSyncMagpieLlm } from "./core/magpie-llm";
vi.mock("./core/magpie-process", () => ({
  executeProcessRequest: vi.fn(),
  publishProcessState: vi.fn(),
}));
vi.mock("./core/magpie-llm", () => ({ autoSyncMagpieLlm: vi.fn() }));
vi.mock("./core/config", () => ({ loadConfig: () => ({ daemonProfile: "coding-agent" }) }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(publishProcessState).mockResolvedValue({ running: false } as never);
  vi.mocked(autoSyncMagpieLlm).mockResolvedValue({ status: "synced" } as never);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("observes on host load without undoing a previous stop", async () => {
  expect(await plugin.server({}, { port: 19100 })).toEqual({});
  expect(publishProcessState).toHaveBeenCalledWith(
    expect.objectContaining({ daemonProfile: "coding-agent" }),
    19100,
    expect.stringContaining("state.js"),
    undefined
  );
  expect(executeProcessRequest).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(publishProcessState).toHaveBeenCalledTimes(2);
});
it("forwards explicit lifecycle requests to the controller", async () => {
  const request = { id: "1795380000000-abcdefghij", action: "stop" as const };
  await plugin.server({}, { port: 19077, processRequest: request });
  expect(executeProcessRequest).toHaveBeenCalledWith(
    expect.anything(),
    19077,
    request,
    expect.stringContaining("state.js")
  );
});
it("rejects invalid ports before probing or managing processes", async () => {
  await expect(plugin.server({}, { port: 0 })).rejects.toThrow("Invalid");
  expect(publishProcessState).not.toHaveBeenCalled();
});
it("renders live status and submits controls through the sandbox bridge", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const handlers = new Map<string, () => Promise<void>>();
  const elements = new Map<
    string,
    {
      textContent: string;
      disabled: boolean;
      dataset: Record<string, string>;
      value: string;
      innerHTML: string;
      addEventListener: (event: string, fn: () => Promise<void>) => void;
    }
  >();
  for (const id of [
    "status",
    "start",
    "stop",
    "restart",
    "refresh",
    "open",
    "address",
    "running",
    "profile",
    "port",
    "daemon",
    "daemonStatus",
    "daemonStart",
    "daemonStop",
    "daemonRestart",
    "checked",
    "llmStatus",
    "llmHost",
    "llmConfigured",
    "llmMode",
    "llmModel",
    "syncLlm",
    "llmNote",
  ]) {
    elements.set(id, {
      textContent: "",
      disabled: true,
      dataset: {},
      value: "",
      innerHTML: "",
      addEventListener: (_event, fn) => {
        handlers.set(id, fn);
      },
    });
  }
  const setOptions = vi.fn();
  const window = {
    hindsightProcessState: {
      port: 19100,
      running: true,
      daemonHealthy: true,
      profile: "coding-agent",
      url: "http://127.0.0.1:19100",
      checkedAt: Date.now(),
      operation: null,
      llm: {
        status: "synced",
        mode: "follow",
        hostModel: "codearts/deepseek-v4.1-flash-1017",
        configuredModel: "codearts/deepseek-v4.1-flash-1017",
        provider: "openai-responses",
        models: ["codearts/deepseek-v4.1-flash-1017", "codearts/glm-5.3-flash"],
        restartRequired: false,
        message: "已跟随 Magpie 当前模型",
        checkedAt: Date.now(),
      },
    },
    magpie: {
      ready: Promise.resolve({}),
      options: { get: async () => ({ port: 19100 }), set: setOptions },
    },
  };
  const script = readFileSync(new URL("../../magpie/page/boot.js", import.meta.url), "utf8");
  await runInNewContext(script, {
    window,
    location: { hostname: "localhost" },
    setInterval: vi.fn(),
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: () => ({ src: "", remove: vi.fn() }),
      head: { append: (asset: { onload: () => void }) => asset.onload() },
    },
  });
  expect(elements.get("running")?.textContent).toBe("运行中");
  expect(elements.get("llmStatus")?.textContent).toBe("已接入");
  expect(elements.get("llmModel")?.disabled).toBe(false);
  expect(elements.get("start")?.disabled).toBe(true);
  expect(elements.get("stop")?.disabled).toBe(false);
  expect(setOptions).not.toHaveBeenCalled();
  await handlers.get("stop")!();
  expect(setOptions).toHaveBeenCalledWith({
    port: 19100,
    processRequest: { action: "stop", id: expect.stringMatching(/^\d{13}-[a-z0-9]{10}$/) },
  });
  expect(elements.get("open")?.disabled).toBe(true);
  elements.get("llmModel")!.value = "codearts/glm-5.3-flash";
  await handlers.get("syncLlm")!();
  expect(setOptions).toHaveBeenLastCalledWith({
    port: 19100,
    processRequest: {
      action: "sync-llm",
      id: expect.stringMatching(/^\d{13}-[a-z0-9]{10}$/),
      model: "codearts/glm-5.3-flash",
    },
  });
});
it("renders and toggles host injection on the standalone injection page", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const handlers = new Map<string, () => Promise<void>>();
  const elements = new Map<
    string,
    {
      textContent: string;
      disabled: boolean;
      dataset: Record<string, string>;
      value: string;
      innerHTML: string;
      addEventListener: (event: string, fn: () => Promise<void>) => void;
    }
  >();
  for (const id of [
    "status",
    "refresh",
    "checked",
    "injectionStatus",
    "injectionConfigPath",
    "injectionEnable",
    "injectionDisable",
    "hostList",
    "showAllHosts",
  ]) {
    elements.set(id, {
      textContent: "",
      disabled: true,
      dataset: {},
      value: "",
      innerHTML: "",
      addEventListener: (_event, fn) => {
        handlers.set(id, fn);
      },
    });
  }
  const setOptions = vi.fn();
  const window = {
    hindsightProcessState: {
      port: 19100,
      running: false,
      daemonHealthy: true,
      profile: "coding-agent",
      url: "http://127.0.0.1:19100",
      checkedAt: Date.now(),
      operation: null,
      injection: {
        enabled: true,
        configPath: "C:\\Users\\test\\.hindsight\\coding-agent.json",
        hosts: [
          {
            name: "antigravity-cli",
            label: "Antigravity (agy)",
            detected: true,
            installed: true,
            harnessDisabled: false,
            effectiveEnabled: true,
          },
          {
            name: "claude-code",
            label: "Claude Code",
            detected: true,
            installed: false,
            harnessDisabled: false,
            effectiveEnabled: true,
          },
        ],
      },
    },
    magpie: {
      ready: Promise.resolve({}),
      options: { get: async () => ({ port: 19100 }), set: setOptions },
    },
  };
  const script = readFileSync(new URL("../../magpie/page/boot.js", import.meta.url), "utf8");
  await runInNewContext(script, {
    window,
    location: { hostname: "localhost" },
    setInterval: vi.fn(),
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: () => ({ src: "", remove: vi.fn() }),
      head: { append: (asset: { onload: () => void }) => asset.onload() },
    },
  });
  expect(elements.get("injectionStatus")?.textContent).toBe("已开启");
  expect(elements.get("injectionStatus")?.dataset.enabled).toBe("true");
  expect(elements.get("injectionConfigPath")?.textContent).toBe(
    "C:\\Users\\test\\.hindsight\\coding-agent.json"
  );
  expect(elements.get("injectionEnable")?.disabled).toBe(true);
  expect(elements.get("injectionDisable")?.disabled).toBe(false);
  expect(elements.get("hostList")?.innerHTML).toContain("Antigravity (agy)");
  expect(elements.get("hostList")?.innerHTML).toContain('data-host-action="host-uninstall"');
  expect(elements.get("hostList")?.innerHTML).toContain('data-host-action="host-install"');
  await handlers.get("injectionDisable")!();
  expect(setOptions).toHaveBeenCalledWith({
    port: 19100,
    processRequest: {
      action: "injection-disable",
      id: expect.stringMatching(/^\d{13}-[a-z0-9]{10}$/),
    },
  });
  await handlers.get("hostList")!({
    target: {
      closest: () => ({
        disabled: false,
        dataset: { hostAction: "host-uninstall", host: "antigravity-cli" },
      }),
    },
  } as never);
  expect(setOptions).toHaveBeenLastCalledWith({
    port: 19100,
    processRequest: {
      action: "host-uninstall",
      host: "antigravity-cli",
      id: expect.stringMatching(/^\d{13}-[a-z0-9]{10}$/),
    },
  });
});
