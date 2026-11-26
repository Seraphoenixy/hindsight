import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MARKER } from "../installer";
import { traecodeDotDirName } from "./skill-dirs";
import { binOnPath, nodeBinary } from "./util";

const execFileAsync = promisify(execFile);

export interface HostInjectionState {
  name: string;
  label: string;
  detected: boolean;
  installed: boolean;
  harnessDisabled: boolean;
  effectiveEnabled: boolean;
}

interface HostSpec {
  name: string;
  label: string;
  detect: (home: string) => boolean;
  isInstalled: (home: string) => boolean;
}

function hasPath(bin: string): boolean {
  return binOnPath(bin) !== undefined;
}

function fileContains(path: string, needle = MARKER): boolean {
  try {
    if (!existsSync(path)) return false;
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

function anyFileContains(paths: string[], needle = MARKER): boolean {
  return paths.some((p) => fileContains(p, needle));
}

function kimiHomeDir(home: string): string {
  return process.env.KIMI_SHARE_DIR || join(home, ".kimi");
}

function dshPatchPaths(home: string): string[] {
  const dirs = [process.env.DSH_HOME, join(home, ".dsh")].filter((d): d is string => Boolean(d));
  return dirs.map((d) => join(d, "cordis.patch.yml"));
}

const HOST_SPECS: HostSpec[] = [
  {
    name: "antigravity-cli",
    label: "Antigravity (agy)",
    detect: (h) => hasPath("agy") || existsSync(join(h, ".gemini", "config")),
    isInstalled: (h) => fileContains(join(h, ".gemini", "config", "hooks.json")),
  },
  {
    name: "claude-code",
    label: "Claude Code",
    detect: (h) => hasPath("claude") || existsSync(join(h, ".claude")),
    isInstalled: (h) => fileContains(join(h, ".claude", "settings.json")),
  },
  {
    name: "codex",
    label: "Codex",
    detect: (h) => hasPath("codex") || existsSync(join(h, ".codex")),
    isInstalled: (h) =>
      anyFileContains([join(h, ".codex", "hooks.json"), join(h, ".codex", "config.toml")]),
  },
  {
    name: "cursor-cli",
    label: "Cursor",
    detect: (h) => hasPath("cursor-agent") || existsSync(join(h, ".cursor")),
    isInstalled: (h) =>
      anyFileContains([join(h, ".cursor", "hooks.json"), join(h, ".cursor", "mcp.json")]),
  },
  {
    name: "opencode",
    label: "OpenCode",
    detect: (h) => hasPath("opencode") || existsSync(join(h, ".config", "opencode")),
    isInstalled: (h) =>
      anyFileContains([
        join(h, ".config", "opencode", "opencode.jsonc"),
        join(h, ".config", "opencode", "opencode.json"),
      ]),
  },
  {
    name: "opencode2",
    label: "OpenCode 2",
    detect: () => hasPath("opencode2"),
    isInstalled: (h) =>
      anyFileContains(
        [
          join(h, ".config", "opencode", "opencode.jsonc"),
          join(h, ".config", "opencode", "opencode.json"),
        ],
        "opencode2"
      ),
  },
  {
    name: "kilo",
    label: "Kilo CLI",
    detect: (h) => hasPath("kilo") || existsSync(join(h, ".config", "kilo")),
    isInstalled: (h) =>
      anyFileContains([
        join(h, ".config", "kilo", "kilo.jsonc"),
        join(h, ".config", "kilo", "kilo.json"),
        join(h, ".config", "kilo", "opencode.json"),
      ]),
  },
  {
    name: "copilot-cli",
    label: "GitHub Copilot CLI",
    detect: (h) => hasPath("copilot") || existsSync(join(h, ".copilot")),
    isInstalled: (h) => existsSync(join(h, ".copilot", "hooks", "hindsight-coding-agents.json")),
  },
  {
    name: "cline-cli",
    label: "Cline CLI",
    detect: (h) => hasPath("cline") || existsSync(join(h, ".cline")),
    isInstalled: (h) =>
      fileContains(join(h, ".cline", "data", "settings", "cline_mcp_settings.json")),
  },
  {
    name: "devin-cli",
    label: "Devin CLI",
    detect: (h) => hasPath("devin") || existsSync(join(h, ".config", "devin")),
    isInstalled: (h) => fileContains(join(h, ".config", "devin", "config.json")),
  },
  {
    name: "grok-build",
    label: "Grok Build",
    detect: (h) => hasPath("grok") || existsSync(join(h, ".grok")),
    isInstalled: (h) => fileContains(join(h, ".grok", "config.toml")),
  },
  {
    name: "qwen-code",
    label: "Qwen Code",
    detect: (h) => hasPath("qwen") || existsSync(join(h, ".qwen")),
    isInstalled: (h) => fileContains(join(h, ".qwen", "settings.json")),
  },
  {
    name: "kimi-code",
    label: "Kimi Code",
    detect: (h) => hasPath("kimi") || existsSync(kimiHomeDir(h)),
    isInstalled: (h) => fileContains(join(kimiHomeDir(h), "config.toml")),
  },
  {
    name: "pi",
    label: "pi",
    detect: (h) => hasPath("pi") || existsSync(join(h, ".pi", "agent")),
    isInstalled: (h) => fileContains(join(h, ".pi", "agent", "settings.json")),
  },
  {
    name: "prime-agent",
    label: "Prime Agent",
    detect: (h) => hasPath("prime-agent") || existsSync(join(h, ".prime", "agent")),
    isInstalled: (h) => fileContains(join(h, ".prime", "agent", "settings.json")),
  },
  {
    name: "factory-droid",
    label: "Factory Droid",
    detect: (h) => hasPath("droid") || existsSync(join(h, ".factory")),
    isInstalled: (h) => fileContains(join(h, ".factory", "hooks.json")),
  },
  {
    name: "zcode",
    label: "ZCode",
    detect: (h) => hasPath("zcode") || existsSync(join(h, ".zcode")),
    isInstalled: (h) =>
      anyFileContains([join(h, ".zcode", "cli", "config.json"), join(h, ".zcode", "config.json")]),
  },
  {
    name: "traecode",
    label: "TraeCode",
    detect: (h) => existsSync(join(h, traecodeDotDirName(h))) || hasPath("trae"),
    isInstalled: (h) => fileContains(join(h, traecodeDotDirName(h), "hooks.json")),
  },
  {
    name: "workbuddy",
    label: "WorkBuddy",
    detect: (h) => existsSync(join(h, ".workbuddy")),
    isInstalled: (h) => fileContains(join(h, ".workbuddy", "settings.json")),
  },
  {
    name: "codebuddy",
    label: "CodeBuddy",
    detect: (h) => existsSync(join(h, ".codebuddy")),
    isInstalled: (h) => fileContains(join(h, ".codebuddy", "settings.json")),
  },
  {
    name: "dcode",
    label: "Dcode",
    detect: (h) => hasPath("dcode") || existsSync(join(h, ".deepagents")),
    isInstalled: (h) =>
      anyFileContains(
        [
          join(h, ".deepagents", "agent", "plugins", "installed_plugins.json"),
          join(h, ".deepagents", "plugins", "installed_plugins.json"),
        ],
        "hindsight"
      ),
  },
  {
    name: "dsh",
    label: "DeepSeek Harness",
    detect: (h) => dshPatchPaths(h).some((p) => existsSync(dirname(p))),
    isInstalled: (h) => anyFileContains(dshPatchPaths(h)),
  },
];

export const VALID_HOST_NAMES = new Set(HOST_SPECS.map((s) => s.name));

export function inspectHosts(
  rawConfig: Record<string, unknown>,
  globalEnabled: boolean,
  home = homedir()
): HostInjectionState[] {
  const harnesses =
    rawConfig.harnesses &&
    typeof rawConfig.harnesses === "object" &&
    !Array.isArray(rawConfig.harnesses)
      ? (rawConfig.harnesses as Record<string, Record<string, unknown> | undefined>)
      : {};
  return HOST_SPECS.map((spec) => {
    const detected = spec.detect(home);
    const installed = spec.isInstalled(home);
    const harnessDisabled = harnesses[spec.name]?.disabled === true;
    return {
      name: spec.name,
      label: spec.label,
      detected,
      installed,
      harnessDisabled,
      effectiveEnabled: globalEnabled && !harnessDisabled,
    };
  });
}

function resolveInstallerPath(home = homedir()): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "coding-agents", "dist", "installer.js"),
    join(home, ".hindsight", "coding-agents", "dist", "installer.js"),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("未找到 installer.js，请先构建 coding-agents");
  return hit;
}

const INSTALLER_WARN_RE =
  /\bskipped\b|could not|manually|preserved|did not finish|unrecognised|add `hooks = true`/i;

export interface HostInstallResult {
  warnings: string[];
}

export async function runHostInstaller(
  action: "install" | "uninstall",
  host: string,
  home = homedir()
): Promise<HostInstallResult> {
  if (!VALID_HOST_NAMES.has(host)) throw new Error(`未知宿主: ${host}`);
  const installer = resolveInstallerPath(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
  };
  const { stdout } = await execFileAsync(nodeBinary(), [installer, action, host], {
    env,
    timeout: 60_000,
    windowsHide: true,
  });
  const warnings = stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^[│\s▲✓✖]+/, "").trim())
    .filter((line) => INSTALLER_WARN_RE.test(line));
  return { warnings };
}
