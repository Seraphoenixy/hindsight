import { NextRequest, NextResponse } from "next/server";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";

export async function GET(request: NextRequest) {
  const response = await fetch(`${DATAPLANE_URL}/v1/default/sync/devices`, {
    method: "GET",
    headers: getDataplaneHeaders({
      "X-Hindsight-Sync-Admin-Token": request.headers.get("X-Hindsight-Sync-Admin-Token") ?? "",
    }),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({ error: "Failed to list sync devices" }));
  return NextResponse.json(data, { status: response.status });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const response = await fetch(`${DATAPLANE_URL}/v1/default/sync/devices`, {
    method: "POST",
    headers: getDataplaneHeaders({
      "Content-Type": "application/json",
      "X-Hindsight-Sync-Admin-Token": request.headers.get("X-Hindsight-Sync-Admin-Token") ?? "",
    }),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: "Failed to register sync device" }));
  return NextResponse.json(data, { status: response.status });
}
