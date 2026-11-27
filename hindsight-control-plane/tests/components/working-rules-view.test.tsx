// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  listWorkingRules: vi.fn(),
  createWorkingRule: vi.fn(),
  updateWorkingRule: vi.fn(),
  deleteWorkingRule: vi.fn(),
  restoreWorkingRule: vi.fn(),
  promoteWorkingRule: vi.fn(),
  exportWorkingRulesMarkdown: vi.fn(),
  previewWorkingRulesOrganization: vi.fn(),
  applyWorkingRulesOrganization: vi.fn(),
  listBanks: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/language-switcher", () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));
vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({ theme: "light", toggleTheme: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({ client: state }));

import { WorkingRulesView } from "@/components/working-rules-view";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseListResponse = {
  items: [
    {
      id: "rule-active",
      scope: "global" as const,
      project_id: null,
      content: "Keep responses strictly factual.",
      importance: "critical" as const,
      pinned: true,
      branches: ["main"],
      is_archived: false,
      archived_at: null,
      archive_reason: null,
      created_at: "2026-11-24T00:00:00Z",
      updated_at: "2026-11-24T00:00:00Z",
    },
    {
      id: "rule-archived",
      scope: "project" as const,
      project_id: "repo-a",
      content: "Legacy archived guideline.",
      importance: "normal" as const,
      pinned: false,
      branches: [],
      is_archived: true,
      archived_at: "2026-11-24T00:00:00Z",
      archive_reason: "capacity_overflow",
      created_at: "2026-11-24T00:00:00Z",
      updated_at: "2026-11-24T00:00:00Z",
    },
  ],
  total: 2,
  limit: 500,
  offset: 0,
  revision: "abcdef1234567890",
  usage: {
    used_bytes: 60,
    limit_bytes: 14336,
    pinned_chars: 32,
    pinned_limit_chars: 3072,
    active_count: 1,
    archived_count: 1,
  },
};

describe("WorkingRulesView", () => {
  it("renders active rules, exports markdown, restores archived rules, and previews AI organization", async () => {
    state.listWorkingRules.mockResolvedValue(baseListResponse);
    state.exportWorkingRulesMarkdown.mockResolvedValue({
      markdown: "# Working Rules\n\n- Keep responses strictly factual.\n",
    });
    state.restoreWorkingRule.mockResolvedValue(baseListResponse.items[1]);
    state.previewWorkingRulesOrganization.mockResolvedValue({
      expected_revision: "abcdef1234567890",
      summary: "No conflicts detected.",
      proposals: [
        {
          number: 1,
          action: "replace",
          reason: "Clarify constraint",
          old_text: "Keep responses strictly factual.",
          content: "State verified behavior, conditions, and results only.",
          importance: "critical",
          scope: "global",
        },
      ],
    });
    state.applyWorkingRulesOrganization.mockResolvedValue({
      revision: "fedcba0987654321",
      results: [{ number: 1, ok: true }],
    });

    render(<WorkingRulesView />);

    expect(await screen.findByText("Keep responses strictly factual.")).toBeTruthy();
    expect(screen.getByText("60 / 14336")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "exportMarkdown" }));
    await waitFor(() => expect(state.exportWorkingRulesMarkdown).toHaveBeenCalledTimes(1));
    expect(await screen.findByDisplayValue(/Keep responses strictly factual/)).toBeTruthy();
  });
});
