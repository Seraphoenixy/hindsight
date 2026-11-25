import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as applyOrganization } from "@/app/api/banks/[bankId]/memory-organization/apply/route";
import { POST as previewOrganization } from "@/app/api/banks/[bankId]/memory-organization/preview/route";
import {
  parseOrganizationSuggestions,
  organizationSnapshotMatches,
} from "@/lib/memory-organization";
import type { MemoryOrganizationRecord } from "@/lib/memory-organization-types";

const bankId = "engineering";
const record: MemoryOrganizationRecord = {
  id: "2f5632f6-d6a6-4d3f-9de8-329258d6cae6",
  text: "Keep the original retry operation ID.",
  tags: ["project:one"],
  state: "valid",
  edited_at: null,
  invalidated_at: null,
  invalidation_reason: null,
};

function context() {
  return { params: Promise.resolve({ bankId }) };
}

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/banks/${bankId}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("memory organization parser", () => {
  it("parses only the supported extractor protocol", () => {
    expect(
      parseOrganizationSuggestions([
        "[1] REWRITE || clearer rule || Keep the original retry operation ID.",
        "[2] MERGE || duplicate || 1",
        "[3] VERIFY || sources disagree",
        "not a suggestion",
      ])
    ).toEqual([
      {
        recordNumber: 1,
        action: "rewrite",
        reason: "clearer rule",
        value: "Keep the original retry operation ID.",
      },
      { recordNumber: 2, action: "merge", reason: "duplicate", value: "1" },
      { recordNumber: 3, action: "verify", reason: "sources disagree" },
    ]);
  });

  it("detects edits made after a preview", () => {
    expect(organizationSnapshotMatches(record, record)).toBe(true);
    expect(organizationSnapshotMatches({ ...record, text: "changed" }, record)).toBe(false);
  });
});

describe("memory organization routes", () => {
  it("builds a preview from recall, extraction, and the current record snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ results: [record] }))
      .mockResolvedValueOnce(
        Response.json({
          facts: [{ text: "[1] REWRITE || clearer rule || Use the original operation ID." }],
        })
      )
      .mockResolvedValueOnce(Response.json(record));
    vi.stubGlobal("fetch", fetchMock);

    const response = await previewOrganization(
      request("/memory-organization/preview", {
        topic: "retry operation IDs",
        instructions: "Make the rule concise.",
      }) as never,
      context()
    );
    const body = (await response.json()) as {
      records: MemoryOrganizationRecord[];
      changes: Array<{ action: string; text?: string; record: MemoryOrganizationRecord }>;
    };

    expect(response.status).toBe(200);
    expect(body.records).toEqual([record]);
    expect(body.changes).toEqual([
      expect.objectContaining({
        action: "rewrite",
        text: "Use the original operation ID.",
        record,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("applies a selected rewrite after rechecking the preview snapshot", async () => {
    const updated = { ...record, text: "Use the original operation ID.", edited_at: "later" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(record))
      .mockResolvedValueOnce(Response.json(updated));
    vi.stubGlobal("fetch", fetchMock);

    const response = await applyOrganization(
      request("/memory-organization/apply", {
        undo: false,
        changes: [
          {
            number: 1,
            action: "rewrite",
            reason: "clearer",
            record,
            text: updated.text,
          },
        ],
      }) as never,
      context()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{ number: 1, ok: true, applied: updated }],
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ text: updated.text }),
    });
  });

  it("reports a stale preview without issuing a write", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ...record, text: "changed" }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await applyOrganization(
      request("/memory-organization/apply", {
        undo: false,
        changes: [
          {
            number: 1,
            action: "archive",
            reason: "obsolete",
            record,
          },
        ],
      }) as never,
      context()
    );
    const body = (await response.json()) as { results: Array<{ ok: boolean; error?: string }> };

    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toContain("changed after this preview");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("undoes an applied archive after checking the post-apply snapshot", async () => {
    const applied = {
      ...record,
      state: "invalidated" as const,
      invalidated_at: "2026-11-24T00:00:00Z",
      invalidation_reason: "Archived by AI memory organization: obsolete",
    };
    const restored = { ...record, state: "valid" as const };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(applied))
      .mockResolvedValueOnce(Response.json(restored));
    vi.stubGlobal("fetch", fetchMock);

    const response = await applyOrganization(
      request("/memory-organization/apply", {
        undo: true,
        changes: [
          {
            number: 1,
            action: "archive",
            reason: "obsolete",
            record,
            applied,
          },
        ],
      }) as never,
      context()
    );

    expect(await response.json()).toEqual({
      results: [{ number: 1, ok: true, restored }],
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({
        state: "valid",
        reason: "Restored from AI memory organization undo.",
      }),
    });
  });
});
