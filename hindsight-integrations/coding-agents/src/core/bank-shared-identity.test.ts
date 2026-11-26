import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./git-layout", () => ({ probeGitLayout: vi.fn() }));

import { BankResolutionError, resolveProjectScope } from "./bank";
import { probeGitLayout } from "./git-layout";

const probe = vi.mocked(probeGitLayout);

function checkout(parent: string, name: string) {
  const root = join(parent, name);
  probe.mockReturnValue({ status: "resolved", commonDir: join(root, ".git"), bare: false });
  return resolveProjectScope(root);
}

afterEach(() => vi.clearAllMocks());

describe("shared project identity", () => {
  it("uses the same name across machines and relocated checkouts without a path hash", () => {
    const first = checkout("/machine-a/work", "Hindsight");
    const second = checkout("/machine-b/projects", "Hindsight");
    expect(first).toEqual({ id: "hindsight", name: "Hindsight" });
    expect(second).toEqual(first);
  });

  it("keeps long and Unicode names distinct instead of truncating them to one slug", () => {
    const prefix = "same-project-name-that-is-longer-than-thirty-two-characters";
    expect(checkout("/work", `${prefix}-one`).id).not.toBe(checkout("/work", `${prefix}-two`).id);
    expect(checkout("/work", "项目甲").id).not.toBe(checkout("/work", "项目乙").id);
    expect(checkout("/work", "my project").id).not.toBe(checkout("/work", "my-project").id);
  });

  it("normalizes case and Unicode consistently and protects document-id separators", () => {
    expect(checkout("/work", "Demo").id).toBe(checkout("/other", "demo").id);
    expect(checkout("/work", "café").id).toBe(checkout("/other", "cafe\u0301").id);
    expect(checkout("/work", "repo:notes").id).toBe("repo%3Anotes");
  });

  it("keeps linked worktrees in the main checkout's project", () => {
    const main = checkout("/work", "repo");
    expect(resolveProjectScope(join("/work", ".worktrees", "feature"))).toEqual(main);
  });

  it("uses the session root for plain workspaces without splitting on subdirectories", () => {
    probe.mockReturnValue({ status: "absent" });
    const root = join("/machine-a", "scratch");
    expect(resolveProjectScope(join(root, "src"), root)).toEqual({
      id: "scratch",
      name: "scratch",
    });
    expect(resolveProjectScope(join("/machine-b", "scratch")).id).toBe("scratch");
  });

  it("still refuses to invent an identity when the repository probe fails", () => {
    probe.mockReturnValue({ status: "failed", reason: "unreadable repository" });
    expect(() => resolveProjectScope("/work/repo")).toThrow(BankResolutionError);
  });
});
