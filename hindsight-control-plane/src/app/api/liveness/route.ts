/**
 * `GET /api/liveness` — is this control-plane process serving?
 *
 * Deliberately separate from `/api/health`: health asks the dataplane whether
 * it is connected, and that request can be slow or fail while the panel itself
 * is perfectly usable. Launchers poll this route to decide when the panel is
 * ready to open, so it must answer immediately and never depend on the
 * backend. It is process-only, read-only and uncached.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { status: "ok", service: "hindsight-control-plane" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
