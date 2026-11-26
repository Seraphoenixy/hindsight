/**
 * `/sync` — multi-device sync: connection, settings, status, conflicts, devices.
 *
 * A server component because the sync settings are local operations: the ops
 * token is read here and handed to the client component, never fetched by the
 * browser. Non-loopback deployments (a hosted control plane) get no token and
 * the page shows only the dataplane-driven manager.
 */
import { headers } from "next/headers";
import { SyncView } from "@/components/sync-view";
import { isLoopbackHostname, requestHostname } from "@/lib/local-access";
import { getOrCreateOpsToken } from "@/lib/ops-token";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const requestHeaders = new Headers(await headers());
  const token = isLoopbackHostname(requestHostname(requestHeaders))
    ? await getOrCreateOpsToken()
    : null;
  return <SyncView token={token} />;
}
