// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SyncConnectionPanel } from "@/components/sync-connection-panel";
import { OPS_TOKEN_HEADER } from "@/lib/local-headers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("signs in to the selected profile's local daemon and clears the password", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ relay_url: "https://old.example.com", device_id: null }))
    .mockResolvedValueOnce(Response.json({ detail: "Relay rejected the master password" }, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ relay_url: "https://new.example.com", device_id: "dev-test" }));
  vi.stubGlobal("fetch", fetch);
  const onSaved = vi.fn();
  render(<SyncConnectionPanel token="ops-token" port={8901} preferZh={false} onSaved={onSaved} />);
  const url = screen.getByLabelText("Server URL") as HTMLInputElement;
  const password = screen.getByLabelText("Sync Master Password") as HTMLInputElement;
  const submit = screen.getByRole("button", { name: "Sign In and Save" });
  await waitFor(() => expect(url.value).toBe("https://old.example.com"));
  expect(password.type).toBe("password");
  fireEvent.change(url, { target: { value: "https://new.example.com" } });
  fireEvent.change(password, { target: { value: "wrong-password" } });
  fireEvent.click(submit);
  await screen.findByText("Relay rejected the master password");
  expect(password.value).toBe("");
  expect(onSaved).not.toHaveBeenCalled();
  expect(url.value).toBe("https://new.example.com");

  fireEvent.change(password, { target: { value: "correct-password" } });
  fireEvent.click(submit);
  await screen.findByRole("status");
  const [target, request] = fetch.mock.calls[2];
  expect(target).toBe("http://127.0.0.1:8901/v1/default/sync/connection");
  expect(request.headers[OPS_TOKEN_HEADER]).toBe("ops-token");
  expect(JSON.parse(request.body)).toEqual({ relay_url: "https://new.example.com", password: "correct-password" });
  expect(password.value).toBe("");
  expect(onSaved).toHaveBeenCalledOnce();
});
