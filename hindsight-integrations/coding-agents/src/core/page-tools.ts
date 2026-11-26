/**
 * Page MCP tool specs — runtime SDK-free so this stays unit-testable without a real MCP
 * host.
 *
 * `src/mcp-server.ts` is the only file with a runtime MCP SDK import; this module uses only its
 * `ToolAnnotations` type. The server wires the specs returned here into an `McpServer`. Each tool
 * wraps one `HindsightClient` page/recall method: it never throws — a thrown client error
 * is caught and turned into an `isError:true` text result so the calling LLM sees the failure
 * instead of the process crashing.
 *
 * The agent-facing surface is intentionally curated: grounding, capture, and explicit memory
 * curation. Raw page CRUD (create/update/delete) is deliberately NOT exposed — agents never author
 * page structure; they capture initiatives (`hindsight_capture_initiative`) and pages are
 * synthesized/maintained by the server. `hindsight_ingest_document` (raw-content retain) also
 * backs the codebase survey (core/survey.ts).
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { HindsightClient } from "./hindsight";
import { syncStatus } from "./status";
import { applyBankConfig, DEFAULT_REFLECT_TOOL_TIMEOUT_MS, loadConfig } from "./config";
import { diagFilePath } from "./diag";
import { describeError } from "./log";
import type { RetainStamp } from "./retain-stamp";
import type { PageTrigger } from "./missions";
import {
  previewEngineeringMemory,
  saveEngineeringMemory,
  type EngineeringInput,
} from "./engineering-memory";

export interface ToolResult {
  // Index signature so this structurally satisfies the MCP SDK's CallToolResult (which carries
  // extra optional fields we don't set) when passed to `McpServer.tool()` in src/mcp-server.ts —
  // the only file that imports the SDK; this file stays SDK-free.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type ToolSafetyAnnotations = Required<
  Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
>;

const READ_ONLY_ANNOTATIONS: ToolSafetyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const NON_DESTRUCTIVE_WRITE_ANNOTATIONS: ToolSafetyAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE_WRITE_ANNOTATIONS: ToolSafetyAnnotations = {
  ...NON_DESTRUCTIVE_WRITE_ANNOTATIONS,
  destructiveHint: true,
};

/**
 * Returned alongside every search result set.
 *
 * Phrased as an obligation triggered by the CALL, not by the agent judging that it "used" a page: a
 * model that paraphrases a snippet into its own prose does not register itself as having quoted
 * anything, and silently absorbs the memory instead of crediting it.
 */
const CREDIT_REMINDER =
  "Crediting is mandatory, not a judgement call: if anything these results contribute reaches your " +
  "reply — quoted, paraphrased, or merely confirming what you were going to say — open that part " +
  'with "> 🧠 **From Hindsight memory (<page>)** — <the specific facts you drew on>". Rewriting a ' +
  "snippet in your own words does not make it yours. If none of them bear on the turn, ignore them " +
  "silently — an unhelpful search needs no mention. These are past records: check a claim that " +
  "something was fixed or works against the code before relying on it.";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  /**
   * Safety metadata published verbatim as the tool's MCP annotations (src/mcp-server.ts).
   *
   * Required, not optional: it is not cosmetic. Dcode gates every MCP tool lacking a coherent
   * read-only annotation behind an approval prompt, so in its headless (`dcode -n`) runtime an
   * unannotated tool is REJECTED outright — "This MCP action requires approval, but the current
   * headless runtime has no approval UI." Codex Auto-review likewise treats an unannotated call as
   * unverified external access. Reads get READ_ONLY_ANNOTATIONS; ordinary writes get
   * NON_DESTRUCTIVE_WRITE_ANNOTATIONS, while direct memory edits also advertise destructiveHint
   * because they can archive a fact.
   */
  annotations: ToolSafetyAnnotations;
  handler: (args: any) => Promise<ToolResult>;
}

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function err(e: unknown): ToolResult {
  const message = describeError(e);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Wrap a handler body so a thrown client error always becomes an isError:true result, never a throw. */
function guarded(fn: (args: any) => Promise<unknown>): (args: any) => Promise<ToolResult> {
  return async (args: any) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return err(e);
    }
  };
}

function shapeEngineeringMemory(record: {
  id: string;
  text: string;
  type?: string;
  context?: string;
  date?: string;
  mentioned_at?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
  tags?: string[];
  document_id?: string | null;
  metadata?: Record<string, string>;
  state?: string;
  updated_at?: string | null;
  edited_at?: string | null;
  invalidated_at?: string | null;
  invalidation_reason?: string | null;
}) {
  return {
    id: record.id,
    text: record.text,
    ...(record.type ? { type: record.type } : {}),
    ...(record.context ? { context: record.context } : {}),
    ...(record.date ? { date: record.date } : {}),
    ...(record.mentioned_at ? { mentioned_at: record.mentioned_at } : {}),
    occurred_start: record.occurred_start ?? null,
    occurred_end: record.occurred_end ?? null,
    tags: record.tags ?? [],
    ...(record.document_id ? { document_id: record.document_id } : {}),
    ...(record.metadata ? { metadata: record.metadata } : {}),
    state: record.state ?? "valid",
    ...(record.updated_at ? { updated_at: record.updated_at } : {}),
    ...(record.edited_at ? { edited_at: record.edited_at } : {}),
    ...(record.invalidated_at ? { invalidated_at: record.invalidated_at } : {}),
    ...(record.invalidation_reason ? { invalidation_reason: record.invalidation_reason } : {}),
  };
}

/** Build the page + recall MCP tool specs, bound to one client/bank. */
export function buildPageTools(
  client: HindsightClient,
  bankId: string,
  opts: {
    repoDir?: string;
    harness?: string;
    stampFor?: () => RetainStamp;
    /** Refresh policy for a page `hindsight_capture_initiative` creates (core/missions.ts). */
    pageTrigger?: PageTrigger;
    /** How long `hindsight_reflect` waits on the server (cfg.reflectToolTimeoutMs). Must be
     *  threaded in by every caller: left unset, the client falls back to a 120s deadline that
     *  aborts high-budget synthesis on a populated bank mid-flight (#3590). */
    reflectToolTimeoutMs?: number;
    /** Reflect budget for `hindsight_reflect` (cfg.reflectBudget, default "high"). */
    reflectBudget?: "low" | "mid" | "high";
    /** cfg.toolGuideExtra, added after the crediting note so it lands with the results too. */
    toolGuideExtra?: string;
  } = {}
): ToolSpec[] {
  const extra = opts.toolGuideExtra?.trim();
  const crediting = extra ? `${CREDIT_REMINDER} ${extra}` : CREDIT_REMINDER;
  return [
    {
      name: "hindsight_sync_status",
      description: client.projectScope
        ? "Report this project's stored survey findings, imported documents, conversation conclusions, pages, and pending memory operations."
        : "Report whether this repo's memory bank is in sync: gitlog seed present, how much recent " +
          "history has been deepened with full diffs, conversations ingested, pages " +
          "created, and extractions still running. `synced: true` means the seeded memory is fully " +
          "queryable. Ingestion is automatic and background — if not synced, it is in progress; " +
          "nothing to run.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async () => {
        try {
          return ok(await syncStatus(client, bankId, opts.repoDir ?? process.cwd()));
        } catch (e) {
          return err(e);
        }
      },
    },
    {
      name: "hindsight_diagnose",
      description:
        "Report safe Hindsight runtime diagnostics for this coding-agent session: resolved bank, " +
        "workspace, harness, config location, API endpoint, and non-secret environment overrides. " +
        "Use this when memory, hooks, MCP tools, or configuration appear not to work. Tokens and " +
        "other secret values are never returned.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (_args: Record<string, never>) => {
        const configPath =
          process.env.HINDSIGHT_CONFIG || join(homedir(), ".hindsight", "coding-agent.json");
        const harness = opts.harness ?? "unknown";
        // Resolve through the SAME pipeline the host used — including the `banks.<id>` section for
        // the bank this client is bound to, which may carry its own apiToken/apiUrl. A bare
        // loadConfig() would report a mismatch for every per-bank credential.
        const cfg = applyBankConfig(
          loadConfig({ harness: opts.harness }),
          bankId,
          opts.repoDir
        ).cfg;
        return ok({
          bank_id: bankId,
          harness,
          workspace: opts.repoDir ?? process.cwd(),
          config: {
            path: configPath,
            exists: existsSync(configPath),
            api_url: cfg.apiUrl,
            api_token_configured: Boolean(cfg.apiToken),
            disabled: cfg.disabled,
          },
          // What the LIVE client is signing with, which is not the same question as what the file
          // says. A long-lived host used to keep a credential the config had already replaced, and
          // this tool reported that state as perfectly healthy (#3600). Booleans only — the token
          // value is never returned.
          credential: {
            api_token_in_use: Boolean(client.apiToken),
            api_token_matches_config: client.apiToken === cfg.apiToken,
          },
          environment: {
            config_override: Boolean(process.env.HINDSIGHT_CONFIG),
            hooks_disabled: Boolean(process.env.HINDSIGHT_DISABLE_HOOKS),
            log_level: process.env.HINDSIGHT_LOG_LEVEL ?? null,
            diagnostics_file: diagFilePath(),
            channel_id_configured: Boolean(process.env.HINDSIGHT_CHANNEL_ID),
            user_id_configured: Boolean(process.env.HINDSIGHT_USER_ID),
          },
        });
      },
    },
    {
      name: "hindsight_recall",
      description:
        "Retrieve raw world and experience memories relevant to a query. This returns memory records, IDs, tags, source metadata, and lifecycle state; it does not generate a synthesized answer. Use it when a page is too shallow, when you need the evidence behind a conclusion, or before editing a memory.",
      inputSchema: {
        query: z.string().trim().min(1).max(2000).describe("what memories to retrieve"),
        limit: z.number().int().min(1).max(20).default(10),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ query, limit }: { query: string; limit?: number }) => {
        const records = await client.engineeringRecords(query, limit ?? 10);
        return {
          records: records.map(shapeEngineeringMemory),
          applicability:
            "Records describe knowledge at their mentioned_at time, not verified current state. Check current code and newer records before applying historical defaults.",
          crediting: CREDIT_REMINDER,
        };
      }),
    },
    {
      name: "hindsight_edit_memory",
      description:
        "Update the text or lifecycle state of one world/experience memory. Use hindsight_recall to obtain its memory_id and the expected_text/expected_state snapshots to guard the write. The tool is marked destructive so the host can present its normal approval prompt before the write. Observations cannot be edited directly.",
      inputSchema: {
        memory_id: z.string().uuid(),
        expected_text: z
          .string()
          .trim()
          .min(1)
          .max(2400)
          .describe(
            "The exact current text, as returned by hindsight_recall; the write is rejected if it changed since then"
          ),
        expected_state: z
          .enum(["valid", "invalidated"])
          .optional()
          .describe(
            "The exact current state, as returned by hindsight_recall; checked when provided"
          ),
        text: z
          .string()
          .trim()
          .min(1)
          .max(2400)
          .optional()
          .describe("The complete replacement conclusion"),
        state: z
          .enum(["valid", "invalidated"])
          .optional()
          .describe("Use invalidated to archive, or valid to restore"),
        reason: z
          .string()
          .trim()
          .max(1000)
          .optional()
          .describe("Why the user requested this archive or restore"),
      },
      annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
      handler: guarded(
        async ({
          memory_id,
          expected_text,
          expected_state,
          text,
          state,
          reason,
        }: {
          memory_id: string;
          expected_text: string;
          expected_state?: "valid" | "invalidated";
          text?: string;
          state?: "valid" | "invalidated";
          reason?: string;
        }) => {
          const current = await client.engineeringMemory(memory_id);
          if (!current)
            throw new Error("Memory not found in the current project. Recall it again.");
          if (current.type === "observation")
            throw new Error("Observations are synthesized records and cannot be edited directly.");
          if (current.text !== expected_text)
            throw new Error(
              "Memory changed since recall — recall it again and retry with the fresh text. Nothing was written."
            );
          if (expected_state !== undefined && (current.state ?? "valid") !== expected_state)
            throw new Error(
              "Memory state changed since recall — recall it again and retry with the fresh state. Nothing was written."
            );
          if (text === undefined && state === undefined)
            throw new Error("Provide replacement text, a new state, or both.");
          return {
            memory: shapeEngineeringMemory(
              await client.curateEngineeringMemory(memory_id, {
                ...(text !== undefined ? { text } : {}),
                ...(state !== undefined ? { state } : {}),
                ...(reason !== undefined ? { reason } : {}),
              })
            ),
          };
        }
      ),
    },
    {
      name: "hindsight_search_pages",
      description:
        "Search this repository's Hindsight pages for content relevant to a query — " +
        "hybrid full-text + semantic search, server-side. Call this when the user's question may " +
        "be answered by the project's accumulated knowledge (architecture, conventions, decisions, " +
        "initiatives) rather than by reading code. Returns ranked pages, each with its opening " +
        "text (not the passage that matched, and not filtered by relevance); " +
        // Same sentence the payload carries, from the same constant: two copies of a rule this
        // fiddly drift apart, and the description is what a host shows when the tool is listed.
        "read a full page with hindsight_read_page. " +
        crediting,
      inputSchema: {
        query: z.string().describe("what to look for"),
        all_projects: z
          .boolean()
          .optional()
          .describe("Search the entire bank when explicitly requested"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async (args: { query: string; all_projects?: boolean }) => {
        try {
          // Limit comes from the client (`pageSearchLimit`), so the tool and the hook's injection
          // can never drift apart — this used to pass its own literal 3.
          const hits = args.all_projects
            ? await client.searchPages(args.query, { allProjects: true })
            : await client.searchPages(args.query);
          // No `score`. The server fuses BM25 and vector search with reciprocal rank fusion, so the
          // number is ~1/(60+rank) summed over two retrievers: a perfect top hit scores about 0.03
          // and nothing ever approaches 1. Handed that, a model reads a strong match as 3% relevant
          // and discounts it. The hits arrive in rank order, which is the ranking that means
          // something here.
          // The reminder rides WITH the hits, not only in the session guide. Measured on real
          // sessions: the agent searched, got ten on-topic pages, wrote an answer built from them
          // and credited nothing — then credited correctly the moment the user asked "where did you
          // see that?". The guide had scrolled far up the context by then; the instruction that
          // lands at the same moment as the results is the one that can still be acted on.
          return ok({
            pages: hits.map((h) => ({
              page: h.name,
              page_id: h.id,
              // The question the page answers — the same `description` the list and read tools
              // carry, so a hit says what the page is FOR, not just how it opens.
              ...(h.source_query ? { description: h.source_query } : {}),
              snippet: h.snippet,
            })),
            crediting,
          });
        } catch (e) {
          return err(e);
        }
      },
    },
    {
      name: "hindsight_list_pages",
      description:
        "List this repository's Hindsight pages — curated, continuously-updated " +
        "summaries of the project's durable knowledge (architecture, components, conventions, key " +
        "decisions, and in-flight initiatives). Returns each page's id, title, and a one-line " +
        "description of what it covers. Call this at the start of any non-trivial task, and again " +
        "periodically in long sessions, to see what the project already knows before you read code " +
        "or ask the user. The list changes as work is captured, so re-check it occasionally.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async () => client.listPages()),
    },
    {
      name: "hindsight_read_page",
      description:
        "Read the full content of one page by its id (from " +
        "hindsight_list_pages). Call this whenever a listed page is relevant to what " +
        "you're about to do — e.g. read Conventions before writing new code, Component map before " +
        "changing a subsystem, or an initiative's page before continuing that feature. A page may " +
        "contain [[page:<id>]] links to related pages; follow one by calling this tool again with " +
        "that id. Prefer reading a page over re-deriving the same understanding from source.",
      inputSchema: {
        page_id: z.string(),
        all_projects: z
          .boolean()
          .optional()
          .describe("Open a page outside this project when explicitly requested"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ page_id, all_projects }) =>
        all_projects ? client.getPage(page_id, true) : client.getPage(page_id)
      ),
    },
    {
      name: "hindsight_reflect",
      description:
        "Deep memory reasoning: an agentic synthesis over this repository's FULL memory (git " +
        "decisions, past sessions, ingested knowledge) that answers WHY questions — the past " +
        "decision and exact rule/values that explain a behavior, bug, or convention. Slower than " +
        "hindsight_search_pages (several seconds): reach for it when pages are too " +
        "shallow and you need the root cause or the decided literals. When the answer informs " +
        'your reply, credit it visibly with a blockquote header: "> 🧠 **From Hindsight memory** — <summary>".',
      inputSchema: {
        query: z.string().describe("the question to reason over memory about"),
        all_projects: z
          .boolean()
          .optional()
          .describe("Reflect across the entire bank when explicitly requested"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ query, all_projects }: { query: string; all_projects?: boolean }) =>
        client.reflect(query, {
          ...(all_projects ? { allProjects: true } : {}),
          budget: opts.reflectBudget ?? "high",
          timeoutMs: opts.reflectToolTimeoutMs ?? DEFAULT_REFLECT_TOOL_TIMEOUT_MS,
        })
      ),
    },
    {
      name: "hindsight_capture_initiative",
      description:
        "Record a new feature or initiative as a tracked page, so future sessions know it " +
        "exists and can build on it — and keep that page tracking the plan as it moves.\n\n" +
        "WHEN TO CALL:\n" +
        "- Starting one: right after the user approves a plan or finishes brainstorming a new feature/" +
        "capability and you are about to start implementing — BEFORE you write any code. Leave " +
        "relates_to_page_id empty.\n" +
        "- Plan changed: call it AGAIN — mid-implementation is fine and expected — whenever the goal, " +
        "scope, or rationale of an initiative you already captured materially changes (an approach is " +
        "dropped, scope grows or shrinks, the why is rewritten). Pass relates_to_page_id = that " +
        "initiative's page id so the change lands on the existing page. Never mint a second page for the " +
        "same initiative.\n\n" +
        "WHEN TO SKIP: bug fixes, small tweaks, refactors, chores, and trivial course-corrections that " +
        "leave the goal intact are not initiatives — skip them.\n\n" +
        "- title: short, specific name (e.g. 'Newsletter refinement chat'). On a recapture, reuse the " +
        "initiative's existing title.\n" +
        "- summary: 2-3 sentences on what you're building and why — the CURRENT intent, not the " +
        "originally approved plan (on a recapture, say what changed and why).\n" +
        "- relates_to_page_id: leave empty for a new initiative. Set it to an existing initiative's page " +
        "id — from hindsight_list_pages, or the id this tool returned earlier — to record a " +
        "plan change or an enhancement to it.\n\n" +
        "Returns the page id. The page is generated for you — you never format one yourself.",
      inputSchema: {
        title: z.string(),
        summary: z.string(),
        relates_to_page_id: z.string().optional(),
      },
      annotations: NON_DESTRUCTIVE_WRITE_ANNOTATIONS,
      handler: guarded(async ({ title, summary, relates_to_page_id }) =>
        client.captureInitiative({
          title,
          summary,
          relatesToPageId: relates_to_page_id,
          ...(opts.stampFor ? { stamp: opts.stampFor() } : {}),
          ...(opts.pageTrigger ? { pageTrigger: opts.pageTrigger } : {}),
        })
      ),
    },
    {
      name: "hindsight_ingest_document",
      description:
        "Save an external document or a block of durable notes/findings into this repository's " +
        "memory so it informs future recall and pages. Use for design notes, research, or " +
        "reference material you want remembered — not for the conversation you're already in " +
        "(that's captured automatically at session end). This is ALSO the correction mechanism: " +
        "when you verify that a retrieved memory is wrong or outdated, ingest a document titled " +
        "'Correction: <topic>' stating what memory claimed, what is actually true, and why — " +
        "the newer fact supersedes the stale one in future retrieval.",
      inputSchema: {
        title: z.string(),
        content: z.string(),
        reference: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe("Source URL or project path, ideally with its section and version"),
        shared: z
          .boolean()
          .optional()
          .describe("Make this reference available to all projects when explicitly requested"),
      },
      annotations: NON_DESTRUCTIVE_WRITE_ANNOTATIONS,
      handler: guarded(async ({ title, content, shared, reference }) => {
        if (client.projectScope && process.env.HINDSIGHT_DISABLE_HOOKS !== "1") {
          const input: EngineeringInput = {
            source: "document",
            title,
            reference: reference || title,
            material: content,
            shared,
            harness: opts.harness,
            stamp: opts.stampFor?.(),
          };
          const candidates = await previewEngineeringMemory(client, input);
          const documentIds = await saveEngineeringMemory(client, input, candidates);
          return { ok: true, accepted: candidates.length, document_ids: documentIds };
        }
        const slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        // ASCII-only slugs erased non-Latin titles (or shared the "doc" fallback),
        // overwriting unrelated documents. Hash the original title, not its content,
        // so re-ingestion still updates it; "--" cannot occur in a legacy slug.
        const docId =
          /[^\x00-\x7f]/.test(title) || !slug
            ? `${slug || "doc"}--${createHash("sha256").update(title).digest("hex")}`
            : slug;
        const stamp = opts.stampFor?.();
        const metadata = {
          ...stamp?.metadata,
          ...(opts.harness ? { harness: opts.harness } : {}),
        };
        await client.retain(
          content,
          "ingested document",
          docId,
          [
            ...new Set([
              ...(stamp?.tags ?? []),
              "source:upload",
              ...(opts.harness ? [`harness:${opts.harness}`] : []),
            ]),
          ],
          "document",
          {
            ...(Object.keys(metadata).length ? { metadata } : {}),
            ...(shared ? { shared: true } : {}),
          }
        );
        return { ok: true, doc_id: docId };
      }),
    },
    {
      name: "hindsight_working_rules",
      description:
        "Read standing Working Rules for the user. " +
        "Defaults to the effective active projection; pass view='all' " +
        "or filters to inspect stored rules and usage metadata.",
      inputSchema: {
        view: z
          .enum(["effective", "all"])
          .optional()
          .describe("'effective' returns active projection; 'all' lists stored entries"),
        include_archived: z.boolean().optional().describe("Include archived rules when view='all'"),
        query: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe("Case-insensitive substring search when view='all'"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      handler: guarded(async ({ view, include_archived, query }) => {
        if (view === "all" || include_archived || query) {
          const list = await client.listWorkingRules({
            includeArchived: include_archived,
            q: query,
          });
          if (!list) {
            return { supported: false, items: [], total: 0 };
          }
          return list;
        }
        const projection = await client.getWorkingRulesProjection();
        if (!projection) {
          return { supported: false, revision: "", text: "", entries: [] };
        }
        return projection;
      }),
    },
    {
      name: "hindsight_manage_working_rules",
      description:
        "Add, replace, or remove standing Working Rules when the user explicitly sets, updates, or " +
        "withdraws an ongoing preference, workflow constraint, or coding rule. Do not store secrets, " +
        "temporary progress, or one-off task context.",
      inputSchema: {
        action: z.enum(["add", "replace", "remove"]).describe("Mutation operation"),
        content: z
          .string()
          .trim()
          .min(1)
          .max(8192)
          .optional()
          .describe("New rule content (required for add and replace)"),
        old_text: z
          .string()
          .trim()
          .min(1)
          .max(8192)
          .optional()
          .describe("Existing rule text or unique substring (required for replace and remove)"),
        importance: z
          .enum(["critical", "normal", "low"])
          .optional()
          .describe(
            "Rule importance (default normal; replace keeps existing higher level unless raised)"
          ),
      },
      annotations: NON_DESTRUCTIVE_WRITE_ANNOTATIONS,
      handler: guarded(async ({ action, content, old_text, importance }) => {
        const result = await client.mutateWorkingRules({
          action,
          content,
          old_text,
          importance,
        });
        if (!result) {
          throw new Error("This Hindsight server does not support Working Rules yet.");
        }
        return result;
      }),
    },
  ];
}
