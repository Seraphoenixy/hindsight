"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { syncConnection } from "@/lib/local-api";

export function SyncConnectionPanel({
  token,
  port,
  preferZh,
  onSaved,
}: {
  token: string;
  port: number;
  preferZh: boolean;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let current = true;
    syncConnection(token, port)
      .then((result) => {
        if (!current) return;
        setUrl(result.relay_url ?? "");
        setDeviceId(result.device_id);
      })
      .catch(() => {
        if (current) {
          setError(
            preferZh
              ? "无法读取同步配置。请确认当前配置档的本地服务已启动并升级。"
              : "Could not read sync settings. Check that this profile's local daemon is running and up to date."
          );
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [token, port, preferZh]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || saving || !url.trim() || !password) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const connection = { relay_url: url.trim(), password };
    setPassword("");
    try {
      const result = await syncConnection(token, port, connection);
      setUrl(result.relay_url ?? "");
      setDeviceId(result.device_id);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{preferZh ? "同步服务端" : "Sync Server"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="sync-relay-url">{preferZh ? "服务端网址" : "Server URL"}</Label>
            <Input
              id="sync-relay-url"
              type="url"
              autoComplete="url"
              placeholder="https://sync.example.com"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setSaved(false);
              }}
              disabled={loading || saving}
              maxLength={2048}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sync-master-password">
              {preferZh ? "同步主密码" : "Sync Master Password"}
            </Label>
            <Input
              id="sync-master-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={loading || saving}
              maxLength={512}
              required
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={loading || saving || !url.trim() || !password}>
              {saving
                ? preferZh
                  ? "正在登录…"
                  : "Signing in…"
                : preferZh
                  ? "登录并保存"
                  : "Sign In and Save"}
            </Button>
            {deviceId && (
              <span className="text-xs text-muted-foreground">
                {preferZh ? "设备 ID" : "Device ID"} <span className="font-mono">{deviceId}</span>
              </span>
            )}
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              {preferZh ? "已登录并保存同步配置。" : "Signed in and saved sync settings."}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
