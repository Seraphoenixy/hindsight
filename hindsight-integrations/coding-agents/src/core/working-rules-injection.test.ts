import { describe, expect, it, vi } from "vitest";
import { buildWorkingRulesInjection, fetchWorkingRulesInjection } from "./working-rules-injection";
import { stripInjectedMemory } from "./transcript-util";

describe("working-rules-injection", () => {
  it("builds and strips <hindsight_working_rules> blocks cleanly", () => {
    const block = buildWorkingRulesInjection({
      revision: "rev-123",
      text: "[CRITICAL] Use strict typing",
      entries: [
        {
          content: "Use strict typing",
          importance: "critical",
        },
      ],
      total_active_entries: 1,
      minimum_characters: 0,
      truncated: false,
    });
    expect(block).toContain('<hindsight_working_rules revision="rev-123" entries="1">');
    expect(block).toContain("[CRITICAL] Use strict typing");

    const promptWithBlock = `${block}\n\nImplement the feature`;
    expect(stripInjectedMemory(promptWithBlock).trim()).toBe("Implement the feature");
  });

  it("returns empty block on unsupported or failing servers", async () => {
    const unsupported = await fetchWorkingRulesInjection({
      workingRulesSupported: false,
      getWorkingRulesProjection: vi.fn(),
    });
    expect(unsupported.block).toBe("");

    const failing = await fetchWorkingRulesInjection({
      getWorkingRulesProjection: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    expect(failing.block).toBe("");
  });
});
