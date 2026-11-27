"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import { client } from "@/lib/api";
import { useBank } from "@/lib/bank-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  List,
  ScatterChart,
  Users,
  X,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Constellation } from "./constellation";
import { convertHindsightGraphData, GraphNode } from "./graph-data";
import { TimelineView } from "./data-view";
import { MemoryDetailModal } from "./memory-detail-modal";
import { TagFilterInput } from "./tag-filter-input";

type MemoryRow = Awaited<ReturnType<typeof client.listMemories>>["items"][number];

type EntityGraphResponse = Awaited<ReturnType<typeof client.getEntityGraph>>;

interface Entity {
  id: string;
  canonical_name: string;
  mention_count: number;
  first_seen?: string;
  last_seen?: string;
  metadata?: Record<string, any>;
}

type EntityDetail = Entity;

type ViewMode = "relations" | "list";

const ITEMS_PER_PAGE = 50;

export function EntitiesView() {
  const t = useTranslations("entitiesView");
  const tCommon = useTranslations("common");
  const { currentBank } = useBank();
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<EntityDetail | null>(null);
  // Per-entity timeline uses the same direct and inherited observation mentions
  // as entity counts. Page through all results so large entities aren't truncated.
  const [entityMemories, setEntityMemories] = useState<MemoryRow[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("relations");
  const [graphData, setGraphData] = useState<EntityGraphResponse | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  // Tag filter. Strict modes, like the documents page: picking a tag should not
  // also pull in every untagged memory. The server recomputes mention counts,
  // dates and graph edges from the matching memories only.
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagsMatch, setTagsMatch] = useState<"any" | "all">("any");
  const tagFilter = useMemo(
    () => ({
      tags: selectedTags,
      tags_match: (tagsMatch === "all" ? "all_strict" : "any_strict") as
        | "all_strict"
        | "any_strict",
    }),
    [selectedTags, tagsMatch]
  );

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotal] = useState(0);

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
  const offset = (currentPage - 1) * ITEMS_PER_PAGE;

  const loadEntities = useCallback(
    async (page: number = 1) => {
      if (!currentBank) return;

      setLoading(true);
      try {
        const pageOffset = (page - 1) * ITEMS_PER_PAGE;
        const result = await client.listEntities({
          bank_id: currentBank,
          limit: ITEMS_PER_PAGE,
          offset: pageOffset,
          ...tagFilter,
        });
        setEntities(result.items || []);
        setTotal(result.total || 0);
      } catch {
        // Error toast is shown automatically by the API client interceptor
      } finally {
        setLoading(false);
      }
    },
    [currentBank, tagFilter]
  );

  const loadEntityDetail = useCallback(
    async (entityId: string) => {
      if (!currentBank) return;

      setEntityMemories([]);
      setLoadingMemories(true);
      try {
        const result: any = await client.getEntity(entityId, currentBank, tagFilter);
        setSelectedEntity(result);
      } catch {
        // Error toast is shown automatically by the API client interceptor
      }

      // Reverse lookup: every memory linked to this entity, rendered as a timeline.
      // Independent of the detail fetch above.
      try {
        // Same tag filter as the entity, so the timeline matches its mention count.
        const allMemories: MemoryRow[] = [];
        let totalMemories = Infinity;
        while (allMemories.length < totalMemories) {
          const memories = await client.listMemories(currentBank, {
            entityId,
            tags: tagFilter.tags,
            tagsMatch: tagFilter.tags_match,
            limit: 500,
            offset: allMemories.length,
          });
          const items = memories.items || [];
          allMemories.push(...items);
          totalMemories = memories.total;
          if (items.length === 0) break;
        }
        setEntityMemories(allMemories);
      } catch {
        // Error toast is shown automatically by the API client interceptor
        setEntityMemories([]);
      } finally {
        setLoadingMemories(false);
      }
    },
    [currentBank, tagFilter]
  );

  // Handle page change
  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
    loadEntities(newPage);
  };

  const loadGraph = useCallback(async () => {
    if (!currentBank) return;
    setGraphLoading(true);
    try {
      const result = await client.getEntityGraph({
        bank_id: currentBank,
        limit: 2000,
        min_count: 1,
        ...tagFilter,
      });
      setGraphData(result);
    } catch {
      // Error toast is shown automatically by the API client interceptor
    } finally {
      setGraphLoading(false);
    }
  }, [currentBank, tagFilter]);

  // A new bank or a new tag filter starts over: the open entity may not be in
  // the new scope, and the graph is refetched by the effect below.
  useEffect(() => {
    if (currentBank) {
      setCurrentPage(1);
      loadEntities(1);
      setSelectedEntity(null);
      setGraphData(null);
    }
  }, [currentBank, tagFilter, loadEntities]);

  useEffect(() => {
    if (viewMode === "relations" && currentBank && !graphData && !graphLoading) {
      loadGraph();
    }
  }, [viewMode, currentBank, graphData, graphLoading, loadGraph]);

  const constellationData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    return convertHindsightGraphData(graphData);
  }, [graphData]);

  // Sum co-occurrence counts (edge weights) per entity, then map to a dot
  // radius. Log scaling keeps hubs big without letting them dwarf everything.
  const nodeWeights = useMemo(() => {
    const weights = new Map<string, number>();
    for (const link of constellationData.links) {
      const w = typeof link.weight === "number" && link.weight > 0 ? link.weight : 1;
      weights.set(link.source, (weights.get(link.source) || 0) + w);
      weights.set(link.target, (weights.get(link.target) || 0) + w);
    }
    return weights;
  }, [constellationData]);

  const maxNodeWeight = useMemo(() => {
    let max = 1;
    for (const w of nodeWeights.values()) if (w > max) max = w;
    return max;
  }, [nodeWeights]);

  const nodeSizeFn = useCallback(
    (node: GraphNode) => {
      const w = nodeWeights.get(node.id) || 0;
      // 3px (isolated) → 14px (the hub); sqrt flattens the long tail.
      const t = Math.sqrt(w / maxNodeWeight);
      return 3 + t * 11;
    },
    [nodeWeights, maxNodeWeight]
  );

  // Recency heat per entity — the most recent co-occurrence across any of its
  // edges. Lets color encode "fresh vs stale" while size encodes co-occurrence
  // volume, so the two axes stay orthogonal.
  const recencyLookup = useMemo(() => {
    const edges = graphData?.edges || [];
    if (!edges.length) return null;
    const times = new Map<string, number>();
    let minT = Infinity;
    let maxT = -Infinity;
    for (const e of edges) {
      const iso = e.data.lastCooccurred;
      if (!iso) continue;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) continue;
      for (const id of [e.data.source, e.data.target]) {
        const prev = times.get(id);
        if (prev === undefined || t > prev) times.set(id, t);
      }
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT === minT) return null;
    return { times, minT, maxT };
  }, [graphData]);

  const nodeHeatFn = useCallback(
    (node: GraphNode) => {
      if (!recencyLookup) return 0.5;
      const t = recencyLookup.times.get(node.id);
      if (t === undefined) return 0;
      return (t - recencyLookup.minT) / (recencyLookup.maxT - recencyLookup.minT);
    },
    [recencyLookup]
  );

  const handleConstellationNodeClick = useCallback(
    (node: GraphNode) => {
      loadEntityDetail(node.id);
    },
    [loadEntityDetail]
  );

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return t("na");
    return new Date(dateStr).toLocaleDateString();
  };

  return (
    <div>
      {/* Tag filter + view mode toggle (same segmented control as memories page) */}
      <div className="mb-4 flex flex-col gap-3 rounded-[16px] border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <TagFilterInput
          value={selectedTags}
          onChange={setSelectedTags}
          bankId={currentBank}
          matchMode={tagsMatch}
          onMatchModeChange={setTagsMatch}
          className="w-full max-w-[520px] flex-1"
        />
        <div className="flex max-w-full shrink-0 items-center gap-1 overflow-x-auto rounded-xl border border-border/70 bg-muted/45 p-1">
          {[
            { id: "relations" as ViewMode, label: t("viewRelations"), icon: ScatterChart },
            { id: "list" as ViewMode, label: t("viewList"), icon: List },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setViewMode(id)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all",
                viewMode === id
                  ? "bg-card text-foreground shadow-[0_1px_3px_rgba(15,23,36,0.10)] ring-1 ring-border/70"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {viewMode === "relations" && (
        <div className="bg-card border border-border border-solid rounded-[16px] overflow-hidden">
          {graphLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <Spinner size="xl" variant="jump" className="mx-auto mb-2" />
                <div className="text-sm text-muted-foreground">{t("loadingEntityGraph")}</div>
              </div>
            </div>
          ) : constellationData.nodes.length > 0 ? (
            <Constellation
              data={constellationData}
              height={700}
              onNodeClick={handleConstellationNodeClick}
              nodeSizeFn={nodeSizeFn}
              nodeHeatFn={recencyLookup ? nodeHeatFn : undefined}
              heatLegendLabel={recencyLookup ? t("heatLegendLabel") : undefined}
              heatLegendEndpoints={
                recencyLookup
                  ? [
                      new Date(recencyLookup.minT).toISOString().slice(0, 10),
                      new Date(recencyLookup.maxT).toISOString().slice(0, 10),
                    ]
                  : undefined
              }
              sizeLegendLabel={t("sizeLegendLabel")}
              compactLabels
            />
          ) : (
            <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
              <div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl border border-border bg-muted/40">
                <Users className="h-5 w-5 text-muted-foreground/60" />
              </div>
              <div className="text-sm font-medium text-foreground">{t("noCooccurrences")}</div>
              <div className="mt-1 max-w-md text-xs text-muted-foreground">
                {t("noCooccurrencesDescription")}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Entity List */}
      {viewMode === "list" && (
        <div>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <Spinner size="xl" variant="jump" className="mx-auto mb-2" />
                <div className="text-sm text-muted-foreground">{t("loadingEntities")}</div>
              </div>
            </div>
          ) : entities.length > 0 ? (
            <>
              <div className="mb-3 flex items-center justify-between gap-3 rounded-[14px] border border-border bg-card px-3.5 py-2.5">
                <div className="text-[11px] text-muted-foreground">
                  {t("entityCount", { count: total })}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary/60" />
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                    {currentPage} / {Math.max(1, totalPages)}
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <Table className="[&_thead]:bg-muted/25">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("colName")}</TableHead>
                      <TableHead>{t("colMentions")}</TableHead>
                      <TableHead>{t("colFirstSeen")}</TableHead>
                      <TableHead>{t("colLastSeen")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entities.map((entity) => (
                      <TableRow
                        key={entity.id}
                        onClick={() => loadEntityDetail(entity.id)}
                        className={`group cursor-pointer hover:bg-primary/[0.025] ${
                          selectedEntity?.id === entity.id ? "bg-primary/10" : ""
                        }`}
                      >
                        <TableCell className="py-3.5">
                          <div className="flex items-center gap-3">
                            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-primary/15 bg-primary/[0.07] text-[11px] font-semibold text-primary">
                              {entity.canonical_name.trim().charAt(0).toUpperCase() || "?"}
                            </span>
                            <span className="font-medium text-card-foreground">
                              {entity.canonical_name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex min-w-7 justify-center rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums text-foreground/75">
                            {entity.mention_count}
                          </span>
                        </TableCell>
                        <TableCell className="text-[11px] text-muted-foreground">
                          {formatDate(entity.first_seen)}
                        </TableCell>
                        <TableCell className="text-[11px] text-muted-foreground">
                          {formatDate(entity.last_seen)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="mt-3 flex items-center justify-between rounded-xl border border-border/70 bg-card px-3 py-2">
                  <div className="text-[10.5px] tabular-nums text-muted-foreground">
                    {offset + 1}-{Math.min(offset + ITEMS_PER_PAGE, total)} of {total}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(1)}
                      disabled={currentPage === 1 || loading}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronsLeft className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(currentPage - 1)}
                      disabled={currentPage === 1 || loading}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </Button>
                    <span className="px-2 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {currentPage} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(currentPage + 1)}
                      disabled={currentPage === totalPages || loading}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(totalPages)}
                      disabled={currentPage === totalPages || loading}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronsRight className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-[18px] border border-dashed border-border bg-card px-6 py-16 text-center">
              <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-2xl border border-border bg-muted/40">
                <Users className="h-5 w-5 text-muted-foreground/60" />
              </div>
              <div className="text-sm font-medium text-foreground">{t("noEntitiesFound")}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("noEntitiesDescription")}</div>
            </div>
          )}
        </div>
      )}

      {/* Entity Detail Panel - Fixed overlay */}
      {selectedEntity && (
        <>
          <div
            className="fixed inset-0 z-40 bg-slate-950/25 backdrop-blur-[1px]"
            onClick={() => {
              setSelectedEntity(null);
              setEntityMemories([]);
            }}
            aria-hidden
          />
          <aside className="fixed right-0 top-0 z-50 h-dvh w-[620px] max-w-[95vw] overflow-y-auto border-l border-border bg-background shadow-[-24px_0_80px_-36px_rgba(0,20,60,0.35)]">
            <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-5 py-4 backdrop-blur-xl">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/10 text-sm font-semibold text-primary">
                  {selectedEntity.canonical_name.trim().charAt(0).toUpperCase() || "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-lg font-semibold tracking-[-0.02em] text-card-foreground">
                    {selectedEntity.canonical_name}
                  </h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{t("entityDetails")}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedEntity(null);
                    setEntityMemories([]);
                  }}
                  className="h-8 w-8 shrink-0 p-0 text-muted-foreground"
                  aria-label={tCommon("close")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-5 p-5">
              {/* Entity Info */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {t("mentionsLabel")}
                  </div>
                  <div className="font-mono text-xl font-semibold tabular-nums text-card-foreground">
                    {selectedEntity.mention_count}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    {t("firstSeenLabel")}
                  </div>
                  <div className="text-sm font-medium text-card-foreground">
                    {formatDate(selectedEntity.first_seen)}
                  </div>
                </div>
              </div>

              {/* ID */}
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {t("entityIdLabel")}
                </div>
                <code className="break-all font-mono text-[10.5px] text-muted-foreground">
                  {selectedEntity.id}
                </code>
              </div>

              {/* Timeline — every memory linked to this entity */}
              <div>
                <div className="mb-3 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                  {t("linkedMemoriesLabel")}
                </div>
                {loadingMemories ? (
                  <div className="py-8 text-center">
                    <Spinner size="md" variant="jump" className="mx-auto mb-2" />
                    <div className="text-sm text-muted-foreground">
                      {t("loadingLinkedMemories")}
                    </div>
                  </div>
                ) : entityMemories.length > 0 ? (
                  <div>
                    <TimelineView
                      data={null}
                      filteredRows={entityMemories}
                      bankId={currentBank ?? undefined}
                      onMemoryClick={setSelectedMemoryId}
                    />
                  </div>
                ) : (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    {t("noLinkedMemories")}
                  </div>
                )}
              </div>
            </div>
          </aside>
        </>
      )}

      {/* Memory detail modal, opened by clicking a timeline item */}
      <MemoryDetailModal
        memoryId={selectedMemoryId}
        onClose={() => setSelectedMemoryId(null)}
        onChanged={() => {
          if (selectedEntity?.id) {
            loadEntityDetail(selectedEntity.id);
          }
        }}
      />
    </div>
  );
}
