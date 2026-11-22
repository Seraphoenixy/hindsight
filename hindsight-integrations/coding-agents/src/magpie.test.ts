import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./magpie";
import { executeProcessRequest, publishProcessState } from "./core/magpie-process";
vi.mock("./core/magpie-process", () => ({
  executeProcessRequest: vi.fn(),
  publishProcessState: vi.fn(),
}));
vi.mock("./core/config", () => ({ loadConfig: () => ({ daemonProfile: "coding-agent" }) }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(publishProcessState).mockResolvedValue({ running: false } as never);
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
    "checked",
  ]) {
    elements.set(id, {
      textContent: "",
      disabled: true,
      dataset: {},
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
    },
    magpie: {
      ready: Promise.resolve({}),
      options: { get: async () => ({ port: 19100 }), set: setOptions },
    },
  };
  const script = readFileSync(new URL("../magpie/page/boot.js", import.meta.url), "utf8");
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
  expect(elements.get("start")?.disabled).toBe(true);
  expect(elements.get("stop")?.disabled).toBe(false);
  expect(setOptions).not.toHaveBeenCalled();
  await handlers.get("stop")!();
  expect(setOptions).toHaveBeenCalledWith({
    port: 19100,
    processRequest: { action: "stop", id: expect.stringMatching(/^\d{13}-[a-z0-9]{10}$/) },
  });
  expect(elements.get("open")?.disabled).toBe(true);
});
