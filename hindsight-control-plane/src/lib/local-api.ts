/**
 * Browser client for `/api/local/*`.
 *
 * Every call carries the ops token this page was rendered with. The token is a
 * prop from the server component, not a cookie or localStorage value: it exists
 * only in this page's JavaScript, so a page on another origin has no way to read
 * it, and the custom header it travels in cannot be set cross-origin without a
 * preflight this app never grants.
 *
 * Errors are surfaced with the server's message when there is one. The local
 * management routes put the specific rejected value in `error` (a bad setting
 * value names its key), which is the part the user has to act on.
 */
import { OPS_TOKEN_HEADER } from "@/lib/local-headers";

export interface LocalApiError {
  error: string;
  reason?: string;
}

async function request<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`/api/local${path}`, {
    method,
    headers: {
      [OPS_TOKEN_HEADER]: token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const failure = parsed as Partial<LocalApiError>;
    throw new Error(failure.error || `Request failed with ${response.status}`);
  }
  return parsed as T;
}

/** One profile row, as the ops CLI reports it. */
export interface ProfileSummary {
  name: string;
  display_name: string;
  port: number;
  is_active: boolean;
  daemon_running: boolean;
  provider: string | null;
  model: string | null;
  has_api_key: boolean;
}

export interface OptionLabel {
  value: string;
  label: string;
  label_zh: string;
}

export interface SettingField {
  key: string;
  label: string;
  kind: "string" | "password" | "number" | "select" | "combo" | "boolean";
  value: string;
  default: string;
  description: string;
  options: string[];
  placeholder: string;
  is_set: boolean;
  label_zh: string;
  description_zh: string;
  option_labels: OptionLabel[];
}

export interface SettingGroup {
  id: string;
  label: string;
  description: string;
  label_zh: string;
  description_zh: string;
  fields: SettingField[];
}

export interface SettingsView {
  name: string;
  display_name: string;
  groups: SettingGroup[];
  unset_required: string[];
}

export interface ModelsView {
  provider: string;
  base_url: string;
  models: string[];
}

export interface ListModelsRequest {
  provider: string;
  /** A string is used as sent; null means "use the saved profile key". */
  api_key: string | null;
  base_url: string;
}

export interface ProfileConfigView {
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

export interface EnvFileView {
  name: string;
  display_name: string;
  path: string;
  content: string;
  exists: boolean;
}

export interface PathsView {
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

/** One section of `ops snapshot`, keyed by the CLI's section id. */
export interface SnapshotSections {
  config?: ProfileConfigView;
  settings?: SettingsView;
  env?: EnvFileView;
  paths?: PathsView;
  health?: HealthView;
  "local-models"?: LocalModelsView;
  "embedding-check"?: EmbeddingCompatibilityView;
  "reembed-status"?: ReembedStatusView;
}

export interface SnapshotView {
  profile: string;
  sections: SnapshotSections;
  /** Sections that raised, keyed by section id. Everything else loaded. */
  errors: Record<string, string>;
}

/**
 * Sections that describe the profile without importing the memory engine.
 *
 * Everything here is a file read, so one process covers all of them in ~0.45 s.
 * `reembed-status` is included because it is a status file read: the panel
 * wants it for its banner, and it costs nothing extra.
 */
export const LOCAL_SNAPSHOT_CORE = [
  "config",
  "settings",
  "env",
  "paths",
  "reembed-status",
] as const;

/**
 * Live state, loaded after the form is painted.
 *
 * `health` is a loopback probe with a 2 s timeout, so a stopped daemon makes it
 * the slowest section by far — exactly when the page should still open quickly.
 * `local-models` imports the memory engine (fastapi/sqlalchemy/pgvector).
 */
export const LOCAL_SNAPSHOT_DIAGNOSTICS = ["health", "local-models"] as const;

/*
 * `embedding-check` is deliberately in neither group: it connects to the
 * database, and when the instance's `postmaster.pid` is absent it starts a
 * temporary pg0 and stops it again. A page load must never be able to do that —
 * a live daemon lost its database that way. The panel asks for the check when
 * the settings tab is opened, and on every save, which is when a dimension
 * mismatch actually matters.
 */

export interface HealthView {
  api_ok: boolean;
  api_detail: string;
  api_detail_zh: string;
  api_port: number;
  api_url: string;
}

export interface DaemonActionResult {
  ok: boolean;
  running: boolean;
  url: string | null;
  message: string;
  message_zh: string;
}

export interface SyncConnectionView {
  relay_url: string | null;
  device_id: string | null;
}

export async function syncConnection(
  token: string,
  port: number,
  connection?: { relay_url: string; password: string }
): Promise<SyncConnectionView> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid API port for this profile.");
  }
  // The browser connects directly to the daemon. The daemon checks the loopback
  // peer and the ops token, and the control-plane server never sees the password.
  const response = await fetch(`http://127.0.0.1:${port}/v1/default/sync/connection`, {
    method: connection ? "POST" : "GET",
    headers: {
      [OPS_TOKEN_HEADER]: token,
      ...(connection ? { "Content-Type": "application/json" } : {}),
    },
    body: connection ? JSON.stringify(connection) : undefined,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(typeof result.detail === "string" ? result.detail : "Sync connection failed.");
  }
  return result as SyncConnectionView;
}

export interface LogTailView {
  path: string;
  exists: boolean;
  content: string;
}

export interface DeleteResult {
  ok: boolean;
  message: string;
  message_zh: string;
}

export interface LocalModelStatus {
  name: string;
  mode: string;
  filename: string;
  dimensions: number | null;
  ctx: number;
  downloaded: boolean;
  downloading: boolean;
  downloaded_bytes: number;
  total_bytes: number | null;
  path: string;
  in_use: boolean;
  error: string | null;
}

export interface LocalModelsView {
  gguf_dir: string;
  models: LocalModelStatus[];
}

export interface DownloadLocalModelResult {
  ok: boolean;
  status: string;
  model: string;
  filename: string;
  message: string;
  message_zh: string;
}

export interface EmbeddingCompatibilityView {
  compatible: boolean;
  reason: string;
  current_dimension: number | null;
  target_dimension: number | null;
  memory_count: number;
  mental_model_count: number;
  is_pg0: boolean;
  can_reembed: boolean;
  message: string;
  message_zh: string;
}

export interface ReembedStatusView {
  status: "idle" | "running" | "done" | "error";
  phase: string;
  rows_embedded: number;
  message: string;
  message_zh: string;
  error: string | null;
}

export interface ResetMemoriesResult {
  ok: boolean;
  daemon_running: boolean;
  message: string;
  message_zh: string;
}

/** URL segment for a profile: the default profile is addressed as `default`. */
export function profileSegment(name: string): string {
  return encodeURIComponent(name || "default");
}

export const localApi = {
  profiles: (token: string) => request<{ profiles: ProfileSummary[] }>(token, "GET", "/profiles"),

  snapshot: (token: string, profile: string, include: readonly string[]) =>
    request<SnapshotView>(
      token,
      "GET",
      `/profiles/${profileSegment(profile)}/snapshot?include=${encodeURIComponent(include.join(","))}`
    ),

  settings: (token: string, profile: string) =>
    request<SettingsView>(token, "GET", `/profiles/${profileSegment(profile)}/settings`),

  saveSettings: (token: string, profile: string, values: Record<string, string>) =>
    request<SettingsView>(token, "POST", `/profiles/${profileSegment(profile)}/settings`, {
      values,
    }),

  syncSettings: (token: string, profile: string) =>
    request<SettingsView>(token, "GET", `/profiles/${profileSegment(profile)}/sync-settings`),

  saveSyncSettings: (token: string, profile: string, values: Record<string, string>) =>
    request<SettingsView>(token, "POST", `/profiles/${profileSegment(profile)}/sync-settings`, {
      values,
    }),

  listModels: (token: string, profile: string, body: ListModelsRequest) =>
    request<ModelsView>(token, "POST", `/profiles/${profileSegment(profile)}/models`, body),

  saveConfig: (token: string, profile: string, body: Record<string, string>) =>
    request<ProfileConfigView>(token, "POST", `/profiles/${profileSegment(profile)}/config`, body),

  saveEnv: (token: string, profile: string, content: string) =>
    request<EnvFileView>(token, "POST", `/profiles/${profileSegment(profile)}/env`, { content }),

  health: (token: string, profile: string) =>
    request<HealthView>(token, "GET", `/profiles/${profileSegment(profile)}/health`),

  logs: (token: string, profile: string, lines: number, source: string) =>
    request<LogTailView>(
      token,
      "GET",
      `/profiles/${profileSegment(profile)}/logs?lines=${lines}&source=${source}`
    ),

  daemon: (token: string, profile: string, action: "start" | "stop" | "restart") =>
    request<DaemonActionResult>(token, "POST", `/profiles/${profileSegment(profile)}/daemon`, {
      action,
    }),

  deleteProfile: (token: string, profile: string) =>
    request<DeleteResult>(token, "POST", `/profiles/${profileSegment(profile)}/delete`),

  localModels: (token: string, profile: string) =>
    request<LocalModelsView>(token, "GET", `/profiles/${profileSegment(profile)}/local-models`),

  downloadLocalModel: (token: string, profile: string, model: string) =>
    request<DownloadLocalModelResult>(
      token,
      "POST",
      `/profiles/${profileSegment(profile)}/local-models`,
      { model }
    ),

  checkEmbeddingCompatibility: (token: string, profile: string, values?: Record<string, string>) =>
    request<EmbeddingCompatibilityView>(
      token,
      "POST",
      `/profiles/${profileSegment(profile)}/embedding-check`,
      values ? { values } : {}
    ),

  startReembed: (token: string, profile: string, values?: Record<string, string>) =>
    request<ReembedStatusView>(
      token,
      "POST",
      `/profiles/${profileSegment(profile)}/reembed`,
      values ? { values } : {}
    ),

  reembedStatus: (token: string, profile: string) =>
    request<ReembedStatusView>(token, "GET", `/profiles/${profileSegment(profile)}/reembed`),

  resetMemories: (token: string, profile: string, values?: Record<string, string>) =>
    request<ResetMemoriesResult>(
      token,
      "POST",
      `/profiles/${profileSegment(profile)}/reset-memories`,
      values ? { values } : {}
    ),
};
