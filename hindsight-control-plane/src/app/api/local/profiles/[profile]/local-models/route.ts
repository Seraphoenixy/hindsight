import { localRoute, readJsonBody } from "@/lib/local-route";
import { downloadLocalModel, getLocalModels } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => getLocalModels(profile));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    if (typeof body.model !== "string" || !body.model.trim()) {
      throw new Error("model must be a non-empty string");
    }
    return downloadLocalModel(profile, body.model.trim());
  });
}
