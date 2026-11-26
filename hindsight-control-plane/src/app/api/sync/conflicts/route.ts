import { NextRequest, NextResponse } from "next/server";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";

export async function GET(request: NextRequest) {
  const qs = request.nextUrl.searchParams.toString();
  const url = `${DATAPLANE_URL}/v1/default/sync/conflicts${qs ? `?${qs}` : ""}`;
  const response = await fetch(url, {
    method: "GET",
    headers: getDataplaneHeaders(),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({ error: "Failed to list sync conflicts" }));
  return NextResponse.json(data, { status: response.status });
}
