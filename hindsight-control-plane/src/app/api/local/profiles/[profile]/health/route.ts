/**
 * `GET /api/local/profiles/<profile>/health` — live daemon health.
 *
 * Never cached: the page polls it to show whether the daemon is up, so a stale
 * answer is the one answer that is always wrong.
 */
import { localRoute } from "@/lib/local-route";
import { getHealth } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => getHealth(profile));
}
