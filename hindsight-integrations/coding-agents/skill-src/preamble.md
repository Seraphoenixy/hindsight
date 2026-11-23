---
name: hindsight-coding-agent
description: How this machine's Hindsight coding-agent memory works — the plugin behind the 🧠 banner. Use when the user says "store/remember this in hindsight", asks what the memory/pages are, wants to configure per-repo memory (disable, rename banks, git depth), or something memory-related looks broken.
---

# Hindsight Coding-Agent Memory

This machine runs the `hindsight-coding-agents` plugin: long-term project memory for coding
sessions, backed by a Hindsight server. You (the agent) are already wired into it — this skill
explains what happens automatically, which tools you have, and how to configure or debug it.

## What happens automatically (no action needed)

- **Shared memory bank**: approved projects use `工程知识与经验` by default.
  Worktrees share their main checkout's project scope within the bank.
- **Project approval**: projects listed in `optInPaths` can initialize their pages.
  Git history, codebase surveys, session write-back, and historical session import
  have separate controls and default to off in shared mode.
- **Session synthesis**: the first prompt can inject context via `autoInject`. Recall and
  Reflect default to the current project plus explicitly shared references.
- **Cross-project lookup**: pass `all_projects: true` to page search or Reflect when the
  task spans projects. Pass `shared: true` when ingesting a reference intended for every project.

## Storing things deliberately

When the user says "store this in hindsight" / "remember this":

- The **current conversation** is captured at session end if session write-back is enabled. Otherwise, use `hindsight_ingest_document` for the notes the user wants to retain.
- An **external document, notes, or durable findings** → `hindsight_ingest_document(title, content)`.
- A **new feature/initiative being started** → `hindsight_capture_initiative(title, summary)`,
  right after the plan is agreed and before code is written.
- A **plan that materially changed** (goal, scope, or rationale — including mid-implementation) →
  call `hindsight_capture_initiative` again with `relates_to_page_id` set to that initiative's page
  id, summarising the _current_ intent. Same page, updated plan — never a second page. Trivial
  course-corrections don't count.

## Retrieving

- `hindsight_search_pages(query)` — FIRST STOP for project questions (components,
  conventions, past decisions, initiatives). Server-side hybrid search, fast.
- `hindsight_read_page(page_id)` / `hindsight_list_pages` — read pages fully.
- `hindsight_reflect(query)` — deep reasoning over scoped memory for WHY questions and exact
  decided values; slower (seconds), use deliberately.
- Credit visibly whenever memory informs an answer: start that part with
  `🧠 From Hindsight memory (<page>): …` — and never credit memory that didn't contribute.

## Correcting wrong or stale memory

If you verify that something Hindsight served is wrong or outdated (the code, git, or an external
source contradicts it), FIX THE RECORD — don't just ignore it. Call
`hindsight_ingest_document` with:

- **title**: `Correction: <topic>` (e.g. `Correction: retry policy 4xx set`)
- **content**: (1) what memory claimed, (2) what is verifiably true now, (3) the evidence you
  checked (file/commit/output). Quote exact values verbatim.

Newer facts supersede older ones in retrieval, so one clear correction permanently outranks the
stale memory. Do this whenever you catch a wrong injected memory, a stale page claim, or
an outdated decision — silent disregard leaves the trap armed for the next session.
