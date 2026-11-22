/**
 * Local management: the control plane's bridge to `hindsight-embed ops`.
 *
 * The control plane is the browser UI for this machine's Hindsight stack — the
 * memory banks, and now the profile and processes that feed them. The
 * implementation of those operations stays in Python (`hindsight-embed ops`),
 * and this module runs it and returns its JSON.
 *
 * Two deliberate choices:
 *
 * 1. A SUBPROCESS, not a reimplementation. The Python side owns the daemon
 *    lifecycle, which carries platform behaviour with no Node equivalent:
 *    Windows kernel queries for the owning PID of a port (`GetExtendedTcpTable`,
 *    `NtQueryInformationProcess`), the detached-process flag combination that
 *    keeps uvx's children from opening a console window, and the cross-platform
 *    profile lock. Those exist because of specific upstream bugs, and the hosts
 *    that would reproduce them are exactly the hosts a rewrite cannot be tested
 *    on in CI. Reimplementing them in TypeScript reintroduces the bugs; calling
 *    the CLI keeps one implementation.
 *
 * 2. READ-ONLY OPERATIONS ARE CACHED BRIEFLY, MUTATIONS ARE NOT. The page polls
 *    status, and every poll would otherwise pay a ~0.4 s interpreter start. A
 *    mutation clears the cache, so a save is visible on the next read rather
 *    than after the TTL.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** How long a read-only result is reused. Short: status is polled every 4s. */
const READ_CACHE_MS = 2000;

/** A cold `ops` call is an interpreter start plus the manager's imports. */
const OPS_TIMEOUT_MS = 120_000;

export class OpsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsUnavailableError";
  }
}

interface CacheEntry {
  at: number;
  value: unknown;
}

const readCache = new Map<string, CacheEntry>();

/** Clear cached reads. Called after every mutation and by the refresh route. */
function invalidateOpsCache(): void {
  readCache.clear();
}

/**
 * Resolve the embed executable.
 *
 * `HINDSIGHT_CP_EMBED_COMMAND` wins: the launcher that started this control
 * plane knows which embed it belongs to (a uv venv, a `uvx` shim, a checkout),
 * and the control plane has no reliable way to rediscover it. Without it, the
 * venv beside this package and then PATH are tried — the same order the embed
 * manager uses for its own binaries.
 */
export function resolveEmbedCommand(
  env: Record<string, string | undefined> = process.env
): string[] {
  const override = env.HINDSIGHT_CP_EMBED_COMMAND?.trim();
  if (override) return splitCommand(override);

  const isWindows = process.platform === "win32";
  const exe = isWindows ? "hindsight-embed.exe" : "hindsight-embed";
  const scripts = isWindows ? "Scripts" : "bin";

  const candidates: string[] = [];
  if (env.VIRTUAL_ENV) candidates.push(join(env.VIRTUAL_ENV, scripts, exe));
  // The standalone CLI changes cwd into <package>/standalone. Walk ancestors
  // so a checkout's .venv remains discoverable when the UI is started directly.
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    candidates.push(join(dir, ".venv", scripts, exe));
    if (dirname(dir) === dir) break;
  }
  candidates.push(join(homedir(), ".local", "bin", exe));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return [candidate];
  }
  return [exe];
}

/**
 * Split a configured command line on whitespace, honoring double quotes.
 *
 * Not `shell: true`: the value can carry a path with spaces (a Windows
 * `C:\Program Files\…`), and passing the string to a shell would then need
 * quoting rules this module would have to get right per platform.
 */
function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of command) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : ["hindsight-embed"];
}

/** Run one `ops` command and return its decoded JSON document. */
async function runOps<T>(command: string, args: string[], body?: unknown): Promise<T> {
  const [exe, ...base] = resolveEmbedCommand();
  const argv = [...base, "ops", command, ...args];

  try {
    const stdout = await execOps(exe, argv, body === undefined ? undefined : JSON.stringify(body));
    return JSON.parse(stdout) as T;
  } catch (error) {
    // A non-zero exit still prints a JSON error document (see ops/cli.py), so
    // prefer that message: it says what actually went wrong, where stderr may
    // carry only a Python traceback header.
    if (error instanceof OpsCallError) {
      const parsed = parseErrorDocument(error.stdout);
      if (parsed) throw new Error(parsed);
      if (error.code === "ENOENT" || /ENOENT/.test(error.message)) {
        throw new OpsUnavailableError(
          `hindsight-embed was not found (tried "${exe}"). Set HINDSIGHT_CP_EMBED_COMMAND to its path.`
        );
      }
      throw new Error(error.stderr.trim() || error.message);
    }
    throw error;
  }
}

/** A failed `ops` child, carrying the streams the caller needs to explain it. */
class OpsCallError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly code?: number | string
  ) {
    super(message);
    this.name = "OpsCallError";
  }
}

/**
 * Spawn one `ops` process, optionally feeding it a JSON request on stdin, and
 * resolve with its stdout.
 *
 * `spawn` rather than `execFile` because mutating commands read their request
 * document from stdin, and `execFile` cannot write to a child's stdin. Both
 * streams are captured as UTF-8 explicitly: the documents carry Chinese profile
 * names, and a Windows child otherwise emits the console code page, which
 * decodes as mojibake.
 */
function execOps(exe: string, argv: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, argv, { windowsHide: true, stdio: "pipe" });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };

    // A cold interpreter start plus the manager's imports; a hung daemon start
    // is bounded by the manager's own timeout, which is longer still.
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`hindsight-embed ops did not finish within ${OPS_TIMEOUT_MS}ms`));
    }, OPS_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      // Guard against a runaway document eating memory before the timeout fires.
      if (stdout.length > 8 * 1024 * 1024) {
        child.kill();
        finish(new Error("hindsight-embed ops output exceeded 8 MiB"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish(null, stdout);
      else
        finish(
          new OpsCallError(
            `hindsight-embed ops exited with code ${code}`,
            stdout,
            stderr,
            code ?? undefined
          )
        );
    });

    if (input !== undefined) {
      child.stdin.end(input, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

function parseErrorDocument(stdout: string | undefined): string | undefined {
  if (!stdout) return undefined;
  try {
    const doc = JSON.parse(stdout) as { error?: unknown };
    return typeof doc.error === "string" ? doc.error : undefined;
  } catch {
    return undefined;
  }
}

/** Memoize a read-only call. Keyed by command + profile so profiles stay separate. */
async function readCached<T>(command: string, args: string[]): Promise<T> {
  const key = [command, ...args].join("\u0000");
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_MS) return hit.value as T;
  const value = await runOps<T>(command, args);
  readCache.set(key, { at: Date.now(), value });
  return value;
}

function profileArgs(profile: string): string[] {
  return profile ? ["--profile", profile] : [];
}

/**
 * `default` and `""` both address the embed's default profile.
 *
 * Exported because the profile id is part of this module's contract, not an
 * internal detail: callers building a request (and the tests asserting how the
 * `default` alias is resolved) need the same mapping the commands apply.
 */
export function normalizeProfile(name: string | null | undefined): string {
  if (name === null || name === undefined) return "";
  const trimmed = name.trim();
  return trimmed === "" || trimmed === "default" ? "" : trimmed;
}

// ── read-only operations ───────────────────────────────────────────────────

interface OpsProfileSummary {
  name: string;
  display_name: string;
  port: number;
  is_active: boolean;
  daemon_running: boolean;
  provider: string | null;
  model: string | null;
  has_api_key: boolean;
}

export function listProfiles(): Promise<{ profiles: OpsProfileSummary[] }> {
  return readCached("profiles", []);
}

interface OpsProfileConfig {
  name: string;
  display_name: string;
  provider: string | null;
  model: string | null;
  base_url: string | null;
  api_key_masked: string | null;
  has_api_key: boolean;
  api_port: number;
  ui_port: number;
  ui_port_is_default: boolean;
  api_version: string | null;
  cp_version: string | null;
}

export function getProfileConfig(profile: string): Promise<OpsProfileConfig> {
  return readCached("config", profileArgs(normalizeProfile(profile)));
}

interface OpsOptionLabel {
  value: string;
  label: string;
  label_zh: string;
}

interface OpsSettingField {
  key: string;
  label: string;
  kind: string;
  value: string;
  default: string;
  description: string;
  options: string[];
  placeholder: string;
  is_set: boolean;
  label_zh: string;
  description_zh: string;
  option_labels: OpsOptionLabel[];
}

interface OpsSettingGroup {
  id: string;
  label: string;
  description: string;
  label_zh: string;
  description_zh: string;
  fields: OpsSettingField[];
}

interface OpsSettings {
  name: string;
  display_name: string;
  groups: OpsSettingGroup[];
  unset_required: string[];
}

export function getSettings(profile: string): Promise<OpsSettings> {
  return readCached("settings", profileArgs(normalizeProfile(profile)));
}

interface OpsEnvFile {
  name: string;
  display_name: string;
  path: string;
  content: string;
  exists: boolean;
}

export function getEnvFile(profile: string): Promise<OpsEnvFile> {
  return readCached("env", profileArgs(normalizeProfile(profile)));
}

interface OpsPaths {
  name: string;
  display_name: string;
  port: number;
  config_path: string;
  log_path: string;
  lock_path: string;
  database_url: string;
  database_path: string | null;
  daemon_url: string;
  ui_url: string;
}

export function getPaths(profile: string): Promise<OpsPaths> {
  return readCached("paths", profileArgs(normalizeProfile(profile)));
}

interface OpsHealth {
  api_ok: boolean;
  api_detail: string;
  api_detail_zh: string;
  api_port: number;
  api_url: string;
}

export function getHealth(profile: string): Promise<OpsHealth> {
  // Not cached: the point of the health probe is that it is live.
  return runOps("health", profileArgs(normalizeProfile(profile)));
}

interface OpsDaemonStatus {
  ok: boolean;
  running: boolean;
  url: string | null;
  message: string;
  message_zh: string;
}

export function getDaemonStatus(profile: string): Promise<OpsDaemonStatus> {
  return readCached("daemon-status", profileArgs(normalizeProfile(profile)));
}

interface OpsLogTail {
  path: string;
  exists: boolean;
  content: string;
}

export function getLogs(profile: string, lines: number, source: string): Promise<OpsLogTail> {
  return runOps("logs", [
    ...profileArgs(normalizeProfile(profile)),
    "--lines",
    String(lines),
    "--source",
    source === "ui" ? "ui" : "daemon",
  ]);
}

// ── mutations ──────────────────────────────────────────────────────────────

export function saveSettings(
  profile: string,
  values: Record<string, string>
): Promise<OpsSettings> {
  invalidateOpsCache();
  return runOps("save-settings", profileArgs(normalizeProfile(profile)), { values });
}

export interface SaveConfigRequest {
  provider?: string;
  api_key?: string;
  model?: string;
  base_url?: string;
  api_port?: string;
  ui_port?: string;
  api_version?: string;
  cp_version?: string;
}

export function saveConfig(profile: string, body: SaveConfigRequest): Promise<OpsProfileConfig> {
  invalidateOpsCache();
  return runOps("save-config", profileArgs(normalizeProfile(profile)), body);
}

export function writeEnvFile(profile: string, content: string): Promise<OpsEnvFile> {
  invalidateOpsCache();
  return runOps("write-env", profileArgs(normalizeProfile(profile)), { content });
}

interface OpsDeleteResult {
  ok: boolean;
  message: string;
  message_zh: string;
}

export function deleteProfile(profile: string): Promise<OpsDeleteResult> {
  invalidateOpsCache();
  return runOps("delete-profile", profileArgs(normalizeProfile(profile)));
}

export function daemonAction(profile: string, action: string): Promise<OpsDaemonStatus> {
  invalidateOpsCache();
  const command = { start: "daemon-start", stop: "daemon-stop", restart: "daemon-restart" }[action];
  if (!command) throw new Error(`unknown daemon action '${action}'`);
  return runOps(command, profileArgs(normalizeProfile(profile)));
}
