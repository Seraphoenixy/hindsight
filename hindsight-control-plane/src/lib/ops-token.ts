/**
 * The ops token, as seen by the control plane.
 *
 * `hindsight-embed` owns the token: it generates one on first use and persists
 * it at `~/.hindsight/ops.token`. This module reads it through the CLI rather
 * than reimplementing the file layout, and caches it for the process lifetime.
 *
 * Where it goes: only into the HTML of the `/local` page, as a prop on the client
 * component. It is never in a GET response the browser fetches on its own and
 * never in a header it could replay to another origin, so a page on any other
 * site cannot read it — no CORS applies to server-rendered HTML.
 *
 * Why cache: it is read on every local-management request, and each read would
 * otherwise cost an interpreter start. `invalidateOpsToken()` is what a route
 * calls when the CLI reports the token is wrong.
 */
import { spawn } from "node:child_process";
import { resolveEmbedCommand } from "./ops";

let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

/** Drop the cached token so the next call re-reads it from the CLI. */
export function invalidateOpsToken(): void {
  cached = null;
}

/**
 * Return the ops token, or null when the embed CLI cannot supply one.
 *
 * Never throws: a missing embed is a state the page has to render ("local
 * management unavailable, here is how to enable it"), not an exception that
 * turns every request into a 500.
 */
export async function getOrCreateOpsToken(): Promise<string | null> {
  if (cached) return cached;
  // A burst of parallel requests (the page loads its panels concurrently) must
  // not spawn one interpreter each. Without this, first paint costs N × 0.4 s.
  if (inflight) return inflight;

  inflight = (async () => {
    const [exe, ...base] = resolveEmbedCommand();
    try {
      const stdout = await spawnCapture(exe, [...base, "ops", "token"]);
      const doc = JSON.parse(stdout) as { token?: unknown };
      cached = typeof doc.token === "string" && doc.token ? doc.token : null;
    } catch {
      cached = null;
    } finally {
      inflight = null;
    }
    return cached;
  })();

  return inflight;
}

/** Minimal capture helper: the token command is short and cannot need a body. */
function spawnCapture(exe: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `exited with code ${code}`));
    });
  });
}
