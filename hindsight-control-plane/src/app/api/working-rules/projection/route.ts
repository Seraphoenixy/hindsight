import { NextRequest } from "next/server";
import { lowLevelClient, sdk } from "@/lib/hindsight-client";
import { respondWithSdk } from "@/lib/sdk-response";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const response = await sdk.getWorkingRulesProjection({
    client: lowLevelClient,
    query: {
      project_id: sp.get("project_id") ?? undefined,
      branch: sp.get("branch") ?? undefined,
      max_chars: sp.has("max_chars") ? Number(sp.get("max_chars")) : undefined,
    },
  });
  return respondWithSdk(response, "Failed to fetch working rules projection", { request });
}
