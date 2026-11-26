import { NextRequest, NextResponse } from "next/server";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const response = await fetch(
    `${DATAPLANE_URL}/v1/default/sync/conflicts/${encodeURIComponent(id)}/confirm`,
    {
      method: "POST",
      headers: getDataplaneHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    }
  );
  const data = await response.json().catch(() => ({ error: "Failed to confirm sync conflict" }));
  return NextResponse.json(data, { status: response.status });
}
