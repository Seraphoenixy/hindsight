// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}));

vi.mock("@/lib/bank-context", () => ({
  useBank: () => ({ currentBank: "bank-a" }),
}));

const getMemory = vi.fn();
const updateMemory = vi.fn();
const deleteMemory = vi.fn();
vi.mock("@/lib/api", () => ({
  client: {
    getMemory: (...args: unknown[]) => getMemory(...args),
    updateMemory: (...args: unknown[]) => updateMemory(...args),
    deleteMemory: (...args: unknown[]) => deleteMemory(...args),
    getGraph: vi.fn(),
    getChunk: vi.fn().mockResolvedValue(null),
    getDocument: vi.fn().mockResolvedValue(null),
    listLLMRequests: vi.fn().mockResolvedValue({ items: [] }),
    getObservationHistory: vi.fn().mockResolvedValue({ items: [] }),
    listMemories: vi.fn().mockResolvedValue({ items: [] }),
  },
}));

import { MemoryDetailModal } from "@/components/memory-detail-modal";
import { cachedGraph, storeGraph } from "@/lib/graph-cache";

function makeMemory(state: "valid" | "invalidated" = "valid") {
  return {
    id: "mem-1",
    text: "User lives in Tokyo.",
    type: "world",
    context: "",
    date: "2026-11-26T00:00:00Z",
    entities: [],
    tags: [],
    metadata: null,
    observation_scopes: null,
    state,
  };
}

beforeEach(() => {
  getMemory.mockReset();
  updateMemory.mockReset();
  deleteMemory.mockReset();
});

afterEach(cleanup);

describe("MemoryDetailModal curation refresh", () => {
  it("invalidates graph cache and invokes onChanged after invalidating a memory", async () => {
    const graphParams = { bank_id: "bank-a", type: "world", limit: 1000 };
    const otherBankParams = { bank_id: "bank-b", type: "world", limit: 1000 };
    storeGraph(graphParams, { total_units: 1 });
    storeGraph(otherBankParams, { total_units: 1 });

    getMemory
      .mockResolvedValueOnce(makeMemory("valid"))
      .mockResolvedValueOnce(makeMemory("invalidated"));
    updateMemory.mockResolvedValueOnce({});
    const onChanged = vi.fn();

    render(<MemoryDetailModal memoryId="mem-1" onClose={() => {}} onChanged={onChanged} />);

    const invalidateBtn = await screen.findByRole("button", { name: "curationInvalidate" });
    fireEvent.click(invalidateBtn);

    const confirmBtns = await screen.findAllByRole("button", { name: "curationInvalidate" });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    await waitFor(() => expect(updateMemory).toHaveBeenCalledWith("mem-1", "bank-a", { state: "invalidated" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    expect(cachedGraph(graphParams)).toBeUndefined();
    expect(cachedGraph(otherBankParams)).toBeDefined();
  });

  it("invalidates graph cache and invokes onChanged after restoring a memory", async () => {
    const graphParams = { bank_id: "bank-a", type: "world", limit: 1000 };
    storeGraph(graphParams, { total_units: 0 });

    getMemory
      .mockResolvedValueOnce(makeMemory("invalidated"))
      .mockResolvedValueOnce(makeMemory("valid"));
    updateMemory.mockResolvedValueOnce({});
    const onChanged = vi.fn();

    render(<MemoryDetailModal memoryId="mem-1" onClose={() => {}} onChanged={onChanged} />);

    const restoreBtn = await screen.findByRole("button", { name: "curationRevert" });
    fireEvent.click(restoreBtn);

    await waitFor(() => expect(updateMemory).toHaveBeenCalledWith("mem-1", "bank-a", { state: "valid" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    expect(cachedGraph(graphParams)).toBeUndefined();
  });

  it("deletes an invalidated memory, invalidates graph cache, and closes modal", async () => {
    const graphParams = { bank_id: "bank-a", type: "world", limit: 1000 };
    storeGraph(graphParams, { total_units: 1 });

    getMemory.mockResolvedValueOnce(makeMemory("invalidated"));
    deleteMemory.mockResolvedValueOnce({ deleted: true, memory_id: "mem-1" });
    const onChanged = vi.fn();
    const onClose = vi.fn();

    render(<MemoryDetailModal memoryId="mem-1" onClose={onClose} onChanged={onChanged} />);

    const deleteBtn = await screen.findByRole("button", { name: "curationDelete" });
    fireEvent.click(deleteBtn);

    await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith("mem-1", "bank-a"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    expect(cachedGraph(graphParams)).toBeUndefined();
  });
});
