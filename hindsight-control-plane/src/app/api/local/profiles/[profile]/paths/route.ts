/** `GET /api/local/profiles/<profile>/paths` — on-disk references and URLs. */
import { localRoute } from "@/lib/local-route";
import { getPaths } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => getPaths(profile));
}
