import { afterEach, describe, expect, it, vi } from "vitest";
import { retainLiveSession } from "./chat";
import { HindsightClient } from "./hindsight";
import { buildPageTools } from "./page-tools";
import { memoryCursorStore } from "./retain-cursor";

const apiUrl = "http://hindsight.test";
const bank = "engineering";
const project = { id: "one", name: "test project" };
const client = () => new HindsightClient({ apiUrl, bank, projectScope: project });

afterEach(() => vi.unstubAllGlobals());

function setup(facts: (material: string) => string[]) {
  const retained: {
    items: {
      content: string;
      context: string;
      strategy: string;
      tags: string[];
      metadata?: Record<string, string>;
    }[];
    operation_id: string;
  }[] = [];
  const extracted: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) || "{}");
    if (url.endsWith("/dry-run-extract")) {
      extracted.push(body.content);
      return Response.json({ facts: facts(body.content).map((text) => ({ text })) });
    }
    if (url.endsWith("/memories") && body.items) retained.push(body);
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetch);
  return { retained, extracted };
}

describe("engineering memory", () => {
  it("retains nothing for a routine exchange and does not extract it twice", async () => {
    const { retained, extracted } = setup(() => []);
    const cursors = memoryCursorStore();
    const memory = client();
    const turns = [
      { role: "user", content: "Rename the helper." },
      { role: "action", content: "Edit app.ts" },
      { role: "assistant", content: "Renamed it. Tests passed." },
    ];
    await retainLiveSession(memory, "session", turns, "", "codex", { cursors });
    await retainLiveSession(memory, "session", turns, "", "codex", { cursors });
    expect(retained).toHaveLength(1);
    expect(extracted).toHaveLength(0);
    expect(retained[0].items[0].content).not.toContain("Edit app.ts");
    expect(retained[0].items[0].content).toMatch(/^PROJECT: test project \[one\]\n/);
    expect(retained[0].items[0].strategy).toBe("conversation");
    expect(retained[0].items[0].tags).toEqual(
      expect.arrayContaining(["project:one", "source:chat", "engineering:record"])
    );
    expect(retained[0].items[0].context).toContain("test project [one]");
    expect(retained[0].items[0].metadata).toMatchObject({
      project: "test project",
      project_id: "one",
      source: "chat",
      session_id: "session",
      ref_id: expect.stringMatching(/^conversation:session#/),
      harness: "codex",
    });
  });

  it("saves document conclusions and reuses a write ID", async () => {
    const { retained } = setup(() => ["[decision] Retry operations with their original ID."]);
    const ingest = buildPageTools(client(), bank).find(
      (tool) => tool.name === "hindsight_ingest_document"
    )!;
    const input = {
      title: "Retries",
      content: "Retry rules. WIP appendix.",
      reference: "ADR-12#retries",
    };
    expect(JSON.parse((await ingest.handler(input)).content[0].text)).toMatchObject({
      accepted: 1,
    });
    await ingest.handler(input);
    expect(retained[0].items[0]).toMatchObject({
      strategy: "engineering-record",
      tags: expect.arrayContaining(["project:one", "source:upload", "knowledge:decision"]),
      content: "Retry operations with their original ID.",
    });
    expect(retained[0].items[0].content).not.toContain("WIP appendix");
    expect(retained[0].operation_id).toBe(retained[1].operation_id);
  });
});
