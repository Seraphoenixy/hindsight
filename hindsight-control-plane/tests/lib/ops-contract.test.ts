/**
 * End-to-end smoke for the control-plane -> `hindsight-embed ops` bridge.
 *
 * Runs the REAL CLI against a temporary HOME, so this is the one test that
 * proves the two halves still agree: the JSON field names the TypeScript types
 * declare, the profile default, and the stdin request document a mutation sends.
 *
 * Skipped when no embed CLI is available (a checkout without a synced venv).
 * That is a deliberate skip rather than a failure: the unit tests cover this
 * module's own logic, and requiring a Python install would make `npm test`
 * unusable on a machine that only has the control plane.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The repo's venv entry point, when this checkout has one. */
function resolveEmbed(): string | null {
  const candidates =
    process.platform === "win32"
      ? [join(process.cwd(), "..", ".venv", "Scripts", "hindsight-embed.exe")]
      : [join(process.cwd(), "..", ".venv", "bin", "hindsight-embed")];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["ops", "--help"], { stdio: "ignore", timeout: 30_000 });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const embed = resolveEmbed();
const home = embed ? mkdtempSync(join(tmpdir(), "hindsight-ops-")) : null;

function ops<T>(args: string[], stdin?: string): T {
  mkdirSync(join(home as string, ".hindsight"), { recursive: true });
  const stdout = execFileSync(embed as string, ["ops", ...args], {
    input: stdin ?? "",
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, HOME: home as string, USERPROFILE: home as string },
  });
  return JSON.parse(stdout) as T;
}

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!embed)("hindsight-embed ops contract", () => {
  beforeAll(() => {
    // The CLI, not the test, is the thing under verification here; nothing else
    // to set up beyond the isolated HOME the helpers already provide.
  });

  it("lists the coding-agent profile on a fresh machine", () => {
    const doc = ops<{ profiles: { name: string; port: number; daemon_running: boolean }[] }>([
      "profiles",
    ]);
    expect(doc.profiles).toHaveLength(1);
    expect(doc.profiles[0].name).toBe("coding-agent");
    // An isolated HOME isolates configuration, not TCP ports: an existing daemon
    // on the default port is adopted. Live status behaviour is covered in embed tests.
    expect(typeof doc.profiles[0].daemon_running).toBe("boolean");
  });

  it("returns the grouped settings catalog with both languages", () => {
    const doc = ops<{
      groups: { id: string; label: string; label_zh: string; fields: unknown[] }[];
      unset_required: string[];
    }>(["settings"]);
    expect(doc.groups.length).toBeGreaterThan(0);
    for (const group of doc.groups) {
      expect(group.label).toBeTruthy();
      expect(group.label_zh).toBeTruthy();
      expect(group.fields.length).toBeGreaterThan(0);
    }
    expect(Array.isArray(doc.unset_required)).toBe(true);
  });

  it("writes a setting sent as a stdin request document", () => {
    const saved = ops<{ groups: { fields: { key: string; value: string }[] }[] }>(
      ["save-settings"],
      JSON.stringify({ values: { HINDSIGHT_API_LLM_PROVIDER: "groq" } })
    );
    const field = saved.groups
      .flatMap((group) => group.fields)
      .find((entry) => entry.key === "HINDSIGHT_API_LLM_PROVIDER");
    expect(field?.value).toBe("groq");
  });

  it("reports a rejected value as a JSON error on a non-zero exit", () => {
    let failed = false;
    try {
      ops(
        ["save-settings"],
        JSON.stringify({ values: { HINDSIGHT_API_LLM_PROVIDER: "not-a-provider" } })
      );
    } catch (error) {
      const err = error as { stdout?: string };
      const doc = JSON.parse(err.stdout ?? "{}") as { error?: string };
      expect(doc.error).toContain("must be one of");
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it("masks the API key in config but not in the raw env", () => {
    ops(["write-env"], JSON.stringify({ content: "HINDSIGHT_API_LLM_API_KEY=sk-secret-123\n" }));
    const config = ops<{ api_key_masked: string | null; has_api_key: boolean }>(["config"]);
    expect(config.has_api_key).toBe(true);
    expect(config.api_key_masked).not.toContain("secret-123");
    const envDoc = ops<{ content: string }>(["env"]);
    expect(envDoc.content).toContain("sk-secret-123");
  });

  it("declines model discovery for OAuth providers without calling the network", () => {
    let message = "";
    try {
      ops(["models"], JSON.stringify({ provider: "openai-codex", api_key: null, base_url: "" }));
    } catch (error) {
      const err = error as { stdout?: string };
      message = (JSON.parse(err.stdout ?? "{}") as { error?: string }).error ?? "";
    }
    expect(message).toContain("Enter the model id directly");
  });

  it("creates and returns an ops token", () => {
    const doc = ops<{ token: string; path: string }>(["token"]);
    expect(doc.token.length).toBeGreaterThan(20);
    expect(doc.path).toContain("ops.token");
  });
});
