/**
 * Local daemon mode — memory with no server and no Cloud account.
 *
 * `serverMode: "daemon"` runs `hindsight-embed` on this machine and points the plugin at it.
 * Lifecycle is delegated to `@vectorize-io/hindsight-all`, which owns the uvx invocation, profile
 * creation, readiness polling and the macOS Metal/MPS workaround. This module only decides WHEN to
 * start it, and with what environment.
 *
 * Three connection modes, resolved in this order (the same priority the old per-agent Claude Code
 * plugin used in `scripts/lib/daemon.py`):
 *   1. an external API — Cloud or self-hosted; `serverMode` is not "daemon" and nothing here runs
 *   2. a healthy server already on the port — adopted as-is, never restarted, so a daemon started
 *      by an earlier session (or a server the user runs themselves) is reused
 *   3. start the daemon
 *
 * TIMING IS THE CONSTRAINT. A cold start pays for a uvx download plus model load and can take tens
 * of seconds, while the prompt hook has to return in time to not stall the user's turn. Only two
 * points can request a detached start: SessionStart and Stop. Foreground hooks make one short
 * health probe and skip memory when it is unavailable. The prompt path only probes.
 *
 * EVERY HARNESS NEEDS BOTH POINTS, not just the fresh-process hook ones. The persistent-plugin
 * hosts (opencode, Kilo, Cline, Prime Agent, dsh) run no hook binaries, so they reach these through
 * `RuntimeCore`: `seedIfCold` is their SessionStart and the write-back is their Stop. Missing that
 * is what #3524 reported — dsh in daemon mode never started a daemon, so every `hindsight_*` call
 * failed with ECONNREFUSED until the user ran `daemon-start.js` by hand. `daemon.test.ts` now fails
 * if a harness entrypoint builds a client without reaching one of the two.
 *
 * There is no stop. One daemon serves every agent and repo on the machine, so ending one session
 * must not cut memory out from under another. Nothing retires it either: the server's idle timeout
 * was removed after it killed in-flight requests (#3903), so `daemonIdleTimeout` is inert.
 */
import { execFileSync, spawn as realSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config";
import { USER_AGENT } from "./hindsight";
import { diag } from "./diag";
import { log } from "./log";
import { nodeBinary } from "./util";

/** Only background write-back in persistent plugin hosts can wait on a cold start. */
export const DAEMON_WAIT_RETAIN_MS = 40_000;
const HOOK_HEALTH_TIMEOUT_MS = 500;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Where `hindsight-embed` keeps a profile's `.env`. The default profile is `~/.hindsight/embed`. */
export function daemonProfileEnvPath(profile: string): string {
  return profile && profile !== "default"
    ? join(homedir(), ".hindsight", "profiles", `${profile}.env`)
    : join(homedir(), ".hindsight", "embed");
}

/**
 * Auto-start only a profile the user has already provisioned.
 *
 * `@vectorize-io/hindsight-all` creates a missing profile on start, so without this gate a host
 * merely opening a session would invent a backend with defaults nobody chose. The management
 * panel writes this file when settings are saved, and so does an explicit
 * `hindsight-embed profile create`. Until then the plugin stays inert and explains how to
 * configure it instead of starting a service that cannot serve memory.
 */
export function daemonProfileProvisioned(cfg: Config): boolean {
  return existsSync(daemonProfileEnvPath(cfg.daemonProfile));
}

const autoStartDeclined = new Set<string>();

/** Say why a cold start was suppressed, once per profile/reason — not on every session. */
function noteAutoStartDeclined(
  cfg: Config,
  harness: string,
  reason: "disabled" | "unprovisioned"
): void {
  const key = `${reason}:${cfg.daemonProfile}`;
  if (autoStartDeclined.has(key)) return;
  autoStartDeclined.add(key);
  if (reason === "disabled") {
    log.info(
      harness,
      "Hindsight daemon auto-start is disabled (daemonAutoStart=false); using an already-running server only"
    );
  } else {
    log.warn(
      harness,
      `Hindsight local memory is not configured yet — open the management panel's Local settings ` +
        `to choose a provider and start it (profile "${cfg.daemonProfile}")`
    );
  }
  diag(harness, reason === "disabled" ? "daemon_autostart_disabled" : "daemon_profile_missing", {
    profile: cfg.daemonProfile,
    path: daemonProfileEnvPath(cfg.daemonProfile),
  });
}

/** Probe a base URL's /health. Never throws — an unreachable server is just "not running". */
export async function isServerHealthy(baseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/** Keep optional memory work off the foreground path when a local API is unavailable. */
export async function isHookServerReady(cfg: Config): Promise<boolean> {
  const url = URL.canParse(cfg.apiUrl) ? new URL(cfg.apiUrl) : undefined;
  if (cfg.serverMode !== "daemon" && !LOOPBACK_HOSTS.has(url?.hostname ?? "")) return true;
  return isServerHealthy(cfg.apiUrl, HOOK_HEALTH_TIMEOUT_MS);
}

/**
 * macOS needs a CURRENT Rust toolchain to install the daemon.
 *
 * litellm — pulled in transitively by the API — publishes wheels only for manylinux and Windows
 * (verified against PyPI for 1.95.0: cp310-cp314, no macOS build for any of them). Every macOS
 * install therefore compiles it from the sdist through maturin, and its dependency tree pins a
 * recent rustc (1.94.1 at the time of writing; observed failing on 1.93.1). Only presence is
 * checked here — the required version comes from litellm's transitive crates and moves on its own
 * schedule, so pinning a number here would just go stale. A too-old toolchain still fails, but the
 * error carries the exact version needed.
 */
export function hasRustToolchain(): boolean {
  if (process.platform !== "darwin") return true; // wheels cover linux + windows
  try {
    execFileSync("cargo", ["--version"], {
      stdio: "pipe",
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Is `uv`/`uvx` on PATH? The daemon is fetched and run through it. */
export function hasUvx(): boolean {
  try {
    execFileSync("uvx", ["--version"], {
      stdio: "pipe",
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

interface ProviderProbe {
  provider: string;
  keyEnv: string;
}

/**
 * Providers the daemon can use for local fact extraction, most-specific first.
 */
const PROVIDER_PROBES: ProviderProbe[] = [
  { provider: "openai", keyEnv: "OPENAI_API_KEY" },
  { provider: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
  { provider: "gemini", keyEnv: "GEMINI_API_KEY" },
  { provider: "groq", keyEnv: "GROQ_API_KEY" },
];

export interface LlmChoice {
  provider: string;
  /** Absent for providers that need no credential. */
  apiKey?: string;
  /** Where it came from, for the installer's output and diagnostics. */
  source: string;
}

/**
 * Decide which LLM the daemon extracts facts with.
 *
 * An explicit `HINDSIGHT_API_LLM_PROVIDER` always wins — including for providers this code knows
 * nothing about, so a local Ollama or a gateway can be pointed at without a code change here.
 */
export function detectLlm(env: NodeJS.ProcessEnv = process.env): LlmChoice | undefined {
  const explicit = env.HINDSIGHT_API_LLM_PROVIDER?.trim();
  if (explicit) {
    return {
      provider: explicit,
      apiKey: env.HINDSIGHT_API_LLM_API_KEY?.trim() || undefined,
      source: "HINDSIGHT_API_LLM_PROVIDER",
    };
  }
  for (const probe of PROVIDER_PROBES) {
    const key = env[probe.keyEnv]?.trim();
    if (key) return { provider: probe.provider, apiKey: key, source: probe.keyEnv };
  }
  return undefined;
}

/** Environment handed to the daemon: the LLM choice, the idle timeout, and any HINDSIGHT_API_* the
 *  user already exports (so provider-specific knobs pass through without being enumerated here). */
export function daemonEnv(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  // Forwarded only when set, and inert either way: the server dropped its idle timeout in #3903
  // (it measured idleness from the request *start*, so a long retain killed its own daemon). Kept
  // so an existing config still starts — the daemon ignores the value.
  // It used to default to 300s here, which made the plugin the one thing on the machine opting a
  // SHARED daemon into an auto-exit; every other integration shipped 0.
  if (cfg.daemonIdleTimeout !== undefined) {
    out.HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT = String(cfg.daemonIdleTimeout);
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("HINDSIGHT_API_") && value) out[key] = value;
  }
  const llm = detectLlm(env);
  if (llm) {
    out.HINDSIGHT_API_LLM_PROVIDER = llm.provider;
    if (llm.apiKey) out.HINDSIGHT_API_LLM_API_KEY = llm.apiKey;
  }
  return out;
}

/** Carries the spawning session's resolved config to the detached starter (daemon-start.ts). */
export const DAEMON_CONFIG_ENV = "HINDSIGHT_CODING_AGENTS_DAEMON_CONFIG";

/**
 * Launch the starter as a DETACHED process, the way seeding and the codebase survey are launched.
 *
 * A cold start pays for a uvx download plus model load and routinely outlives any hook's timeout,
 * so it cannot be awaited inline: the harness would kill the hook mid-start and the daemon would
 * never come up. The child outlives this process and keeps going.
 *
 * One spawn per cold start is the goal, and `ensureDaemon` is what holds a burst of callers to it.
 * The starter also re-checks health, so a spawn that slips through anyway leaves the daemon the
 * winner started alone — but racing starters are not free: they queue on the profile's file lock.
 */
export function startDaemonDetached(
  cfg: Config,
  harness: string,
  spawnFn: typeof realSpawn = realSpawn
): void {
  try {
    const starter = join(dirname(fileURLToPath(import.meta.url)), "daemon-start.js");
    const child = spawnFn(nodeBinary(), [starter, "--harness", harness], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // The caller's config is already resolved for its directory and bank. Re-reading the file in
      // the starter lost `paths` / `banks` overrides, so a daemon enabled only there never started
      // (#6334).
      env: { ...process.env, [DAEMON_CONFIG_ENV]: JSON.stringify(cfg) },
    });
    // spawn() failures often surface ASYNCHRONOUSLY as an 'error' event; unhandled, that would
    // crash the hook.
    child.on("error", () => {});
    child.unref();
    diag(harness, "daemon_start_spawned", { apiUrl: cfg.apiUrl });
  } catch {
    /* best-effort: a failed spawn must not break the caller */
  }
}

/**
 * Cold starts currently in flight, keyed by API URL.
 *
 * Every ensure point re-checks health and starts its own daemon when the port is dead, and the
 * persistent-plugin hosts fire several of them within the same tick — one SessionStart per session
 * plus a Stop per finished turn. Each of them therefore observes the same dead port before the
 * first daemon answers, and each spawns a starter of its own. The starters then serialise on the
 * profile's file lock, where the losers sit for the full 300 s lock budget before failing
 * (#1155, #3100). One entry per URL collapses that burst onto a single spawn.
 *
 * Keyed by URL rather than held as a module singleton because a caller may be pointed at any
 * daemon port. The entry is dropped as soon as its attempt settles, so a later turn that still
 * finds the port dead starts a fresh attempt instead of inheriting a spent one.
 *
 * Module-global, and deliberately without a lock: Node runs one thread, and the check-then-set
 * below contains no `await`, so two callers cannot interleave between the `get` and the `set`.
 */
const coldStarts = new Map<string, Promise<boolean>>();

/**
 * Await `p` for at most `ms`. The timer is cleared on the way out: a follower that gives up early
 * must not leave an abandoned `setTimeout` holding the hook process open behind it.
 */
async function waitBounded(p: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(ms, 0));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check whether memory can proceed, optionally requesting a detached start in daemon mode.
 * Remote APIs use the memory client's normal request handling.
 *
 * `waitMs` bounds how long the caller is willing to block for a cold start — always well under the
 * calling hook's own timeout, so a slow start costs memory for one turn rather than a killed hook.
 *
 * A start already underway is joined rather than duplicated; see `coldStarts`.
 */
export async function ensureDaemon(
  cfg: Config,
  harness: string,
  opts: { waitMs?: number; spawnFn?: typeof realSpawn } = {}
): Promise<boolean> {
  if (await isHookServerReady(cfg)) return true;
  if (cfg.serverMode !== "daemon") return false;
  if (!cfg.daemonAutoStart) {
    noteAutoStartDeclined(cfg, harness, "disabled");
    return false;
  }
  if (!daemonProfileProvisioned(cfg)) {
    noteAutoStartDeclined(cfg, harness, "unprovisioned");
    return false;
  }

  const waitMs = opts.waitMs ?? 0;
  const running = coldStarts.get(cfg.apiUrl);
  if (running) {
    // Join the start already underway instead of spawning a competitor, so a burst costs one
    // starter rather than one per caller. Never for longer than this caller's own budget — a Stop
    // hook waiting 40 s must not push a SessionStart hook past its 30 s timeout — and whatever is
    // left of that budget once the shared attempt settles goes on waiting for the daemon the
    // attempt set in motion, so joining never leaves a caller with less patience than it would
    // have had on its own.
    const startedAt = Date.now();
    if (waitMs <= 0) return false;
    if (await waitBounded(running, waitMs)) return true;
    const remaining = waitMs - (Date.now() - startedAt);
    return remaining > 0 && (await waitForHealth(cfg.apiUrl, remaining));
  }

  const attempt = (async () => {
    startDaemonDetached(cfg, harness, opts.spawnFn);
    return waitForHealth(cfg.apiUrl, waitMs);
  })();
  coldStarts.set(cfg.apiUrl, attempt);
  try {
    return await attempt;
  } finally {
    // Only the owner clears the entry, so a follower can never drop a newer attempt's guard.
    if (coldStarts.get(cfg.apiUrl) === attempt) coldStarts.delete(cfg.apiUrl);
  }
}

/** Poll /health until it answers or the budget runs out. `budgetMs <= 0` means "don't wait". */
export async function waitForHealth(
  baseUrl: string,
  budgetMs: number,
  pollMs = 1_000
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await isServerHealthy(baseUrl)) return true;
  }
  return false;
}

/** The two things daemon mode cannot work without. Reported, never thrown. */
export function preflightDaemon(cfg: Config, harness: string): boolean {
  if (!hasUvx()) {
    diag(harness, "daemon_uvx_missing", { apiUrl: cfg.apiUrl });
    log.warn(harness, "daemon mode needs `uv` on PATH — see https://docs.astral.sh/uv/");
    return false;
  }
  if (!hasRustToolchain()) {
    diag(harness, "daemon_rust_missing", { platform: process.platform });
    log.warn(
      harness,
      "daemon mode on macOS needs a current Rust toolchain (litellm ships no macOS wheel) — " +
        "install from https://rustup.rs, then `rustup default stable && rustup update`"
    );
    return false;
  }
  if (!detectLlm()) {
    diag(harness, "daemon_no_llm", {});
    log.warn(
      harness,
      "daemon mode needs an LLM for fact extraction — set OPENAI_API_KEY (or ANTHROPIC_API_KEY / " +
        "GEMINI_API_KEY / HINDSIGHT_API_LLM_PROVIDER)"
    );
    return false;
  }
  return true;
}
