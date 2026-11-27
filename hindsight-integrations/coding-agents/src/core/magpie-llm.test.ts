import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";
import type { runEmbedOps } from "./embed-ops";
import {
  clearMagpieLlmCache,
  discoverMagpieLlm,
  inspectMagpieLlm,
  managedStatePath,
  parseEnvFile,
  profileEnvPath,
  readProfileLlm,
  syncMagpieLlm,
  type DiscoveryOptions,
} from "./magpie-llm";

const MODELS = {
  data: [
    {
      id: "codearts/deepseek-v4.1-flash-1017",
      magpie_label: "DeepSeek-V4.1-Flash-1017",
      native_endpoints: ["/v1/chat/completions"],
    },
    {
      id: "codearts/glm-5.3-flash",
      magpie_label: "GLM-5.3-Flash",
      native_endpoints: ["/v1/chat/completions"],
    },
    {
      id: "codex/gpt-6.2-sol",
      magpie_label: "GPT-6.2-Sol",
      native_endpoints: ["/v1/responses"],
    },
  ],
};

const cfg = resolveConfig({ daemonProfile: "coding-agent" });
let root: string;
let configPath: string;
let env: NodeJS.ProcessEnv;

function writeCodexConfig(extra = ""): void {
  writeFileSync(
    configPath,
    [
      'model = "codearts/deepseek-v4.1-flash-1017"',
      'model_reasoning_effort = "high"',
      "",
      "[model_providers.magpie]",
      'base_url = "http://127.0.0.1:3425/v1"',
      'experimental_bearer_token = "magpie"',
      'wire_api = "responses"',
      'http_headers = { "x-openai-actor-authorization" = "magpie" }',
      extra,
    ].join("\n")
  );
}

function writeProfile(values: Record<string, string>): void {
  const path = profileEnvPath("coding-agent", env);
  mkdirSync(join(root, ".hindsight", "profiles"), { recursive: true });
  writeFileSync(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

function modelFetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => MODELS,
  })) as unknown as typeof fetch;
}

function discoveryOptions(overrides: Partial<DiscoveryOptions> = {}): DiscoveryOptions {
  return {
    env,
    codexConfigPath: configPath,
    fetchFn: modelFetch(),
    ...overrides,
  };
}

beforeEach(() => {
  clearMagpieLlmCache();
  root = mkdtempSync(join(tmpdir(), "hs-magpie-llm-"));
  configPath = join(root, ".codex", "config.toml");
  mkdirSync(join(root, ".codex"), { recursive: true });
  env = { HOME: root, USERPROFILE: root };
  writeCodexConfig();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverMagpieLlm", () => {
  it("reads the gateway, token and current model from Codex config", async () => {
    const result = await discoverMagpieLlm(discoveryOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.llm).toMatchObject({
      provider: "openai",
      baseUrl: "http://127.0.0.1:3425/v1",
      apiKey: "magpie",
      model: "codearts/deepseek-v4.1-flash-1017",
      hostModel: "codearts/deepseek-v4.1-flash-1017",
    });
    expect(result.llm.models).toEqual([
      "codearts/deepseek-v4.1-flash-1017",
      "codearts/glm-5.3-flash",
      "codex/gpt-6.2-sol",
    ]);
  });

  it("uses openai-responses when the model natively supports /v1/responses", async () => {
    const result = await discoverMagpieLlm(discoveryOptions({ model: "codex/gpt-6.2-sol" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.llm.provider).toBe("openai-responses");
  });

  it("derives the gateway from Codex's older openai_base_url shape", async () => {
    writeFileSync(
      configPath,
      [
        'model = "codex/gpt-6.2-sol"',
        'openai_base_url = "http://127.0.0.1:3425/backend-api/codex"',
      ].join("\n")
    );
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "codex/gpt-6.2-sol", magpie_label: "GPT" }] }),
    })) as unknown as typeof fetch;
    const result = await discoverMagpieLlm(discoveryOptions({ fetchFn }));
    expect(result.ok && result.llm.baseUrl).toBe("http://127.0.0.1:3425/v1");
  });

  it("resolves a host model to the gateway's namespaced id", async () => {
    writeFileSync(
      configPath,
      [
        'model = "deepseek-v4.1-flash-1017"',
        "[model_providers.magpie]",
        'base_url = "http://127.0.0.1:3425/v1"',
      ].join("\n")
    );
    const result = await discoverMagpieLlm(discoveryOptions());
    expect(result.ok && result.llm.model).toBe("codearts/deepseek-v4.1-flash-1017");
  });

  it("refuses a gateway that is not on loopback", async () => {
    writeFileSync(
      configPath,
      [
        'model = "codearts/deepseek-v4.1-flash-1017"',
        "[model_providers.magpie]",
        'base_url = "https://gateway.example/v1"',
      ].join("\n")
    );
    const result = await discoverMagpieLlm(discoveryOptions());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("loopback");
  });

  it("refuses a loopback service that is not a Magpie gateway", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "some-model" }] }),
    })) as unknown as typeof fetch;
    const result = await discoverMagpieLlm(discoveryOptions({ fetchFn }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("不像 Magpie");
  });

  it("reports an unreachable gateway without throwing", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await discoverMagpieLlm(discoveryOptions({ fetchFn }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("连不上");
  });
});

describe("profile and sync", () => {
  it("parses the profile env without mistaking comments for keys", () => {
    expect(
      parseEnvFile(
        [
          "# HINDSIGHT_API_LLM_PROVIDER=commented",
          "",
          "HINDSIGHT_API_LLM_PROVIDER=openai",
          'HINDSIGHT_API_LLM_MODEL="gpt-5"',
          "export OTHER=x",
        ].join("\n")
      )
    ).toEqual({
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      HINDSIGHT_API_LLM_MODEL: "gpt-5",
    });
  });

  it("auto-provisions an empty profile and records the applied values", async () => {
    const runOps = vi.fn(async (_cfg, _args, options) => {
      const values = (options?.input as { values: Record<string, string> }).values;
      writeProfile(values);
      return "{}";
    }) as unknown as typeof runEmbedOps;
    const healthy = vi.fn(async () => false);

    const result = await syncMagpieLlm(cfg, {
      ...discoveryOptions(),
      runOps,
      healthy,
    });

    expect(result.status).toBe("updated");
    expect(result.mode).toBe("follow");
    expect(runOps).toHaveBeenCalledWith(cfg, ["save-settings", "--profile", "coding-agent"], {
      input: {
        values: {
          HINDSIGHT_API_LLM_PROVIDER: "openai",
          HINDSIGHT_API_LLM_BASE_URL: "http://127.0.0.1:3425/v1",
          HINDSIGHT_API_LLM_API_KEY: "magpie",
          HINDSIGHT_API_LLM_MODEL: "codearts/deepseek-v4.1-flash-1017",
        },
      },
    });
    expect(readProfileLlm("coding-agent", env).provider).toBe("openai");
    const state = JSON.parse(readFileSync(managedStatePath(env), "utf8"));
    expect(state.profiles["coding-agent"].mode).toBe("follow");
  });

  it("follows a changed host model when it owns the profile", async () => {
    const runOps = vi.fn(async (_cfg, _args, options) => {
      const values = (options?.input as { values: Record<string, string> }).values;
      writeProfile(values);
      return "{}";
    }) as unknown as typeof runEmbedOps;
    const healthy = vi.fn(async () => false);
    await syncMagpieLlm(cfg, { ...discoveryOptions(), runOps, healthy });

    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        'model = "codearts/deepseek-v4.1-flash-1017"',
        'model = "codearts/glm-5.3-flash"'
      )
    );
    clearMagpieLlmCache();
    const result = await syncMagpieLlm(cfg, { ...discoveryOptions(), runOps, healthy });
    expect(result.status).toBe("updated");
    expect(result.configuredModel).toBe("codearts/glm-5.3-flash");
  });

  it("never overwrites a manually configured profile without force", async () => {
    writeProfile({
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      HINDSIGHT_API_LLM_BASE_URL: "https://api.openai.com/v1",
      HINDSIGHT_API_LLM_MODEL: "gpt-5",
      HINDSIGHT_API_LLM_API_KEY: "sk-user",
    });
    const runOps = vi.fn() as unknown as typeof runEmbedOps;
    const result = await syncMagpieLlm(cfg, {
      ...discoveryOptions(),
      runOps,
      healthy: async () => false,
    });
    expect(result.status).toBe("manual");
    expect(runOps).not.toHaveBeenCalled();
    expect(readProfileLlm("coding-agent", env).model).toBe("gpt-5");
  });

  it("adopts the old keyless OAuth placeholder on first onboarding", async () => {
    writeProfile({
      HINDSIGHT_API_LLM_PROVIDER: "openai-codex",
      HINDSIGHT_API_LLM_MODEL: "claude-3",
    });
    const runOps = vi.fn(async (_cfg, _args, options) => {
      const values = (options?.input as { values: Record<string, string> }).values;
      writeProfile(values);
      return "{}";
    }) as unknown as typeof runEmbedOps;
    const result = await syncMagpieLlm(cfg, {
      ...discoveryOptions(),
      runOps,
      healthy: async () => false,
    });
    expect(result.status).toBe("updated");
    expect(readProfileLlm("coding-agent", env).provider).toBe("openai");
    const state = JSON.parse(readFileSync(managedStatePath(env), "utf8"));
    expect(state.profiles["coding-agent"].adoptedFrom).toMatchObject({
      provider: "openai-codex",
      model: "claude-3",
    });
  });

  it("replaces a manual profile only when the page asks for it", async () => {
    writeProfile({
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      HINDSIGHT_API_LLM_MODEL: "gpt-5",
    });
    const runOps = vi.fn(async (_cfg, _args, options) => {
      const values = (options?.input as { values: Record<string, string> }).values;
      writeProfile(values);
      return "{}";
    }) as unknown as typeof runEmbedOps;
    const result = await syncMagpieLlm(cfg, {
      ...discoveryOptions(),
      runOps,
      healthy: async () => false,
      force: true,
      mode: "fixed",
      model: "codearts/glm-5.3-flash",
    });
    expect(result.status).toBe("updated");
    expect(result.mode).toBe("fixed");
    expect(readProfileLlm("coding-agent", env).model).toBe("codearts/glm-5.3-flash");
  });

  it("asks for a restart only when the backend is running", async () => {
    const runOps = vi.fn(async (_cfg, _args, options) => {
      if (options?.input) {
        const values = (options.input as { values: Record<string, string> }).values;
        writeProfile(values);
      }
      return "{}";
    }) as unknown as typeof runEmbedOps;
    const result = await syncMagpieLlm(cfg, {
      ...discoveryOptions(),
      runOps,
      healthy: async () => true,
    });
    expect(result.status).toBe("updated");
    expect(result.restartRequired).toBe(true);
    expect(result.message).toContain("重启记忆服务");
  });

  it("reports synced when the profile already matches the host", async () => {
    writeProfile({
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      HINDSIGHT_API_LLM_BASE_URL: "http://127.0.0.1:3425/v1",
      HINDSIGHT_API_LLM_API_KEY: "magpie",
      HINDSIGHT_API_LLM_MODEL: "codearts/deepseek-v4.1-flash-1017",
    });
    const state = await inspectMagpieLlm(cfg, { ...discoveryOptions(), daemonHealthy: false });
    expect(state.status).toBe("synced");
    expect(state.configuredModel).toBe("codearts/deepseek-v4.1-flash-1017");
  });

  it("migrates a managed chat-only model from openai-responses to openai", async () => {
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        'model = "codearts/deepseek-v4.1-flash-1017"',
        'model = "codex/gpt-6.2-sol"'
      )
    );
    writeProfile({
      HINDSIGHT_API_LLM_PROVIDER: "openai-responses",
      HINDSIGHT_API_LLM_BASE_URL: "http://127.0.0.1:3425/v1",
      HINDSIGHT_API_LLM_API_KEY: "magpie",
      HINDSIGHT_API_LLM_MODEL: "codearts/deepseek-v4.1-flash-1017",
    });
    mkdirSync(join(root, ".hindsight", "magpie"), { recursive: true });
    writeFileSync(
      managedStatePath(env),
      JSON.stringify({
        version: 1,
        profiles: {
          "coding-agent": {
            profile: "coding-agent",
            provider: "openai-responses",
            baseUrl: "http://127.0.0.1:3425/v1",
            model: "codearts/deepseek-v4.1-flash-1017",
            mode: "fixed",
            appliedAt: "2026-11-26T00:00:00.000Z",
            restartRequired: false,
          },
        },
      })
    );
    const runOps = vi.fn(async (_cfg, _args, options) => {
      if (options?.input) {
        const values = (options.input as { values: Record<string, string> }).values;
        writeProfile(values);
      }
      return "{}";
    }) as unknown as typeof runEmbedOps;

    const result = await syncMagpieLlm(cfg, {
      ...discoveryOptions(),
      runOps,
      healthy: async () => true,
    });
    expect(result.status).toBe("updated");
    expect(result.provider).toBe("openai");
    expect(readProfileLlm("coding-agent", env).provider).toBe("openai");
  });
});
