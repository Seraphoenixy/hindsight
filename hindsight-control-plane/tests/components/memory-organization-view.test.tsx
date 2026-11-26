// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  previewMemoryOrganization: vi.fn(),
  applyMemoryOrganization: vi.fn(),
}));

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/bank-context", () => ({
  useBank: () => ({ currentBankName: "Engineering" }),
}));
vi.mock("@/lib/api", () => ({ client: state }));

import { MemoryOrganizationView } from "@/components/memory-organization-view";

const record = {
  id: "2f5632f6-d6a6-4d3f-9de8-329258d6cae6",
  text: "Old conclusion.",
  tags: ["project:one"],
  state: "valid" as const,
  edited_at: null,
  invalidated_at: null,
  invalidation_reason: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemoryOrganizationView", () => {
  it("shows the prompt form and an AI-generated preview", async () => {
    state.previewMemoryOrganization.mockResolvedValue({
      preview_id: "preview",
      records: [record],
      changes: [
        {
          number: 1,
          action: "rewrite",
          reason: "clearer",
          record,
          text: "Better conclusion.",
        },
        {
          number: 2,
          action: "verify",
          reason: "sources disagree",
          record: { ...record, id: "another-id" },
        },
      ],
    });

    render(<MemoryOrganizationView bankId="engineering" />);

    expect(screen.getByText("instructionsTitle")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("instructions"), {
      target: { value: "Make conclusions concise." },
    });
    fireEvent.click(screen.getByRole("button", { name: "generatePreview" }));

    await waitFor(() =>
      expect(state.previewMemoryOrganization).toHaveBeenCalledWith("engineering", {
        instructions: "Make conclusions concise.",
      })
    );
    expect(await screen.findByText("Better conclusion.")).toBeTruthy();
    expect(screen.getByText("verifyHint")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "applySelected" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
