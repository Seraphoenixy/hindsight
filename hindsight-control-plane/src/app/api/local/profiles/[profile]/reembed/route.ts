import { localRoute, normalizeOptionalValues, readJsonBody } from "@/lib/local-route";
import { getReembedStatus, startReembed } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => getReembedStatus(profile));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    return startReembed(profile, normalizeOptionalValues(body.values));
  });
}
