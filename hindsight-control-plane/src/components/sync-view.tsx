"use client";

import { useLocale } from "next-intl";
import { RefreshCw } from "lucide-react";
import { MemoryPageHeader } from "@/components/memory-page-header";
import { StandaloneShell } from "@/components/standalone-shell";
import { SyncManagerPanel } from "@/components/sync-manager-panel";
import { SyncSettingsPanel } from "@/components/sync-settings-panel";

export function SyncView({ token }: { token?: string | null }) {
  const locale = useLocale();
  const preferZh = locale.startsWith("zh") || locale === "yue-Hant";
  const title = preferZh ? "多端同步" : "Sync";

  return (
    <StandaloneShell section="sync" title={title}>
      <main className="mx-auto w-full max-w-[1024px] xl:max-w-[1280px] 2xl:max-w-[1440px] flex-1 space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <MemoryPageHeader
          icon={RefreshCw}
          title={preferZh ? "多端同步与冲突管理" : "Sync & Conflict Management"}
          description={
            preferZh
              ? "查看同步状态、手动触发同步、处理同步冲突以及管理中继设备。"
              : "Inspect sync status, trigger syncs, resolve conflicts, and manage relay devices."
          }
        />

        <SyncManagerPanel
          preferZh={preferZh}
          settingsSlot={token ? <SyncSettingsPanel token={token} preferZh={preferZh} /> : null}
        />
      </main>
    </StandaloneShell>
  );
}
