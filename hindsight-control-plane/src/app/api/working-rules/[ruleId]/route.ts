import { NextRequest, NextResponse } from "next/server";
import { lowLevelClient, sdk } from "@/lib/hindsight-client";
import { respondWithSdk } from "@/lib/sdk-response";

type Params = { params: Promise<{ ruleId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { ruleId } = await params;
  const response = await sdk.getWorkingRule({
    client: lowLevelClient,
    path: { rule_id: ruleId },
  });
  return respondWithSdk(response, "Failed to fetch working rule", { request });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { ruleId } = await params;
  const body = await request.json().catch(() => null);
  if (body === null) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const response = await sdk.updateWorkingRule({
    client: lowLevelClient,
    path: { rule_id: ruleId },
    body,
  });
  return respondWithSdk(response, "Failed to update working rule", { request });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { ruleId } = await params;
  const response = await sdk.deleteWorkingRule({
    client: lowLevelClient,
    path: { rule_id: ruleId },
  });
  return respondWithSdk(response, "Failed to delete working rule", { request });
}
