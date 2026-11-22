/**
 * The control plane's lifecycle helpers, and the two bugs their shape exists to avoid.
 *
 * 1. `ensureControlPlaneStarted` must NOT memoize a SETTLED result. The host calls it at plugin
 *    load, so a settled memo makes every later call (in particular the panel's refresh button)
 *    answer in microseconds without spawning anything — even after the UI was stopped. (When this
 *    helper drove the retired control center, that was the "refresh does not bring 7878 up" bug.)
 * 2. The trigger must answer non-2xx when the attempt failed, so the panel can tell a failed start
 *    from a running one.
 *
 * The child-process layer is stubbed: these assert the DECISION to spawn, which is what broke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";

const execFileAsync = vi.fn(async () => ({ stdout: "", stderr: "" }));

/**
 * Arguments of every spawned CLI command, in order.
 *
 * Captured in the shim rather than read off `execFileAsync`, because the shim calls that stub
 * with no arguments to keep the promisified shape simple — so the stub cannot see them.
 */
const spawned: { cmd: string; args: string[] }[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      // promisify(execFile) shape: (cmd, args, opts, cb)
      const cb = args[args.length - 1] as (err: unknown, out: unknown) => void;
      spawned.push({ cmd: String(args[0]), args: (args[1] as string[]) ?? [] });
      void execFileAsync();
      cb(null, { stdout: "", stderr: "" });
    },
  };
});

const cfg = resolveConfig({ serverMode: "daemon" });

/** The control plane's port is the daemon's plus the embed's fixed UI offset. */
const EXPECTED_PORT = cfg.apiPort + 10_000;

/** Health answers alternate: the first N probes say "up", then "down" — like stopping it by hand. */
function stubHealth(sequence: boolean[]): ReturnType<typeof vi.fn> {
  let index = 0;
  const probe = vi.fn(() => {
    const up = sequence[Math.min(index++, sequence.length - 1)];
    return up
      ? Promise.resolve({ ok: true } as Response)
      : Promise.reject(new Error("ECONNREFUSED"));
  });
  vi.stubGlobal("fetch", probe);
  return probe;
}

beforeEach(() => {
  execFileAsync.mockClear();
  spawned.length = 0;
  delete process.env.HINDSIGHT_EMBED_CP_PORT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.HINDSIGHT_EMBED_CP_PORT;
});

async function freshModule() {
  // The in-flight marker is module state; a fresh import per test keeps the cases independent.
  return import("./control-plane");
}

describe("ensureControlPlaneStarted", () => {
  it("re-checks a settled attempt instead of answering from it", async () => {
    const { ensureControlPlaneStarted } = await freshModule();
    // Up for the first call, down for the second, up again for its post-start probe.
    stubHealth([true, false, true]);

    const first = await ensureControlPlaneStarted(cfg, "dsh");
    expect(first.running).toBe(true);
    expect(execFileAsync).not.toHaveBeenCalled(); // already healthy: nothing to spawn

    const second = await ensureControlPlaneStarted(cfg, "dsh");
    // The regression: this used to return the FIRST attempt's `running: true` without spawning.
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(second.running).toBe(true);
  });

  it("collapses a burst of concurrent callers onto one start", async () => {
    const { ensureControlPlaneStarted } = await freshModule();
    stubHealth([false, true]);

    const results = await Promise.all([
      ensureControlPlaneStarted(cfg, "dsh"),
      ensureControlPlaneStarted(cfg, "dsh"),
      ensureControlPlaneStarted(cfg, "dsh"),
    ]);

    expect(execFileAsync).toHaveBeenCalledTimes(1);
    for (const status of results) {
      expect(status.running).toBe(true);
      expect(status.port).toBe(EXPECTED_PORT);
    }
  });

  it("starts the UI on loopback, not on every interface", async () => {
    const { ensureControlPlaneStarted } = await freshModule();
    stubHealth([false, true]);

    await ensureControlPlaneStarted(cfg, "dsh");

    // The /local page on this UI controls local processes and rewrites the profile .env, so the
    // bind address is part of the contract, not an accident of the CLI's default (0.0.0.0).
    expect(spawned[0].args).toEqual(
      expect.arrayContaining(["ui", "start", "--hostname", "127.0.0.1"])
    );
    expect(spawned[0].args).toEqual(expect.arrayContaining(["--port", String(EXPECTED_PORT)]));
  });

  it("reports the URL the panel embeds, including the local settings page", async () => {
    const { ensureControlPlaneStarted } = await freshModule();
    stubHealth([true]);
    const status = await ensureControlPlaneStarted(cfg, "dsh");
    expect(status.url).toBe(`http://localhost:${EXPECTED_PORT}`);
    expect(status.localUrl).toBe(`http://localhost:${EXPECTED_PORT}/local`);
  });

  it("never throws when the embed binary cannot be spawned", async () => {
    const { ensureControlPlaneStarted } = await freshModule();
    stubHealth([false]);
    execFileAsync.mockRejectedValueOnce(new Error("spawn hindsight-embed ENOENT"));

    const status = await ensureControlPlaneStarted(cfg, "dsh");
    expect(status.running).toBe(false);
    expect(status.port).toBe(EXPECTED_PORT);
  });

  it("lets an explicit open re-check even while a start is in flight", async () => {
    const { ensureControlPlaneStarted } = await freshModule();
    stubHealth([false, false, true]);

    const background = ensureControlPlaneStarted(cfg, "dsh");
    const opened = ensureControlPlaneStarted(cfg, "dsh", { openBrowser: true });
    await Promise.all([background, opened]);

    // The user action must not be served by the background attempt's promise.
    expect(opened).not.toBe(background);
  });
});

describe("stopControlPlane", () => {
  it("runs `ui stop` for the daemon's profile", async () => {
    const { stopControlPlane } = await freshModule();

    await expect(stopControlPlane(cfg)).resolves.toBe(true);
    // The profile is the contract: a bare `ui stop` would target the active profile and leave a
    // UI started for this one running.
    expect(spawned.length).toBe(1);
    expect(spawned[0].args).toEqual(
      expect.arrayContaining(["ui", "stop", "--profile", cfg.daemonProfile])
    );
  });
});

describe("resolveControlPlanePort", () => {
  it("derives the port from the daemon's, matching the embed's offset", async () => {
    const { resolveControlPlanePort } = await freshModule();
    expect(resolveControlPlanePort(cfg)).toBe(EXPECTED_PORT);
  });

  it("honours HINDSIGHT_EMBED_CP_PORT and ignores nonsense", async () => {
    const { resolveControlPlanePort } = await freshModule();

    process.env.HINDSIGHT_EMBED_CP_PORT = "8123";
    expect(resolveControlPlanePort(cfg)).toBe(8123);

    process.env.HINDSIGHT_EMBED_CP_PORT = "0";
    expect(resolveControlPlanePort(cfg)).toBe(EXPECTED_PORT);

    process.env.HINDSIGHT_EMBED_CP_PORT = "abc";
    expect(resolveControlPlanePort(cfg)).toBe(EXPECTED_PORT);

    delete process.env.HINDSIGHT_EMBED_CP_PORT;
    expect(resolveControlPlanePort(cfg)).toBe(EXPECTED_PORT);
  });
});
