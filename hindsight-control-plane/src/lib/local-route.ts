/**
 * Shared plumbing for the `/api/local/*` routes.
 *
 * Every route does the same three things: gate the request, run an `ops`
 * command, and answer JSON (or a deployment-shaped error). Keeping them here
 * means a route file only names its command — and a change to the gate or the
 * error envelope cannot reach one route and miss another.
 */
import { NextResponse } from "next/server";
import { authorizeLocalRequest } from "@/lib/local-access";
import { OpsUnavailableError } from "@/lib/ops";

/**
 * Answer 404 for a request that may not use this surface.
 *
 * 404 rather than 401/403 on purpose: the surface should not confirm its own
 * existence to a caller that is not allowed to use it. The reason still travels
 * in the body, which the page renders — it is the one client with a legitimate
 * interest in knowing why.
 */
function deny(decision: { reason?: string; message?: string }): NextResponse {
  return NextResponse.json(
    { error: decision.message ?? "Not available.", reason: decision.reason },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Run a route body behind the gate.
 *
 * `handler` returns the payload; this wraps it in a JSON response with
 * `no-store` (a live control surface must not be served from a cache) and maps
 * a missing embed CLI to a 501 the page explains, since that is a deployment
 * fact rather than a bug.
 */
export async function localRoute<T>(
  request: Request,
  handler: () => Promise<T> | T
): Promise<NextResponse> {
  const decision = await authorizeLocalRequest(request);
  if (!decision.allowed) return deny(decision);

  try {
    const payload = await handler();
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OpsUnavailableError) {
      return NextResponse.json(
        { error: error.message, reason: "ops_unavailable" },
        { status: 501, headers: { "Cache-Control": "no-store" } }
      );
    }
    // The message comes from the ops CLI and names the rejected value (e.g.
    // "HINDSIGHT_LLM_STRICT_SCHEMA must be true or false, got 'yes'"), which is
    // what the user has to act on. Translating it would lose the key.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: message, reason: "ops_failed" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/** Read a JSON body, treating an absent one as an empty object. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
