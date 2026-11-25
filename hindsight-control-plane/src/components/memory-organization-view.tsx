"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Archive, Check, GitMerge, PencilLine, ShieldQuestion, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/api";
import { useBank } from "@/lib/bank-context";
import type {
  MemoryOrganizationAction,
  MemoryOrganizationChange,
  MemoryOrganizationPreview,
  MemoryOrganizationRecord,
} from "@/lib/memory-organization-types";

const ALL_MEMORIES = "__all__";
const APPLICABLE_ACTIONS: MemoryOrganizationAction[] = ["rewrite", "archive", "merge"];

const ACTION_META: Record<
  MemoryOrganizationAction,
  { icon: typeof PencilLine; className: string }
> = {
  rewrite: {
    icon: PencilLine,
    className: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  },
  archive: {
    icon: Archive,
    className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  merge: {
    icon: GitMerge,
    className: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  verify: {
    icon: ShieldQuestion,
    className: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
  },
};

function applicable(change: MemoryOrganizationChange): boolean {
  return APPLICABLE_ACTIONS.includes(change.action);
}

export function MemoryOrganizationView({ bankId }: { bankId: string }) {
  const t = useTranslations("memoryOrganization");
  const { currentBankName } = useBank();
  const [topic, setTopic] = useState("");
  const [instructions, setInstructions] = useState("");
  const [tag, setTag] = useState(ALL_MEMORIES);
  const [projectTags, setProjectTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [preview, setPreview] = useState<MemoryOrganizationPreview | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [applied, setApplied] = useState<Record<number, MemoryOrganizationRecord>>({});
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listTags(bankId, "project:*", 100)
      .then((result) => {
        if (!cancelled) setProjectTags(result.items);
      })
      .catch(() => {
        if (!cancelled) setProjectTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bankId]);

  useEffect(() => {
    setPreview(null);
    setSelected(new Set());
    setApplied({});
    setError(null);
  }, [bankId]);

  const selectableChanges = useMemo(
    () => preview?.changes.filter((change) => applicable(change) && !applied[change.number]) ?? [],
    [preview, applied]
  );
  const appliedChanges = useMemo(
    () => preview?.changes.filter((change) => applied[change.number]) ?? [],
    [preview, applied]
  );
  const actionLabels: Record<MemoryOrganizationAction, string> = {
    rewrite: t("action.rewrite"),
    archive: t("action.archive"),
    merge: t("action.merge"),
    verify: t("action.verify"),
  };

  async function generatePreview() {
    if (!topic.trim() || !instructions.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const next = await client.previewMemoryOrganization(bankId, {
        topic: topic.trim(),
        instructions: instructions.trim(),
        ...(tag === ALL_MEMORIES ? {} : { tag }),
      });
      setPreview(next);
      setSelected(new Set());
      setApplied({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("previewFailed"));
    } finally {
      setGenerating(false);
    }
  }

  function toggle(number: number, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(number);
      else next.delete(number);
      return next;
    });
  }

  async function applySelected() {
    if (!preview || selected.size === 0) return;
    const changes = preview.changes.filter((change) => selected.has(change.number));
    setApplying(true);
    setError(null);
    try {
      const response = await client.applyMemoryOrganization(bankId, {
        undo: false,
        changes,
      });
      const nextApplied = { ...applied };
      let succeeded = 0;
      for (const result of response.results) {
        if (result.ok && result.applied) {
          nextApplied[result.number] = result.applied;
          succeeded += 1;
        }
      }
      setApplied(nextApplied);
      setSelected(new Set());
      const failed = response.results.filter((result) => !result.ok);
      if (succeeded) toast.success(t("applySucceeded", { count: succeeded }));
      if (failed.length)
        setError(
          failed
            .map((result) => result.error)
            .filter(Boolean)
            .join("\n")
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("applyFailed"));
    } finally {
      setApplying(false);
    }
  }

  async function undoApplied() {
    if (!preview || appliedChanges.length === 0) return;
    const changes = appliedChanges.map((change) => ({
      ...change,
      applied: applied[change.number],
    }));
    setApplying(true);
    setError(null);
    try {
      const response = await client.applyMemoryOrganization(bankId, { undo: true, changes });
      const nextApplied = { ...applied };
      let restored = 0;
      for (const result of response.results) {
        if (result.ok && result.restored) {
          delete nextApplied[result.number];
          restored += 1;
        }
      }
      setApplied(nextApplied);
      const failed = response.results.filter((result) => !result.ok);
      if (restored) toast.success(t("undoSucceeded", { count: restored }));
      if (failed.length)
        setError(
          failed
            .map((result) => result.error)
            .filter(Boolean)
            .join("\n")
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("undoFailed"));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="p-5 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("instructionsTitle")}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t("instructionsDescription")}</p>
        </CardHeader>
        <CardContent className="p-5 pt-0">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="memory-organization-project">{t("projectScope")}</Label>
              <Select value={tag} onValueChange={setTag}>
                <SelectTrigger id="memory-organization-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_MEMORIES}>{t("allMemories")}</SelectItem>
                  {projectTags.map((project) => (
                    <SelectItem key={project.tag} value={project.tag}>
                      {project.tag} · {project.count}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="memory-organization-topic">{t("topic")}</Label>
              <Input
                id="memory-organization-topic"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder={t("topicPlaceholder")}
                maxLength={2000}
              />
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <Label htmlFor="memory-organization-instructions">{t("instructions")}</Label>
            <Textarea
              id="memory-organization-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder={t("instructionsPlaceholder")}
              maxLength={4000}
              className="min-h-28"
            />
            <p className="text-xs text-muted-foreground">{t("instructionsHint")}</p>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {currentBankName ? t("bankScope", { bank: currentBankName }) : null}
            </p>
            <Button
              onClick={generatePreview}
              disabled={generating || !topic.trim() || !instructions.trim()}
            >
              {generating ? (
                <Spinner size="sm" className="mr-2" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              {generating ? t("generating") : t("generatePreview")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-[12px] border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm whitespace-pre-wrap text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {preview && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{t("previewTitle")}</h2>
              <p className="text-sm text-muted-foreground">
                {t("previewSummary", {
                  records: preview.records.length,
                  changes: preview.changes.length,
                })}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {selectableChanges.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSelected(new Set(selectableChanges.map((change) => change.number)))
                  }
                >
                  <Check className="mr-2 h-4 w-4" />
                  {t("selectAll")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={undoApplied}
                disabled={applying || appliedChanges.length === 0}
              >
                {t("undoApplied")}
              </Button>
              <Button
                type="button"
                onClick={applySelected}
                disabled={applying || selected.size === 0}
              >
                {applying && <Spinner size="sm" className="mr-2" />}
                {applying ? t("applying") : t("applySelected", { count: selected.size })}
              </Button>
            </div>
          </div>

          {preview.changes.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                {preview.records.length === 0 ? t("noRecords") : t("noChanges")}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {preview.changes.map((change) => {
                const meta = ACTION_META[change.action];
                const Icon = meta.icon;
                const isApplied = Boolean(applied[change.number]);
                const canChoose = applicable(change) && !isApplied;
                return (
                  <Card key={change.number}>
                    <CardContent className="p-4 sm:p-5">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={selected.has(change.number)}
                          onCheckedChange={(checked) => toggle(change.number, checked === true)}
                          disabled={!canChoose}
                          aria-label={t("selectChange", { number: change.number })}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1 space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${meta.className}`}
                            >
                              <Icon className="h-3.5 w-3.5" />
                              {actionLabels[change.action]}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {t("changeNumber", { number: change.number })}
                            </span>
                            {isApplied && (
                              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                                {t("applied")}
                              </span>
                            )}
                          </div>
                          <p className="whitespace-pre-wrap text-sm text-foreground">
                            {change.record.text}
                          </p>
                          {change.action === "rewrite" && change.text && (
                            <div className="rounded-[10px] border border-blue-500/20 bg-blue-500/5 p-3">
                              <p className="mb-1 text-xs font-medium text-blue-700 dark:text-blue-300">
                                {t("replacement")}
                              </p>
                              <p className="whitespace-pre-wrap text-sm">{change.text}</p>
                            </div>
                          )}
                          {change.action === "merge" && change.target && (
                            <div className="rounded-[10px] border border-violet-500/20 bg-violet-500/5 p-3">
                              <p className="mb-1 text-xs font-medium text-violet-700 dark:text-violet-300">
                                {t("mergeTarget")}
                              </p>
                              <p className="whitespace-pre-wrap text-sm">{change.target.text}</p>
                            </div>
                          )}
                          <p className="text-xs text-muted-foreground">{change.reason}</p>
                          {change.action === "verify" && (
                            <p className="text-xs text-red-700 dark:text-red-300">
                              {t("verifyHint")}
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
