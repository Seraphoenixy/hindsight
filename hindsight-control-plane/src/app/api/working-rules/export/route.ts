import { NextRequest } from "next/server";
import { lowLevelClient, sdk } from "@/lib/hindsight-client";
import { respondWithSdk } from "@/lib/sdk-response";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const rawScope = sp.get("scope");
  const scope = rawScope === "global" || rawScope === "project" ? rawScope : undefined;
  const response = await sdk.exportWorkingRules({
    client: lowLevelClient,
    query: {
      scope,
      project_id: sp.get("project_id") ?? undefined,
      include_archived: sp.has("include_archived")
        ? sp.get("include_archived") === "true"
        : undefined,
    },
  });
  return respondWithSdk(response, "Failed to export working rules", { request });
}
