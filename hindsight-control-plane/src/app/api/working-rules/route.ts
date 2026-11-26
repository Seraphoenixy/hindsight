import { NextRequest, NextResponse } from "next/server";
import { lowLevelClient, sdk } from "@/lib/hindsight-client";
import { respondWithSdk } from "@/lib/sdk-response";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const response = await sdk.listWorkingRules({
    client: lowLevelClient,
    query: {
      include_archived: sp.has("include_archived")
        ? sp.get("include_archived") === "true"
        : undefined,
      q: sp.get("q") ?? undefined,
      limit: sp.has("limit") ? Number(sp.get("limit")) : undefined,
      offset: sp.has("offset") ? Number(sp.get("offset")) : undefined,
    },
  });
  return respondWithSdk(response, "Failed to list working rules", { request });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (body === null) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const response = await sdk.createWorkingRule({ client: lowLevelClient, body });
  return respondWithSdk(response, "Failed to create working rule", { request });
}
