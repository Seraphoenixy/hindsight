/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const mockState = vi.hoisted(() => ({
  pathname: "/local",
  getVersion: vi.fn(),
  listBanks: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockState.pathname,
}));

vi.mock("@/lib/api", () => ({
  client: {
    getVersion: mockState.getVersion,
    listBanks: mockState.listBanks,
  },
}));

import { FeaturesProvider, useFeatures } from "@/lib/features-context";
import { BankProvider, useBank } from "@/lib/bank-context";

function Probe() {
  const { loading } = useFeatures();
  const { banksLoading } = useBank();
  return <div data-features-loading={String(loading)} data-banks-loading={String(banksLoading)} />;
}

describe("FeaturesProvider & BankProvider on standalone routes", () => {
  beforeEach(() => {
    mockState.pathname = "/local";
    mockState.getVersion.mockReset().mockResolvedValue({ features: {} });
    mockState.listBanks.mockReset().mockResolvedValue({ banks: [], total: 0 });
  });

  it("skips dataplane fetches on /local, /login, and /dashboard mount, then fetches on /banks/my-bank", async () => {
    const { rerender } = render(
      <FeaturesProvider>
        <BankProvider>
          <Probe />
        </BankProvider>
      </FeaturesProvider>
    );

    await waitFor(() => {
      expect(mockState.getVersion).not.toHaveBeenCalled();
      expect(mockState.listBanks).not.toHaveBeenCalled();
    });

    for (const deferredPath of ["/login", "/dashboard"]) {
      mockState.pathname = deferredPath;
      rerender(
        <FeaturesProvider>
          <BankProvider>
            <Probe />
          </BankProvider>
        </FeaturesProvider>
      );

      expect(mockState.getVersion).not.toHaveBeenCalled();
      expect(mockState.listBanks).not.toHaveBeenCalled();
    }

    mockState.pathname = "/knowledge-banks";
    rerender(
      <FeaturesProvider>
        <BankProvider>
          <Probe />
        </BankProvider>
      </FeaturesProvider>
    );

    await waitFor(() => {
      expect(mockState.getVersion).toHaveBeenCalledTimes(1);
      expect(mockState.listBanks).toHaveBeenCalledTimes(1);
    });
  });
});
