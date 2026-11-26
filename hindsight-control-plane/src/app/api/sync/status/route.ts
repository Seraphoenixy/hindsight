import { NextResponse } from "next/server";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";

export async function GET() {
  const response = await fetch(`${DATAPLANE_URL}/v1/default/sync/status`, {
    method: "GET",
    headers: getDataplaneHeaders(),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({ error: "Failed to read sync status" }));
  return NextResponse.json(data, { status: response.status });
}
