import { NextRequest, NextResponse } from "next/server";
import { DATAPLANE_URL, getDataplaneHeaders } from "@/lib/hindsight-client";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const response = await fetch(
    `${DATAPLANE_URL}/v1/default/sync/devices/${encodeURIComponent(id)}/rotate`,
    {
      method: "POST",
      headers: getDataplaneHeaders({
        "X-Hindsight-Sync-Admin-Token": request.headers.get("X-Hindsight-Sync-Admin-Token") ?? "",
      }),
    }
  );
  const data = await response.json().catch(() => ({ error: "Failed to rotate sync device token" }));
  return NextResponse.json(data, { status: response.status });
}
