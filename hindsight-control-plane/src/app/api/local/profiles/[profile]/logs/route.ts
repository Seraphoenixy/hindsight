/**
 * `GET /api/local/profiles/<profile>/logs` — tail of the profile's daemon or
 * control-plane log.
 *
 * The settings page polls this whenever the log source changes; it is
 * read-only, never cached, and bounded so a crafted request cannot ask the
 * CLI to read an unbounded amount of text.
 */
import { localRoute } from "@/lib/local-route";
import { getLogs } from "@/lib/ops";

export const dynamic = "force-dynamic";

const DEFAULT_LINES = 200;
const MAX_LINES = 5000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  const url = new URL(request.url);
  const requested = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  const lines = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 1), MAX_LINES)
    : DEFAULT_LINES;
  const source = url.searchParams.get("source") === "ui" ? "ui" : "daemon";
  return localRoute(request, () => getLogs(profile, lines, source));
}
