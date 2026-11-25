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
import { RefreshCw } from "lucide-react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useTheme } from "@/lib/theme-context";
import { useLocale } from "next-intl";
import {
  localApi,
  type DaemonActionResult,
  type EnvFileView,
  type HealthView,
  type PathsView,
  type ProfileConfigView,
  type ProfileSummary,
  type SettingField,
  type SettingsView,
} from "@/lib/local-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { countLogLevels, parseLogLines, type LogLevel, type ParsedLogLine } from "@/lib/log-levels";

type Tab = "quick" | "settings" | "config" | "files" | "logs";

const TABS: { id: Tab; key: Tab }[] = [
  { id: "quick", key: "quick" },
  { id: "settings", key: "settings" },
  { id: "config", key: "config" },
  { id: "files", key: "files" },
  { id: "logs", key: "logs" },
];

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
        <div className="mx-auto max-w-2xl px-6 py-16">
          <Alert>
            <AlertTitle>{t("unavailableTitle")}</AlertTitle>
            <AlertDescription>
              <p className="mb-3">{t("unavailableBody")}</p>
              <code className="block rounded bg-muted px-3 py-2 font-mono text-xs break-all">
                {embedCommand}
              </code>
              <p className="mt-3 text-sm">
                {t("unavailableHint")} <code className="font-mono">HINDSIGHT_CP_EMBED_COMMAND</code>
              </p>
            </AlertDescription>
          </Alert>
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
    const { profiles: list } = await localApi.profiles(token);
    setProfiles(list);
    return list;
  }, [token]);

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

      // Each panel loads independently: one failing endpoint must not blank the
      // whole page, and older installs may not have every operation.
      const settle = async <T,>(promise: Promise<T>): Promise<T | null> => {
        try {
          return await promise;
        } catch {
          return null;
        }
      };
      const [cfg, sets, env, pth, hlt] = await Promise.all([
        settle(localApi.config(token, name)),
        settle(localApi.settings(token, name)),
        settle(localApi.env(token, name)),
        settle(localApi.paths(token, name)),
        settle(localApi.health(token, name)),
      ]);
      if (currentRef.current !== name) return;

      if (cfg) {
        setConfig(cfg);
        setForm({
          apiPort: String(cfg.api_port),
          uiPort: cfg.ui_port_is_default ? "" : String(cfg.ui_port),
          apiVersion: cfg.api_version ?? "",
          cpVersion: cfg.cp_version ?? "",
        });
      }
      setSettings(sets);
      if (env) {
        setEnvFile(env);
        setEnvText(env.content);
      }
      setPaths(pth);
      setHealth(hlt);
    },
    [token]
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
    if (!current) return;
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
    if (!current || tab !== "logs") return;
    void loadLogs(current);
    if (!logAuto) return;
    const id = setInterval(() => void loadLogs(current), 2000);
    return () => clearInterval(id);
  }, [current, tab, logAuto, loadLogs]);

  const dirty = useMemo(() => Object.keys(draft).length > 0, [draft]);

  const daemonAction = async (action: "start" | "stop" | "restart") => {
    if (!current) return;
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
    if (!current) return;
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

  const saveSettings = async () => {
    if (!current) return;
    if (!dirty) {
      setNotice(t("nothingChanged"));
      return;
    }
    await run(async () => {
      const next = await localApi.saveSettings(token, current, draft);
      setSettings(next);
      setDraft({});
      await loadProfiles().catch(() => undefined);
    }, t("savedRestart"));
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

  const fetchModels = async () => {
    if (!current) return;
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
    if (!current) return;
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

  return (
    <Shell>
      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6 lg:px-8">
        <aside className="w-56 shrink-0">
          <h2 className="mb-2 px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("profiles")}
          </h2>
          <ul className="space-y-1">
            {profiles.map((profile) => (
              <li key={profile.name || "default"}>
                <button
                  type="button"
                  onClick={() => void selectProfile(profile.name)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                    profile.name === current && "bg-accent font-medium"
                  )}
                >
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      profile.daemon_running ? "bg-emerald-500" : "bg-muted-foreground/40"
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{profile.display_name}</span>
                  {profile.is_active && (
                    <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {t("active")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="min-w-0 flex-1">
          {current === null ? (
            <p className="text-sm text-muted-foreground">{t("selectProfile")}</p>
          ) : (
            <Fragment>
              <div className="mb-4 flex flex-wrap items-end gap-3">
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-semibold">
                    {config?.display_name ?? current}
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    {t("daemon")}: {statusLabel(Boolean(health?.api_ok))}
                    {health ? ` · ${preferZh ? health.api_detail_zh : health.api_detail}` : ""}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                  {health?.api_ok && (
                    <Button asChild size="sm">
                      <Link href="/dashboard">{t("openMemory")}</Link>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void daemonAction(health?.api_ok ? "restart" : "start")}
                  >
                    {health?.api_ok ? t("restart") : t("start")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !health?.api_ok}
                    onClick={() => void daemonAction("stop")}
                  >
                    {t("stop")}
                  </Button>
                  {current !== "" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void deleteProfile()}
                    >
                      {t("deleteProfile")}
                    </Button>
                  )}
                </div>
              </div>

              {error && (
                <Alert variant="destructive" className="mb-4">
                  <AlertTitle>{t("failed")}</AlertTitle>
                  <AlertDescription className="break-words">{error}</AlertDescription>
                </Alert>
              )}
              {notice && (
                <Alert className="mb-4">
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              )}

              <div className="mb-4 flex gap-1 border-b">
                {TABS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setTab(entry.id)}
                    className={cn(
                      "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                      tab === entry.id
                        ? "border-foreground font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t(entry.key)}
                  </button>
                ))}
              </div>

              {tab === "quick" && (
                <section className="max-w-2xl space-y-4">
                  <p className="text-sm text-muted-foreground">{t("quickIntro")}</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("apiPort")}>
                      <Input
                        type="number"
                        value={form.apiPort}
                        onChange={(e) => setForm({ ...form, apiPort: e.target.value })}
                      />
                    </Field>
                    <Field label={t("uiPort")} hint={t("uiPortHint")}>
                      <Input
                        type="number"
                        placeholder={config ? String(config.ui_port) : ""}
                        value={form.uiPort}
                        onChange={(e) => setForm({ ...form, uiPort: e.target.value })}
                      />
                    </Field>
                    <Field label={t("apiVersion")} hint={t("versionHint")}>
                      <Input
                        value={form.apiVersion}
                        placeholder={config?.api_version ?? t("embedDefault")}
                        onChange={(e) => setForm({ ...form, apiVersion: e.target.value })}
                      />
                    </Field>
                    <Field label={t("cpVersion")} hint={t("versionHint")}>
                      <Input
                        value={form.cpVersion}
                        placeholder={config?.cp_version ?? t("embedDefault")}
                        onChange={(e) => setForm({ ...form, cpVersion: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Button disabled={busy} onClick={() => void saveQuick()}>
                    {busy ? <Spinner size="sm" /> : null}
                    {t("save")}
                  </Button>
                </section>
              )}

              {tab === "settings" && (
                <section className="space-y-6">
                  {settings === null ? (
                    <p className="text-sm text-muted-foreground">{t("loading")}</p>
                  ) : (
                    <Fragment>
                      <p className="text-sm text-muted-foreground">{t("settingsIntro")}</p>
                      {settings.unset_required.length > 0 && (
                        <Alert>
                          <AlertTitle>{t("unsetRequired")}</AlertTitle>
                          <AlertDescription>
                            {settings.unset_required.map((key) => (
                              <code key={key} className="mr-2 font-mono text-xs">
                                {key}
                              </code>
                            ))}
                          </AlertDescription>
                        </Alert>
                      )}
                      {settings.groups.map((group) => (
                        <div key={group.id} className="space-y-3">
                          <div>
                            <h3 className="text-sm font-semibold">{label(group)}</h3>
                            <p className="text-xs text-muted-foreground">{description(group)}</p>
                          </div>
                          <div className="grid gap-4 md:grid-cols-2">
                            {group.fields.map((field) => (
                              <SettingControl
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
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center gap-3">
                        <Button disabled={busy} onClick={() => void saveSettings()}>
                          {busy ? <Spinner size="sm" /> : null}
                          {t("save")}
                        </Button>
                        {dirty && (
                          <span className="text-xs text-muted-foreground">{t("modified")}</span>
                        )}
                      </div>
                    </Fragment>
                  )}
                </section>
              )}

              {tab === "config" && (
                <section className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {t("configIntro")}{" "}
                    <code className="font-mono text-xs">{envFile?.path ?? ""}</code>
                  </p>
                  <Textarea
                    className="min-h-[420px] font-mono text-xs"
                    spellCheck={false}
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button disabled={busy} onClick={() => void saveEnv()}>
                      {busy ? <Spinner size="sm" /> : null}
                      {t("save")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void selectProfile(current)}
                    >
                      {t("reload")}
                    </Button>
                  </div>
                </section>
              )}

              {tab === "files" && paths && (
                <section>
                  <p className="mb-3 text-sm text-muted-foreground">{t("filesIntro")}</p>
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
                    {[
                      [t("port"), String(paths.port)],
                      [t("configPath"), paths.config_path],
                      [t("daemonLog"), paths.log_path],
                      [t("lockPath"), paths.lock_path],
                      [t("databaseUrl"), paths.database_url],
                      [t("databaseDir"), paths.database_path ?? "—"],
                      [t("daemonUrl"), paths.daemon_url],
                      [t("controlPlane"), paths.ui_url],
                    ].map(([key, value]) => (
                      <Fragment key={key}>
                        <dt className="text-muted-foreground">{key}</dt>
                        <dd className="font-mono text-xs break-all">{value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </section>
              )}

              {tab === "logs" && (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      value={logSource}
                      onChange={(e) => setLogSource(e.target.value === "ui" ? "ui" : "daemon")}
                    >
                      <option value="daemon">{t("logSourceDaemon")}</option>
                      <option value="ui">{t("logSourceUi")}</option>
                    </select>
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      value={logLines}
                      onChange={(e) => setLogLines(Number(e.target.value))}
                    >
                      {[100, 200, 500].map((count) => (
                        <option key={count} value={count}>
                          {t("lines", { count })}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={logAuto}
                        onChange={(e) => setLogAuto(e.target.checked)}
                      />
                      {t("autoRefresh")}
                    </label>
                    <Button size="sm" variant="outline" onClick={() => void loadLogs(current)}>
                      {t("refresh")}
                    </Button>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {logPath}
                    </span>
                  </div>
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
                            "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
                            active ? LOG_FILTER_ACTIVE[item.id] : LOG_FILTER_IDLE[item.id]
                          )}
                        >
                          <span>{item.label}</span>
                          <span className="tabular-nums opacity-75">{item.count}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div
                    role="log"
                    className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs space-y-0.5"
                  >
                    {filteredLogLines.length > 0 ? (
                      filteredLogLines.map((entry, idx) => <LogLineRow key={idx} entry={entry} />)
                    ) : (
                      <div className="px-2 py-1 text-muted-foreground">
                        {logText ? t("logsNoMatch") : "—"}
                      </div>
                    )}
                  </div>
                </section>
              )}
            </Fragment>
          )}
        </main>
      </div>
    </Shell>
  );
}

/** Page chrome: brand, title, theme toggle and language picker. */
function Shell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("local");
  const tNav = useTranslations("nav");
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex items-center gap-3 border-b px-4 py-3 lg:px-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="" className="h-6 w-6" />
        <span className="font-semibold">{t("title")}</span>
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={toggleTheme}>
            {theme === "light" ? tNav("darkMode") : tNav("lightMode")}
          </Button>
          <LanguageSwitcher />
        </span>
      </header>
      {children}
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
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
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
function SettingControl({
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
    <div
      className={cn(
        "space-y-1.5",
        changed && "rounded-md ring-1 ring-amber-500/40 ring-offset-4 ring-offset-background"
      )}
    >
      <div className="flex items-center gap-2">
        <Label className="text-xs">{label}</Label>
        {changed && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400">{t("modified")}</span>
        )}
      </div>

      {field.kind === "boolean" ? (
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={value === "" ? "__default__" : value}
          onChange={(e) => onChange(e.target.value === "__default__" ? "" : e.target.value)}
        >
          <option value="__default__">{t("optionDefault")}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : field.kind === "select" || field.kind === "combo" ? (
        <div className="space-y-1">
          <select
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
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
              className="shrink-0"
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
              <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto rounded-md border bg-muted/30 p-1.5">
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

      <p className="text-[11px] text-muted-foreground">
        {description}
        {!field.is_set && field.default ? ` ${t("defaultHint", { value: field.default })}` : ""}
      </p>
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
  error: "border-l-2 border-red-500 bg-red-500/10 text-red-700 dark:text-red-300",
  warn: "border-l-2 border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  info: "border-l-2 border-sky-500/40 text-foreground",
  debug: "border-l-2 border-transparent text-muted-foreground",
  other: "border-l-2 border-transparent text-foreground/85",
};

const LOG_TOKEN_CLASS: Record<Exclude<LogLevel, "other">, string> = {
  error: "rounded px-1 py-0.5 font-semibold bg-red-500/20 text-red-700 dark:text-red-300",
  warn: "rounded px-1 py-0.5 font-semibold bg-amber-500/20 text-amber-700 dark:text-amber-300",
  info: "rounded px-1 py-0.5 font-semibold bg-sky-500/15 text-sky-700 dark:text-sky-300",
  debug: "rounded px-1 py-0.5 font-semibold bg-muted text-muted-foreground",
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
