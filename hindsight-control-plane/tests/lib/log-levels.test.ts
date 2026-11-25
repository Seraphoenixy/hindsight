import { describe, expect, it } from "vitest";
import { countLogLevels, detectExplicitLogLevel, parseLogLines } from "@/lib/log-levels";

describe("log-levels", () => {
  it("classifies standard Python logging lines and captures level token spans", () => {
    const infoLine =
      "2026-11-24 14:51:51,771 - INFO - hindsight_api.engine.audit - destructive_op status=ok";
    const warnLine =
      "2026-11-24 14:52:04,946 - WARNING - hindsight_api.engine.providers - JSON parse error from reply";
    const errorLine = "2026-11-24 14:52:05,100 - ERROR - hindsight_api.api - request failed";
    const criticalLine = "2026-11-24 14:52:06,000 - CRITICAL - hindsight_api.main - fatal startup";
    const debugLine = "2026-11-24 14:52:07,000 - DEBUG - hindsight_api.db - pool acquire";

    const info = detectExplicitLogLevel(infoLine);
    expect(info?.level).toBe("info");
    expect(infoLine.slice(info!.matchStart!, info!.matchEnd!)).toBe("INFO");

    const warn = detectExplicitLogLevel(warnLine);
    expect(warn?.level).toBe("warn");
    expect(warnLine.slice(warn!.matchStart!, warn!.matchEnd!)).toBe("WARNING");

    const err = detectExplicitLogLevel(errorLine);
    expect(err?.level).toBe("error");
    expect(errorLine.slice(err!.matchStart!, err!.matchEnd!)).toBe("ERROR");

    const crit = detectExplicitLogLevel(criticalLine);
    expect(crit?.level).toBe("error");
    expect(criticalLine.slice(crit!.matchStart!, crit!.matchEnd!)).toBe("CRITICAL");

    const dbg = detectExplicitLogLevel(debugLine);
    expect(dbg?.level).toBe("debug");
    expect(debugLine.slice(dbg!.matchStart!, dbg!.matchEnd!)).toBe("DEBUG");
  });

  it("classifies uvicorn, bracketed, and JSON log lines", () => {
    const uvicornInfo = "INFO:     Started server process [32936]";
    const uvicornError = "ERROR:      + Exception Group Traceback (most recent call last):";
    const bracketWarn = "[WARN] Slow query detected";
    const jsonError = '{"severity":"ERROR","message":"boom","timestamp":"2026-11-24T00:00:00Z"}';

    expect(detectExplicitLogLevel(uvicornInfo)?.level).toBe("info");
    expect(detectExplicitLogLevel(uvicornError)?.level).toBe("error");
    expect(detectExplicitLogLevel(bracketWarn)?.level).toBe("warn");
    expect(detectExplicitLogLevel(jsonError)?.level).toBe("error");
  });

  it("propagates error/warn level to indented traceback continuation lines", () => {
    const raw = [
      "2026-11-24 14:51:51,000 - INFO - hindsight_api - starting",
      "ERROR:      + Exception Group Traceback (most recent call last):",
      "  |     await self.gen.athrow(typ, value, traceback)",
      "  |   File \"app.py\", line 10, in run",
      "2026-11-24 14:51:52,000 - INFO - hindsight_api - recovered",
      "✓ Ready in 0ms",
    ].join("\n");

    const parsed = parseLogLines(raw);
    expect(parsed.map((p) => p.level)).toEqual([
      "info",
      "error",
      "error",
      "error",
      "info",
      "other",
    ]);

    expect(countLogLevels(parsed)).toEqual({
      error: 3,
      warn: 0,
      info: 2,
      debug: 0,
      other: 1,
    });
  });

  it("handles Python warnings and Next.js error markers", () => {
    expect(detectExplicitLogLevel("UserWarning: cache symlinks disabled")?.level).toBe("warn");
    expect(detectExplicitLogLevel("✗ Failed to compile")?.level).toBe("error");
  });
});
