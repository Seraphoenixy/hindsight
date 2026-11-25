import { NextRequest } from "next/server";
import { lowLevelClient, sdk } from "@/lib/hindsight-client";
import { respondWithSdk } from "@/lib/sdk-response";

type Params = { params: Promise<{ ruleId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { ruleId } = await params;
  const response = await sdk.restoreWorkingRule({
    client: lowLevelClient,
    path: { rule_id: ruleId },
  });
  return respondWithSdk(response, "Failed to restore working rule", { request });
}
