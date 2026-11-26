import { localRoute, normalizeOptionalValues, readJsonBody } from "@/lib/local-route";
import { resetLocalMemories } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    return resetLocalMemories(profile, normalizeOptionalValues(body.values));
  });
}
