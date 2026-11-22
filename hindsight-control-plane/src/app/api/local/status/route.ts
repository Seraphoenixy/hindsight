/**
 * `GET /api/local/status` — whether local management is usable here, and how.
 *
 * The page calls this first so a disabled page explains itself instead of every
 * panel failing with the same opaque error. It reports the gate's decision and
 * the resolved `hindsight-embed` command, never a credential.
 */
import { NextResponse } from "next/server";
import { authorizeLocalRequest } from "@/lib/local-access";
import { resolveEmbedCommand } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const decision = await authorizeLocalRequest(request);
  return NextResponse.json(
    {
      available: decision.allowed,
      reason: decision.reason ?? null,
      message: decision.message ?? null,
      embed_command: resolveEmbedCommand().join(" "),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
