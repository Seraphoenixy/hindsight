// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SyncSettingsPanel } from "@/components/sync-settings-panel";
import { OPS_TOKEN_HEADER } from "@/lib/local-headers";

const PROFILE = {
  name: "",
  display_name: "default",
  port: 8888,
  is_active: true,
  daemon_running: false,
  provider: null,
  model: null,
  has_api_key: false,
};

const SYNC_GROUP = {
  id: "sync",
  label: "Multi-device sync",
  description: "Background object-level sync across devices through a Hindsight relay.",
  label_zh: "多端同步",
  description_zh: "通过 Hindsight 中继在多台设备之间自动同步记忆对象。",
  fields: [
    {
      key: "HINDSIGHT_SYNC_STATE_DIR",
      label: "State directory",
      kind: "string",
      value: "",
      default: "",
      description: "Local private directory holding device identity and sync lock.",
      options: [],
      placeholder: "",
      is_set: false,
      label_zh: "状态目录",
      description_zh: "存放设备凭据与同步锁的本地目录。",
      option_labels: [],
    },
    {
      key: "HINDSIGHT_SYNC_AUTO_ENABLED",
      label: "Automatic sync",
      kind: "boolean",
      value: "",
      default: "true",
      description: "Run lightweight checks on startup, after local writes, and on interval.",
      options: [],
      placeholder: "",
      is_set: false,
      label_zh: "自动同步",
      description_zh: "在启动、本地写入后和固定间隔自动检查并同步变更。",
      option_labels: [],
    },
    {
      key: "HINDSIGHT_SYNC_INTERVAL_SECONDS",
      label: "Check interval (s)",
      kind: "number",
      value: "",
      default: "15",
      description: "Seconds between lightweight sync checks.",
      options: [],
      placeholder: "15",
      is_set: false,
      label_zh: "检查间隔（秒）",
      description_zh: "两次轻量同步检查之间的间隔秒数。",
      option_labels: [],
    },
  ],
};

function response(body: unknown): Response {
  return Response.json(body);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("saves only the changed sync fields through the sync page's own endpoint", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/local/profiles")) return response({ profiles: [PROFILE] });
    if (url.includes("/sync-settings") && (init?.method ?? "GET") === "GET") {
      return response({
        name: "",
        display_name: "default",
        groups: [SYNC_GROUP],
        unset_required: [],
      });
    }
    if (url.includes("/sync-settings") && init?.method === "POST") {
      const saved = JSON.parse(String(init.body)) as { values: Record<string, string> };
      return response({
        name: "",
        display_name: "default",
        unset_required: [],
        groups: [
          {
            ...SYNC_GROUP,
            fields: SYNC_GROUP.fields.map((field) =>
              field.key in saved.values
                ? { ...field, value: saved.values[field.key], is_set: true }
                : field
            ),
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);

  render(<SyncSettingsPanel token="ops-token" preferZh={false} />);

  const interval = (await screen.findByLabelText("Check interval (s)")) as HTMLInputElement;
  fireEvent.change(interval, { target: { value: "30" } });

  const save = screen.getByRole("button", { name: "Save" });
  fireEvent.click(save);

  await screen.findByRole("status");

  const postCall = fetch.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST"
  );
  expect(postCall).toBeDefined();
  const [url, request] = postCall as [RequestInfo | URL, RequestInit];
  expect(String(url)).toBe("/api/local/profiles/default/sync-settings");
  expect((request.headers as Record<string, string>)[OPS_TOKEN_HEADER]).toBe("ops-token");
  expect(JSON.parse(String(request.body))).toEqual({
    values: { HINDSIGHT_SYNC_INTERVAL_SECONDS: "30" },
  });

  await waitFor(() =>
    expect((screen.getByLabelText("Check interval (s)") as HTMLInputElement).value).toBe("30")
  );
});
