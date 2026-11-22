import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isLoopbackHostname, originAllowed, requestHostname } from "@/lib/local-access";
import { resolveEmbedCommand, normalizeProfile } from "@/lib/ops";

/**
 * The local-management gate is the only thing standing between a web page and
 * process control on this machine, so its decisions are asserted directly rather
 * than through a route.
 */
describe("isLoopbackHostname", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", "LOCALHOST"])(
    "accepts %s",
    (host) => {
      expect(isLoopbackHostname(host)).toBe(true);
    }
  );

  it.each(["example.com", "192.168.1.10", "10.0.0.5", "evil.localhost.example", ""])(
    "rejects %s",
    (host) => {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  );
});

describe("requestHostname", () => {
  it("prefers the forwarded host over Host", () => {
    const headers = new Headers({ host: "127.0.0.1:9999", "x-forwarded-host": "example.com" });
    expect(requestHostname(headers)).toBe("example.com");
  });

  it("strips the port", () => {
    expect(requestHostname(new Headers({ host: "localhost:9999" }))).toBe("localhost");
  });

  it("keeps an IPv6 literal bracketed so the loopback set still matches", () => {
    expect(requestHostname(new Headers({ host: "[::1]:9999" }))).toBe("[::1]");
  });

  it("falls back to the URL when no host header is present", () => {
    expect(requestHostname(new Headers(), "http://127.0.0.1:9999/local")).toBe("127.0.0.1");
  });
});

describe("originAllowed", () => {
  it("allows an absent origin (a non-browser caller running as this user)", () => {
    expect(originAllowed(null)).toBe(true);
  });

  it.each(["http://localhost:9999", "http://127.0.0.1:9999", "https://[::1]:443"])(
    "allows the loopback page %s",
    (origin) => {
      expect(originAllowed(origin)).toBe(true);
    }
  );

  it.each([
    "https://example.com",
    "http://localhost.evil.test",
    "http://192.168.1.5:9999",
    // A sandboxed iframe or a file:// page: names no origin we can vouch for.
    "null",
    "",
    "not a url",
    "file:///etc/passwd",
  ])("rejects %s", (origin) => {
    expect(originAllowed(origin)).toBe(false);
  });
});

describe("resolveEmbedCommand", () => {
  it("honours HINDSIGHT_CP_EMBED_COMMAND, quotes included", () => {
    expect(
      resolveEmbedCommand({ HINDSIGHT_CP_EMBED_COMMAND: '"C:\\Program Files\\py\\hindsight-embed.exe"' })
    ).toEqual(["C:\\Program Files\\py\\hindsight-embed.exe"]);
  });

  it("splits a command with arguments", () => {
    expect(resolveEmbedCommand({ HINDSIGHT_CP_EMBED_COMMAND: "uvx hindsight-embed@1.2.3" })).toEqual([
      "uvx",
      "hindsight-embed@1.2.3",
    ]);
  });

  it.each(["ancestor", "active"])("finds the %s venv from a standalone working directory", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "hs-embed-resolve-"));
    const exe = process.platform === "win32" ? "hindsight-embed.exe" : "hindsight-embed";
    const scripts = process.platform === "win32" ? "Scripts" : "bin";
    const venv = join(root, kind === "ancestor" ? ".venv" : "active venv");
    const command = join(venv, scripts, exe);
    mkdirSync(join(venv, scripts), { recursive: true });
    writeFileSync(command, "");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(join(root, "control-plane", "standalone"));
    try {
      expect(resolveEmbedCommand(kind === "active" ? { VIRTUAL_ENV: venv } : {})).toEqual([command]);
    } finally {
      cwd.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the bare executable name", () => {
    const [command] = resolveEmbedCommand({});
    expect(command).toMatch(/hindsight-embed(\.exe)?$/);
  });
});

describe("normalizeProfile", () => {
  it("maps the default profile's names to the internal empty id", () => {
    expect(normalizeProfile("")).toBe("");
    expect(normalizeProfile("default")).toBe("");
    expect(normalizeProfile(null)).toBe("");
    expect(normalizeProfile(undefined)).toBe("");
    expect(normalizeProfile("  default  ")).toBe("");
  });

  it("keeps a named profile", () => {
    expect(normalizeProfile("coding-agent")).toBe("coding-agent");
    expect(normalizeProfile(" 测试 ")).toBe("测试");
  });
});
