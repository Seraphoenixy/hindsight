#!/usr/bin/env node
/**
 * Native TS MCP (stdio) server exposing the `hindsight_*` page + recall + capture tools.
 *
 * Bank resolution MUST mirror the hooks exactly (`resolveHostMemory`, i.e. loadConfig +
 * deriveBankId + the banks section, harness from the REQUIRED HINDSIGHT_MCP_HARNESS) so
 * pages, recall, and retain all land in ONE per-repo bank — this is
 * why this is a native TS server and not a reuse of the Python MCP (whose bank derivation
 * differs). MCP servers usually launch with the project dir as cwd; `HINDSIGHT_MCP_PROJECT_CWD`
 * is the survey's escape hatch when they do not. Cursor's Agents Window is the other case: it
 * spawns user-level `~/.cursor/mcp.json` from `~` and ignores stdio `cwd`. Cursor *does*
 * interpolate `${workspaceFolder}` in `args`, so the installer passes the open workspace as
 * argv[2] rather than as a Hindsight env setting.
 */
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type Config } from "./core/config";
import { ensureControlPlaneStarted } from "./core/control-plane";
import { resolveHostMemory } from "./core/host-client";
import { HindsightClient } from "./core/hindsight";
import { buildPageTools, type ToolSpec } from "./core/page-tools";
import { buildPageTrigger } from "./core/missions";
import { buildRetainStamp } from "./core/retain-stamp";
import { readActiveWorkspace } from "./core/session-cache";

/**
 * Which tools this server should expose for a given config. Pure + SDK-free so the
 * disabled-flag behavior is unit-testable without spinning up a real MCP host: a disabled
 * Hindsight (mirrors the hooks' `cfg.disabled` check) exposes NO tools — the server still
 * connects, it just has nothing registered.
 */
export function selectTools(
  cfg: Config,
  client: HindsightClient,
  bankId: string,
  opts: { cwd?: string; harness?: string } = {}
): ToolSpec[] {
  const cwd = opts.cwd ?? process.cwd();
  const harness = opts.harness ?? cfg.harness;
  return cfg.disabled
    ? []
    : buildPageTools(client, bankId, {
        repoDir: cwd,
        harness,
        pageTrigger: buildPageTrigger(cfg),
        reflectToolTimeoutMs: cfg.reflectToolTimeoutMs,
        reflectBudget: cfg.reflectBudget,
        toolGuideExtra: cfg.toolGuideExtra,
        stampFor: () => buildRetainStamp(cfg, { directory: cwd, harness, bankId }),
      });
}

/**
 * The harness this server is running for, from the environment its registration declares.
 *
 * REQUIRED, deliberately with no fallback. This used to default to "claude-code", which read as a
 * safe convenience and was not: every host launches this same binary, so a registration that named
 * no harness was silently served as Claude Code — Codex ingests came back tagged
 * `harness:claude-code`, indistinguishable from Claude Code's own, and resolved Claude Code's bank
 * (#3603). A wrong answer here corrupts stored data; refusing to start is recoverable.
 */
export function resolveHarness(env: NodeJS.ProcessEnv = process.env): string {
  const harness = env.HINDSIGHT_MCP_HARNESS;
  if (!harness) {
    throw new Error(
      "HINDSIGHT_MCP_HARNESS is not set. Every coding agent launches this same mcp-server.js, so " +
        "only that variable identifies the caller — it decides the harness:<id> stamp on everything " +
        "ingested and which bank this session resolves. Re-run `npx " +
        "@vectorize-io/hindsight-coding-agents install <harness>` to repair a registration written " +
        "before the installer set it."
    );
  }
  return harness;
}

/**
 * Directory this process should treat as the project.
 *
 * Survey sets `HINDSIGHT_MCP_PROJECT_CWD`. Cursor cannot: user-level mcp.json is spawned from
 * `~` and Cursor does not interpolate `cwd`. The installer therefore passes
 * `${workspaceFolder}` as argv[2], which Cursor does interpolate.
 */
export function resolveProjectCwd(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  fallbackCwd = process.cwd()
): string {
  const override = env.HINDSIGHT_MCP_PROJECT_CWD?.trim();
  if (override && !override.includes("${")) return override;
  if (env.HINDSIGHT_MCP_HARNESS === "cursor-cli") {
    const folder = argv[2]?.trim();
    if (folder && !folder.includes("${")) return folder;
  }
  return fallbackCwd;
}

/**
 * Extract the first local filesystem path from MCP `roots/list` entries.
 */
export function extractRootPath(roots: ReadonlyArray<{ uri: string }>): string | undefined {
  for (const root of roots) {
    if (!root?.uri?.startsWith("file://")) continue;
    try {
      return fileURLToPath(root.uri);
    } catch {
      // Ignore malformed file URIs and try the next root.
    }
  }
  return undefined;
}

/**
 * Build the MCP surface for the resolved project.
 *
 * An opted-out project intentionally has no Hindsight tools, but some clients probe `tools/list`
 * without first checking the initialize capabilities. Advertising an empty, queryable tool list
 * keeps that privacy boundary intact while preventing one optional probe from failing startup.
 */
export function buildMcpServer(tools: ToolSpec[]): McpServer {
  const server = new McpServer({ name: "hindsight", version: "0.1.0" });
  if (tools.length === 0) {
    server.server.registerCapabilities({ tools: { listChanged: false } });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    return server;
  }

  for (const tool of tools) {
    // registerTool (not the deprecated `tool()`) so the safety annotations reach the client:
    // Dcode rejects unannotated MCP calls outright in headless mode, and Codex Auto-review treats
    // them as unverified external access. See ToolSpec.annotations.
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      tool.handler
    );
  }
  return server;
}

async function main() {
  const harness = resolveHarness();
  const explicitOverride = Boolean(process.env.HINDSIGHT_MCP_PROJECT_CWD?.trim());
  let hasMcpRoot = false;
  let activeCwd = resolveProjectCwd(
    process.env,
    process.argv,
    readActiveWorkspace(harness) ?? process.cwd()
  );

  const initial = resolveHostMemory(harness, activeCwd);
  void ensureControlPlaneStarted(initial.cfg, harness);
  const initialTools = selectTools(initial.cfg, initial.client, initial.bankId, {
    cwd: activeCwd,
    harness,
  });
  const activeHandlers = new Map<string, ToolSpec["handler"]>(
    initialTools.map((t) => [t.name, t.handler])
  );

  const rebindWorkspace = (nextCwd: string) => {
    if (!nextCwd || nextCwd === activeCwd) return;
    activeCwd = nextCwd;
    const next = resolveHostMemory(harness, activeCwd);
    void ensureControlPlaneStarted(next.cfg, harness);
    const nextTools = selectTools(next.cfg, next.client, next.bankId, { cwd: activeCwd, harness });
    activeHandlers.clear();
    for (const nt of nextTools) {
      activeHandlers.set(nt.name, nt.handler);
    }
  };

  // Delegate each registered tool through `activeHandlers` so `roots/list` (resolved after
  // the MCP `initialize` handshake), `roots/list_changed`, and hook-recorded active workspace
  // updates can rebind the project bank and `project:<name>` tag dynamically without restarting.
  const delegatedTools: ToolSpec[] = initialTools.map((t) => ({
    ...t,
    handler: async (args: Record<string, unknown>, extra?: unknown) => {
      if (!explicitOverride && !hasMcpRoot) {
        const recorded = readActiveWorkspace(harness);
        if (recorded) rebindWorkspace(recorded);
      }
      const h = activeHandlers.get(t.name);
      if (!h) {
        return {
          content: [
            { type: "text" as const, text: "Hindsight memory is disabled for this workspace." },
          ],
          isError: true,
        };
      }
      return h(args, extra);
    },
  }));

  const server = buildMcpServer(delegatedTools);

  const refreshFromRoots = async () => {
    if (explicitOverride) return;
    if (!server.server.getClientCapabilities()?.roots) return;
    try {
      const res = await server.server.listRoots();
      const rootDir = extractRootPath(res?.roots ?? []);
      if (!rootDir) return;
      hasMcpRoot = true;
      rebindWorkspace(rootDir);
    } catch {
      // Client advertised roots or failed the request; keep the existing cwd.
    }
  };

  server.server.oninitialized = () => {
    void refreshFromRoots();
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await refreshFromRoots();
  });

  await server.connect(new StdioServerTransport());
}

// Only auto-run when this file is executed directly (e.g. `node dist/mcp-server.js`) — importing
// it (as src/mcp-server.test.ts does) must not start a real server.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("hindsight mcp-server failed:", e);
    process.exit(1);
  });
}
