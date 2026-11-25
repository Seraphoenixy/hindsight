import { NextRequest, NextResponse } from "next/server";
import { lowLevelClient, sdk } from "@/lib/hindsight-client";
import { respondWithSdk } from "@/lib/sdk-response";

type Params = { params: Promise<{ ruleId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { ruleId } = await params;
  const body = await request.json().catch(() => null);
  if (body === null) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const response = await sdk.promoteWorkingRule({
    client: lowLevelClient,
    path: { rule_id: ruleId },
    body,
  });
  return respondWithSdk(response, "Failed to promote working rule", { request });
}
