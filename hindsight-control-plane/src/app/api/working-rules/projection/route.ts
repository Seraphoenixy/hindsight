import { NextRequest } from "next/server";
import { lowLevelClient, sdk } from "@/lib/hindsight-client";
import { respondWithSdk } from "@/lib/sdk-response";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const response = await sdk.getWorkingRulesProjection({
    client: lowLevelClient,
    query: {
      max_chars: sp.has("max_chars") ? Number(sp.get("max_chars")) : undefined,
    },
  });
  return respondWithSdk(response, "Failed to fetch working rules projection", { request });
}
