// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  listEntities: vi.fn(),
  getEntityGraph: vi.fn(),
  getEntity: vi.fn(),
  listMemories: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ client: api }));
vi.mock("@/lib/bank-context", () => ({ useBank: () => ({ currentBank: "test-bank" }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/components/constellation", () => ({ Constellation: () => null }));
vi.mock("@/components/tag-filter-input", () => ({ TagFilterInput: () => null }));
vi.mock("@/components/memory-detail-modal", () => ({ MemoryDetailModal: () => null }));
vi.mock("@/components/data-view", () => ({
  TimelineView: ({ filteredRows }: { filteredRows: unknown[] }) => (
    <div data-testid="timeline-count">{filteredRows.length}</div>
  ),
}));

import { EntitiesView } from "@/components/entities-view";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("loads every page of linked memories instead of truncating the entity timeline at 500", async () => {
  const entity = { id: "alice", canonical_name: "Alice", mention_count: 501 };
  api.listEntities.mockResolvedValue({ items: [entity], total: 1 });
  api.getEntityGraph.mockResolvedValue({ nodes: [], edges: [] });
  api.getEntity.mockResolvedValue(entity);
  api.listMemories
    .mockResolvedValueOnce({ items: Array.from({ length: 500 }, (_, id) => ({ id: String(id) })), total: 501 })
    .mockResolvedValueOnce({ items: [{ id: "500" }], total: 501 });
  render(<EntitiesView />);
  fireEvent.click(screen.getByText("viewList"));
  fireEvent.click(await screen.findByText("Alice"));
  await waitFor(() => expect(screen.getByTestId("timeline-count").textContent).toBe("501"));
  expect(api.listMemories).toHaveBeenNthCalledWith(
    2,
    "test-bank",
    expect.objectContaining({ entityId: "alice", limit: 500, offset: 500 })
  );
});
