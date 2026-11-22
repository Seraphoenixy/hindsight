import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openManagementPage } from "./management-browser";

const state = vi.hoisted(() => ({ home: "", failure: false }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => state.home,
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    callback(state.failure ? new Error("cannot open browser") : null, "");
    return {} as ChildProcess;
  }),
}));
beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), "hs-browser-"));
  state.failure = false;
  vi.clearAllMocks();
});
afterEach(() => rmSync(state.home, { recursive: true, force: true }));
it("opens only for an explicit request and consumes it across host reloads", async () => {
  await openManagementPage(19077);
  expect(execFile).not.toHaveBeenCalled();
  const request = "1795380000000-abcdefghij";
  await openManagementPage(19077, request);
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(vi.mocked(execFile).mock.calls[0][1]).toContain("http://127.0.0.1:19077");
  await openManagementPage(19077, request);
  expect(execFile).toHaveBeenCalledTimes(1);
  await openManagementPage(19077, "1795380000001-klmnopqrst");
  expect(execFile).toHaveBeenCalledTimes(2);
});
it("allows a failed browser launch to be retried", async () => {
  state.failure = true;
  const request = "1795380000000-abcdefghij";
  await expect(openManagementPage(19077, request)).rejects.toThrow("cannot open");
  state.failure = false;
  await openManagementPage(19077, request);
  expect(execFile).toHaveBeenCalledTimes(2);
});
it("rejects malformed request identifiers", async () => {
  await expect(openManagementPage(19077, "malformed")).rejects.toThrow("Invalid");
  expect(execFile).not.toHaveBeenCalled();
});
