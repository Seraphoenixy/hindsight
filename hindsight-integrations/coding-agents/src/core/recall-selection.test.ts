import { describe, expect, it } from "vitest";
import { selectRecallCandidates } from "./recall-selection";

describe("Agent recall selection", () => {
  it("rejects weak semantic matches and graph-only results without query evidence", () => {
    expect(
      selectRecallCandidates([
        { text: "unrelated configuration", scores: { semantic: 0.41 } },
        { text: "graph neighbor", scores: { semantic: null, keyword: null } },
        { text: "legacy result without scores" },
      ])
    ).toEqual([]);
  });

  it("keeps lexical evidence and the similarity boundary, excluding invalidated records", () => {
    const records = [
      { text: "keyword match", scores: { keyword: 1 } },
      { text: "semantic match", scores: { semantic: 0.5 } },
      { text: "withdrawn", scores: { semantic: 0.9 }, state: "invalidated" },
      { text: "   ", scores: { semantic: 0.9 } },
    ];
    expect(selectRecallCandidates(records).map((record) => record.text)).toEqual([
      "semantic match",
      "keyword match",
    ]);
  });

  it("prioritizes query similarity over graph-inflated fusion order", () => {
    const records = [
      { text: "unrelated", scores: { semantic: 0.47 } },
      { text: "related", scores: { semantic: 0.6 } },
      { text: "direct answer", scores: { semantic: 0.81 } },
    ];
    expect(selectRecallCandidates(records).map((record) => record.text)).toEqual([
      "direct answer",
      "related",
    ]);
    expect(records[0].text).toBe("unrelated");
  });

  it("uses actual recording times to resolve equal relevance", () => {
    const records = [
      { text: "old", mentioned_at: "2026-11-26T08:00:00+08:00", scores: { semantic: 0.8 } },
      { text: "new", mentioned_at: "2026-11-26T01:00:00Z", scores: { semantic: 0.8 } },
    ];
    expect(selectRecallCandidates(records)[0].text).toBe("new");
  });
});
