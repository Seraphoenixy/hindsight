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

/** URL segment for a profile: the default profile is addressed as `default`. */
export function profileSegment(name: string): string {
  return encodeURIComponent(name || "default");
}

export const localApi = {
  profiles: (token: string) => request<{ profiles: ProfileSummary[] }>(token, "GET", "/profiles"),

  settings: (token: string, profile: string) =>
    request<SettingsView>(token, "GET", `/profiles/${profileSegment(profile)}/settings`),

  saveSettings: (token: string, profile: string, values: Record<string, string>) =>
    request<SettingsView>(token, "POST", `/profiles/${profileSegment(profile)}/settings`, {
      values,
    }),

  config: (token: string, profile: string) =>
    request<ProfileConfigView>(token, "GET", `/profiles/${profileSegment(profile)}/config`),

  saveConfig: (token: string, profile: string, body: Record<string, string>) =>
    request<ProfileConfigView>(token, "POST", `/profiles/${profileSegment(profile)}/config`, body),

  env: (token: string, profile: string) =>
    request<EnvFileView>(token, "GET", `/profiles/${profileSegment(profile)}/env`),

  saveEnv: (token: string, profile: string, content: string) =>
    request<EnvFileView>(token, "POST", `/profiles/${profileSegment(profile)}/env`, { content }),

  paths: (token: string, profile: string) =>
    request<PathsView>(token, "GET", `/profiles/${profileSegment(profile)}/paths`),

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
};
