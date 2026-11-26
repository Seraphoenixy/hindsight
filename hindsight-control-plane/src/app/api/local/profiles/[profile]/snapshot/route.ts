/**
 * `GET /api/local/profiles/<profile>/snapshot?include=config,settings,...`
 *
 * The page's read model in one call: a page render needs six to eight documents
 * that all describe the same profile, and asking for them separately costs one
 * `hindsight-embed` process each (an interpreter start plus the manager's
 * imports). One process assembles them instead, and the caller chooses the
 * sections so the cheap ones can paint before the diagnostics.
 *
 * `include` is optional (every section) and validated by the CLI, not here: a
 * second copy of the section list would drift from `service.SNAPSHOT_SECTIONS`.
 */
import { localRoute } from "@/lib/local-route";
import { getSnapshot } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  const include = new URL(request.url).searchParams.get("include") ?? undefined;
  return localRoute(request, () => getSnapshot(profile, include));
}
