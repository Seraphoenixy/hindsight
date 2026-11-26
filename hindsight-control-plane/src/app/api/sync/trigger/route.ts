import { NextRequest, NextResponse } from "next/server";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const response = await fetch(`${DATAPLANE_URL}/v1/default/sync/trigger`, {
    method: "POST",
    headers: getDataplaneHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: "Failed to trigger sync" }));
  return NextResponse.json(data, { status: response.status });
}
