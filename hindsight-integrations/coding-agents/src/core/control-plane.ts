/**
 * Local control plane lifecycle and the desktop agents' control entry helper.
 *
 * The management UI for a local install used to be two things: the control plane
 * (Next.js, memory banks) and `hindsight-embed`'s own control center (port 7878,
 * profile settings and the daemon). They are now one. The control center is
 * gone, and its operations live in the control plane's `/local` page, which
 * calls `hindsight-embed ops` (see that package's `ops/cli.py`).
 *
 * WHY THE CONTROL CENTER WENT: it was a second UI over the same stack — a second
 * URL, a second access token, a second process to supervise — and the settings a
 * user changed lived in the one that did not show their memories. Nothing it did
 * needed a persistent process of its own: every operation was already a
 * `hindsight-embed` command underneath.
 *
 * WHAT REPLACED `ensureControlCenterStarted`: `ensureControlPlaneStarted`, which
 * starts the control plane the same way (an embed CLI subprocess) and reports the
 * same shape. Callers that used to warm 7878 now warm the UI the user actually
 * opens, and the daemon's own status stays with `ensureDaemon`.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { Config } from "./config";
import { daemonEnv, isServerHealthy } from "./daemon";
import { diag } from "./diag";
import { log } from "./log";
import type { ToolSpec } from "./page-tools";

const execFileAsync = promisify(execFile);

/** How long a health probe may take. The UI answers /api/health quickly. */
const CONTROL_HEALTH_TIMEOUT_MS = 1200;
/** A cold UI start is an npx/npm resolution plus a Next.js boot. */
const CONTROL_START_TIMEOUT_MS = 90_000;
/** A stop is a kill plus the CLI's own wait; well under the start budget. */
const CONTROL_STOP_TIMEOUT_MS = 20_000;

/**
 * The control plane's port for a profile: the daemon port plus a fixed offset,
 * matching `profile_manager.UI_PORT_OFFSET`. Reused rather than asked for,
 * because the answer must be available before the UI is running (to probe it),
 * and the embed CLI applies the same derivation.
 */
const CONTROL_PORT_OFFSET = 10_000;

export function resolveControlPlanePort(cfg: Config): number {
  const envPort = Number.parseInt(process.env.HINDSIGHT_EMBED_CP_PORT?.trim() ?? "", 10);
  if (Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535) return envPort;
  return cfg.apiPort + CONTROL_PORT_OFFSET;
}

export function buildControlPlaneUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** `/local` is the management page the retired control center's settings moved to. */
export function buildLocalSettingsUrl(port: number): string {
  return `${buildControlPlaneUrl(port)}/local`;
}

export async function isControlPlaneHealthy(port: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONTROL_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface ControlPlaneStatus {
  running: boolean;
  port: number;
  url: string;
  /** The local-management page; equal to `url` when the UI is down. */
  localUrl: string;
}

/**
 * The start currently in flight, if any.
 *
 * This dedupes CONCURRENT callers only — the host fires ensure at plugin load, at
 * every session start, and again from the panel's refresh trigger, all before the
 * first attempt settles. It deliberately holds nothing once the attempt is over:
 * the point of a later call (in particular the refresh button) is to observe the
 * ports again, so a settled attempt must never answer for it. Memoizing the
 * settled result made every later refresh return the first attempt's
 * `running: true` without starting anything.
 */
let _inflightStart: Promise<ControlPlaneStatus> | null = null;

/**
 * Start the control plane if it is not already healthy.
 *
 * Never throws: host startup must not fail if the optional UI fails to bind.
 */
export function ensureControlPlaneStarted(
  cfg: Config,
  harness: string,
  opts: { openBrowser?: boolean; port?: number } = {}
): Promise<ControlPlaneStatus> {
  // An explicit open is a user action against the live machine; it always re-checks.
  if (opts.openBrowser) return _ensureControlPlaneStartedImpl(cfg, harness, opts);
  if (_inflightStart) return _inflightStart;
  // Compared against the WRAPPED promise, which is the one stored: comparing it
  // with the inner one never matches, leaving the entry set forever.
  const attempt = _ensureControlPlaneStartedImpl(cfg, harness, opts);
  const tracked = attempt.finally(() => {
    if (_inflightStart === tracked) _inflightStart = null;
  });
  _inflightStart = tracked;
  return tracked;
}

function resolveRepoRootFromStaged(): string | undefined {
  try {
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const originPath = join(pkgRoot, ".install-origin.json");
    if (existsSync(originPath)) {
      const origin = JSON.parse(readFileSync(originPath, "utf8")) as { source?: string };
      if (origin.source) return join(origin.source, "..", "..");
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function resolveEmbedCommand(cfg: Config): Promise<[string, ...string[]]> {
  if (!cfg.embedPackagePath) {
    const exeName = process.platform === "win32" ? "hindsight-embed.exe" : "hindsight-embed";
    const binDir = process.platform === "win32" ? "Scripts" : "bin";
    const repoRoot = resolveRepoRootFromStaged();
    if (repoRoot) {
      const venvEmbed = join(repoRoot, ".venv", binDir, exeName);
      if (existsSync(venvEmbed)) return [venvEmbed];
    }
    // Magpie's independently bundled entry lives deeper in this checkout and
    // has no staged-install marker. Prefer that checkout's installed embed too.
    for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
      const venvEmbed = join(dir, ".venv", binDir, exeName);
      if (existsSync(venvEmbed)) return [venvEmbed];
      if (dirname(dir) === dir) break;
    }
    const localEmbed = join(homedir(), ".local", "bin", exeName);
    if (existsSync(localEmbed)) return [localEmbed];
  }

  const { getEmbedCommand } = await import("@vectorize-io/hindsight-all");
  const [cmd, ...baseArgs] = getEmbedCommand({
    embedVersion: cfg.embedVersion,
    embedPackagePath: cfg.embedPackagePath,
  });

  if (cmd === "uvx") {
    const uvxName = process.platform === "win32" ? "uvx.exe" : "uvx";
    for (const candidate of [
      join(homedir(), ".local", "bin", uvxName),
      join(homedir(), ".cargo", "bin", uvxName),
    ]) {
      if (existsSync(candidate)) return [candidate, ...baseArgs];
    }
  }
  return [cmd, ...baseArgs];
}

async function _ensureControlPlaneStartedImpl(
  cfg: Config,
  harness: string,
  opts: { openBrowser?: boolean; port?: number } = {}
): Promise<ControlPlaneStatus> {
  const port = opts.port ?? resolveControlPlanePort(cfg);
  const url = buildControlPlaneUrl(port);
  const localUrl = buildLocalSettingsUrl(port);

  if (!opts.openBrowser && (await isControlPlaneHealthy(port))) {
    return { running: true, port, url, localUrl };
  }

  try {
    const [cmd, ...baseArgs] = await resolveEmbedCommand(cfg);
    // `ui start` ensures the daemon first (the page reads banks from it), then
    // starts the standalone server. `--hostname 127.0.0.1` is deliberate for a
    // UI whose /local page controls local processes: the routes are gated, but a
    // loopback bind removes the LAN from the path entirely. A user who wants the
    // UI on the network runs `hindsight-embed ui start --hostname 0.0.0.0`
    // themselves, which is an explicit choice rather than a side effect of
    // starting memory.
    const args = [
      ...baseArgs,
      "ui",
      "start",
      "--profile",
      cfg.daemonProfile,
      "--port",
      String(port),
      "--hostname",
      "127.0.0.1",
    ];

    await execFileAsync(cmd, args, {
      env: daemonEnv(cfg),
      timeout: CONTROL_START_TIMEOUT_MS,
      windowsHide: true,
    });

    const running = await isControlPlaneHealthy(port);
    if (running) {
      log.info(harness, `control plane ready at ${url}`);
      diag(harness, "control_plane_started", { port, url });
    } else {
      log.warn(harness, `control plane did not answer /api/health on port ${port}`);
    }
    return { running, port, url, localUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(harness, `control plane start skipped: ${message}`);
    diag(harness, "control_plane_failed", { port, error: message });
    return { running: await isControlPlaneHealthy(port), port, url, localUrl };
  }
}

/**
 * Stop the control plane for this profile.
 *
 * Returns true when the stop command succeeded. Never throws: the caller
 * (`/restart`) decides whether the port actually came free, which is the only
 * outcome that matters and is observable independently of this exit status.
 *
 * This exists because `ensureControlPlaneStarted` cannot replace a running UI —
 * it only starts what is down. A process left from a previous install keeps
 * serving the bundle it was built with, so a rebuilt UI never reaches the browser
 * and a settings change appears to do nothing.
 */
export async function stopControlPlane(
  cfg: Config,
  opts: { port?: number } = {}
): Promise<boolean> {
  const [cmd, ...baseArgs] = await resolveEmbedCommand(cfg);
  const args = [...baseArgs, "ui", "stop", "--profile", cfg.daemonProfile];
  if (opts.port !== undefined) args.push("--port", String(opts.port));
  await execFileAsync(cmd, args, {
    env: daemonEnv(cfg),
    timeout: CONTROL_STOP_TIMEOUT_MS,
    windowsHide: true,
  });
  return true;
}

/**
 * Shared `hindsight_control_plane` tool spec exposed to desktop agents (DSH,
 * Codex, Antigravity, ZCode): backend status plus the local management URL.
 *
 * The name and payload keep their shape from the control-center era (`running`,
 * `url`) so a panel that reads them needs no change for the endpoint swap; the
 * fields naming the control center are gone, not renamed, because a stale field
 * is worse than an absent one.
 */
export function controlPlaneToolSpec(cfg: Config, harness: string): ToolSpec {
  return {
    name: "hindsight_control_plane",
    description:
      "Inspect local Hindsight backend status and return (or open) the local control plane, including its local settings page.",
    inputSchema: {
      open: z
        .boolean()
        .optional()
        .describe("If true, open the local settings page in the default browser."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const openBrowser = Boolean(args.open);
      const daemonHealthy = await isServerHealthy(cfg.apiUrl);
      const cp =
        cfg.serverMode === "daemon"
          ? await ensureControlPlaneStarted(cfg, harness, { openBrowser })
          : {
              running: await isControlPlaneHealthy(resolveControlPlanePort(cfg)),
              port: resolveControlPlanePort(cfg),
              url: buildControlPlaneUrl(resolveControlPlanePort(cfg)),
              localUrl: buildLocalSettingsUrl(resolveControlPlanePort(cfg)),
            };

      const payload = {
        server_mode: cfg.serverMode,
        daemon_healthy: daemonHealthy,
        api_url: cfg.apiUrl,
        control_plane_running: cp.running,
        control_plane_url: cp.url,
        local_settings_url: cp.localUrl,
        profile_log: join(homedir(), ".hindsight", "profiles", `${cfg.daemonProfile}.log`),
        plugin_log: join(homedir(), ".hindsight", "coding-agents-logs", "plugin.log"),
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  };
}
