/**
 * `GET /api/local/profiles` — every local profile with its daemon status.
 *
 * Behind the local-management gate: see `lib/local-access.ts` for why these
 * routes need both a loopback origin and the ops token.
 */
import { localRoute } from "@/lib/local-route";
import { listProfiles } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return localRoute(request, () => listProfiles());
}
