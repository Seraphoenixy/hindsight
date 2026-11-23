/**
 * Run `hindsight-embed ops` from the plugin.
 *
 * The control plane is not the only owner of the local install: the Magpie
 * plugin needs the same operations (read settings, write settings, restart the
 * daemon) without requiring the UI to be running. This module owns the command
 * resolution once, so every caller finds the same embed binary — the repo's
 * `.venv` during development, a staged install, or a published package through
 * `@vectorize-io/hindsight-all`.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config";
import { daemonEnv } from "./daemon";

/** The default budget for an ops read/write. A daemon restart asks for longer. */
export const OPS_TIMEOUT_MS = 30_000;

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

/**
 * Find the `hindsight-embed` command, plus any leading arguments a wrapper
 * needs (e.g. `uvx hindsight-embed@latest`).
 */
export async function resolveEmbedCommand(cfg: Config): Promise<[string, ...string[]]> {
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

export interface RunOpsOptions {
  /** JSON request document for a mutating command. */
  input?: unknown;
  timeoutMs?: number;
}

/**
 * Run one ops command and resolve with its stdout.
 *
 * A non-zero exit still prints a JSON error document (see ops/cli.py), so the
 * rejection carries that message rather than a bare exit code. The caller is
 * usually going to show it to the user.
 */
export async function runEmbedOps(
  cfg: Config,
  args: string[],
  options: RunOpsOptions = {}
): Promise<string> {
  const [cmd, ...base] = await resolveEmbedCommand(cfg);
  const timeoutMs = options.timeoutMs ?? OPS_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...base, "ops", ...args], {
      env: { ...process.env, ...daemonEnv(cfg) },
      stdio: "pipe",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`hindsight-embed ops did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish(
          new Error(
            `hindsight-embed was not found (tried "${cmd}"). Set HINDSIGHT_CP_EMBED_COMMAND or embedPackagePath.`
          )
        );
        return;
      }
      finish(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      let message = stderr.trim() || `hindsight-embed ops exited with code ${code}`;
      try {
        const parsed = JSON.parse(stdout) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) message = parsed.error;
      } catch {
        // stdout was not a JSON error document; keep stderr.
      }
      finish(new Error(message));
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(options.input));
  });
}
