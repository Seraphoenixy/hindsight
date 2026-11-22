/**
 * Gate for the local-management routes (`/api/local/*`).
 *
 * Those routes are a different kind of surface from the rest of this app. The
 * ordinary routes read and write memory through the dataplane; these write the
 * profile `.env` — which holds the LLM API key — and start or kill local
 * processes. Three conditions therefore have to hold together:
 *
 *   1. **Loopback host.** The control plane binds `0.0.0.0` by default, so the
 *      page is reachable from the LAN. A remote visitor must not reach process
 *      control just because they reached the UI.
 *
 *   2. **The ops token**, issued by `hindsight-embed` and persisted at
 *      `~/.hindsight/ops.token`. It is injected into the page by the server
 *      component that renders it, never fetched by the browser, so a page on
 *      another origin cannot read it (no CORS on HTML) and cannot present it.
 *
 *   3. **A required custom header** carrying that token. A cross-origin request
 *      cannot set a custom header without a CORS preflight, and this app grants
 *      no preflight on these paths — so the header is a second, independent
 *      block on the same attack.
 *
 * A foreign `Origin` is rejected outright as well; it costs nothing and covers
 * the case where a token leaks.
 */
import { OPS_TOKEN_HEADER } from "./local-headers";
import { getOrCreateOpsToken } from "./ops-token";

/**
 * Re-exported for the routes. Defined in `local-headers.ts` so the browser half
 * can import the name without importing this module — which spawns a process.
 */
export { OPS_TOKEN_HEADER };

export interface LocalAccessDecision {
  allowed: boolean;
  /** Machine-readable reason, for the route to include in its JSON. */
  reason?: "loopback_required" | "origin_not_allowed" | "invalid_token" | "token_unavailable";
  /** Human-facing explanation, safe to render. */
  message?: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * Whether a host name refers to this machine.
 *
 * `0.0.0.0` is included because the control plane binds it and a browser on this
 * machine may well spell the URL that way; it is not routable from elsewhere, so
 * a remote client cannot present it as its own Host unless it actually reached
 * this computer.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.trim().toLowerCase());
}

/** The host a request was addressed to: the forwarded original first, then `Host`. */
export function requestHostname(headers: Headers, url?: string): string {
  const forwarded = headers.get("x-forwarded-host");
  const host = forwarded || headers.get("host") || "";
  if (host) {
    // Strip the port. IPv6 literals keep their brackets, which the set carries.
    if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
    return host.split(":")[0];
  }
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

/**
 * Whether an `Origin` header names a loopback page.
 *
 * `undefined` means the header was absent — a non-browser caller such as curl,
 * already running as this user — and is allowed. `"null"` is what a sandboxed
 * iframe or a `file://` page sends; it names no origin this app can vouch for and
 * is rejected.
 */
export function originAllowed(origin: string | null): boolean {
  if (origin === null) return true;
  const trimmed = origin.trim();
  if (!trimmed || trimmed === "null") return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/** Decide whether one request may use the local-management routes. */
export async function authorizeLocalRequest(request: Request): Promise<LocalAccessDecision> {
  const hostname = requestHostname(request.headers, request.url);
  if (!isLoopbackHostname(hostname)) {
    return {
      allowed: false,
      reason: "loopback_required",
      message: "Local management is only available from this machine.",
    };
  }

  if (!originAllowed(request.headers.get("origin"))) {
    return {
      allowed: false,
      reason: "origin_not_allowed",
      message: "Local management accepts only this machine's own pages.",
    };
  }

  const expected = await getOrCreateOpsToken();
  if (!expected) {
    return {
      allowed: false,
      reason: "token_unavailable",
      message:
        "Could not read the ops token from hindsight-embed. Set HINDSIGHT_CP_EMBED_COMMAND to its path.",
    };
  }

  if (!timingSafeEqual(request.headers.get(OPS_TOKEN_HEADER) ?? "", expected)) {
    return {
      allowed: false,
      reason: "invalid_token",
      message: "Missing or invalid ops token.",
    };
  }

  return { allowed: true };
}

/**
 * Compare two strings without an early return on the first differing byte.
 *
 * The token gates local process control, and a length-leaking comparison is the
 * standard way a timing oracle appears. Length is compared first only because it
 * cannot be hidden; the content comparison then runs over the whole string.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
