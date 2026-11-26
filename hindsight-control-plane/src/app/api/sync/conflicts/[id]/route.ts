import { NextRequest, NextResponse } from "next/server";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const response = await fetch(
    `${DATAPLANE_URL}/v1/default/sync/conflicts/${encodeURIComponent(id)}`,
    {
      method: "GET",
      headers: getDataplaneHeaders(),
      cache: "no-store",
    }
  );
  const data = await response.json().catch(() => ({ error: "Failed to fetch sync conflict" }));
  return NextResponse.json(data, { status: response.status });
}
