import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";
import { buildHookOutput, runHook } from "./hook";
import { diagFilePath, readHookEvent } from "./diag";
import { readActiveWorkspace } from "./session-cache";
import { journalPath, readJournalTranscript } from "./turn-journal";

let root: string;
let cacheFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hs-hook-"));
  cacheFile = join(root, "cache", "session.json");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

/** One page with a preamble and two headed sections. Pages are fetched/cached for the
 *  hindsight_search_pages tool but are NEVER auto-injected into context. */
const PAGE_CONTENT =
  "Preamble prose about this page.\n\n" +
  "## Retry backoff\n" +
  "Uploads retry with exponential backoff and a 200ms jitter window.\n\n" +
  "## Auth tokens\n" +
  "Tokens rotate daily via the auth service.\n";

/** The header formatPageInjection uses — must NEVER appear in hook context anymore. */
const PAGES_HEADER = "Project knowledge from Hindsight, this repository's long-term memory";

/** A prompt overlapping the "Retry backoff" section (pages still must not inject). */
const MATCHING_PROMPT = "why does the upload retry backoff fail?";
/** A prompt matching nothing in the page. */
const UNRELATED_PROMPT = "completely unrelated banana smoothie question";

function makeClient(
  overrides: Partial<{
    reflect: (query: string, opts: { budget?: string; timeoutMs: number }) => Promise<string>;
    listPages: () => Promise<unknown>;
    getPage: (pageId: string) => Promise<unknown>;
    searchPages: (
      query: string,
      opts?: { limit?: number; timeoutMs?: number }
    ) => Promise<{ id: string; name: string; snippet: string }[]>;
    recallObservations: (query: string, opts: { timeoutMs: number }) => Promise<string[]>;
    getWorkingRulesProjection: (opts?: { timeoutMs?: number }) => Promise<
      | {
          revision: string;
          text: string;
          entries: {
            content: string;
            importance: "critical" | "normal" | "low";
            pinned: boolean;
            scope: "global" | "project";
          }[];
          total_active_entries: number;
          minimum_characters: number;
          truncated: boolean;
        }
      | undefined
    >;
  }> = {}
) {
  return {
    reflect: vi.fn(async () => "REFLECT_ANSWER"),
    listPages: vi.fn(async () => ({ items: [{ id: "p1", name: "Uploader guide" }] })),
    getPage: vi.fn(async () => ({ content: PAGE_CONTENT })),
    searchPages: vi.fn(async () => [] as { id: string; name: string; snippet: string }[]),
    recallObservations: vi.fn(async () => [] as string[]),
    ...overrides,
  };
}

describe("buildHookOutput", () => {
  it("turn 1: injects recalled memories by default, wrapped in the system-injection preamble", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({ recallObservations: vi.fn(async () => ["RECALL_ANSWER"]) });
    const result = await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(result.context).toContain("Automatically retrieved by Hindsight");
    expect(result.context).toContain("RECALL_ANSWER");
    expect(client.reflect).not.toHaveBeenCalled();
    expect(existsSync(cacheFile)).toBe(true);
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(cached.turns).toBe(1);
    expect(cached.reflectAnswer).toContain("RECALL_ANSWER");
  });

  it("recall runs ONCE per session: cached on turn 1, not called again on turn 2", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({ recallObservations: vi.fn(async () => ["RECALL_ANSWER"]) });
    const t1 = await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    const t2 = await buildHookOutput({
      harness: "claude-code",
      prompt: "another prompt entirely",
      cfg,
      client,
      cacheFile,
    });
    expect(client.recallObservations).toHaveBeenCalledTimes(1);
    expect(client.reflect).not.toHaveBeenCalled();
    // Injected ONCE (hook context persists in the transcript — stacking it every turn would
    // duplicate the same block); turn 2 carries no repeat.
    expect(t1.context).toContain("RECALL_ANSWER");
    expect(t2.context ?? "").not.toContain("RECALL_ANSWER");
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).turns).toBe(2);
  });

  it("defers the first automatic injection for a new bank, then recalls on prompt two", async () => {
    mkdirSync(join(root, "cache"), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ deferInitialReflect: true }));
    const cfg = resolveConfig({});
    const client = makeClient({ recallObservations: vi.fn(async () => ["RECALL_ANSWER"]) });

    const first = await buildHookOutput({
      harness: "claude-code",
      prompt: "first task while the bank is seeding",
      cfg,
      client,
      cacheFile,
    });
    expect(client.recallObservations).not.toHaveBeenCalled();
    // The guide is re-stated every turn now (pageRefreshEveryTurns defaults to
    // 1), so context is never empty — what this test is about is that no MEMORY
    // was injected on the deferred turn.
    expect(first.context).not.toContain("<hindsight_memory>");
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).deferInitialReflect).toBeUndefined();

    const second = await buildHookOutput({
      harness: "claude-code",
      prompt: "second task after the bank has had time to populate",
      cfg,
      client,
      cacheFile,
    });
    expect(client.recallObservations).toHaveBeenCalledTimes(1);
    expect(second.context).toContain("RECALL_ANSWER");
  });

  it("recall rejection: retried once on a later turn, then cached '' — no throw, no context", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({
      recallObservations: vi.fn(async () => {
        throw new Error("recall boom");
      }),
    });
    const t1 = await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    // Recall failed -> no memory block; pages are never auto-injected -> nothing to inject.
    expect(t1.context).not.toContain("<hindsight_memory>");
    // ...but the turn is NOT silent: one line pointing at the diag trail (#3443).
    expect(t1.notice).toContain("no memory this turn");
    expect(t1.notice).toContain(diagFilePath());
    // A failure is not an answer: nothing is cached, so a later turn can still get memory (#4607).
    const afterT1 = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(afterT1.reflectAnswer).toBeUndefined();
    expect(afterT1.reflectAttempts).toBe(1);

    const args = { harness: "claude-code", prompt: UNRELATED_PROMPT, cfg, client, cacheFile };
    await buildHookOutput(args);
    expect(client.recallObservations).toHaveBeenCalledTimes(2);
    expect(client.reflect).not.toHaveBeenCalled();
    // Second failure exhausts the budget — now it IS cached, so a dead server costs 2 turns, not every turn.
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).reflectAnswer).toBe("");
    await buildHookOutput(args);
    expect(client.recallObservations).toHaveBeenCalledTimes(2);
  });

  it("inject_recall_failed records the server's full error body", async () => {
    const diagFile = join(root, "diag.log");
    vi.stubEnv("HINDSIGHT_DIAG_FILE", diagFile);
    const body = `{"detail":"${"x".repeat(400)} upstream LLM rejected the turn"}`;
    const client = {
      ...makeClient({
        recallObservations: vi.fn(async () => {
          throw new Error(`recall 500 ${body}`);
        }),
      }),
      bank: "coding-agent::demo",
    };
    await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg: resolveConfig({}),
      client,
      cacheFile,
    });

    const failed = readFileSync(diagFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "inject_recall_failed");
    expect(failed.bank).toBe("coding-agent::demo");
    expect(failed.timeoutMs).toBe(7000);
    expect(failed.error).toContain("recall 500");
    // Past describeError's default 200-char cut, where the root cause usually sits.
    expect(failed.error).toContain("upstream LLM rejected the turn");
  });

  it("the notice fires on the turns recall ran, and stops once the retries are spent", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({
      recallObservations: vi.fn(async () => {
        throw new Error("recall boom");
      }),
    });
    const args = { harness: "claude-code", prompt: UNRELATED_PROMPT, cfg, client, cacheFile };
    expect((await buildHookOutput(args)).notice).toContain("no memory this turn");
    // Turn 2 retries (and fails) — it observed the failure, so it says so.
    expect((await buildHookOutput(args)).notice).toContain("no memory this turn");
    // Turn 3 does not re-run recall, so re-announcing a failure it did not observe would nag.
    expect((await buildHookOutput(args)).notice).toBeUndefined();
  });

  it("an EMPTY recall is not a failure: no notice", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({ recallObservations: vi.fn(async () => []) });
    const result = await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(result.notice).toBeUndefined();
    expect(result.context).not.toContain("<hindsight_memory>");
  });

  it.each(["pages", "recall"] as const)(
    "autoInject %s honours the default and configured injection timeouts",
    async (autoInject) => {
      for (const injectTimeoutMs of [undefined, 2000, 15000]) {
        const client = makeClient();
        await buildHookOutput({
          harness: "dsh",
          prompt: MATCHING_PROMPT,
          cfg: resolveConfig({ autoInject, injectTimeoutMs }),
          client,
          cacheFile: join(root, `${autoInject}-${injectTimeoutMs}.json`),
        });
        const retrieve = autoInject === "pages" ? client.searchPages : client.recallObservations;
        expect(retrieve).toHaveBeenCalledWith(MATCHING_PROMPT, {
          timeoutMs: injectTimeoutMs ?? 7000,
        });
        expect(client.reflect).not.toHaveBeenCalled();
      }
    }
  );

  it("autoInject pages: injects page-search hits once, never reflects or recalls", async () => {
    const client = makeClient({
      searchPages: vi.fn(async () => [
        { id: "p1", name: "Uploader guide", snippet: "retry backoff 200ms jitter" },
      ]),
    });
    const cfg = resolveConfig({ autoInject: "pages" });
    const out = await buildHookOutput({
      harness: "claude-code",
      prompt: MATCHING_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(client.reflect).not.toHaveBeenCalled();
    expect(client.recallObservations).not.toHaveBeenCalled();
    expect(out.context).toContain("<hindsight_memory>");
    expect(out.context).toContain("Uploader guide (p1): retry backoff 200ms jitter");
    expect(out.context).not.toContain("synthesis was unavailable");
    expect(out.notice).toContain("Uploader guide");
    const next = await buildHookOutput({
      harness: "claude-code",
      prompt: "next",
      cfg,
      client,
      cacheFile,
    });
    expect(client.searchPages).toHaveBeenCalledTimes(1);
    expect(next.context ?? "").not.toContain("<hindsight_memory>");
  });

  it("autoInject pages: a FAILED search is retried within its budget", async () => {
    // The retryability fix applies to both retrieval sources. A page search that threw used to cache "" just
    // like a search that matched nothing, so a transient blip cost the whole session (#4607).
    const cfg = resolveConfig({ autoInject: "pages" });
    const client = makeClient({
      searchPages: vi.fn(async () => {
        throw new Error("search boom");
      }),
    });
    const args = { harness: "claude-code", prompt: MATCHING_PROMPT, cfg, client, cacheFile };
    await buildHookOutput(args);
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).reflectAnswer).toBeUndefined();
    await buildHookOutput(args);
    expect(client.searchPages).toHaveBeenCalledTimes(2);
    // Budget spent — now it is cached, so a broken search costs 2 turns and then stops.
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).reflectAnswer).toBe("");
    await buildHookOutput(args);
    expect(client.searchPages).toHaveBeenCalledTimes(2);
  });

  it("autoInject recall: an EMPTY result retries on a later prompt, within a bounded budget", async () => {
    // An empty first recall used to be cached as "" and stopped injection for the whole session,
    // although each turn queries with its OWN prompt (#5082).
    const cfg = resolveConfig({ autoInject: "recall" });
    const recallObservations = vi
      .fn<(q: string, o: { timeoutMs: number }) => Promise<string[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["Uploads retry 3 times."]);
    const client = makeClient({ recallObservations });
    const args = { harness: "claude-code", prompt: MATCHING_PROMPT, cfg, client, cacheFile };
    const first = await buildHookOutput(args);
    expect(first.context ?? "").not.toContain("Uploads retry 3 times.");
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).reflectAnswer).toBeUndefined();
    const second = await buildHookOutput(args);
    expect(second.context).toContain("Uploads retry 3 times.");
    expect(recallObservations).toHaveBeenCalledTimes(2);

    // Bounded: a bank that never matches stops being asked after five empty turns.
    rmSync(cacheFile, { force: true });
    const empty = makeClient({ recallObservations: vi.fn(async () => []) });
    for (let i = 0; i < 7; i++) await buildHookOutput({ ...args, client: empty });
    expect(empty.recallObservations).toHaveBeenCalledTimes(5);
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).reflectAnswer).toBe("");
  });

  it("autoInject recall: bounds the query under the server's 500-token cap", async () => {
    // A 2000-character slice sent ~1000 tokens of CJK, which older servers reject with HTTP 400,
    // so long or non-Latin prompts got no memory at all (#5476).
    const recallObservations = vi.fn(
      async (_q: string, _o: { timeoutMs: number }) => [] as string[]
    );
    const client = makeClient({ recallObservations });
    const cfg = resolveConfig({ autoInject: "recall" });
    const bytes = (s: string) => Buffer.byteLength(s, "utf8");
    for (const prompt of ["记忆".repeat(1500), "🧠".repeat(1000), "word ".repeat(1000)]) {
      rmSync(cacheFile, { force: true });
      await buildHookOutput({ harness: "claude-code", prompt, cfg, client, cacheFile });
      const query = recallObservations.mock.calls.at(-1)![0] as string;
      expect(query.length).toBeGreaterThan(0);
      expect(prompt.startsWith(query)).toBe(true);
      // Non-ASCII: never more UTF-8 bytes than the cap (a BPE token spans at least one byte).
      if (!/^[\x00-\x7f]*$/.test(prompt)) expect(bytes(query)).toBeLessThanOrEqual(500);
    }
    // ASCII keeps a useful query length rather than collapsing to the byte bound.
    expect((recallObservations.mock.calls.at(-1)![0] as string).length).toBe(1000);
  });

  it("injectQueryMaxChars caps what pages and recall search with, never the reflect goal (#5089)", async () => {
    const recallObservations = vi.fn(
      async (_q: string, _o: { timeoutMs: number }) => [] as string[]
    );
    const searchPages = vi.fn(
      async (_q: string, _o?: { timeoutMs?: number }) =>
        [] as { id: string; name: string; snippet: string }[]
    );
    const client = makeClient({ recallObservations, searchPages });
    const prompt = "🧠".repeat(10) + "word ".repeat(400);
    const run = async (raw: Parameters<typeof resolveConfig>[0]) => {
      rmSync(cacheFile, { force: true });
      await buildHookOutput({
        harness: "claude-code",
        prompt,
        cfg: resolveConfig(raw),
        client,
        cacheFile,
      });
    };
    await run({ autoInject: "recall", injectQueryMaxChars: 5 });
    // Code points, so the emoji pair is never split.
    expect(recallObservations.mock.calls.at(-1)![0]).toBe("🧠".repeat(5));
    await run({ autoInject: "pages", injectQueryMaxChars: 30 });
    expect(searchPages.mock.calls.at(-1)![0]).toBe(Array.from(prompt).slice(0, 30).join(""));
    // A cap above the built-in bounds changes nothing.
    await run({ autoInject: "pages", injectQueryMaxChars: 100_000 });
    expect(searchPages.mock.calls.at(-1)![0]).toBe(prompt.slice(0, 500));
    // Unset = today's query.
    await run({ autoInject: "pages" });
    expect(searchPages.mock.calls.at(-1)![0]).toBe(prompt.slice(0, 500));
  });

  it("autoInject recall: injects recalled observations, never reflects or searches pages", async () => {
    const client = makeClient({
      recallObservations: vi.fn(async () => ["Uploads retry 3 times."]),
    });
    const out = await buildHookOutput({
      harness: "claude-code",
      prompt: MATCHING_PROMPT,
      cfg: resolveConfig({ autoInject: "recall" }),
      client,
      cacheFile,
    });
    expect(client.reflect).not.toHaveBeenCalled();
    expect(client.searchPages).not.toHaveBeenCalled();
    expect(out.context).toContain("- Uploads retry 3 times.");
    expect(out.context).not.toContain("synthesis was unavailable");
  });

  it("autoInject recall: an EMPTY retrieval injects nothing and stays silent", async () => {
    const client = makeClient({ recallObservations: vi.fn(async () => []) });
    const out = await buildHookOutput({
      harness: "claude-code",
      prompt: MATCHING_PROMPT,
      cfg: resolveConfig({ autoInject: "recall" }),
      client,
      cacheFile,
    });
    expect(out.context ?? "").not.toContain("<hindsight_memory>");
    // Nothing to say is not a failure — announcing one would report a break on the sessions
    // where the plugin worked and the bank was simply sparse.
    expect(out.notice).toBeUndefined();
  });

  it("autoInject recall: a FAILED retrieval says so, like a failed reflect", async () => {
    const client = makeClient({
      recallObservations: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const out = await buildHookOutput({
      harness: "claude-code",
      prompt: MATCHING_PROMPT,
      cfg: resolveConfig({ autoInject: "recall" }),
      client,
      cacheFile,
    });
    expect(out.context ?? "").not.toContain("<hindsight_memory>");
    // These modes used to stay silent, so a memory-less turn looked identical to a healthy one.
    expect(out.notice).toContain("no memory this turn");
  });

  it("autoReflect false: never calls reflect, injects no memory block", async () => {
    const cfg = resolveConfig({ autoReflect: false });
    const client = makeClient();
    const out = await buildHookOutput({
      harness: "claude-code",
      prompt: "the prompt",
      cfg,
      client,
      cacheFile,
    });
    expect(client.reflect).not.toHaveBeenCalled();
    expect(out.context ?? "").not.toContain("<hindsight_memory>");
    // Tool-only mode's pull trigger: the roster refresh must carry the pages-first rule.
    const cfg2 = resolveConfig({ autoReflect: false, pageRefreshEveryTurns: 1 });
    const out2 = await buildHookOutput({
      harness: "claude-code",
      prompt: "next",
      cfg: cfg2,
      client,
      cacheFile,
    });
    expect(out2.context ?? "").toContain("NEW task or goal");
  });

  it("fetches the page ROSTER (ids + titles, no content) on the first turn; nothing injected from it", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({ recallObservations: vi.fn(async () => ["RECALL_ANSWER"]) });
    const result = await buildHookOutput({
      harness: "claude-code",
      prompt: MATCHING_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    // The roster is fetched into the session cache (ids + titles only — content lives behind
    // the server-side search tool now, so getPage is never called here)…
    expect(client.listPages).toHaveBeenCalledTimes(1);
    expect(client.getPage).not.toHaveBeenCalled();
    // …but NO page content appears in context: the context is the recall block only.
    expect(result.context).not.toContain(PAGES_HEADER);
    expect(result.context).not.toContain("Preamble prose about this page.");
    expect(result.context).not.toContain("200ms jitter window");
    expect(result.context).not.toContain("Auth tokens");
    expect(result.context).not.toContain("hindsight_read_page p1");
    expect(result.context).toContain("Automatically retrieved by Hindsight");
    expect(result.context).toContain("RECALL_ANSWER");
    // The roster is cached for the cadence-based refresh.
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(cached.pages.atTurn).toBe(1);
    expect(cached.pages.list).toEqual([{ id: "p1", title: "Uploader guide" }]);
  });

  it("pages with content are NEVER auto-injected, even for an unrelated prompt", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({ recallObservations: vi.fn(async () => ["RECALL_ANSWER"]) });
    const result = await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(result.context).toContain("RECALL_ANSWER"); // recall still injected
    expect(result.context).not.toContain(PAGES_HEADER);
    expect(result.context).not.toContain("hindsight_read_page p1");
  });

  it("empty page list -> no pages block", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({
      listPages: vi.fn(async () => ({ items: [] })),
      recallObservations: vi.fn(async () => ["RECALL_ANSWER"]),
    });
    const result = await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(result.context).toContain("RECALL_ANSWER"); // recall still injected
    expect(result.context).not.toContain(PAGES_HEADER);
    // The tool NAME now appears in the every-turn guide, so the thing to assert
    // is the absence of a page entry, not of the string.
    expect(result.context).not.toContain("hindsight_read_page p1");
  });

  it("injects the page-roster refresh only on cadence turns", async () => {
    const cfg = resolveConfig({ pageRefreshEveryTurns: 2 });
    const client = makeClient({ recallObservations: vi.fn(async () => ["RECALL_ANSWER"]) });
    // turn 1: not a multiple of 2 -> no refresh
    const t1 = await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(t1.context).not.toContain("hindsight_page_refresh");
    // turn 2: multiple of 2 -> refresh injected, listing the page roster
    const t2 = await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(t2.context).toContain("<hindsight_page_refresh>");
    expect(t2.context).toContain("deliberately NOT listed here");
    // The recall block is NOT re-injected on cadence turns (injected once, on its turn)
    expect(t2.context).not.toContain("RECALL_ANSWER");
  });

  it("listPages rejection: no throw, recall block still returned, turn still counted", async () => {
    const cfg = resolveConfig({});
    const client = makeClient({
      listPages: vi.fn(async () => {
        throw new Error("listPages boom");
      }),
      recallObservations: vi.fn(async () => ["RECALL_ANSWER"]),
    });
    const result = await buildHookOutput({
      harness: "claude-code",
      prompt: MATCHING_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(result.context).toContain("RECALL_ANSWER");
    expect(result.context).not.toContain(PAGES_HEADER);
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).turns).toBe(1);
  });

  it("persists and increments the turn counter each call", async () => {
    const cfg = resolveConfig({ pageRefreshEveryTurns: 3 });
    const client = makeClient();
    for (let n = 1; n <= 4; n++) {
      await buildHookOutput({
        harness: "claude-code",
        prompt: `turn ${n}`,
        cfg,
        client,
        cacheFile,
      });
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { turns?: number };
      expect(cached.turns).toBe(n);
    }
  });

  it("re-fetches pages every pageRefreshEveryTurns turns, serving the cache in between", async () => {
    const cfg = resolveConfig({ pageRefreshEveryTurns: 2 });
    const client = makeClient();
    // Seed the cache so this session already has pages from turn 1.
    mkdirSync(join(root, "cache"), { recursive: true });
    writeFileSync(
      cacheFile,
      JSON.stringify({
        turns: 1,
        reflectAnswer: "CACHED",
        pages: { atTurn: 1, list: [{ id: "p1", title: "Uploader guide", content: PAGE_CONTENT }] },
      })
    );
    // turn 2: 2 - 1 < 2 -> cache is fresh, no fetch
    await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(client.listPages).not.toHaveBeenCalled();
    // turn 3: 3 - 1 >= 2 -> stale, re-fetched
    await buildHookOutput({
      harness: "claude-code",
      prompt: UNRELATED_PROMPT,
      cfg,
      client,
      cacheFile,
    });
    expect(client.listPages).toHaveBeenCalledTimes(1);
  });
});

describe("runHook anti-recursion guard", () => {
  const ORIGINAL = process.env.HINDSIGHT_DISABLE_HOOKS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.HINDSIGHT_DISABLE_HOOKS;
    else process.env.HINDSIGHT_DISABLE_HOOKS = ORIGINAL;
  });

  it("HINDSIGHT_DISABLE_HOOKS set -> returns immediately, never reads stdin or builds a client", async () => {
    process.env.HINDSIGHT_DISABLE_HOOKS = "1";
    const makeClient = vi.fn();
    // No stdin is provided/mocked here — if the guard didn't return before `readFileSync(0, ...)`,
    // this call would attempt to read the real process stdin. The fact this resolves at all (let
    // alone without calling makeClient) proves the guard fired first.
    await runHook({ harness: "claude-code", parse: () => ({}), emit: (c) => ({ c }) }, makeClient);
    expect(makeClient).not.toHaveBeenCalled();
  });
});

vi.mock("./diag", async (orig) => ({
  ...(await orig<typeof import("./diag")>()),
  readHookEvent: vi.fn(),
}));

describe("runHook prompt cleaning (#6488)", () => {
  const spec = {
    harness: "hs-test-6488",
    journalPrompt: true,
    parse: (ev: Record<string, unknown>) => ({
      prompt: ev.prompt as string,
      cwd: root,
      sessionId: "s1",
    }),
    emit: (c: string) => ({ c }),
  };

  beforeEach(() => {
    vi.stubEnv("HINDSIGHT_BANK_MODE", "project");
    vi.stubEnv("HINDSIGHT_AUTO_SEED", "false");
    vi.stubEnv("HINDSIGHT_SERVER_MODE", "daemon");
    vi.stubEnv("HINDSIGHT_BANK_ID", "hs-test-6488");
    vi.stubEnv("HINDSIGHT_AUTO_INJECT", "recall");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 }))
    );
  });
  // The journal and the once-per-session cache both live in this harness's temp directory.
  afterEach(() =>
    rmSync(dirname(journalPath(spec.harness, "s1")), { recursive: true, force: true })
  );

  async function run(prompt: string) {
    vi.mocked(readHookEvent).mockReturnValue({ prompt });
    const client = makeClient();
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await runHook(spec, () => client as never);
    } finally {
      write.mockRestore();
    }
    return client;
  }

  it("drops a host's <system-reminder> block so the query starts with the user's words", async () => {
    const boilerplate = "host instructions ".repeat(300);
    const client = await run(
      `<system-reminder>\n${boilerplate}\n</system-reminder>\n\nwhy does upload retry fail?`
    );
    const journal = readJournalTranscript(journalPath(spec.harness, "s1"));
    expect(journal.map((t) => t.content)).toEqual(["why does upload retry fail?"]);
    expect(client.recallObservations).toHaveBeenCalledTimes(1);
    const [query] = vi.mocked(client.recallObservations).mock.calls[0];
    expect(query).not.toContain("system-reminder");
    expect(query).toContain("why does upload retry fail?");
  });

  it("a prompt made only of injected tags is skipped", async () => {
    const client = await run("<system-reminder>only host text</system-reminder>");
    expect(existsSync(journalPath(spec.harness, "s1"))).toBe(false);
    expect(client.recallObservations).not.toHaveBeenCalled();
  });

  it("records the prompt locally and skips retrieval while the daemon is down", async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", probe);
    const offline = await run("why does upload retry fail?");
    expect(offline.recallObservations).not.toHaveBeenCalled();
    expect(readJournalTranscript(journalPath(spec.harness, "s1"))[0].content).toBe(
      "why does upload retry fail?"
    );
    const recovered = await run("why does upload retry fail again?");
    expect(recovered.recallObservations).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("records the active workspace for MCP fallback resolution", async () => {
    await run("check active workspace recording");
    expect(readActiveWorkspace(spec.harness)).toBe(root);
  });
});

describe("buildHookOutput working rules revision injection", () => {
  it("injects working rules when revision is new or changes, and stays quiet when unchanged", async () => {
    const getWorkingRulesProjection = vi
      .fn()
      .mockResolvedValueOnce({
        revision: "rev-1",
        text: "Rule one",
        entries: [{ content: "Rule one", importance: "normal", pinned: false, scope: "global" }],
        total_active_entries: 1,
        minimum_characters: 0,
        truncated: false,
      })
      .mockResolvedValueOnce({
        revision: "rev-1",
        text: "Rule one",
        entries: [{ content: "Rule one", importance: "normal", pinned: false, scope: "global" }],
        total_active_entries: 1,
        minimum_characters: 0,
        truncated: false,
      })
      .mockResolvedValueOnce({
        revision: "rev-2",
        text: "Rule one\n\nRule two",
        entries: [
          { content: "Rule one", importance: "normal", pinned: false, scope: "global" },
          { content: "Rule two", importance: "critical", pinned: true, scope: "global" },
        ],
        total_active_entries: 2,
        minimum_characters: 0,
        truncated: false,
      })
      .mockResolvedValue({
        revision: "rev-empty",
        text: "",
        entries: [],
        total_active_entries: 0,
        minimum_characters: 0,
        truncated: false,
      });

    const client = makeClient({
      listPages: vi.fn(async () => ({ items: [] })),
      getWorkingRulesProjection,
    });
    const cfg = resolveConfig({ autoInject: "none", pageRefreshEveryTurns: 0 });

    const t1 = await buildHookOutput({
      harness: "claude-code",
      prompt: "hi",
      cfg,
      client,
      cacheFile,
    });
    expect(t1.context).toContain('<hindsight_working_rules revision="rev-1" entries="1">');
    expect(t1.context).toContain("Rule one");

    const t2 = await buildHookOutput({
      harness: "claude-code",
      prompt: "next",
      cfg,
      client,
      cacheFile,
    });
    expect(t2.context ?? "").not.toContain("<hindsight_working_rules");

    const t3 = await buildHookOutput({
      harness: "claude-code",
      prompt: "after edit",
      cfg,
      client,
      cacheFile,
    });
    expect(t3.context).toContain('<hindsight_working_rules revision="rev-2" entries="2">');
    expect(t3.context).toContain("Rule two");
    expect(t3.context).toContain("This block replaces all earlier Hindsight working rules");

    const t4 = await buildHookOutput({
      harness: "claude-code",
      prompt: "after removal",
      cfg,
      client,
      cacheFile,
    });
    expect(t4.context).toContain('<hindsight_working_rules revision="rev-empty" entries="0">');
    expect(t4.context).toContain("No standing working rules apply");

    const t5 = await buildHookOutput({
      harness: "claude-code",
      prompt: "next",
      cfg,
      client,
      cacheFile,
    });
    expect(t5.context ?? "").not.toContain("<hindsight_working_rules");
  });
});
