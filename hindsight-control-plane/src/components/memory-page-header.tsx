import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface MemoryPageHeaderProps {
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/**
 * The shared heading surface for every memory-bank screen. A bank is a large
 * workspace, so its pages need a stronger first read than a bare h1; keeping
 * that treatment here stops Memories, Organize, Entities and Pages from each
 * inventing a slightly different title block.
 */
export function MemoryPageHeader({
  icon: Icon,
  title,
  description,
  eyebrow,
  actions,
  children,
  className,
}: MemoryPageHeaderProps) {
  return (
    <header
      className={cn(
        "relative isolate overflow-hidden rounded-[14px] border border-border bg-card",
        className
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_right,rgba(0,116,217,0.13),transparent_52%)] dark:bg-[radial-gradient(ellipse_at_top_right,rgba(91,176,255,0.12),transparent_50%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-8 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-primary/45 to-transparent"
      />
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-primary/15 bg-primary/10 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] dark:border-primary/20 dark:bg-primary/10">
            <Icon className="h-4 w-4" strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            {eyebrow && (
              <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {eyebrow}
              </div>
            )}
            <h1 className="text-[18px] font-semibold leading-snug tracking-[-0.025em] text-foreground sm:text-[20px]">
              {title}
            </h1>
            {description && (
              <p className="mt-0.5 max-w-2xl text-xs leading-normal text-muted-foreground sm:text-[13px]">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="border-t border-border/60 px-4 py-2.5 sm:px-5">{children}</div>}
    </header>
  );
}

interface MemoryPageStatProps {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "emerald" | "amber" | "violet";
}

const STAT_TONE = {
  default: "border-border bg-background/55 text-primary",
  emerald: "border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300",
  amber: "border-amber-500/20 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300",
  violet: "border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:text-violet-300",
} as const;

/** A compact metric chip for a page-header footer. */
export function MemoryPageStat({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: MemoryPageStatProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2",
        STAT_TONE[tone]
      )}
      title={hint}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">
        <div className="truncate text-[9.5px] font-semibold uppercase tracking-[0.1em] opacity-70">
          {label}
        </div>
        <div className="mt-0.5 truncate text-[12px] font-medium tabular-nums text-foreground">
          {value}
        </div>
      </div>
    </div>
  );
}
