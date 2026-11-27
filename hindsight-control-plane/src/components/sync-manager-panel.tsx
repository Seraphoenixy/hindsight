"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  Clock,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { formatRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  client,
  type RelayDeviceInfo,
  type RelayDeviceProvisioned,
  type SyncConflictDetailResponse,
  type SyncObjectConflictRecord,
  type SyncStatusSnapshot,
} from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

type FieldChange = { path: string; local: unknown; remote: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldChanges(local: unknown, remote: unknown, path = ""): FieldChange[] {
  if (isObject(local) && isObject(remote)) {
    const keys = [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort();
    return keys.flatMap((key) =>
      fieldChanges(
        Object.hasOwn(local, key) ? local[key] : undefined,
        Object.hasOwn(remote, key) ? remote[key] : undefined,
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`
      )
    );
  }
  return JSON.stringify(local) === JSON.stringify(remote)
    ? []
    : [{ path: path || "/", local, remote }];
}

function authStatusMeta(authStatus: string | undefined, preferZh: boolean) {
  switch (authStatus) {
    case "ok":
      return {
        label: preferZh ? "已认证" : "Authenticated",
        tone: "emerald" as const,
      };
    case "needs_prefer":
      return {
        label: preferZh ? "需首次合并" : "Initial join required",
        tone: "amber" as const,
      };
    case "revoked":
      return {
        label: preferZh ? "凭据已撤销" : "Revoked",
        tone: "red" as const,
      };
    case "unconfigured":
      return {
        label: preferZh ? "未配置" : "Unconfigured",
        tone: "muted" as const,
      };
    default:
      return {
        label: preferZh
          ? `异常 (${authStatus || "unknown"})`
          : `Error (${authStatus || "unknown"})`,
        tone: "red" as const,
      };
  }
}

const BADGE_TONE = {
  emerald: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  amber: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  red: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
  muted: "border-border bg-muted/60 text-muted-foreground",
} as const;

const DOT_TONE = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  muted: "bg-muted-foreground/60",
} as const;

export function SyncManagerPanel({
  preferZh = false,
  settingsSlot,
}: {
  preferZh?: boolean;
  settingsSlot?: React.ReactNode;
}) {
  const [status, setStatus] = useState<SyncStatusSnapshot | null>(null);
  const [conflicts, setConflicts] = useState<SyncObjectConflictRecord[]>([]);
  const [devices, setDevices] = useState<RelayDeviceInfo[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unconfirmedOnly, setUnconfirmedOnly] = useState(false);

  const [selectedDetail, setSelectedDetail] = useState<SyncConflictDetailResponse | null>(null);
  const [noteInput, setNoteInput] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [newDeviceName, setNewDeviceName] = useState("");
  const [provisionedToken, setProvisionedToken] = useState<RelayDeviceProvisioned | null>(null);

  const refreshAll = useCallback(async () => {
    setError(null);
    try {
      const [st, confPage] = await Promise.all([
        client.getSyncStatus(),
        client.listSyncConflicts({ limit: 100, offset: 0, unconfirmed_only: unconfirmedOnly }),
      ]);
      setStatus(st);
      setConflicts(confPage.items);
      if (st.configured && adminToken) {
        try {
          const devResp = await client.listSyncDevices(adminToken);
          setDevices(devResp.devices);
          setCurrentDeviceId(devResp.current_device_id ?? st.device_id ?? null);
        } catch {
          setDevices([]);
        }
      } else {
        setDevices([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [unconfirmedOnly, adminToken]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const handleTriggerSync = async (prefer?: "local" | "remote") => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await client.triggerSync({ prefer, automatic: false });
      setNotice(res.message);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openConflictDetail = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const detail = await client.getSyncConflictDetail(id);
      setSelectedDetail(detail);
      setNoteInput(detail.conflict.confirmation?.note ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!selectedDetail) return;
    setBusy(true);
    setError(null);
    try {
      await client.confirmSyncConflict(selectedDetail.conflict.id, {
        note: noteInput.trim() || null,
      });
      await openConflictDetail(selectedDetail.conflict.id);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (side: "local" | "remote") => {
    if (!selectedDetail) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await client.restoreSyncConflict(selectedDetail.conflict.id, {
        side,
        expected_version: selectedDetail.current_object_version,
        note: noteInput.trim() || null,
      });
      setNotice(
        preferZh
          ? `已恢复 ${side} 版本并将作为新变更同步`
          : `Restored ${side} payload and queued sync change`
      );
      setSelectedDetail(null);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRegisterDevice = async () => {
    const trimmed = newDeviceName.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const created = await client.registerSyncDevice({ name: trimmed }, adminToken);
      setProvisionedToken(created);
      setNewDeviceName("");
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRotateDevice = async (deviceId: string) => {
    setBusy(true);
    setError(null);
    try {
      const rotated = await client.rotateSyncDevice(deviceId, adminToken);
      setProvisionedToken(rotated);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeDevice = async (deviceId: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.revokeSyncDevice(deviceId, adminToken);
      setNotice(preferZh ? `已撤销设备 ${deviceId}` : `Revoked device ${deviceId}`);
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner size="sm" />
        {preferZh ? "正在加载同步状态..." : "Loading sync status..."}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{preferZh ? "同步操作失败" : "Sync error"}</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {status?.auth_status && !["ok", "unconfigured"].includes(status.auth_status) && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>
            {status.auth_status === "revoked"
              ? preferZh
                ? "设备凭据已被撤销"
                : "Device credential revoked"
              : status.auth_status === "needs_prefer"
                ? preferZh
                  ? "需要首次合并选择"
                  : "Initial join choice required"
                : preferZh
                  ? "中继认证失败"
                  : "Relay authentication failed"}
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{status.last_error || status.last_message}</p>
            {status.auth_status === "needs_prefer" && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleTriggerSync("local")}
                >
                  {preferZh ? "以本机为准加入" : "Join keeping Local"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleTriggerSync("remote")}
                >
                  {preferZh ? "以远端为准加入" : "Join keeping Remote"}
                </Button>
              </div>
            )}
          </AlertDescription>
        </Alert>
      )}

      {(() => {
        const configured = Boolean(status?.configured);
        const authMeta = authStatusMeta(status?.auth_status, preferZh);
        const localHwm = status?.local_high_water ?? 0;
        const outSeq = status?.out_seq ?? 0;
        const inSeq = status?.in_seq ?? 0;
        const relayVer = status?.relay_version ?? 0;
        const pendingPush = Math.max(0, localHwm - outSeq);
        const pendingPull = Math.max(0, relayVer - inSeq);
        const hasError = Boolean(status?.last_error) || authMeta.tone === "red";
        const overallTone: keyof typeof BADGE_TONE = !configured
          ? "muted"
          : hasError
            ? "red"
            : authMeta.tone === "amber" || pendingPush > 0 || pendingPull > 0
              ? "amber"
              : "emerald";
        const overallLabel = !configured
          ? preferZh
            ? "未配置"
            : "Not configured"
          : hasError
            ? preferZh
              ? "同步异常"
              : "Sync issue"
            : authMeta.tone === "amber"
              ? authMeta.label
              : pendingPush > 0 || pendingPull > 0
                ? preferZh
                  ? "有待同步变更"
                  : "Changes pending"
                : preferZh
                  ? "已同步"
                  : "Up to date";

        return (
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-base">
                    {preferZh ? "同步状态" : "Sync Status"}
                  </CardTitle>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                      BADGE_TONE[overallTone]
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", DOT_TONE[overallTone])} />
                    {overallLabel}
                  </span>
                </div>
                <CardDescription className="truncate font-mono text-xs">
                  {configured
                    ? status?.relay_url
                    : preferZh
                      ? "同步服务端未配置"
                      : "Sync server not configured"}
                </CardDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void refreshAll()}
                  title={preferZh ? "刷新状态" : "Refresh status"}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="gradient"
                  disabled={busy || !configured}
                  onClick={() => void handleTriggerSync()}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", busy && "animate-spin")} />
                  {preferZh ? "立即同步" : "Sync Now"}
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-border/70 bg-background/50 p-3">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{preferZh ? "认证与设备" : "Auth & Device"}</span>
                    <ShieldCheck className="h-3.5 w-3.5 text-primary/80" />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                        BADGE_TONE[authMeta.tone]
                      )}
                    >
                      {authMeta.label}
                    </span>
                  </div>
                  <div
                    className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground"
                    title={status?.device_id || undefined}
                  >
                    {preferZh ? "设备：" : "ID: "}
                    {status?.device_id || "—"}
                  </div>
                </div>

                <div className="rounded-xl border border-border/70 bg-background/50 p-3">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{preferZh ? "本地推送 (Out)" : "Local Push (Out)"}</span>
                    <ArrowUpFromLine className="h-3.5 w-3.5 text-primary/80" />
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums">{outSeq}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">/ {localHwm}</span>
                  </div>
                  <div className="mt-1 text-[11px]">
                    {pendingPush > 0 ? (
                      <span className="font-medium text-amber-600 dark:text-amber-300">
                        {preferZh ? `待推送 ${pendingPush} 条变更` : `${pendingPush} pending push`}
                      </span>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {preferZh ? "本地变更已全部推送" : "All local changes pushed"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-border/70 bg-background/50 p-3">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{preferZh ? "远端拉取 (In)" : "Remote Pull (In)"}</span>
                    <ArrowDownToLine className="h-3.5 w-3.5 text-primary/80" />
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums">{inSeq}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      / v{relayVer}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px]">
                    {pendingPull > 0 ? (
                      <span className="font-medium text-amber-600 dark:text-amber-300">
                        {preferZh
                          ? `服务端领先 ${pendingPull} 个版本`
                          : `${pendingPull} remote version(s) behind`}
                      </span>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {preferZh ? "已拉取到最新游标" : "Caught up with relay"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-border/70 bg-background/50 p-3">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{preferZh ? "最近同步" : "Last Synced"}</span>
                    <Clock className="h-3.5 w-3.5 text-primary/80" />
                  </div>
                  <div
                    className="mt-1.5 truncate text-sm font-medium"
                    title={
                      status?.last_synced_at
                        ? new Date(status.last_synced_at).toLocaleString()
                        : undefined
                    }
                  >
                    {status?.last_synced_at
                      ? formatRelativeTime(status.last_synced_at)
                      : preferZh
                        ? "尚未同步"
                        : "Never"}
                  </div>
                  <div className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
                    {preferZh
                      ? `自动轮询：每 ${status?.interval_seconds ?? "-"} 秒`
                      : `Auto interval: ${status?.interval_seconds ?? "-"}s`}
                  </div>
                </div>
              </div>

              {(status?.last_message || status?.last_error) && (
                <div className="rounded-lg border border-border/60 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
                  {status.last_error ? (
                    <span className="text-red-600 dark:text-red-400">{status.last_error}</span>
                  ) : (
                    <span>{status.last_message}</span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {settingsSlot}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">
              {preferZh ? "冲突记录与逐条复核" : "Object Sync Conflicts"}
            </CardTitle>
            <CardDescription>
              {preferZh
                ? "自动合并保留另一侧内容供逐条比对、确认与恢复。"
                : "Concurrent edits to the same object keep the discarded side for comparison and restore."}
            </CardDescription>
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={unconfirmedOnly}
              onChange={(e) => setUnconfirmedOnly(e.target.checked)}
            />
            {preferZh ? "仅显示未确认" : "Unconfirmed only"}
          </label>
        </CardHeader>
        <CardContent>
          {conflicts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {preferZh ? "暂无冲突记录。" : "No object sync conflicts recorded."}
            </p>
          ) : (
            <div className="space-y-2">
              {conflicts.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5 text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="font-medium">
                      <span className="font-mono">{c.object_type}</span>{" "}
                      <span className="text-muted-foreground">
                        {c.bank_id ? `${c.bank_id}/` : ""}
                        {c.object_id}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      {preferZh ? `保留=${c.resolution}` : `kept=${c.resolution}`} · local@
                      {c.local_device_id}(v
                      {c.local_version}) vs remote@{c.remote_device_id}(v{c.remote_version}) ·{" "}
                      {c.confirmation
                        ? preferZh
                          ? `已确认 (${c.confirmation.by})`
                          : `confirmed (${c.confirmation.by})`
                        : preferZh
                          ? "待确认"
                          : "awaiting review"}
                      {c.restored_side ? ` · restored ${c.restored_side}` : ""}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => void openConflictDetail(c.id)}>
                    {preferZh ? "查看差异 / 恢复" : "Inspect & Resolve"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <details className="rounded-[16px] border border-border bg-card text-card-foreground">
        <summary className="cursor-pointer px-6 py-4">
          <span className="block text-sm font-semibold">
            {preferZh ? "高级：设备管理" : "Advanced: Device Management"}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {preferZh
              ? "仅用于注册、轮换或撤销设备。这里的管理员令牌与服务端登录主密码不同。"
              : "Register, rotate, or revoke devices. This administrator token differs from the sync master password."}
          </span>
        </summary>
        <div className="space-y-4 border-t px-6 py-6">
          <div className="space-y-1">
            <Label htmlFor="sync-admin-token">
              {preferZh ? "中继管理员令牌" : "Relay administrator token"}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="sync-admin-token"
                type="password"
                autoComplete="off"
                value={adminTokenInput}
                onChange={(event) => setAdminTokenInput(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAdminToken(adminTokenInput.trim())}
              >
                {preferZh ? "更新设备列表" : "Update device list"}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1 space-y-1">
              <Label className="text-xs">
                {preferZh ? "注册新设备名称" : "Register new device name"}
              </Label>
              <Input
                value={newDeviceName}
                placeholder="work-laptop"
                onChange={(e) => setNewDeviceName(e.target.value)}
              />
            </div>
            <Button
              size="sm"
              disabled={busy || !adminToken || !newDeviceName.trim()}
              onClick={() => void handleRegisterDevice()}
            >
              {preferZh ? "注册设备" : "Register"}
            </Button>
          </div>

          {provisionedToken && (
            <Alert>
              <KeyRound className="h-4 w-4" />
              <AlertTitle>
                {preferZh
                  ? `设备凭据 (${provisionedToken.device_id}) — 仅显示一次`
                  : `Device token (${provisionedToken.device_id}) — shown once`}
              </AlertTitle>
              <AlertDescription className="font-mono text-xs break-all">
                HINDSIGHT_SYNC_TOKEN={provisionedToken.token}
              </AlertDescription>
            </Alert>
          )}

          {devices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {preferZh
                ? "暂无可列出的已注册设备（或需要管理员令牌）。"
                : "No registered devices listed."}
            </p>
          ) : (
            <div className="space-y-2">
              {devices.map((d) => (
                <div
                  key={d.device_id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5 text-xs"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 font-medium">
                      {d.active ? (
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Ban className="h-3.5 w-3.5 text-red-500" />
                      )}
                      <span>{d.name}</span>
                      <span className="font-mono text-muted-foreground">({d.device_id})</span>
                      {d.device_id === currentDeviceId && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                          {preferZh ? "本机" : "this device"}
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground">
                      {d.active
                        ? `Active · last seen ${d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "never"}`
                        : `Revoked at ${d.revoked_at}`}
                    </div>
                  </div>
                  {d.active && (
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handleRotateDevice(d.device_id)}
                      >
                        <RotateCcw className="mr-1 h-3 w-3" />
                        {preferZh ? "轮换" : "Rotate"}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void handleRevokeDevice(d.device_id)}
                      >
                        {preferZh ? "撤销" : "Revoke"}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </details>

      <Dialog
        open={selectedDetail !== null}
        onOpenChange={(open) => !open && setSelectedDetail(null)}
      >
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {selectedDetail
                ? `${selectedDetail.conflict.object_type}: ${selectedDetail.conflict.object_id}`
                : ""}
            </DialogTitle>
            <DialogDescription>
              {selectedDetail
                ? `Current object version: v${selectedDetail.current_object_version} · Automatically kept: ${selectedDetail.conflict.resolution}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {selectedDetail && (
            <div className="space-y-4">
              <div className="max-h-72 overflow-auto rounded border">
                <table className="w-full table-fixed text-left text-xs">
                  <thead>
                    <tr>
                      <th className="w-1/5 p-2">{preferZh ? "变更字段" : "Changed field"}</th>
                      <th className="p-2">
                        {preferZh ? "本地" : "Local"} · v{selectedDetail.conflict.local_version}
                      </th>
                      <th className="p-2">
                        {preferZh ? "远端" : "Remote"} · v{selectedDetail.conflict.remote_version}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldChanges(
                      selectedDetail.conflict.local_payload,
                      selectedDetail.conflict.remote_payload
                    ).map(({ path, local, remote }) => (
                      <tr key={path} className="border-t align-top">
                        <th className="break-all p-2 font-mono font-normal">{path}</th>
                        {[local, remote].map((value, side) => (
                          <td key={side} className="break-all p-2 font-mono whitespace-pre-wrap">
                            {JSON.stringify(value, null, 2) ?? (preferZh ? "缺失" : "Absent")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">{preferZh ? "审核备注" : "Review note"}</Label>
                <Input
                  value={noteInput}
                  placeholder={preferZh ? "可选：说明为何保留或恢复此版本" : "Optional audit note"}
                  onChange={(e) => setNoteInput(e.target.value)}
                />
              </div>
            </div>
          )}

          <DialogFooter className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void handleConfirm()}>
              {preferZh ? "确认已审阅" : "Confirm Reviewed"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void handleRestore("local")}>
              {preferZh ? "恢复本地版本" : "Restore Local"}
            </Button>
            <Button disabled={busy} onClick={() => void handleRestore("remote")}>
              {preferZh ? "恢复远端版本" : "Restore Remote"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
