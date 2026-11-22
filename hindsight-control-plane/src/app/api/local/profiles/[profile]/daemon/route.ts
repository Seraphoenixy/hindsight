/**
 * `/api/local/profiles/<profile>/daemon` — status, and the lifecycle actions.
 *
 * POST body: `{ action: "start" | "stop" | "restart" }`. A domain failure (the
 * daemon refused to stop, the start produced no listener) comes back as
 * `{ ok: false, message }` with HTTP 200: it is a state for the page to show,
 * not a transport error, and a non-2xx would make the client treat an expected
 * outcome as a crash.
 */
import { localRoute, readJsonBody } from "@/lib/local-route";
import { daemonAction, getDaemonStatus } from "@/lib/ops";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["start", "stop", "restart"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => getDaemonStatus(profile));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    const action = String(body.action ?? "");
    if (!ACTIONS.has(action)) {
      throw new Error(`action must be one of ${[...ACTIONS].join(", ")}, got '${action}'`);
    }
    return daemonAction(profile, action);
  });
}
