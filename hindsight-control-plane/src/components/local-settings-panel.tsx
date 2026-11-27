"use client";

/**
 * The local-management page: profiles, their settings, and their daemon.
 *
 * This is the single management UI for a local Hindsight install. It used to be
 * two: this app for memory banks, and `hindsight-embed`'s own control center on
 * port 7878 for the configuration and the daemon. Two UIs over one stack meant
 * two URLs, two tokens and two processes, and the settings a user changed lived
 * in the one that did not show their memories. The control center is gone; its
 * operations are `hindsight-embed ops` and this page calls them.
 *
 * The token arrives as a prop from the server component that renders this page —
 * it is never fetched by the browser (see `lib/local-access.ts`).
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FolderOpen,
  Gauge,
  GitBranch,
  Layers,
  ListOrdered,
  LockKeyhole,
  Moon,
  Network,
  Play,
  PlugZap,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Server,
  Settings2,
  Sliders,
  Sparkles,
  Square,
  Sun,
  Terminal,
  Trash2,
  Wifi,
} from "lucide-react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useTheme } from "@/lib/theme-context";
import { useLocale } from "next-intl";
import {
  localApi,
  LOCAL_SNAPSHOT_CORE,
  LOCAL_SNAPSHOT_DIAGNOSTICS,
  type DaemonActionResult,
  type EmbeddingCompatibilityView,
  type EnvFileView,
  type HealthView,
  type LocalModelsView,
  type LocalModelStatus,
  type PathsView,
  type ProfileConfigView,
  type ProfileSummary,
  type ReembedStatusView,
  type SettingField,
  type SettingGroup,
  type SettingsView,
  type SnapshotSections,
} from "@/lib/local-api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { StandaloneShell } from "@/components/standalone-shell";
import { countLogLevels, parseLogLines, type LogLevel, type ParsedLogLine } from "@/lib/log-levels";

type Tab = "quick" | "settings" | "config" | "files" | "logs";

const TABS: { id: Tab; key: Tab; icon: typeof Sliders }[] = [
  { id: "quick", key: "quick", icon: Sliders },
  { id: "settings", key: "settings", icon: Settings2 },
  { id: "config", key: "config", icon: FileCode2 },
  { id: "files", key: "files", icon: FolderOpen },
  { id: "logs", key: "logs", icon: ScrollText },
];

const SELECT_CLASS =
  "h-9 w-full appearance-none rounded-[10px] border border-border bg-card px-3 pr-9 text-[13px] text-foreground shadow-none transition-colors outline-none hover:border-[rgba(0,0,0,0.18)] focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/40 dark:hover:border-[rgba(100,160,255,0.22)]";

const SETTINGS_GROUP_ICONS: Record<string, typeof Sliders> = {
  service: Server,
  llm: Sparkles,
  vision: Eye,
  embeddings: Layers,
  reranker: ListOrdered,
  decision: GitBranch,
  retain: Database,
};

export interface LocalSettingsPanelProps {
  /** The ops token, read server-side. Null when `hindsight-embed` is unreachable. */
  token: string | null;
  /** The resolved embed command, shown when the token could not be read. */
  embedCommand: string;
}

export function LocalSettingsPanel({ token, embedCommand }: LocalSettingsPanelProps) {
  const t = useTranslations("local");

  if (!token) {
    return (
      <Shell>
        <div className="mx-auto flex max-w-xl flex-col items-center px-6 py-20 text-center">
          <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-300">
            <PlugZap className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t("unavailableTitle")}</h1>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {t("unavailableBody")}
          </p>
          <div className="mt-5 w-full overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm">
            <div className="flex items-center gap-1.5 border-b border-border/70 bg-muted/40 px-3 py-2">
              <span className="h-2 w-2 rounded-full bg-rose-400/80" />
              <span className="h-2 w-2 rounded-full bg-amber-400/80" />
              <span className="h-2 w-2 rounded-full bg-emerald-400/80" />
              <Terminal className="ml-2 h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
              {embedCommand}
            </pre>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            {t("unavailableHint")}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              HINDSIGHT_CP_EMBED_COMMAND
            </code>
          </p>
        </div>
      </Shell>
    );
  }
  return <Loaded token={token} />;
}

function Loaded({ token }: { token: string }) {
  const t = useTranslations("local");
  const locale = useLocale();
  // The catalog ships both English and Chinese for every label; the page renders
  // the Chinese pair only in a Chinese locale, so one field definition serves both.
  const preferZh = locale.startsWith("zh") || locale === "yue-Hant";
  const label = useCallback(
    (entry: { label: string; label_zh: string }) =>
      preferZh && entry.label_zh ? entry.label_zh : entry.label,
    [preferZh]
  );
  const description = useCallback(
    (entry: { description: string; description_zh: string }) =>
      preferZh && entry.description_zh ? entry.description_zh : entry.description,
    [preferZh]
  );

  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("quick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [config, setConfig] = useState<ProfileConfigView | null>(null);
  const [form, setForm] = useState({ apiPort: "", uiPort: "", apiVersion: "", cpVersion: "" });

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [models, setModels] = useState<string[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelNotice, setModelNotice] = useState<string | null>(null);

  const [envFile, setEnvFile] = useState<EnvFileView | null>(null);
  const [envText, setEnvText] = useState("");

  const [paths, setPaths] = useState<PathsView | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [localModels, setLocalModels] = useState<LocalModelsView | null>(null);
  const [compatibility, setCompatibility] = useState<EmbeddingCompatibilityView | null>(null);
  const [reembedStatus, setReembedStatus] = useState<ReembedStatusView | null>(null);
  const [conflictDialog, setConflictDialog] = useState<{
    compat: EmbeddingCompatibilityView;
    pendingValues: Record<string, string> | null;
  } | null>(null);
  const [missingModelDialog, setMissingModelDialog] = useState<{
    missing: LocalModelStatus[];
    pendingValues: Record<string, string>;
  } | null>(null);

  const [logText, setLogText] = useState("");
  const [logPath, setLogPath] = useState("");
  const [logSource, setLogSource] = useState<"daemon" | "ui">("daemon");
  const [logLines, setLogLines] = useState(200);
  const [logAuto, setLogAuto] = useState(true);
  const [logLevelFilter, setLogLevelFilter] = useState<"all" | LogLevel>("all");

  // A request that lands after the user picked another profile must not paint
  // that profile's data onto the new selection. Every loader checks it.
  const currentRef = useRef<string | null>(null);
  currentRef.current = current;
  // The dimension check is asked for once per profile selection, on the tab
  // that shows embedding settings; see the effect below for why it is not part
  // of the page load.
  const compatibilityChecked = useRef<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>, okMessage?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (okMessage) setNotice(okMessage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const { profiles: list } = await localApi.profiles(token);
      setProfiles(list);
      return list;
    } finally {
      setProfilesLoaded(true);
    }
  }, [token]);

  /** Paint whatever sections came back; absent ones keep their placeholder. */
  const applySections = useCallback((sections: SnapshotSections) => {
    const cfg = sections.config;
    if (cfg) {
      setConfig(cfg);
      setForm({
        apiPort: String(cfg.api_port),
        uiPort: cfg.ui_port_is_default ? "" : String(cfg.ui_port),
        apiVersion: cfg.api_version ?? "",
        cpVersion: cfg.cp_version ?? "",
      });
    }
    if (sections.settings) setSettings(sections.settings);
    if (sections.env) {
      setEnvFile(sections.env);
      setEnvText(sections.env.content);
    }
    if (sections.paths) setPaths(sections.paths);
    if (sections.health) setHealth(sections.health);
    if (sections["local-models"]) setLocalModels(sections["local-models"]);
    if (sections["embedding-check"]) setCompatibility(sections["embedding-check"]);
    if (sections["reembed-status"]) setReembedStatus(sections["reembed-status"]);
  }, []);

  /**
   * Name a section that failed instead of leaving its panel blank.
   *
   * The old per-route fan-out turned every failure into `null`, so a missing
   * operation and a slow one looked the same. The snapshot reports which
   * section raised; the page shows the first one.
   */
  const noteSectionFailures = useCallback((errors: Record<string, string>) => {
    const [section, message] = Object.entries(errors)[0] ?? [];
    if (section && message) setError(`${section}: ${message}`);
  }, []);

  const selectProfile = useCallback(
    async (name: string) => {
      setCurrent(name);
      setDraft({});
      setModels([]);
      setModelBusy(false);
      setModelError(null);
      setModelNotice(null);
      setError(null);
      setNotice(null);
      setSettings(null);
      setConfig(null);
      setEnvFile(null);
      setPaths(null);
      setHealth(null);
      setLocalModels(null);
      setCompatibility(null);
      setReembedStatus(null);
      setConflictDialog(null);
      setMissingModelDialog(null);
      compatibilityChecked.current = null;

      // One process for the whole paint, not one per panel: every section
      // describes the same profile, and each separate `ops` call pays an
      // interpreter start plus the manager's imports (~0.45 s). See ADR-011.
      const load = async (
        include: readonly string[]
      ): Promise<{ sections: SnapshotSections; errors: Record<string, string> }> => {
        const doc = await localApi.snapshot(token, name, include);
        return { sections: doc.sections, errors: doc.errors };
      };

      // The sections are grouped by cost, not by panel. Core is file reads; the
      // live probe and the engine-backed model list fill in afterwards, so a
      // stopped daemon cannot hold the form hostage.
      const core = await load(LOCAL_SNAPSHOT_CORE);
      if (currentRef.current !== name) return;
      applySections(core.sections);
      noteSectionFailures(core.errors);

      void load(LOCAL_SNAPSHOT_DIAGNOSTICS)
        .then((diagnostics) => {
          if (currentRef.current !== name) return;
          applySections(diagnostics.sections);
          noteSectionFailures(diagnostics.errors);
        })
        .catch(() => undefined);
    },
    [applySections, noteSectionFailures, token]
  );

  const loadLogs = useCallback(
    async (name: string) => {
      try {
        const tail = await localApi.logs(token, name, logLines, logSource);
        if (currentRef.current !== name) return;
        setLogPath(tail.path);
        setLogText(tail.exists ? tail.content || t("logsEmpty") : t("logsMissing"));
      } catch (e) {
        if (currentRef.current === name) setLogText(e instanceof Error ? e.message : String(e));
      }
    },
    [t, token, logLines, logSource]
  );

  // Boot: profiles, then the first one. A deep link (`?profile=`) wins.
  useEffect(() => {
    void (async () => {
      try {
        const list = await loadProfiles();
        if (list.length === 0) return;
        const requested = new URLSearchParams(window.location.search).get("profile");
        const target =
          requested && list.some((p) => p.display_name === requested) ? requested : list[0].name;
        await selectProfile(target);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    // Runs once for this token; `selectProfile`/`loadProfiles` are stable per token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Health poll for the selected profile. 4s: a start or stop shows up quickly
  // without spawning a subprocess per second.
  useEffect(() => {
    if (current === null) return;
    const id = setInterval(() => {
      void localApi
        .health(token, current)
        .then((next) => {
          if (currentRef.current === current) setHealth(next);
        })
        .catch(() => {
          /* a failed probe is already the "unreachable" state */
        });
    }, 4000);
    return () => clearInterval(id);
  }, [current, token]);

  // The dimension check inspects the database, and its fallback starts and then
  // stops a temporary pg0 when it cannot see a running instance. That is not
  // something a page load may do — it once took down a live daemon's database —
  // so it runs when the user opens the tab that changes embedding models.
  useEffect(() => {
    if (tab !== "settings" || current === null) return;
    if (compatibility !== null || compatibilityChecked.current === current) return;
    compatibilityChecked.current = current;
    const profileName = current;
    void localApi
      .checkEmbeddingCompatibility(token, profileName)
      .then((next) => {
        if (currentRef.current === profileName) setCompatibility(next);
      })
      .catch(() => undefined);
  }, [compatibility, current, tab, token]);

  const parsedLogLines = useMemo(() => parseLogLines(logText), [logText]);
  const logLevelCounts = useMemo(() => countLogLevels(parsedLogLines), [parsedLogLines]);
  const filteredLogLines = useMemo(
    () =>
      logLevelFilter === "all"
        ? parsedLogLines
        : parsedLogLines.filter((entry) => entry.level === logLevelFilter),
    [parsedLogLines, logLevelFilter]
  );

  // Log tail poll, only while the Logs tab is open and auto-refresh is on.
  useEffect(() => {
    if (current === null || tab !== "logs") return;
    void loadLogs(current);
    if (!logAuto) return;
    const id = setInterval(() => void loadLogs(current), 2000);
    return () => clearInterval(id);
  }, [current, tab, logAuto, loadLogs]);

  const ordinarySettings = settings?.groups ?? [];
  const editableFields = ordinarySettings.flatMap((group) => group.fields);
  const currentDraft = Object.fromEntries(
    editableFields
      .filter((field) => field.key in draft)
      .map((field) => [field.key, draft[field.key]])
  );
  const dirtyCount = Object.keys(currentDraft).length;
  const dirty = dirtyCount > 0;
  const quickDirty =
    config !== null &&
    (form.apiPort !== String(config.api_port) ||
      form.uiPort !== (config.ui_port_is_default ? "" : String(config.ui_port)) ||
      form.apiVersion !== (config.api_version ?? "") ||
      form.cpVersion !== (config.cp_version ?? ""));
  const envDirty = envFile !== null && envText !== envFile.content;
  const currentProfile = profiles.find((profile) => profile.name === current);
  const profileInitial = (config?.display_name ?? current ?? "H").trim().charAt(0).toUpperCase();

  const daemonAction = async (action: "start" | "stop" | "restart") => {
    if (current === null) return;
    await run(async () => {
      const result: DaemonActionResult = await localApi.daemon(token, current, action);
      setTab("logs");
      setLogSource("daemon");
      if (!result.ok)
        throw new Error(preferZh && result.message_zh ? result.message_zh : result.message);
      setHealth(await localApi.health(token, current).catch(() => null));
    });
    await loadProfiles().catch(() => undefined);
  };

  const saveQuick = async () => {
    if (current === null) return;
    await run(async () => {
      const next = await localApi.saveConfig(token, current, {
        api_port: form.apiPort.trim(),
        ui_port: form.uiPort.trim(),
        api_version: form.apiVersion.trim(),
        cp_version: form.cpVersion.trim(),
      });
      setConfig(next);
      setForm({
        apiPort: String(next.api_port),
        uiPort: next.ui_port_is_default ? "" : String(next.ui_port),
        apiVersion: next.api_version ?? "",
        cpVersion: next.cp_version ?? "",
      });
    }, t("savedRestart"));
  };

  const resetQuickForm = () => {
    if (!config) return;
    setForm({
      apiPort: String(config.api_port),
      uiPort: config.ui_port_is_default ? "" : String(config.ui_port),
      apiVersion: config.api_version ?? "",
      cpVersion: config.cp_version ?? "",
    });
  };

  const effectiveSetting = useCallback(
    (key: string) => {
      if (!settings) return "";
      for (const group of settings.groups) {
        const field = group.fields.find((entry) => entry.key === key);
        if (field) return draft[key] ?? field.value;
      }
      return "";
    },
    [draft, settings]
  );

  // Poll local model downloads while any model is actively downloading.
  const anyDownloading = Boolean(localModels?.models.some((m) => m.downloading));
  useEffect(() => {
    if (!anyDownloading || current === null) return;
    const profileName = current;
    const timer = setInterval(() => {
      void localApi
        .localModels(token, profileName)
        .then((next) => {
          if (currentRef.current === profileName) setLocalModels(next);
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [anyDownloading, current, token]);

  // Poll background re-embed status while running.
  useEffect(() => {
    if (reembedStatus?.status !== "running" || current === null) return;
    const profileName = current;
    const timer = setInterval(() => {
      void localApi
        .reembedStatus(token, profileName)
        .then(async (next) => {
          if (currentRef.current !== profileName) return;
          setReembedStatus(next);
          if (next.status === "done") {
            setNotice(preferZh ? next.message_zh : next.message);
            const [hlt, compat] = await Promise.all([
              localApi.health(token, profileName).catch(() => null),
              localApi.checkEmbeddingCompatibility(token, profileName).catch(() => null),
            ]);
            if (currentRef.current !== profileName) return;
            setHealth(hlt);
            setCompatibility(compat);
            await loadProfiles().catch(() => undefined);
          } else if (next.status === "error") {
            setError(next.error || (preferZh ? next.message_zh : next.message));
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [reembedStatus?.status, current, token, preferZh, loadProfiles]);

  const handleDownloadLocalModel = async (modelName: string) => {
    if (current === null) return;
    await run(async () => {
      const res = await localApi.downloadLocalModel(token, current, modelName);
      setLocalModels(await localApi.localModels(token, current));
      setNotice(preferZh ? res.message_zh : res.message);
    });
  };

  const commitSaveSettings = async (valuesToSave: Record<string, string>) => {
    if (current === null) return;
    const next = await localApi.saveSettings(token, current, valuesToSave);
    setSettings(next);
    setDraft((pending) =>
      Object.fromEntries(
        Object.entries(pending).filter(([key, value]) => valuesToSave[key] !== value)
      )
    );
    setCompatibility(await localApi.checkEmbeddingCompatibility(token, current).catch(() => null));
    setLocalModels(await localApi.localModels(token, current).catch(() => null));
    await loadProfiles().catch(() => undefined);
  };

  const findMissingSelectedLocalModels = useCallback(
    (valuesToCheck: Record<string, string>): LocalModelStatus[] => {
      if (!localModels) return [];
      const merged = (key: string, fallback: string) =>
        (key in valuesToCheck ? valuesToCheck[key] : effectiveSetting(key)) || fallback;

      const wantedNames: string[] = [];
      const embProv = merged("HINDSIGHT_API_EMBEDDINGS_PROVIDER", "local").trim().toLowerCase();
      if (embProv === "local" || embProv === "llamacpp") {
        wantedNames.push(merged("HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL", "qwen3-0.6b"));
      }
      const rerankProv = merged("HINDSIGHT_API_RERANKER_PROVIDER", "local").trim().toLowerCase();
      if (rerankProv === "local" || rerankProv === "llamacpp") {
        wantedNames.push(merged("HINDSIGHT_API_RERANKER_LOCAL_MODEL", "hindsight-ai/hs-rerank-1"));
      }
      const llmProv = merged("HINDSIGHT_API_LLM_PROVIDER", "").trim().toLowerCase();
      if (llmProv === "llamacpp") {
        wantedNames.push(merged("HINDSIGHT_API_LLM_MODEL", ""));
      }

      const missing: LocalModelStatus[] = [];
      for (const name of wantedNames) {
        const entry = localModels.models.find(
          (m) => m.name.toLowerCase() === name.trim().toLowerCase()
        );
        if (entry && !entry.downloaded && !missing.some((x) => x.name === entry.name)) {
          missing.push(entry);
        }
      }
      return missing;
    },
    [effectiveSetting, localModels]
  );

  const checkCompatibilityAndSave = async (valuesToSave: Record<string, string>) => {
    if (current === null) return;
    const compat = await localApi
      .checkEmbeddingCompatibility(token, current, valuesToSave)
      .catch(() => null);
    if (compat && !compat.compatible) {
      setConflictDialog({ compat, pendingValues: valuesToSave });
      return;
    }
    await commitSaveSettings(valuesToSave);
    setNotice(t("savedRestart"));
  };

  const saveSettings = async () => {
    if (current === null) return;
    if (!dirty) {
      setNotice(t("nothingChanged"));
      return;
    }
    await run(async () => {
      const missing = findMissingSelectedLocalModels(currentDraft);
      if (missing.length > 0) {
        setMissingModelDialog({ missing, pendingValues: currentDraft });
        return;
      }
      await checkCompatibilityAndSave(currentDraft);
    });
  };

  const handleReembed = async (pendingValues: Record<string, string> | null) => {
    if (current === null) return;
    setConflictDialog(null);
    await run(async () => {
      const res = await localApi.startReembed(token, current, pendingValues ?? undefined);
      setReembedStatus(res);
      if (pendingValues) {
        setSettings(await localApi.settings(token, current));
        setDraft((pending) =>
          Object.fromEntries(
            Object.entries(pending).filter(([key, value]) => pendingValues[key] !== value)
          )
        );
      }
      setNotice(preferZh ? res.message_zh : res.message);
    });
  };

  const handleResetMemories = async (pendingValues: Record<string, string> | null) => {
    if (current === null) return;
    setConflictDialog(null);
    await run(async () => {
      const res = await localApi.resetMemories(token, current, pendingValues ?? undefined);
      if (pendingValues) {
        setSettings(await localApi.settings(token, current));
        setDraft((pending) =>
          Object.fromEntries(
            Object.entries(pending).filter(([key, value]) => pendingValues[key] !== value)
          )
        );
      }
      setHealth(await localApi.health(token, current).catch(() => null));
      setCompatibility(
        await localApi.checkEmbeddingCompatibility(token, current).catch(() => null)
      );
      await loadProfiles().catch(() => undefined);
      if (!res.ok) throw new Error(preferZh ? res.message_zh : res.message);
      setNotice(preferZh ? res.message_zh : res.message);
    });
  };

  const fetchModels = async () => {
    if (current === null) return;
    const requestedProfile = current;
    const provider = effectiveSetting("HINDSIGHT_API_LLM_PROVIDER").trim();
    if (!provider) {
      setModels([]);
      setModelNotice(null);
      setModelError(t("modelsNeedProvider"));
      return;
    }
    setModelBusy(true);
    setModelError(null);
    setModelNotice(null);
    try {
      const result = await localApi.listModels(token, requestedProfile, {
        provider,
        // null means "use the saved key"; a string (including "") is the form's
        // current value, so testing a new key never writes it to the profile.
        api_key: "HINDSIGHT_API_LLM_API_KEY" in draft ? draft["HINDSIGHT_API_LLM_API_KEY"] : null,
        base_url: effectiveSetting("HINDSIGHT_API_LLM_BASE_URL"),
      });
      if (currentRef.current !== requestedProfile) return;
      setModels(result.models);
      setModelNotice(
        result.models.length
          ? t("modelsAvailable", { count: result.models.length })
          : t("modelsEmpty")
      );
    } catch (e) {
      if (currentRef.current !== requestedProfile) return;
      setModels([]);
      setModelError(e instanceof Error ? e.message : String(e));
    } finally {
      if (currentRef.current === requestedProfile) setModelBusy(false);
    }
  };

  const saveEnv = async () => {
    if (current === null) return;
    await run(async () => {
      const next = await localApi.saveEnv(token, current, envText);
      setEnvFile(next);
      setEnvText(next.content);
    }, t("savedRestart"));
  };

  const deleteProfile = async () => {
    if (!current) return;
    if (!window.confirm(t("deleteConfirm", { name: current || t("defaultProfile") }))) return;
    let removed = false;
    await run(async () => {
      const result = await localApi.deleteProfile(token, current);
      if (!result.ok)
        throw new Error(preferZh && result.message_zh ? result.message_zh : result.message);
      removed = true;
    });
    if (removed) {
      const list = await loadProfiles().catch(() => []);
      setCurrent(list[0]?.name ?? null);
      if (list[0]) await selectProfile(list[0].name);
    }
  };

  const statusLabel = (running: boolean) => (running ? t("running") : t("stopped"));

  const renderSettingsGroup = (group: SettingGroup, fields = group.fields) => (
    <Card key={group.id} className="overflow-hidden">
      <CardHeader className="flex-row items-center gap-3 space-y-0 border-b border-border/70 bg-muted/20 px-5 py-4 sm:px-6">
        <IconTile icon={SETTINGS_GROUP_ICONS[group.id] ?? Settings2} />
        <div className="min-w-0">
          <CardTitle className="text-[14px] leading-tight">{label(group)}</CardTitle>
          <CardDescription className="mt-1 text-[12px] leading-relaxed">
            {description(group)}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="divide-y divide-border/70 p-0">
        {fields.map((field) => (
          <SettingRow
            key={field.key}
            field={field}
            value={draft[field.key] ?? field.value}
            changed={field.key in draft}
            label={label(field)}
            description={description(field)}
            models={models}
            modelBusy={modelBusy}
            modelError={modelError}
            modelNotice={modelNotice}
            onFetchModels={() => void fetchModels()}
            localModels={localModels?.models}
            onDownloadLocalModel={(modelName) => void handleDownloadLocalModel(modelName)}
            onChange={(value) => {
              setDraft((d) => ({ ...d, [field.key]: value }));
              if (
                field.key === "HINDSIGHT_API_LLM_PROVIDER" ||
                field.key === "HINDSIGHT_API_LLM_BASE_URL" ||
                field.key === "HINDSIGHT_API_LLM_API_KEY"
              ) {
                setModels([]);
                setModelError(null);
                setModelNotice(null);
              }
            }}
          />
        ))}
      </CardContent>
    </Card>
  );

  const settingsSave = (
    <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card/95 px-4 py-3 shadow-lg shadow-black/5 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {dirty ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            <span className="font-medium text-amber-600 dark:text-amber-400">
              {t("modified")} · {dirtyCount}
            </span>
          </>
        ) : (
          <>
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            <span>{t("nothingChanged")}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => setDraft({})}>
          {t("discard")}
        </Button>
        <Button size="sm" disabled={busy || !dirty} onClick={() => void saveSettings()}>
          {busy ? <Spinner size="sm" /> : null}
          {t("save")}
        </Button>
      </div>
    </div>
  );

  return (
    <Shell>
      <div className="mx-auto grid w-full max-w-[1360px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[264px_minmax(0,1fr)] lg:px-8 lg:py-8">
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <h2 className="text-[13px] font-semibold">{t("profiles")}</h2>
              {profilesLoaded ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                  {profiles.length}
                </span>
              ) : (
                <span className="h-4 w-6 animate-pulse rounded-full bg-muted" aria-hidden />
              )}
            </div>
            <ul className="space-y-1 p-2">
              {!profilesLoaded ? (
                <li className="space-y-1.5" aria-hidden>
                  <div className="h-[58px] animate-pulse rounded-xl bg-muted/70" />
                  <div className="h-[58px] animate-pulse rounded-xl bg-muted/50" />
                </li>
              ) : profiles.length === 0 ? (
                <li className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {t("noProfiles")}
                </li>
              ) : (
                profiles.map((profile) => {
                  const selected = profile.name === current;
                  return (
                    <li key={profile.name || "default"}>
                      <button
                        type="button"
                        onClick={() => void selectProfile(profile.name)}
                        aria-current={selected ? "true" : undefined}
                        className={cn(
                          "group relative flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors",
                          selected
                            ? "bg-secondary/80 shadow-xs ring-1 ring-border"
                            : "hover:bg-muted/60"
                        )}
                      >
                        {selected && (
                          <span
                            className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary-gradient"
                            aria-hidden
                          />
                        )}
                        <span className="mt-1.5 shrink-0">
                          <StatusDot running={profile.daemon_running} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium">
                              {profile.display_name}
                            </span>
                            {profile.is_active && (
                              <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-primary uppercase">
                                {t("active")}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                            {profile.provider
                              ? `${profile.provider}${profile.model ? ` · ${profile.model}` : ""}`
                              : `${t("apiPort")} ${profile.port}`}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-md bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground ring-1 ring-border/60">
                          :{profile.port}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </Card>

          {paths && (
            <Card className="hidden overflow-hidden lg:block">
              <div className="border-b border-border/70 px-4 py-3">
                <h2 className="text-[13px] font-semibold">{t("files")}</h2>
              </div>
              <div className="space-y-3 p-3">
                <SidebarPath label={t("configPath")} value={paths.config_path} />
                <SidebarPath label={t("databaseDir")} value={paths.database_path ?? "—"} />
              </div>
            </Card>
          )}
        </aside>

        <main className="min-w-0 space-y-5">
          {current === null ? (
            <Card className="overflow-hidden">
              <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
                {profilesLoaded ? (
                  <>
                    <div className="grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                      <Server className="h-5 w-5" />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {profiles.length === 0 ? t("noProfiles") : t("selectProfile")}
                    </p>
                    {error && (
                      <p className="max-w-md text-xs break-words text-destructive">{error}</p>
                    )}
                  </>
                ) : (
                  <>
                    <Spinner size="lg" />
                    <p className="text-sm text-muted-foreground">{t("loading")}</p>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <Fragment>
              <Card className="relative overflow-hidden">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_0%_0%,rgba(0,116,217,0.13),transparent_58%),radial-gradient(90%_100%_at_100%_0%,rgba(0,146,150,0.10),transparent_62%)]"
                />
                <CardContent className="relative p-5 sm:p-6">
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-0">
                      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary-gradient text-lg font-semibold text-white shadow-lg shadow-primary/20">
                        {profileInitial || "H"}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h1 className="truncate text-[22px] leading-tight font-semibold tracking-tight sm:text-2xl">
                            {config?.display_name ?? current}
                          </h1>
                          <StatusPill running={Boolean(health?.api_ok)}>
                            {t("daemon")}: {statusLabel(Boolean(health?.api_ok))}
                          </StatusPill>
                          {currentProfile?.is_active && (
                            <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-primary uppercase">
                              {t("active")}
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                          {health
                            ? preferZh
                              ? health.api_detail_zh
                              : health.api_detail
                            : t("loading")}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          <InfoChip
                            icon={Network}
                            label={`${t("apiPort")} ${config?.api_port ?? paths?.port ?? "—"}`}
                          />
                          <InfoChip
                            icon={Gauge}
                            label={`${t("uiPort")} ${config?.ui_port ?? "—"}`}
                          />
                          {config?.provider && (
                            <InfoChip
                              icon={Bot}
                              label={`${config.provider}${config.model ? ` · ${config.model}` : ""}`}
                            />
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                      {health?.api_ok && (
                        <Button asChild size="sm" variant="gradient">
                          <Link href="/dashboard">
                            <ExternalLink />
                            {t("openMemory")}
                          </Link>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant={health?.api_ok ? "outline" : "default"}
                        disabled={busy}
                        onClick={() => void daemonAction(health?.api_ok ? "restart" : "start")}
                      >
                        {health?.api_ok ? <RotateCcw /> : <Play />}
                        {health?.api_ok ? t("restart") : t("start")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !health?.api_ok}
                        onClick={() => void daemonAction("stop")}
                      >
                        <Square />
                        {t("stop")}
                      </Button>
                      {current !== "" && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-9 w-9 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          disabled={busy}
                          title={t("deleteProfile")}
                          aria-label={t("deleteProfile")}
                          onClick={() => void deleteProfile()}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {paths && (
                    <div className="mt-5 grid gap-1 rounded-xl border border-border/60 bg-background/55 p-1 sm:grid-cols-3">
                      <HeroStat icon={Wifi} label={t("daemonUrl")} value={paths.daemon_url} />
                      <HeroStat
                        icon={ExternalLink}
                        label={t("controlPlane")}
                        value={paths.ui_url}
                      />
                      <HeroStat
                        icon={FileCode2}
                        label={t("configPath")}
                        value={paths.config_path}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>

              {reembedStatus?.status === "running" && (
                <div className="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/[0.06] px-4 py-3">
                  <Spinner size="sm" className="mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {preferZh ? "正在重算记忆向量" : "Re-embedding Memories"}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {preferZh ? reembedStatus.message_zh : reembedStatus.message}
                    </p>
                  </div>
                </div>
              )}

              {compatibility &&
                !compatibility.compatible &&
                reembedStatus?.status !== "running" && (
                  <Alert
                    variant="destructive"
                    className="rounded-xl border-destructive/30 bg-destructive/[0.04] py-4"
                  >
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>
                      {preferZh ? "向量维度不兼容，无法启动" : "Embedding Dimension Mismatch"}
                    </AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>{preferZh ? compatibility.message_zh : compatibility.message}</p>
                      <div className="flex flex-wrap gap-2">
                        {compatibility.can_reembed && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void handleReembed(null)}
                          >
                            {preferZh ? "保留记忆，原地重算向量并启动" : "Re-embed & Keep Memories"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => void handleResetMemories(null)}
                        >
                          {preferZh ? "清空本地记忆并重置" : "Clear Memories & Reset"}
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}

              {error && (
                <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t("failed")}</p>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed break-words">{error}</p>
                  </div>
                </div>
              )}
              {notice && (
                <div className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-4 py-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <p className="min-w-0 text-[12.5px] leading-relaxed break-words">{notice}</p>
                </div>
              )}

              <div
                role="tablist"
                className="sticky top-[57px] z-10 flex gap-1 overflow-x-auto rounded-2xl border border-border/80 bg-card/90 p-1.5 shadow-sm backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {TABS.map((entry) => {
                  const Icon = entry.icon;
                  const active = tab === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setTab(entry.id)}
                      className={cn(
                        "inline-flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors",
                        active
                          ? "bg-foreground text-background shadow-sm"
                          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {t(entry.key)}
                    </button>
                  );
                })}
              </div>

              {tab === "quick" && (
                <Card className="overflow-hidden">
                  <CardHeader className="flex-row items-start gap-3 space-y-0 border-b border-border/70 bg-muted/20 px-5 py-4 sm:px-6">
                    <IconTile icon={Sliders} />
                    <div className="min-w-0">
                      <CardTitle className="text-[15px] leading-tight">{t("quick")}</CardTitle>
                      <CardDescription className="mt-1 max-w-2xl text-[12.5px] leading-relaxed">
                        {t("quickIntro")}
                      </CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="p-5 sm:p-6">
                    {config === null ? (
                      <div className="grid gap-5 sm:grid-cols-2 lg:max-w-3xl" aria-hidden>
                        {[0, 1, 2, 3].map((index) => (
                          <div key={index} className="space-y-2">
                            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                            <div className="h-9 animate-pulse rounded-[10px] bg-muted/60" />
                            {index >= 1 && (
                              <div className="h-2.5 w-40 animate-pulse rounded bg-muted/50" />
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="grid gap-5 sm:grid-cols-2 lg:max-w-3xl">
                        <Field label={t("apiPort")}>
                          <Input
                            type="number"
                            className="font-mono tabular-nums"
                            value={form.apiPort}
                            onChange={(e) => setForm({ ...form, apiPort: e.target.value })}
                          />
                        </Field>
                        <Field label={t("uiPort")} hint={t("uiPortHint")}>
                          <Input
                            type="number"
                            className="font-mono tabular-nums"
                            placeholder={String(config.ui_port)}
                            value={form.uiPort}
                            onChange={(e) => setForm({ ...form, uiPort: e.target.value })}
                          />
                        </Field>
                        <Field label={t("apiVersion")} hint={t("versionHint")}>
                          <Input
                            className="font-mono"
                            value={form.apiVersion}
                            placeholder={config.api_version ?? t("embedDefault")}
                            onChange={(e) => setForm({ ...form, apiVersion: e.target.value })}
                          />
                        </Field>
                        <Field label={t("cpVersion")} hint={t("versionHint")}>
                          <Input
                            className="font-mono"
                            value={form.cpVersion}
                            placeholder={config.cp_version ?? t("embedDefault")}
                            onChange={(e) => setForm({ ...form, cpVersion: e.target.value })}
                          />
                        </Field>
                      </div>
                    )}
                  </CardContent>
                  <CardFooter className="flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-5 py-3.5 sm:px-6">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {config === null ? (
                        <>
                          <Spinner size="sm" />
                          {t("loading")}
                        </>
                      ) : quickDirty ? (
                        <>
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                          <span className="font-medium text-amber-600 dark:text-amber-400">
                            {t("modified")}
                          </span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          {t("nothingChanged")}
                        </>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || !quickDirty}
                        onClick={resetQuickForm}
                      >
                        {t("discard")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || !quickDirty}
                        onClick={() => void saveQuick()}
                      >
                        {busy ? <Spinner size="sm" /> : null}
                        {t("save")}
                      </Button>
                    </div>
                  </CardFooter>
                </Card>
              )}

              {tab === "settings" && (
                <section className="space-y-4">
                  {settings === null ? (
                    <div className="space-y-4">
                      {[0, 1].map((index) => (
                        <Card key={index} className="overflow-hidden">
                          <div className="flex items-center gap-3 border-b border-border/70 bg-muted/20 px-5 py-4">
                            <div className="h-9 w-9 animate-pulse rounded-xl bg-muted" />
                            <div className="space-y-2">
                              <div className="h-3 w-28 animate-pulse rounded bg-muted" />
                              <div className="h-2.5 w-52 animate-pulse rounded bg-muted/70" />
                            </div>
                          </div>
                          <div className="space-y-3 p-5">
                            {[0, 1, 2].map((row) => (
                              <div
                                key={row}
                                className="h-11 animate-pulse rounded-lg bg-muted/40"
                              />
                            ))}
                          </div>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <Fragment>
                      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                        {t("settingsIntro")}
                      </p>
                      {settings.unset_required.length > 0 && (
                        <Alert className="rounded-xl border-amber-500/25 bg-amber-500/[0.06]">
                          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                          <AlertTitle>{t("unsetRequired")}</AlertTitle>
                          <AlertDescription className="flex flex-wrap gap-1.5 pt-1">
                            {settings.unset_required.map((key) => (
                              <code
                                key={key}
                                className="rounded-md bg-background/70 px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-border/60"
                              >
                                {key}
                              </code>
                            ))}
                          </AlertDescription>
                        </Alert>
                      )}
                      {ordinarySettings.map((group) => renderSettingsGroup(group))}
                      {settingsSave}
                    </Fragment>
                  )}
                </section>
              )}

              {tab === "config" && (
                <Card className="overflow-hidden">
                  <CardHeader className="flex-row items-start gap-3 space-y-0 px-5 py-4 sm:px-6">
                    <IconTile icon={FileCode2} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-[15px] leading-tight">{t("config")}</CardTitle>
                        {envDirty && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            {t("modified")}
                          </span>
                        )}
                      </div>
                      <CardDescription className="mt-1 text-[12.5px] leading-relaxed">
                        {t("configIntro")}
                      </CardDescription>
                      {envFile?.path && (
                        <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1">
                          <FileCode2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <code className="truncate font-mono text-[10.5px] text-muted-foreground">
                            {envFile.path}
                          </code>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="flex items-center justify-between border-y border-border/70 bg-muted/30 px-4 py-1.5">
                      <span className="font-mono text-[10px] tracking-wide text-muted-foreground">
                        .env
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                        {envText ? envText.split("\n").length : 0}
                      </span>
                    </div>
                    {envFile === null ? (
                      <div className="min-h-[460px] space-y-3 px-4 py-4" aria-hidden>
                        {[72, 56, 88, 64, 48, 80, 60, 68].map((width, index) => (
                          <div
                            key={index}
                            className="h-3 animate-pulse rounded bg-muted/60"
                            style={{ width: `${width}%` }}
                          />
                        ))}
                      </div>
                    ) : (
                      <Textarea
                        className="min-h-[460px] rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[12px] leading-relaxed shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                        spellCheck={false}
                        value={envText}
                        onChange={(e) => setEnvText(e.target.value)}
                      />
                    )}
                  </CardContent>
                  <CardFooter className="flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-5 py-3.5 sm:px-6">
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {envFile === null ? (
                        <>
                          <Spinner size="sm" />
                          {t("loading")}
                        </>
                      ) : envDirty ? (
                        <>
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                          <span className="font-medium text-amber-600 dark:text-amber-400">
                            {t("modified")}
                          </span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                          {t("nothingChanged")}
                        </>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void selectProfile(current)}
                      >
                        <RotateCcw />
                        {t("reload")}
                      </Button>
                      <Button size="sm" disabled={busy || !envDirty} onClick={() => void saveEnv()}>
                        {busy ? <Spinner size="sm" /> : null}
                        {t("save")}
                      </Button>
                    </div>
                  </CardFooter>
                </Card>
              )}

              {tab === "files" &&
                (paths ? (
                  <Card className="overflow-hidden">
                    <CardHeader className="flex-row items-start gap-3 space-y-0 px-5 py-4 sm:px-6">
                      <IconTile icon={FolderOpen} />
                      <div className="min-w-0">
                        <CardTitle className="text-[15px] leading-tight">{t("files")}</CardTitle>
                        <CardDescription className="mt-1 text-[12.5px] leading-relaxed">
                          {t("filesIntro")}
                        </CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="p-0">
                      <dl className="divide-y divide-border/70">
                        {[
                          { icon: Gauge, label: t("port"), value: String(paths.port) },
                          { icon: FileCode2, label: t("configPath"), value: paths.config_path },
                          { icon: ScrollText, label: t("daemonLog"), value: paths.log_path },
                          { icon: LockKeyhole, label: t("lockPath"), value: paths.lock_path },
                          { icon: Database, label: t("databaseUrl"), value: paths.database_url },
                          {
                            icon: Database,
                            label: t("databaseDir"),
                            value: paths.database_path ?? "—",
                          },
                          { icon: Wifi, label: t("daemonUrl"), value: paths.daemon_url },
                          { icon: ExternalLink, label: t("controlPlane"), value: paths.ui_url },
                        ].map(({ icon: Icon, label: rowLabel, value }) => (
                          <div
                            key={rowLabel}
                            className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted/30 sm:px-6"
                          >
                            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                              <Icon className="h-3.5 w-3.5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <dt className="text-[10px] font-medium tracking-wide text-muted-foreground">
                                {rowLabel}
                              </dt>
                              <dd className="mt-0.5 font-mono text-[12px] leading-relaxed break-all">
                                {value}
                              </dd>
                            </div>
                            <CopyButton value={value} label={rowLabel} />
                          </div>
                        ))}
                      </dl>
                    </CardContent>
                  </Card>
                ) : (
                  <Card>
                    <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                      <Spinner size="sm" />
                      {t("loading")}
                    </CardContent>
                  </Card>
                ))}

              {tab === "logs" && (
                <Card className="overflow-hidden">
                  <CardHeader className="flex-row items-start gap-3 space-y-0 px-5 py-4 sm:px-6">
                    <IconTile icon={ScrollText} />
                    <div className="min-w-0 flex-1">
                      <CardTitle className="text-[15px] leading-tight">{t("logs")}</CardTitle>
                      <CardDescription className="mt-1 truncate font-mono text-[11px]">
                        {logPath || "—"}
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative">
                        <select
                          className={cn(SELECT_CLASS, "w-auto min-w-[132px]")}
                          value={logSource}
                          onChange={(e) => setLogSource(e.target.value === "ui" ? "ui" : "daemon")}
                        >
                          <option value="daemon">{t("logSourceDaemon")}</option>
                          <option value="ui">{t("logSourceUi")}</option>
                        </select>
                        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      </div>
                      <div className="relative">
                        <select
                          className={cn(SELECT_CLASS, "w-auto min-w-[104px]")}
                          value={logLines}
                          onChange={(e) => setLogLines(Number(e.target.value))}
                        >
                          {[100, 200, 500].map((count) => (
                            <option key={count} value={count}>
                              {t("lines", { count })}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      </div>
                      <label className="flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 text-xs text-muted-foreground">
                        <Switch checked={logAuto} onCheckedChange={setLogAuto} />
                        {t("autoRefresh")}
                      </label>
                      <Button size="sm" variant="outline" onClick={() => void loadLogs(current)}>
                        <RefreshCw />
                        {t("refresh")}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 p-5 sm:p-6">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(
                        [
                          { id: "all", label: t("logLevelAll"), count: parsedLogLines.length },
                          { id: "error", label: "ERROR", count: logLevelCounts.error },
                          { id: "warn", label: "WARNING", count: logLevelCounts.warn },
                          { id: "info", label: "INFO", count: logLevelCounts.info },
                          { id: "debug", label: "DEBUG", count: logLevelCounts.debug },
                        ] as const
                      ).map((item) => {
                        const active = logLevelFilter === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => setLogLevelFilter(item.id)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                              active ? LOG_FILTER_ACTIVE[item.id] : LOG_FILTER_IDLE[item.id]
                            )}
                          >
                            <span>{item.label}</span>
                            <span className="tabular-nums opacity-75">{item.count}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="overflow-hidden rounded-xl border border-slate-800/80 bg-[#0A1020] shadow-inner">
                      <div className="flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.03] px-3 py-2">
                        <span className="flex gap-1.5" aria-hidden>
                          <span className="h-2 w-2 rounded-full bg-rose-400/70" />
                          <span className="h-2 w-2 rounded-full bg-amber-400/70" />
                          <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
                        </span>
                        <span className="ml-1 min-w-0 flex-1 truncate font-mono text-[10px] text-slate-400">
                          {logPath || "—"}
                        </span>
                        <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-slate-400">
                          {filteredLogLines.length}
                        </span>
                      </div>
                      <div
                        role="log"
                        className="max-h-[58vh] min-h-[360px] space-y-0.5 overflow-auto p-3 font-mono text-[11.5px] leading-5"
                      >
                        {filteredLogLines.length > 0 ? (
                          filteredLogLines.map((entry, idx) => (
                            <LogLineRow key={idx} entry={entry} />
                          ))
                        ) : (
                          <div className="flex min-h-[336px] flex-col items-center justify-center gap-2 text-center">
                            <Terminal className="h-6 w-6 text-slate-600" />
                            <p className="text-[11px] text-slate-500">
                              {logText ? t("logsNoMatch") : "—"}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </Fragment>
          )}
        </main>
      </div>

      {missingModelDialog && (
        <Dialog open onOpenChange={(open) => !open && setMissingModelDialog(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <div className="flex items-start gap-3">
                <IconTile
                  icon={Download}
                  className="bg-amber-500/10 text-amber-600 dark:text-amber-300"
                />
                <div className="min-w-0">
                  <DialogTitle>
                    {preferZh ? "本地模型尚未下载" : "Local Model Not Downloaded"}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    {preferZh
                      ? "为避免后台静默拉取大文件导致启动卡死，请确认是否先下载所选模型："
                      : "To avoid silent background downloads on startup, confirm how to proceed:"}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              {missingModelDialog.missing.map((m) => (
                <div
                  key={m.name}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5"
                >
                  <span className="min-w-0 truncate font-mono text-[11.5px]">{m.filename}</span>
                  {m.dimensions ? (
                    <span className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {m.dimensions} dims
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            <DialogFooter className="flex-wrap">
              <Button variant="ghost" size="sm" onClick={() => setMissingModelDialog(null)}>
                {preferZh ? "取消" : "Cancel"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const values = missingModelDialog.pendingValues;
                  setMissingModelDialog(null);
                  void run(() => checkCompatibilityAndSave(values));
                }}
              >
                {preferZh ? "仅保存配置" : "Save Config Only"}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  const { missing, pendingValues } = missingModelDialog;
                  setMissingModelDialog(null);
                  void run(async () => {
                    for (const item of missing) {
                      await localApi.downloadLocalModel(token, current ?? "", item.name);
                    }
                    setLocalModels(await localApi.localModels(token, current ?? ""));
                    await checkCompatibilityAndSave(pendingValues);
                  });
                }}
              >
                {preferZh ? "开始下载并保存" : "Download & Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {conflictDialog && (
        <Dialog open onOpenChange={(open) => !open && setConflictDialog(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <div className="flex items-start gap-3">
                <IconTile icon={AlertTriangle} className="bg-destructive/10 text-destructive" />
                <div className="min-w-0">
                  <DialogTitle className="text-destructive">
                    {preferZh ? "向量维度不兼容" : "Embedding Dimension Mismatch"}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    {preferZh ? conflictDialog.compat.message_zh : conflictDialog.compat.message}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              {preferZh
                ? "你可以保留现有记忆并用新模型在后台原地重算向量，也可以清空本地记忆重新初始化。"
                : "You can keep your existing memories and re-embed them in place, or clear local memories to reinitialize."}
            </div>
            <DialogFooter className="flex-wrap">
              <Button variant="ghost" size="sm" onClick={() => setConflictDialog(null)}>
                {preferZh ? "取消" : "Cancel"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void handleResetMemories(conflictDialog.pendingValues)}
              >
                {preferZh ? "清空本地记忆并重置" : "Clear Memories & Reset"}
              </Button>
              {conflictDialog.compat.can_reembed && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void handleReembed(conflictDialog.pendingValues)}
                >
                  {preferZh ? "保留记忆，原地重算向量" : "Re-embed & Keep Memories"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Shell>
  );
}

/** Page chrome: shared standalone shell with navigation, theme toggle and language picker. */
function Shell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("local");
  return (
    <StandaloneShell
      section="local"
      title={t("title")}
      backLabel={t("openMemory")}
      maxWidthClass="max-w-[1360px]"
    >
      {children}
    </StandaloneShell>
  );
}

function IconTile({
  icon: Icon,
  className,
  size = "md",
}: {
  icon: typeof Sliders;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center bg-primary/10 text-primary",
        size === "lg"
          ? "h-12 w-12 rounded-2xl"
          : size === "sm"
            ? "h-8 w-8 rounded-lg"
            : "h-9 w-9 rounded-xl",
        className
      )}
    >
      <Icon className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} />
    </div>
  );
}

function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      className={cn(
        "block h-2 w-2 rounded-full",
        running
          ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.16)]"
          : "bg-muted-foreground/35"
      )}
      aria-hidden
    />
  );
}

function StatusPill({ running, children }: { running: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        running
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-border bg-muted/70 text-muted-foreground"
      )}
    >
      <StatusDot running={running} />
      {children}
    </span>
  );
}

function InfoChip({ icon: Icon, label }: { icon: typeof Sliders; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2 py-1 text-[10.5px] text-muted-foreground">
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function HeroStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Sliders;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-lg px-3 py-2">
      <div className="flex items-center gap-1.5 text-[9.5px] font-medium tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-foreground/85" title={value}>
        {value}
      </div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations("local");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard access can be denied; leave the value selectable instead */
    }
  };

  const actionLabel = `${copied ? t("copied") : t("copy")} ${label}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "h-7 w-7 shrink-0 text-muted-foreground opacity-60 transition-opacity hover:opacity-100",
        copied && "text-emerald-600 opacity-100 dark:text-emerald-400"
      )}
      title={actionLabel}
      aria-label={actionLabel}
      onClick={() => void copy()}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function SidebarPath({ label, value }: { label: string; value: string }) {
  return (
    <div className="group rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[9.5px] font-medium tracking-wide text-muted-foreground">
          {label}
        </span>
        <CopyButton value={value} label={label} />
      </div>
      <p className="mt-0.5 font-mono text-[10.5px] leading-relaxed break-all text-foreground/80">
        {value}
      </p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-[12px] font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * One catalog field, rendered by its declared kind.
 *
 * The kind decides the widget so the catalog stays the single source of truth:
 * adding a setting is a Python-side change, and it appears here without a
 * TypeScript edit. `combo` is a select plus a free-text escape hatch, because
 * the daemon accepts values beyond the shipped set (any HuggingFace id, a local
 * `.gguf` path, a provider-specific reasoning level).
 */
function SettingRow({
  field,
  value,
  changed,
  label,
  description,
  models,
  modelBusy,
  modelError,
  modelNotice,
  onFetchModels,
  localModels,
  onDownloadLocalModel,
  onChange,
}: {
  field: SettingField;
  value: string;
  changed: boolean;
  label: string;
  description: string;
  models?: string[];
  modelBusy?: boolean;
  modelError?: string | null;
  modelNotice?: string | null;
  onFetchModels?: () => void;
  localModels?: LocalModelStatus[];
  onDownloadLocalModel?: (modelName: string) => void;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("local");
  return (
    <div
      className={cn(
        "grid gap-4 px-5 py-5 transition-colors sm:px-6 md:grid-cols-[minmax(0,1fr)_minmax(240px,320px)] md:items-start",
        changed && "bg-amber-500/[0.035]"
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-[12.5px] font-medium">{label}</Label>
          {changed && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              {t("modified")}
            </span>
          )}
          {!field.is_set && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
              {t("optionDefault")}
            </span>
          )}
        </div>
        <p className="max-w-prose text-[11.5px] leading-relaxed text-muted-foreground">
          {description}
        </p>
        {!field.is_set && field.default && (
          <p className="font-mono text-[10px] text-muted-foreground/80">
            {t("defaultHint", { value: field.default })}
          </p>
        )}
      </div>
      <div className="w-full min-w-0 md:justify-self-end">
        <SettingControl
          field={field}
          value={value}
          models={models}
          modelBusy={modelBusy}
          modelError={modelError}
          modelNotice={modelNotice}
          onFetchModels={onFetchModels}
          localModels={localModels}
          onDownloadLocalModel={onDownloadLocalModel}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

function SettingControl({
  field,
  value,
  models,
  modelBusy,
  modelError,
  modelNotice,
  onFetchModels,
  localModels,
  onDownloadLocalModel,
  onChange,
}: {
  field: SettingField;
  value: string;
  models?: string[];
  modelBusy?: boolean;
  modelError?: string | null;
  modelNotice?: string | null;
  onFetchModels?: () => void;
  localModels?: LocalModelStatus[];
  onDownloadLocalModel?: (modelName: string) => void;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("local");
  const modelListId = useId();
  const options = field.option_labels.length > 0 ? field.option_labels : null;
  const isCustom = field.kind === "combo" && value !== "" && !field.options.includes(value);

  const selectValue = () => {
    if (value === "") return "__default__";
    if (field.kind === "combo" && isCustom) return "__custom__";
    return value;
  };

  return (
    <div className="space-y-2">
      {field.kind === "boolean" ? (
        <div className="grid grid-cols-3 gap-1 rounded-[10px] border border-border bg-muted/40 p-1">
          {[
            { value: "__default__", label: t("optionDefault") },
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ].map((option) => {
            const active = (value === "" ? "__default__" : value) === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onChange(option.value === "__default__" ? "" : option.value)}
                className={cn(
                  "truncate rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  active
                    ? "bg-card text-foreground shadow-xs ring-1 ring-border"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : field.kind === "select" || field.kind === "combo" ? (
        <div className="space-y-1.5">
          <div className="relative">
            <select
              className={SELECT_CLASS}
              value={selectValue()}
              onChange={(e) => {
                const next = e.target.value;
                if (next === "__default__") onChange("");
                else if (next === "__custom__") onChange(isCustom ? value : " ");
                else onChange(next);
              }}
            >
              <option value="__default__">{t("optionDefault")}</option>
              {options
                ? options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                : field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
              {field.kind === "combo" && <option value="__custom__">{t("optionCustom")}</option>}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
          {field.kind === "combo" && (isCustom || value === " ") && (
            <Input
              value={value === " " ? "" : value}
              placeholder={field.placeholder}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      ) : field.key === "HINDSIGHT_API_LLM_MODEL" && onFetchModels ? (
        <div className="space-y-1">
          <div className="flex gap-2">
            <Input
              list={models && models.length > 0 ? modelListId : undefined}
              value={value}
              placeholder={field.placeholder || field.default}
              onChange={(e) => onChange(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0"
              disabled={modelBusy}
              title={t("modelsHint")}
              onClick={onFetchModels}
            >
              {modelBusy ? <Spinner size="sm" /> : <RefreshCw />}
              {modelBusy ? t("fetchingModels") : t("fetchModels")}
            </Button>
          </div>
          {models && models.length > 0 ? (
            <>
              <datalist id={modelListId}>
                {models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto rounded-lg border border-border/70 bg-muted/30 p-1.5">
                {models.map((model) => (
                  <button
                    key={model}
                    type="button"
                    title={model}
                    onClick={() => onChange(model)}
                    className={cn(
                      "max-w-full truncate rounded px-1.5 py-0.5 text-[11px]",
                      value === model
                        ? "bg-primary text-primary-foreground"
                        : "bg-background hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {model}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <Input
          type={
            field.kind === "number" ? "number" : field.kind === "password" ? "password" : "text"
          }
          className={field.kind === "number" ? "font-mono tabular-nums" : undefined}
          value={value}
          placeholder={field.placeholder || field.default}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.key === "HINDSIGHT_API_LLM_MODEL" && modelNotice && (
        <p className="text-[11px] text-muted-foreground">{modelNotice}</p>
      )}
      {field.key === "HINDSIGHT_API_LLM_MODEL" && modelError && (
        <p className="text-[11px] text-red-600 dark:text-red-400" role="alert">
          {modelError}
        </p>
      )}

      {(field.key === "HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL" ||
        field.key === "HINDSIGHT_API_RERANKER_LOCAL_MODEL" ||
        field.key === "HINDSIGHT_API_LLM_MODEL") &&
        localModels &&
        onDownloadLocalModel && (
          <LocalModelDownloadBar
            modelName={value || field.default}
            localModels={localModels}
            onDownload={onDownloadLocalModel}
          />
        )}
    </div>
  );
}

const LOG_FILTER_ACTIVE: Record<"all" | LogLevel, string> = {
  all: "border-foreground bg-foreground text-background",
  error: "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300",
  warn: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  info: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300",
  debug: "border-border bg-muted text-foreground",
  other: "border-border bg-muted text-foreground",
};

const LOG_FILTER_IDLE: Record<"all" | LogLevel, string> = {
  all: "border-border bg-background text-muted-foreground hover:text-foreground",
  error: "border-border bg-background text-red-600/80 dark:text-red-400/80 hover:bg-red-500/10",
  warn: "border-border bg-background text-amber-600/80 dark:text-amber-400/80 hover:bg-amber-500/10",
  info: "border-border bg-background text-sky-600/80 dark:text-sky-400/80 hover:bg-sky-500/10",
  debug: "border-border bg-background text-muted-foreground hover:text-foreground",
  other: "border-border bg-background text-muted-foreground hover:text-foreground",
};

const LOG_ROW_CLASS: Record<LogLevel, string> = {
  error: "border-l-2 border-red-400/70 bg-red-400/10 text-red-200",
  warn: "border-l-2 border-amber-400/70 bg-amber-400/10 text-amber-200",
  info: "border-l-2 border-sky-400/25 text-slate-300",
  debug: "border-l-2 border-transparent text-slate-500",
  other: "border-l-2 border-transparent text-slate-300",
};

const LOG_TOKEN_CLASS: Record<Exclude<LogLevel, "other">, string> = {
  error: "rounded px-1 py-0.5 font-semibold bg-red-400/15 text-red-300",
  warn: "rounded px-1 py-0.5 font-semibold bg-amber-400/15 text-amber-300",
  info: "rounded px-1 py-0.5 font-semibold bg-sky-400/10 text-sky-300",
  debug: "rounded px-1 py-0.5 font-semibold bg-white/5 text-slate-400",
};

/** Single log line with level-based border/tint and highlighted severity token. */
function LogLineRow({ entry }: { entry: ParsedLogLine }) {
  const { line, level, matchStart, matchEnd } = entry;
  const hasToken =
    level !== "other" &&
    matchStart !== undefined &&
    matchEnd !== undefined &&
    matchEnd > matchStart;

  return (
    <div
      className={cn(
        "rounded-r px-2 py-0.5 leading-5 whitespace-pre-wrap break-words",
        LOG_ROW_CLASS[level]
      )}
    >
      {hasToken ? (
        <>
          {line.slice(0, matchStart)}
          <span className={LOG_TOKEN_CLASS[level]}>{line.slice(matchStart, matchEnd)}</span>
          {line.slice(matchEnd)}
        </>
      ) : (
        line || " "
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function LocalModelDownloadBar({
  modelName,
  localModels,
  onDownload,
}: {
  modelName: string;
  localModels: LocalModelStatus[];
  onDownload: (modelName: string) => void;
}) {
  const preferZh = useLocale().startsWith("zh");
  const entry = localModels.find((m) => m.name.toLowerCase() === modelName.trim().toLowerCase());
  if (!entry) return null;

  if (entry.downloaded) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span>
          {preferZh ? "已下载" : "Downloaded"} · {formatBytes(entry.downloaded_bytes)}
          {entry.dimensions ? ` · ${entry.dimensions} dims` : ""}
        </span>
      </div>
    );
  }

  if (entry.downloading) {
    const pct =
      entry.total_bytes && entry.total_bytes > 0
        ? Math.min(100, Math.round((entry.downloaded_bytes * 100) / entry.total_bytes))
        : null;
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-primary">
          <span className="inline-flex items-center gap-1.5">
            <Spinner size="sm" />
            {preferZh ? "正在下载…" : "Downloading…"}
            {pct !== null ? ` ${pct}%` : ""}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {formatBytes(entry.downloaded_bytes)}
            {entry.total_bytes ? ` / ${formatBytes(entry.total_bytes)}` : ""}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${pct ?? 15}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-amber-600 dark:text-amber-400">
          {preferZh ? "未下载到本地" : "Not downloaded"}
          {entry.dimensions ? ` · ${entry.dimensions} dims` : ""}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
          onClick={() => onDownload(entry.name)}
        >
          <Download className="mr-1 h-3 w-3" />
          {preferZh ? "下载模型" : "Download"}
        </Button>
      </div>
      {entry.error && <p className="text-[11px] text-red-600 dark:text-red-400">{entry.error}</p>}
    </div>
  );
}
