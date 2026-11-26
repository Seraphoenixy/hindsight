"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Moon, RefreshCw, Sun } from "lucide-react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SyncManagerPanel } from "@/components/sync-manager-panel";
import { SyncSettingsPanel } from "@/components/sync-settings-panel";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme-context";

export function SyncView({ token }: { token?: string | null }) {
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const preferZh = locale.startsWith("zh") || locale === "yue-Hant";
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b bg-background/90 px-4 py-3 backdrop-blur-sm lg:px-8">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={tNav("home")}
        >
          <ArrowLeft className="h-4 w-4" />
          <span>{tCommon("back")}</span>
        </Link>
        <div className="flex items-center gap-2 font-semibold">
          <RefreshCw className="h-5 w-5 text-primary" />
          <span>{preferZh ? "多端同步" : "Sync"}</span>
        </div>
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={toggleTheme}
            aria-label={theme === "light" ? tNav("darkMode") : tNav("lightMode")}
          >
            {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </Button>
          <LanguageSwitcher />
        </span>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 lg:px-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {preferZh ? "多端同步与冲突管理" : "Sync & Conflict Management"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {preferZh
              ? "查看同步状态、手动触发同步、处理同步冲突以及管理中继设备。"
              : "Inspect sync status, trigger syncs, resolve conflicts, and manage relay devices."}
          </p>
        </div>

        {token && <SyncSettingsPanel token={token} preferZh={preferZh} />}

        <SyncManagerPanel preferZh={preferZh} />
      </main>
    </div>
  );
}
