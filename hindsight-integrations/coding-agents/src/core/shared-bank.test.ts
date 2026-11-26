import { afterEach, describe, expect, it, vi } from "vitest";
import { retainLiveSession } from "./chat";
import { memoryCursorStore } from "./retain-cursor";
import { HindsightClient, type PageNode } from "./hindsight";

const bank = "工程知识与经验";
const left = new HindsightClient({
  apiUrl: "http://memory",
  bank,
  projectScope: { name: "left-repo", id: "left" },
});
const right = new HindsightClient({
  apiUrl: "http://memory",
  bank,
  projectScope: { name: "right-repo", id: "right" },
});

afterEach(() => vi.unstubAllGlobals());

describe("shared bank", () => {
  it("namespaces writes, reuses logical document IDs locally, and filters automatic reads", async () => {
    const calls: { url: URL; body: Record<string, any> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(url);
        calls.push({ url: u, body: JSON.parse((init.body as string) || "{}") });
        if (u.pathname.endsWith("/documents"))
          return Response.json({
            items: [{ id: "project:left:gitlog:repo" }, { id: "project:right:gitlog:repo" }],
            total: 2,
          });
        return Response.json({ text: "", results: [] });
      })
    );
    await left.retain("left", "", "gitlog:repo", ["project:right", "source:git"], "gitlog", {
      operationId: "retry",
    });
    await right.retain("right", "", "gitlog:repo", ["source:git"], "gitlog", {
      operationId: "retry",
    });
    await right.retain("reference", "", "ref", [], "document", { shared: true });
    expect(await left.listDocumentIds("source:git")).toEqual(new Set(["gitlog:repo"]));
    await left.recallObservations("query", { timeoutMs: 1000 });
    await left.reflect("query", { timeoutMs: 1000 });
    await left.reflect("query", { timeoutMs: 1000, allProjects: true });
    expect(calls[0].url.pathname).toBe(calls[1].url.pathname);
    expect(decodeURIComponent(calls[0].url.pathname)).toContain(`/banks/${bank}/memories`);
    expect(calls[0].body.items[0]).toMatchObject({
      document_id: "project:left:gitlog:repo",
      tags: ["source:git", "project:left"],
      observation_scopes: [["project:left"]],
    });
    expect(calls[1].body.items[0].document_id).toBe("project:right:gitlog:repo");
    expect(calls[2].body.items[0]).toMatchObject({
      tags: ["project:right", "scope:shared"],
      observation_scopes: [["scope:shared"]],
    });
    expect(calls[3].url.searchParams.getAll("tags")).toEqual(["source:git", "project:left"]);
    for (const call of calls.slice(4, 6))
      expect(call.body).toMatchObject({
        tags: ["project:left", "scope:shared"],
        tags_match: "any_strict",
      });
    expect(calls[6].body).not.toHaveProperty("tags");
  });

  it("keeps transcript segments in their own project after a workspace switch", async () => {
    const writes: {
      items: {
        document_id: string;
        content: string;
        tags: string[];
        metadata?: Record<string, string>;
      }[];
      operation_id: string;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse((init.body as string) || "{}");
        if (body.items) writes.push(body);
        return Response.json({ version: "0.0.0" });
      })
    );
    const cursors = memoryCursorStore();
    const time = "2026-01-01T00:00:00Z";
    const turns = [
      { role: "user", content: "left first" },
      { role: "assistant", content: "left first verified" },
      { role: "user", content: "right only" },
      { role: "assistant", content: "right only verified" },
      { role: "user", content: "left again" },
      { role: "assistant", content: "left again verified" },
    ];
    await retainLiveSession(left, "session", turns.slice(0, 2), time, "codex", { cursors });
    await retainLiveSession(right, "session", turns.slice(0, 4), time, "codex", { cursors });
    await retainLiveSession(left, "session", turns, time, "codex", { cursors });
    expect(writes.map(({ items }) => items[0].document_id)).toEqual([
      expect.stringMatching(/^project:left:engineering-exchange:/),
      expect.stringMatching(/^project:right:engineering-exchange:/),
      expect.stringMatching(/^project:left:engineering-exchange:/),
    ]);
    expect(
      writes.every(({ items }) =>
        items[0].tags.includes(`project:${items[0].document_id.split(":")[1]}`)
      )
    ).toBe(true);
    expect(writes[1].items[0].content).toContain("right only");
    expect(writes[1].items[0].content).not.toContain("left first");
    expect(writes[2].items[0].content).toContain("left again");
    expect(writes[2].items[0].content).not.toContain("right only");
    expect(writes.map(({ items }) => items[0].content.split("\n")[0])).toEqual([
      "PROJECT: left-repo",
      "PROJECT: right-repo",
      "PROJECT: left-repo",
    ]);
    expect(writes.map(({ items }) => items[0].metadata)).toEqual([
      expect.objectContaining({ project: "left-repo", project_id: "left" }),
      expect.objectContaining({ project: "right-repo", project_id: "right" }),
      expect.objectContaining({ project: "left-repo", project_id: "left" }),
    ]);
    expect(new Set(writes.map(({ operation_id }) => operation_id)).size).toBe(3);
  });

  it("seeds independent page trees and limits page searches and direct reads", async () => {
    const nodes: PageNode[] = [];
    const bodies: Record<string, any>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(url);
        if (u.pathname.endsWith("/tree")) return Response.json({ roots: nodes });
        if (u.pathname.endsWith("/search"))
          return Response.json({
            results: nodes.flatMap((node) => node.children ?? []),
          });
        const body = JSON.parse((init.body as string) || "{}");
        if (u.pathname.endsWith("/folders")) {
          const id = "folder-" + nodes.length;
          nodes.push({ id, kind: "folder", name: body.name, children: [] });
          return Response.json({ id });
        }
        if (init.method === "POST") {
          bodies.push(body);
          const folder = nodes.find((node) => node.id === body.parent_id)!;
          const id = folder.id + "-" + folder.children!.length;
          folder.children!.push({
            id,
            kind: "page",
            name: body.name,
            description: body.source_query,
          });
          return Response.json({ page_id: id });
        }
        return Response.json({ name: "page" });
      })
    );
    await left.seedPages();
    await right.seedPages();
    await left.seedPages();
    await new HindsightClient({
      apiUrl: "http://memory",
      bank,
      projectScope: { name: "LEFT-REPO", id: "left" },
    }).seedPages();
    expect(nodes.map((node) => node.children?.length)).toEqual([3, 3]);
    expect(nodes.map((node) => node.name)).toEqual(["left-repo", "right-repo"]);
    expect(
      bodies
        .slice(0, 3)
        .every(
          (body) => body.tags[0] === "project:left" && body.trigger.tags_match === "all_strict"
        )
    ).toBe(true);
    expect(bodies.slice(3).every((body) => body.tags[0] === "project:right")).toBe(true);
    expect(await left.searchPages("map")).toHaveLength(3);
    expect(await left.searchPages("map", { allProjects: true })).toHaveLength(6);
    await expect(left.getPage("folder-1-0")).rejects.toThrow("not found in this project");
  });
});
