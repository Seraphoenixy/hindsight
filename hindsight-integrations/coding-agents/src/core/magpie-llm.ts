/**
 * Follow the LLM Magpie already serves, instead of asking the user to configure
 * Hindsight's model by hand.
 *
 * Magpie writes its gateway into Codex's `config.toml`:
 *
 *     model = "codearts/deepseek-v4.1-flash-1017"
 *     [model_providers.magpie]
 *     base_url = "http://127.0.0.1:3425/v1"
 *     experimental_bearer_token = "magpie"
 *     wire_api = "responses"
 *
 * That is a normal OpenAI-compatible endpoint on loopback, and every model the
 * gateway lists also answers `/v1/responses`, so Hindsight can use the
 * `openai-responses` provider without an external key. The gateway is verified
 * (it must look like Magpie, and it must be loopback) before anything is written.
 *
 * OWNERSHIP RULES. Auto-onboarding must not fight a user who configured
 * Hindsight themselves. The profile is ours to write only when it has no LLM
 * provider yet, or when its provider/base/model still equal the values this
 * module last wrote. Anything else is "manual": reported, never overwritten
 * without an explicit action from the plugin page.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Config } from "./config";
import { isServerHealthy } from "./daemon";
import { runEmbedOps } from "./embed-ops";

export const ENV_LLM_PROVIDER = "HINDSIGHT_API_LLM_PROVIDER";
export const ENV_LLM_API_KEY = "HINDSIGHT_API_LLM_API_KEY";
export const ENV_LLM_BASE_URL = "HINDSIGHT_API_LLM_BASE_URL";
export const ENV_LLM_MODEL = "HINDSIGHT_API_LLM_MODEL";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DISCOVERY_TTL_MS = 30_000;
const RESTART_TIMEOUT_MS = 120_000;

export interface MagpieLlm {
  provider: "openai-responses" | "openai";
  baseUrl: string;
  apiKey: string;
  /** The model Hindsight should use (host model, or the page's fixed choice). */
  model: string;
  /** The model Codex is currently set to, for display and change detection. */
  hostModel: string;
  models: string[];
  configPath: string;
}

export type LlmStatus = "synced" | "pending" | "updated" | "manual" | "unavailable" | "error";

export interface LlmState {
  status: LlmStatus;
  mode: "follow" | "fixed";
  hostModel: string | null;
  configuredModel: string | null;
  provider: string | null;
  models: string[];
  restartRequired: boolean;
  message: string;
  checkedAt: number;
}

interface DiscoveryOk {
  ok: true;
  llm: MagpieLlm;
  mtimeMs: number;
}

interface DiscoveryFailure {
  ok: false;
  status: "unavailable" | "error";
  message: string;
  hostModel: string | null;
  mtimeMs?: number;
}

export type Discovery = DiscoveryOk | DiscoveryFailure;

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  codexConfigPath?: string;
  model?: string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  noCache?: boolean;
}

export interface ProfileLlm {
  exists: boolean;
  path: string;
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface ManagedLlmState {
  profile: string;
  provider: string;
  baseUrl: string;
  model: string;
  mode: "follow" | "fixed";
  appliedAt: string;
  restartRequired: boolean;
  /** The values replaced by first-time onboarding, kept for transparency. */
  adoptedFrom?: { provider: string; baseUrl: string; model: string };
}

interface ManagedFile {
  version: 1;
  profiles: Record<string, ManagedLlmState>;
}

export interface SyncOptions extends DiscoveryOptions {
  /** Omitted on the automatic path: keep the mode from the last applied state. */
  mode?: "follow" | "fixed";
  /** Required for `mode: "fixed"`; null/empty means the host's current model. */
  model?: string | null;
  /** The page's explicit action may replace a manually configured profile. */
  force?: boolean;
  /** The page's explicit action also applies the change to a running daemon. */
  restart?: boolean;
  runOps?: typeof runEmbedOps;
  healthy?: (url: string) => Promise<boolean>;
}

let _queue: Promise<unknown> = Promise.resolve();
let _cache: { key: string; at: number; value: Discovery } | undefined;
let _lastAuto: { key: string; at: number; value: LlmState } | undefined;

/** Tests and the explicit action use this to bypass the short status cache. */
export function clearMagpieLlmCache(): void {
  _cache = undefined;
  _lastAuto = undefined;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

export function profileEnvPath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = homeDir(env);
  return profile && profile !== "default"
    ? join(root, ".hindsight", "profiles", `${profile}.env`)
    : join(root, ".hindsight", "embed");
}

export function managedStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDir(env), ".hindsight", "magpie", "llm.json");
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homeDir(env), ".codex");
  return join(codexHome, "config.toml");
}

/** Minimal KEY=VALUE reader for the profile's .env; comments and blanks are ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function readProfileLlm(profile: string, env: NodeJS.ProcessEnv = process.env): ProfileLlm {
  const path = profileEnvPath(profile, env);
  if (!existsSync(path)) {
    return { exists: false, path, provider: "", baseUrl: "", model: "", hasApiKey: false };
  }
  const values = parseEnvFile(readFileSync(path, "utf8"));
  return {
    exists: true,
    path,
    provider: (values[ENV_LLM_PROVIDER] ?? "").trim(),
    baseUrl: (values[ENV_LLM_BASE_URL] ?? "").trim().replace(/\/+$/, ""),
    model: (values[ENV_LLM_MODEL] ?? "").trim(),
    hasApiKey: Boolean((values[ENV_LLM_API_KEY] ?? "").trim()),
  };
}

export function readManagedState(
  profile: string,
  env: NodeJS.ProcessEnv = process.env
): ManagedLlmState | undefined {
  try {
    const file = JSON.parse(readFileSync(managedStatePath(env), "utf8")) as ManagedFile;
    return file.profiles?.[profile];
  } catch {
    return undefined;
  }
}

function writeManagedState(profile: string, state: ManagedLlmState, env: NodeJS.ProcessEnv): void {
  const path = managedStatePath(env);
  let file: ManagedFile = { version: 1, profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ManagedFile;
    if (parsed?.version === 1 && parsed.profiles && typeof parsed.profiles === "object")
      file = parsed;
  } catch {
    // A missing or unreadable state file is the same as no history.
  }
  file.profiles[profile] = state;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function fail(
  status: "unavailable" | "error",
  message: string,
  hostModel: string | null,
  mtimeMs?: number
): DiscoveryFailure {
  return { ok: false, status, message, hostModel, mtimeMs };
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("gateway URL must be http(s)");
  if (!LOOPBACK_HOSTS.has(url.hostname))
    throw new Error("gateway is not on loopback; refusing to send the local token off-machine");
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/backend-api/codex"))
    path = path.slice(0, -"/backend-api/codex".length) + "/v1";
  if (!path) path = "/v1";
  return `${url.origin}${path}`;
}

function modelIds(payload: unknown): { models: string[]; magpie: boolean } {
  const items =
    payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : [];
  const models: string[] = [];
  let magpie = false;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id === "string" && entry.id.trim()) models.push(entry.id.trim());
    if (typeof entry.magpie_label === "string" || Array.isArray(entry.native_endpoints))
      magpie = true;
  }
  return { models, magpie };
}

/**
 * Read the Magpie gateway from Codex's config and verify it answers.
 *
 * The returned model is the caller's override when one is given, otherwise the
 * host's current `model`. A model id not in the gateway list is kept: gateways
 * routinely serve aliases their own list omits, and refusing would block a
 * perfectly valid host choice.
 */
export async function discoverMagpieLlm(options: DiscoveryOptions = {}): Promise<Discovery> {
  const env = options.env ?? process.env;
  const path = options.codexConfigPath ?? codexConfigPath(env);
  if (!existsSync(path)) {
    return fail("unavailable", `未找到 Magpie 的 LLM 配置（${path}）`, null);
  }

  let mtimeMs: number;
  let doc: Record<string, unknown>;
  try {
    mtimeMs = statSync(path).mtimeMs;
    doc = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return fail(
      "error",
      `读取 Magpie 配置失败：${error instanceof Error ? error.message : String(error)}`,
      null
    );
  }

  const hostModel = typeof doc.model === "string" && doc.model.trim() ? doc.model.trim() : null;
  const providers = doc.model_providers as Record<string, unknown> | undefined;
  const magpie = providers?.magpie as Record<string, unknown> | undefined;
  let rawBase = typeof magpie?.base_url === "string" ? magpie.base_url.trim() : "";
  if (
    !rawBase &&
    typeof doc.openai_base_url === "string" &&
    doc.openai_base_url.includes("/backend-api/codex")
  ) {
    // Older Magpie builds only wrote Codex's own base URL. The gateway root is
    // the same origin, and its OpenAI-compatible surface is /v1.
    rawBase = doc.openai_base_url.trim().replace(/\/backend-api\/codex\/?$/, "/v1");
  }
  if (!rawBase) {
    return fail(
      "unavailable",
      "Codex 配置中没有 Magpie 的 LLM 网关；请先在 Magpie 中连接模型。",
      hostModel,
      mtimeMs
    );
  }

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawBase);
  } catch (error) {
    return fail(
      "unavailable",
      error instanceof Error ? error.message : String(error),
      hostModel,
      mtimeMs
    );
  }

  if (!hostModel) {
    return fail(
      "unavailable",
      "Codex 配置中没有当前模型；请先在 Magpie 中选择模型。",
      null,
      mtimeMs
    );
  }

  const apiKey =
    (typeof magpie?.experimental_bearer_token === "string" &&
      magpie.experimental_bearer_token.trim()) ||
    "magpie";
  const provider: MagpieLlm["provider"] =
    magpie?.wire_api === "chat" ? "openai" : "openai-responses";
  const fetchFn = options.fetchFn ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("unavailable", `连不上 Magpie 网关 ${baseUrl}：${detail}`, hostModel, mtimeMs);
  }
  if (!response.ok) {
    return fail(
      "unavailable",
      `Magpie 网关返回 HTTP ${response.status}；请在 Magpie 中确认模型连接。`,
      hostModel,
      mtimeMs
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return fail(
      "error",
      `Magpie 网关返回的不是模型 JSON：${error instanceof Error ? error.message : String(error)}`,
      hostModel,
      mtimeMs
    );
  }
  const listed = modelIds(payload);
  if (!listed.magpie) {
    return fail(
      "unavailable",
      `${baseUrl} 不像 Magpie 网关；为避免误连本机其他服务，未自动接入。`,
      hostModel,
      mtimeMs
    );
  }

  const requested = (options.model ?? "").trim() || hostModel;
  const suffix = listed.models.filter((id) => id.endsWith(`/${requested}`));
  const model = listed.models.includes(requested)
    ? requested
    : suffix.length === 1
      ? suffix[0]
      : requested;

  return {
    ok: true,
    mtimeMs,
    llm: {
      provider,
      baseUrl,
      apiKey,
      model,
      hostModel,
      models: listed.models.sort((a, b) => a.localeCompare(b)),
      configPath: path,
    },
  };
}

async function cachedDiscovery(options: DiscoveryOptions = {}): Promise<Discovery> {
  const env = options.env ?? process.env;
  const path = options.codexConfigPath ?? codexConfigPath(env);
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // discovery reports the missing file with a better message.
  }
  const key = `${path}:${mtime}:${options.model ?? ""}`;
  if (!options.noCache && _cache && _cache.key === key && Date.now() - _cache.at < DISCOVERY_TTL_MS)
    return _cache.value;
  const value = await discoverMagpieLlm(options);
  _cache = { key, at: Date.now(), value };
  return value;
}

function sameLlm(current: ProfileLlm, provider: string, baseUrl: string, model: string): boolean {
  return current.provider === provider && current.baseUrl === baseUrl && current.model === model;
}

/**
 * A profile that predates Magpie onboarding: empty, a placeholder, or the
 * keyless OAuth default the old wizard wrote. Only these are adopted without a
 * prior "we wrote this" record; a real provider + key is always a manual choice.
 */
function isLegacyDefault(current: ProfileLlm): boolean {
  if (!current.exists || !current.provider) return true;
  const provider = current.provider.toLowerCase();
  if (provider === "mock" || provider === "none") return true;
  return (provider === "openai-codex" || provider === "chatgpt") && !current.hasApiKey;
}

function emptyState(
  status: LlmStatus,
  mode: "follow" | "fixed",
  message: string,
  discovery?: Discovery
): LlmState {
  const hostModel = discovery
    ? discovery.ok
      ? discovery.llm.hostModel
      : discovery.hostModel
    : null;
  const models = discovery?.ok ? discovery.llm.models : [];
  return {
    status,
    mode,
    hostModel,
    configuredModel: null,
    provider: null,
    models,
    restartRequired: false,
    message,
    checkedAt: Date.now(),
  };
}

/**
 * Report the LLM state without writing anything.
 *
 * `daemonHealthy` comes from the caller's existing health probe: when the
 * backend is down there is nothing to restart, so a stale "restart required"
 * flag is cleared for display.
 */
export async function inspectMagpieLlm(
  cfg: Config,
  options: DiscoveryOptions & { daemonHealthy?: boolean } = {}
): Promise<LlmState> {
  const env = options.env ?? process.env;
  const managed = readManagedState(cfg.daemonProfile, env);
  const mode = managed?.mode ?? "follow";
  const discovery = await cachedDiscovery(options);
  if (!discovery.ok) return emptyState(discovery.status, mode, discovery.message, discovery);

  const host = discovery.llm;
  const desiredModel = mode === "fixed" ? managed?.model || host.hostModel : host.hostModel;
  const current = readProfileLlm(cfg.daemonProfile, env);
  const synced = sameLlm(current, host.provider, host.baseUrl, desiredModel);
  const managedNow = managed && sameLlm(current, managed.provider, managed.baseUrl, managed.model);
  const status: LlmStatus = synced
    ? "synced"
    : isLegacyDefault(current) || managedNow
      ? "pending"
      : "manual";
  return {
    status,
    mode,
    hostModel: host.hostModel,
    configuredModel: current.model || null,
    provider: current.provider || null,
    models: host.models,
    restartRequired: options.daemonHealthy === false ? false : Boolean(managed?.restartRequired),
    message: synced
      ? mode === "fixed"
        ? `使用固定模型 ${desiredModel}`
        : "已跟随 Magpie 当前模型"
      : status === "pending"
        ? "检测到 Magpie 的配置；正在自动接入"
        : "Hindsight 的 LLM 已手动配置，未自动覆盖",
    checkedAt: Date.now(),
  };
}

async function doSync(cfg: Config, options: SyncOptions): Promise<LlmState> {
  const env = options.env ?? process.env;
  const managed = readManagedState(cfg.daemonProfile, env);
  const mode = options.mode ?? managed?.mode ?? "follow";
  const discovery = await cachedDiscovery({
    ...options,
    model: options.mode ? options.model : undefined,
    noCache: options.noCache,
  });
  if (!discovery.ok) return emptyState(discovery.status, mode, discovery.message, discovery);

  const host = discovery.llm;
  const desiredModel =
    mode === "fixed" ? options.model?.trim() || managed?.model || host.hostModel : host.hostModel;
  const current = readProfileLlm(cfg.daemonProfile, env);
  const synced = sameLlm(current, host.provider, host.baseUrl, desiredModel);
  const managedNow = managed && sameLlm(current, managed.provider, managed.baseUrl, managed.model);
  const adoptable = isLegacyDefault(current);

  if (!synced && !adoptable && !managedNow && !options.force) {
    return {
      ...emptyState(
        "manual",
        mode,
        "Hindsight 的 LLM 已手动配置，未自动覆盖。可在本页点击同步改用 Magpie 的模型。"
      ),
      hostModel: host.hostModel,
      configuredModel: current.model || null,
      provider: current.provider || null,
      models: host.models,
      restartRequired: false,
    };
  }

  if (synced) {
    const restartRequired = Boolean(managed?.restartRequired);
    writeManagedState(
      cfg.daemonProfile,
      {
        profile: cfg.daemonProfile,
        provider: host.provider,
        baseUrl: host.baseUrl,
        model: desiredModel,
        mode,
        appliedAt: managed?.appliedAt ?? new Date().toISOString(),
        restartRequired,
      },
      env
    );
    return {
      status: "synced",
      mode,
      hostModel: host.hostModel,
      configuredModel: desiredModel,
      provider: host.provider,
      models: host.models,
      restartRequired,
      message: mode === "fixed" ? `使用固定模型 ${desiredModel}` : "已跟随 Magpie 当前模型",
      checkedAt: Date.now(),
    };
  }

  const runOps = options.runOps ?? runEmbedOps;
  const healthy = options.healthy ?? isServerHealthy;
  try {
    await runOps(cfg, ["save-settings", "--profile", cfg.daemonProfile], {
      input: {
        values: {
          [ENV_LLM_PROVIDER]: host.provider,
          [ENV_LLM_BASE_URL]: host.baseUrl,
          [ENV_LLM_API_KEY]: host.apiKey,
          [ENV_LLM_MODEL]: desiredModel,
        },
      },
    });
  } catch (error) {
    return {
      ...emptyState(
        "error",
        mode,
        `写入 Hindsight 配置失败：${error instanceof Error ? error.message : String(error)}`
      ),
      hostModel: host.hostModel,
      models: host.models,
    };
  }

  const wasHealthy = await healthy(cfg.apiUrl);
  let restarted = false;
  if (wasHealthy && options.restart) {
    try {
      await runOps(cfg, ["daemon-restart", "--profile", cfg.daemonProfile], {
        timeoutMs: RESTART_TIMEOUT_MS,
      });
      restarted = true;
    } catch (error) {
      // The config is already written; a failed restart must not look like a
      // failed sync. Report it as "restart required" instead.
      return {
        status: "updated",
        mode,
        hostModel: host.hostModel,
        configuredModel: desiredModel,
        provider: host.provider,
        models: host.models,
        restartRequired: true,
        message: `配置已同步，但重启记忆服务失败：${error instanceof Error ? error.message : String(error)}`,
        checkedAt: Date.now(),
      };
    }
  }

  const restartRequired = wasHealthy && !restarted;
  writeManagedState(
    cfg.daemonProfile,
    {
      profile: cfg.daemonProfile,
      provider: host.provider,
      baseUrl: host.baseUrl,
      model: desiredModel,
      mode,
      appliedAt: new Date().toISOString(),
      restartRequired,
      adoptedFrom:
        current.provider || current.baseUrl || current.model
          ? { provider: current.provider, baseUrl: current.baseUrl, model: current.model }
          : undefined,
    },
    env
  );
  return {
    status: "updated",
    mode,
    hostModel: host.hostModel,
    configuredModel: desiredModel,
    provider: host.provider,
    models: host.models,
    restartRequired,
    message: restarted
      ? "已同步 Magpie 的模型，并重启记忆服务"
      : restartRequired
        ? "已同步 Magpie 的模型；重启记忆服务后生效"
        : "已接入 Magpie 的模型",
    checkedAt: Date.now(),
  };
}

/**
 * Serialise syncs: the 3-second monitor and the page's explicit action can
 * arrive together, and two `save-settings` writes racing would make the
 * ownership check read a half-written file.
 */
export function syncMagpieLlm(cfg: Config, options: SyncOptions = {}): Promise<LlmState> {
  // An explicit action is the new source of truth for the next status poll.
  if (options.force) _lastAuto = undefined;
  const run = () => doSync(cfg, options);
  const next = _queue.then(run, run);
  _queue = next.catch(() => undefined);
  return next;
}

/**
 * The automatic path: apply config changes from the host, but never restart a
 * running backend (the page offers that as one explicit action).
 *
 * A failure or an unavailable gateway is retried at a slow cadence rather than
 * every three seconds.
 */
export async function autoSyncMagpieLlm(cfg: Config, options: SyncOptions = {}): Promise<LlmState> {
  const env = options.env ?? process.env;
  const path = options.codexConfigPath ?? codexConfigPath(env);
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // discover() explains the missing file.
  }
  const key = `${path}:${mtime}`;
  if (_lastAuto && _lastAuto.key === key && Date.now() - _lastAuto.at < DISCOVERY_TTL_MS)
    return _lastAuto.value;
  const value = await syncMagpieLlm(cfg, { ...options, restart: false });
  _lastAuto = { key, at: Date.now(), value };
  return value;
}
