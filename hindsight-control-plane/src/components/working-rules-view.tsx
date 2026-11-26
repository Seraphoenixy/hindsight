"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  FileText,
  Moon,
  PencilLine,
  Plus,
  RotateCcw,
  ScrollText,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";
import {
  client,
  type WorkingRuleImportance,
  type WorkingRuleOrganizeAction,
  type WorkingRuleOrganizeProposalItem,
  type WorkingRuleRecord,
  type WorkingRulesUsage,
} from "@/lib/api";

type BankOption = {
  bank_id: string;
  name?: string | null;
};
import { LanguageSwitcher } from "@/components/language-switcher";
import { useTheme } from "@/lib/theme-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ViewTab = "active" | "archived" | "organize";

const IMPORTANCE_BADGE: Record<WorkingRuleImportance, string> = {
  critical: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  normal: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  low: "border-border bg-muted text-muted-foreground",
};

const ORGANIZE_BADGE: Record<WorkingRuleOrganizeAction, string> = {
  add: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  replace: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  archive: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  remove: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

function parseCsvList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function WorkingRulesView() {
  const t = useTranslations("workingRules");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const { theme, toggleTheme } = useTheme();

  const [tab, setTab] = useState<ViewTab>("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<WorkingRuleRecord[]>([]);
  const [revision, setRevision] = useState("");
  const [usage, setUsage] = useState<WorkingRulesUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create / Edit dialog state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<WorkingRuleRecord | null>(null);
  const [formContent, setFormContent] = useState("");
  const [formImportance, setFormImportance] = useState<WorkingRuleImportance>("normal");
  const [saving, setSaving] = useState(false);

  // Delete confirmation dialog state
  const [deleteTarget, setDeleteTarget] = useState<WorkingRuleRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Promote archived rule dialog state
  const [promoteTarget, setPromoteTarget] = useState<WorkingRuleRecord | null>(null);
  const [banks, setBanks] = useState<BankOption[]>([]);
  const [promoteBankId, setPromoteBankId] = useState("");
  const [promoteTags, setPromoteTags] = useState("");
  const [promoting, setPromoting] = useState(false);

  // Markdown export dialog state
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMarkdown, setExportMarkdown] = useState("");
  const [exportLoading, setExportLoading] = useState(false);

  // AI organization state
  const [organizeInstructions, setOrganizeInstructions] = useState("");
  const [organizePreview, setOrganizePreview] = useState<{
    expected_revision: string;
    summary: string;
    proposals: WorkingRuleOrganizeProposalItem[];
  } | null>(null);
  const [selectedProposals, setSelectedProposals] = useState<Set<number>>(new Set());
  const [appliedProposals, setAppliedProposals] = useState<Set<number>>(new Set());
  const [previewingOrganize, setPreviewingOrganize] = useState(false);
  const [applyingOrganize, setApplyingOrganize] = useState(false);

  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.listWorkingRules({
        include_archived: true,
        q: searchQuery.trim() || undefined,
        limit: 500,
      });
      setRules(res.items);
      setRevision(res.revision);
      setUsage(res.usage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "__load_failed__");
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const activeRules = useMemo(() => rules.filter((r) => !r.is_archived), [rules]);
  const archivedRules = useMemo(() => rules.filter((r) => r.is_archived), [rules]);

  const openCreateDialog = () => {
    setEditingRule(null);
    setFormContent("");
    setFormImportance("normal");
    setEditorOpen(true);
  };

  const openEditDialog = (rule: WorkingRuleRecord) => {
    setEditingRule(rule);
    setFormContent(rule.content);
    setFormImportance(rule.importance);
    setEditorOpen(true);
  };

  const handleSaveRule = async () => {
    if (!formContent.trim()) return;
    setSaving(true);
    try {
      if (editingRule) {
        await client.updateWorkingRule(editingRule.id, {
          content: formContent.trim(),
          importance: formImportance,
        });
        toast.success(t("updated"));
      } else {
        await client.createWorkingRule({
          content: formContent.trim(),
          importance: formImportance,
        });
        toast.success(t("created"));
      }
      setEditorOpen(false);
      await loadRules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleArchiveToggle = async (rule: WorkingRuleRecord) => {
    try {
      if (rule.is_archived) {
        await client.restoreWorkingRule(rule.id);
        toast.success(t("restored"));
      } else {
        await client.updateWorkingRule(rule.id, { is_archived: true });
        toast.success(t("archivedToast"));
      }
      await loadRules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("saveFailed"));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await client.deleteWorkingRule(deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t("deleted"));
      await loadRules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  const openPromoteDialog = async (rule: WorkingRuleRecord) => {
    setPromoteTarget(rule);
    setPromoteTags("");
    setPromoteBankId("");
    try {
      const res = await client.listBanks({ limit: 100 });
      const allBanks: BankOption[] = Array.isArray(res?.banks) ? res.banks : [];
      setBanks(allBanks);
      if (allBanks.length > 0) setPromoteBankId(allBanks[0].bank_id);
    } catch {
      setBanks([]);
    }
  };

  const handlePromote = async () => {
    if (!promoteTarget || !promoteBankId.trim()) return;
    setPromoting(true);
    try {
      const res = await client.promoteWorkingRule(promoteTarget.id, {
        bank_id: promoteBankId.trim(),
        tags: parseCsvList(promoteTags),
      });
      toast.success(t("promotedToast", { bank: res.bank_id }));
      setPromoteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("promoteFailed"));
    } finally {
      setPromoting(false);
    }
  };

  const handleOpenExport = async () => {
    setExportOpen(true);
    setExportLoading(true);
    try {
      const res = await client.exportWorkingRulesMarkdown({
        include_archived: true,
      });
      setExportMarkdown(res.markdown);
    } catch (err) {
      setExportMarkdown("");
      toast.error(err instanceof Error ? err.message : t("exportFailed"));
    } finally {
      setExportLoading(false);
    }
  };

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(exportMarkdown);
      toast.success(t("copiedMarkdown"));
    } catch {
      toast.error(t("exportFailed"));
    }
  };

  const handleDownloadMarkdown = () => {
    const blob = new Blob([exportMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "working-rules.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePreviewOrganize = async () => {
    setPreviewingOrganize(true);
    setAppliedProposals(new Set());
    try {
      const preview = await client.previewWorkingRulesOrganization({
        instructions: organizeInstructions.trim(),
      });
      setOrganizePreview(preview);
      setSelectedProposals(new Set(preview.proposals.map((p) => p.number)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("organizePreviewFailed"));
    } finally {
      setPreviewingOrganize(false);
    }
  };

  const handleApplyOrganize = async () => {
    if (!organizePreview) return;
    const chosen = organizePreview.proposals.filter(
      (p) => selectedProposals.has(p.number) && !appliedProposals.has(p.number)
    );
    if (chosen.length === 0) return;
    setApplyingOrganize(true);
    try {
      const res = await client.applyWorkingRulesOrganization({
        expected_revision: organizePreview.expected_revision,
        proposals: chosen,
      });
      const succeededNumbers = res.results.filter((r) => r.ok).map((r) => r.number);
      const nextApplied = new Set(appliedProposals);
      for (const n of succeededNumbers) nextApplied.add(n);
      setAppliedProposals(nextApplied);
      setOrganizePreview((prev) => (prev ? { ...prev, expected_revision: res.revision } : null));
      const failedCount = res.results.length - succeededNumbers.length;
      if (failedCount > 0) {
        toast.error(t("organizePartialFailed", { failed: failedCount }));
      } else {
        toast.success(t("organizeApplied", { count: succeededNumbers.length }));
      }
      await loadRules();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("organizeApplyFailed"));
    } finally {
      setApplyingOrganize(false);
    }
  };

  const bytesPct =
    usage && usage.limit_bytes > 0
      ? Math.min(100, Math.round((usage.used_bytes / usage.limit_bytes) * 100))
      : 0;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 lg:px-8">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          aria-label={tNav("home")}
        >
          <ArrowLeft className="h-4 w-4" />
          <span>{tCommon("back")}</span>
        </Link>
        <div className="flex items-center gap-2 font-semibold">
          <ScrollText className="h-5 w-5 text-primary" />
          <span>{t("title")}</span>
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
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleOpenExport}>
              <FileText className="mr-1.5 h-4 w-4" />
              {t("exportMarkdown")}
            </Button>
            <Button size="sm" onClick={openCreateDialog}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t("addRule")}
            </Button>
          </div>
        </div>

        {usage && (
          <Card>
            <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("usageBytes")}</span>
                  <span className="font-mono">
                    {usage.used_bytes} / {usage.limit_bytes}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full transition-all",
                      bytesPct >= 90 ? "bg-amber-500" : "bg-primary"
                    )}
                    style={{ width: `${bytesPct}%` }}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">
                    {t("countsSummary", {
                      active: usage.active_count,
                      archived: usage.archived_count,
                    })}
                  </span>
                </div>
                {revision && (
                  <code className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {revision.slice(0, 12)}
                  </code>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="min-w-0 flex-1"
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{t("loadFailed")}</AlertTitle>
            <AlertDescription>
              {error === "__load_failed__" ? t("loadFailed") : error}
            </AlertDescription>
          </Alert>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as ViewTab)}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 sm:w-auto">
            <TabsTrigger value="active">
              {t("tabActive")} ({activeRules.length})
            </TabsTrigger>
            <TabsTrigger value="archived">
              {t("tabArchived")} ({archivedRules.length})
            </TabsTrigger>
            <TabsTrigger value="organize">
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {t("tabOrganize")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="mt-4 space-y-3">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner />
              </div>
            ) : activeRules.length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  {t("emptyActive")}
                </CardContent>
              </Card>
            ) : (
              activeRules.map((rule) => (
                <Card key={rule.id}>
                  <CardContent className="space-y-3 pt-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-xs font-medium",
                            IMPORTANCE_BADGE[rule.importance]
                          )}
                        >
                          {t(`importance.${rule.importance}`)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEditDialog(rule)}
                          title={tCommon("edit")}
                          aria-label={tCommon("edit")}
                        >
                          <PencilLine className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleArchiveToggle(rule)}
                          title={t("archiveAction")}
                          aria-label={t("archiveAction")}
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget(rule)}
                          title={tCommon("delete")}
                          aria-label={tCommon("delete")}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>

                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                      {rule.content}
                    </p>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="archived" className="mt-4 space-y-3">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner />
              </div>
            ) : archivedRules.length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  {t("emptyArchived")}
                </CardContent>
              </Card>
            ) : (
              archivedRules.map((rule) => (
                <Card key={rule.id} className="border-dashed">
                  <CardContent className="space-y-3 pt-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-xs font-medium",
                            IMPORTANCE_BADGE[rule.importance]
                          )}
                        >
                          {t(`importance.${rule.importance}`)}
                        </span>
                        {rule.archive_reason && (
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                            {rule.archive_reason}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleArchiveToggle(rule)}
                        >
                          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                          {t("restoreAction")}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openPromoteDialog(rule)}>
                          <ArrowUpRight className="mr-1.5 h-3.5 w-3.5" />
                          {t("promoteAction")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeleteTarget(rule)}
                          aria-label={tCommon("delete")}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>

                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                      {rule.content}
                    </p>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="organize" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("organizeTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="organize-instructions">{t("organizeInstructionsLabel")}</Label>
                  <Textarea
                    id="organize-instructions"
                    rows={3}
                    value={organizeInstructions}
                    onChange={(e) => setOrganizeInstructions(e.target.value)}
                    placeholder={t("organizeInstructionsPlaceholder")}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{t("organizeHint")}</p>
                  <Button onClick={handlePreviewOrganize} disabled={previewingOrganize}>
                    {previewingOrganize ? (
                      <Spinner className="mr-2 h-4 w-4" />
                    ) : (
                      <Sparkles className="mr-2 h-4 w-4" />
                    )}
                    {previewingOrganize ? t("organizing") : t("generateOrganizePreview")}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {organizePreview && (
              <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{t("organizeProposalsTitle")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{organizePreview.summary}</p>
                  </div>
                  {organizePreview.proposals.length > 0 && (
                    <Button
                      size="sm"
                      onClick={handleApplyOrganize}
                      disabled={
                        applyingOrganize ||
                        organizePreview.proposals.every(
                          (p) => !selectedProposals.has(p.number) || appliedProposals.has(p.number)
                        )
                      }
                    >
                      {applyingOrganize ? (
                        <Spinner className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {t("applySelected")}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  {organizePreview.proposals.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("organizeNoChanges")}</p>
                  ) : (
                    organizePreview.proposals.map((item) => {
                      const isApplied = appliedProposals.has(item.number);
                      const isChecked = selectedProposals.has(item.number);
                      return (
                        <div key={item.number} className="space-y-2 rounded-lg border p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Checkbox
                                checked={isChecked}
                                disabled={isApplied}
                                aria-label={t("selectProposal", { number: item.number })}
                                onCheckedChange={(checked) => {
                                  const next = new Set(selectedProposals);
                                  if (checked) next.add(item.number);
                                  else next.delete(item.number);
                                  setSelectedProposals(next);
                                }}
                              />
                              <span
                                className={cn(
                                  "rounded-full border px-2 py-0.5 text-xs font-medium",
                                  ORGANIZE_BADGE[item.action]
                                )}
                              >
                                {t(`organizeAction.${item.action}`)}
                              </span>
                              {isApplied && (
                                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                                  {t("appliedLabel")}
                                </span>
                              )}
                            </div>
                            <code className="font-mono text-xs text-muted-foreground">
                              #{item.number}
                            </code>
                          </div>

                          <p className="text-xs text-muted-foreground">{item.reason}</p>
                          {item.old_text && (
                            <div className="rounded bg-muted/60 p-2 text-xs text-muted-foreground line-through">
                              {item.old_text}
                            </div>
                          )}
                          {item.content && (
                            <div className="rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                              {item.content}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </main>

      {/* Create / Edit Rule Dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRule ? t("editRule") : t("addRule")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="rule-content">{t("contentLabel")}</Label>
              <Textarea
                id="rule-content"
                rows={4}
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                placeholder={t("contentPlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("importanceLabel")}</Label>
              <Select
                value={formImportance}
                onValueChange={(v) => setFormImportance(v as WorkingRuleImportance)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">{t("importance.critical")}</SelectItem>
                  <SelectItem value="normal">{t("importance.normal")}</SelectItem>
                  <SelectItem value="low">{t("importance.low")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={handleSaveRule} disabled={saving || !formContent.trim()}>
              {saving && <Spinner className="mr-2 h-4 w-4" />}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Markdown Export Dialog */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("exportMarkdown")}</DialogTitle>
          </DialogHeader>
          {exportLoading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          ) : (
            <Textarea readOnly rows={14} value={exportMarkdown} className="font-mono text-xs" />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={handleCopyMarkdown} disabled={!exportMarkdown}>
              <Copy className="mr-1.5 h-4 w-4" />
              {t("copyMarkdown")}
            </Button>
            <Button onClick={handleDownloadMarkdown} disabled={!exportMarkdown}>
              <Download className="mr-1.5 h-4 w-4" />
              {t("downloadMarkdown")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Promote Archived Rule Dialog */}
      <Dialog open={Boolean(promoteTarget)} onOpenChange={(o) => !o && setPromoteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("promoteTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">{t("promoteHint")}</p>
            <div className="space-y-1.5">
              <Label>{t("targetBankLabel")}</Label>
              {banks.length > 0 ? (
                <Select value={promoteBankId} onValueChange={setPromoteBankId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {banks.map((bank) => (
                      <SelectItem key={bank.bank_id} value={bank.bank_id}>
                        {bank.name || bank.bank_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={promoteBankId}
                  onChange={(e) => setPromoteBankId(e.target.value)}
                  placeholder={t("targetBankPlaceholder")}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promote-tags">{t("tagsLabel")}</Label>
              <Input
                id="promote-tags"
                value={promoteTags}
                onChange={(e) => setPromoteTags(e.target.value)}
                placeholder={t("tagsPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoteTarget(null)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={handlePromote} disabled={promoting || !promoteBankId.trim()}>
              {promoting && <Spinner className="mr-2 h-4 w-4" />}
              {t("promoteAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete} disabled={deleting}>
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
