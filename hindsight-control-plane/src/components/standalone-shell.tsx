"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Moon, RefreshCw, ScrollText, ServerCog, Sun } from "lucide-react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { withBasePath } from "@/lib/base-path";
import { useTheme } from "@/lib/theme-context";
import { cn } from "@/lib/utils";

export type StandaloneSection = "working-rules" | "sync" | "local";

interface StandaloneShellProps {
  section: StandaloneSection;
  title: string;
  backHref?: string;
  backLabel?: string;
  maxWidthClass?: string;
  children: React.ReactNode;
}

/**
 * Shared sticky header and page shell for standalone operational routes
 * (`/working-rules`, `/sync`, `/local`), keeping navigation, backdrop blur,
 * theme toggle, and language switching consistent across the control plane.
 */
export function StandaloneShell({
  section,
  title,
  backHref = "/dashboard",
  backLabel,
  maxWidthClass = "max-w-[1024px] xl:max-w-[1280px] 2xl:max-w-[1440px]",
  children,
}: StandaloneShellProps) {
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const preferZh = locale.startsWith("zh") || locale === "yue-Hant";
  const { theme, toggleTheme } = useTheme();

  const navItems: {
    id: StandaloneSection;
    href: string;
    label: string;
    icon: typeof ScrollText;
  }[] = [
    {
      id: "working-rules",
      href: "/working-rules",
      label: preferZh ? "工作准则" : "Working Rules",
      icon: ScrollText,
    },
    {
      id: "sync",
      href: "/sync",
      label: preferZh ? "多端同步" : "Sync",
      icon: RefreshCw,
    },
    {
      id: "local",
      href: "/local",
      label: preferZh ? "本地设置" : "Local",
      icon: ServerCog,
    },
  ];

  return (
    <div className="min-h-dvh bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/80 backdrop-blur-xl">
        <div
          className={cn(
            "mx-auto flex h-14 w-full items-center gap-2 px-4 sm:px-6 lg:px-8",
            maxWidthClass
          )}
        >
          <Link
            href={backHref}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={tNav("home")}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{backLabel ?? tCommon("back")}</span>
          </Link>
          <div className="mx-1 h-4 w-px bg-border" aria-hidden />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={withBasePath("/favicon.png")} alt="" className="h-7 w-auto shrink-0" />
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-[13px] font-semibold tracking-tight">Hindsight</span>
            <span className="text-[11px] text-muted-foreground">/</span>
            <span className="truncate text-[13px] text-muted-foreground">{title}</span>
          </div>

          <nav
            aria-label={preferZh ? "独立工具导航" : "Standalone tools"}
            className="ml-4 hidden md:flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-0.5"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.id === section;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors",
                    active
                      ? "bg-card text-foreground font-medium shadow-2xs"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", active && "text-primary")} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <span className="ml-auto flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground"
              onClick={toggleTheme}
              aria-label={theme === "light" ? tNav("darkMode") : tNav("lightMode")}
            >
              {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </Button>
            <LanguageSwitcher />
          </span>
        </div>
      </header>
      {children}
    </div>
  );
}
