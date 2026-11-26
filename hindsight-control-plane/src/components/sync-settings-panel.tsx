"use client";

/**
 * Multi-device sync configuration, on the sync page rather than in local
 * settings (ADR-012).
 *
 * The two halves have different requirements. Signing in to a relay is a daemon
 * operation — it performs the PAKE exchange, writes the device credential, and
 * wakes the running scheduler — so it needs the local service. The three knobs
 * (state dir, automatic sync, interval) are read from `.env` at daemon startup:
 * they can be written while it is stopped, and take effect next start. Neither
 * belongs in a form whose whole point is to work without the daemon.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { SyncConnectionPanel } from "@/components/sync-connection-panel";
import { cn } from "@/lib/utils";
import {
  localApi,
  type ProfileSummary,
  type SettingField,
  type SettingGroup,
} from "@/lib/local-api";

export function SyncSettingsPanel({ token, preferZh }: { token: string; preferZh: boolean }) {
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const [group, setGroup] = useState<SettingGroup | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { profiles } = await localApi.profiles(token);
      const active = profiles.find((entry) => entry.is_active) ?? profiles[0] ?? null;
      setProfile(active);
      if (!active) {
        setGroup(null);
        return;
      }
      setGroup((await localApi.syncSettings(token, active.name)).groups[0] ?? null);
      setDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = Object.fromEntries(
    (group?.fields ?? [])
      .filter((field) => field.key in draft && draft[field.key] !== field.value)
      .map((field) => [field.key, draft[field.key]])
  );
  const dirty = Object.keys(changed).length > 0;

  const save = async () => {
    if (!profile || !dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next =
        (await localApi.saveSyncSettings(token, profile.name, changed)).groups[0] ?? null;
      setGroup(next);
      setDraft({});
      setNotice(
        preferZh
          ? "已保存。自动同步与检查间隔在下次启动本地服务后生效。"
          : "Saved. Automatic sync and the check interval take effect on the next start of the local service."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
          <Spinner size="sm" />
          {preferZh ? "加载同步配置…" : "Loading sync settings…"}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      {profile && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {preferZh
                ? `当前配置档：${profile.display_name}`
                : `Profile: ${profile.display_name}`}
            </p>
            <Button size="sm" variant="ghost" onClick={() => void load()} disabled={saving}>
              <RefreshCw />
              {preferZh ? "刷新" : "Refresh"}
            </Button>
          </div>

          {profile.daemon_running ? (
            <SyncConnectionPanel
              key={profile.name}
              token={token}
              port={profile.port}
              preferZh={preferZh}
              onSaved={() => void load()}
            />
          ) : (
            <Card>
              <CardContent className="py-5">
                <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-300">
                  {preferZh
                    ? "本地服务未运行：同步登录不可用。下方的设置仍可保存，并在下次启动时生效。"
                    : "The local service is not running: sign-in is unavailable. The settings below can still be saved and apply on the next start."}
                </p>
              </CardContent>
            </Card>
          )}

          {group && (
            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle className="text-base">
                  {preferZh ? group.label_zh || group.label : group.label}
                </CardTitle>
                <CardDescription>
                  {preferZh ? group.description_zh || group.description : group.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="divide-y divide-border/70 p-0">
                {group.fields.map((field) => (
                  <SyncFieldRow
                    key={field.key}
                    field={field}
                    value={field.key in draft ? draft[field.key] : field.value}
                    preferZh={preferZh}
                    disabled={saving}
                    onChange={(value) =>
                      setDraft((pending) => {
                        const next = { ...pending };
                        if (value === field.value) delete next[field.key];
                        else next[field.key] = value;
                        return next;
                      })
                    }
                  />
                ))}
              </CardContent>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-5 py-3.5">
                <span className="text-xs text-muted-foreground">
                  {preferZh
                    ? "状态目录、自动同步与检查间隔在下次启动本地服务后生效。"
                    : "The state directory, automatic sync and interval apply on the next start of the local service."}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving || !dirty}
                    onClick={() => setDraft({})}
                  >
                    {preferZh ? "放弃更改" : "Discard"}
                  </Button>
                  <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
                    {saving ? <Spinner size="sm" /> : <Save />}
                    {preferZh ? "保存" : "Save"}
                  </Button>
                </div>
              </div>
            </Card>
          )}
          {!group && !error && (
            <p className="text-sm text-muted-foreground">
              {preferZh
                ? "这个版本的本地服务没有可编辑的同步设置。"
                : "This version of the local service exposes no editable sync settings."}
            </p>
          )}
        </>
      )}

      {!profile && !error && (
        <p className="text-sm text-muted-foreground">
          {preferZh ? "没有本地配置档。" : "No local profiles."}
        </p>
      )}
    </div>
  );
}

function SyncFieldRow({
  field,
  value,
  preferZh,
  disabled,
  onChange,
}: {
  field: SettingField;
  value: string;
  preferZh: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const label = preferZh ? field.label_zh || field.label : field.label;
  const description = preferZh ? field.description_zh || field.description : field.description;
  const inputId = `sync-setting-${field.key}`;
  return (
    <div className="grid gap-4 px-5 py-5 sm:px-6 md:grid-cols-[minmax(0,1fr)_minmax(240px,320px)] md:items-start">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Label
            htmlFor={field.kind === "boolean" ? undefined : inputId}
            className="text-[12.5px] font-medium"
          >
            {label}
          </Label>
          {!field.is_set && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
              {preferZh ? "默认" : "default"}
            </span>
          )}
        </div>
        <p className="max-w-prose text-[11.5px] leading-relaxed text-muted-foreground">
          {description}
        </p>
        {!field.is_set && field.default && (
          <p className="font-mono text-[10px] text-muted-foreground/80">{field.default}</p>
        )}
      </div>
      <div className="w-full min-w-0 md:justify-self-end">
        {field.kind === "boolean" ? (
          <div className="grid grid-cols-3 gap-1 rounded-[10px] border border-border bg-muted/40 p-1">
            {[
              { value: "", label: preferZh ? "默认" : "default" },
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ].map((option) => {
              const active = value === option.value;
              return (
                <button
                  key={option.value || "default"}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(option.value)}
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
        ) : (
          <Input
            id={inputId}
            type={field.kind === "number" ? "number" : "text"}
            value={value}
            disabled={disabled}
            placeholder={field.placeholder || field.default}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </div>
    </div>
  );
}
