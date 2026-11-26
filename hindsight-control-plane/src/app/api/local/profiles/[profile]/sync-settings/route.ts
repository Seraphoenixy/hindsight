/**
 * `/api/local/profiles/<profile>/sync-settings` — the sync page's settings
 * group, read and written on its own.
 *
 * Sync has its own page (see ADR-012): signing in needs the daemon running,
 * while the local settings form is the one place that must work with it
 * stopped. Keeping the two write paths apart is what stops the local form from
 * carrying keys it no longer displays.
 */
import { localRoute, normalizeOptionalValues, readJsonBody } from "@/lib/local-route";
import { getSyncSettings, saveSyncSettings } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => getSyncSettings(profile));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    return saveSyncSettings(profile, normalizeOptionalValues(body.values) ?? {});
  });
}
