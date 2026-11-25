"use client";

import { useEffect, useState } from "react";
import { BankSelector } from "@/components/bank-selector";
import { BanksOverview } from "@/components/banks-overview";
import { Spinner } from "@/components/ui/spinner";
import { useBank } from "@/lib/bank-context";
import { useFeatures } from "@/lib/features-context";
import { useRouter } from "@/i18n/navigation";

export default function DashboardPage() {
  const { setCurrentBank, loadBanks } = useBank();
  const { refreshFeatures } = useFeatures();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  // The dashboard lists banks that live in the dataplane. When that backend is
  // absent (first run, a stopped daemon, a wrong dataplane URL), an empty bank
  // view looks like an empty product and hides the one thing the user has to do
  // — configure and start the daemon. Send them to /local instead; that page owns
  // the profile's configuration and the daemon's lifecycle.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let connected = false;
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const body = (await response.json()) as { dataplane?: { status?: string } };
        connected = body.dataplane?.status === "connected";
      } catch {
        connected = false;
      }
      if (cancelled) return;
      if (connected) {
        void refreshFeatures();
        void loadBanks();
        setReady(true);
      } else {
        router.replace("/local");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, refreshFeatures, loadBanks]);

  // This page is the "all banks" view, so nothing is selected while it is open.
  // The selection survives navigating back here from a bank page otherwise, and the
  // header would keep offering bank-scoped actions for a bank that is not on screen.
  useEffect(() => {
    if (ready) setCurrentBank(null);
  }, [ready, setCurrentBank]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Spinner size="lg" variant="jump" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-1 flex flex-col">
        <BankSelector />
        <BanksOverview />
      </div>
    </div>
  );
}
