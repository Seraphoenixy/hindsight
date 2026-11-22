/**
 * Wire constants shared by the local-management routes and the browser client.
 *
 * This module exists so the two halves can agree on a header name WITHOUT the
 * browser half importing the gate. `lib/local-access.ts` reads the ops token
 * through `lib/ops-token.ts`, which spawns `hindsight-embed` — a Node-only path.
 * A `"use client"` component that imported the gate for this one string would
 * pull `node:child_process` into the client bundle, which the bundler rejects
 * (or, worse, fails at runtime in the browser).
 *
 * Keep this file dependency-free. It is imported from both sides of the boundary.
 */

/** Request header carrying the ops token on every `/api/local/*` call. */
export const OPS_TOKEN_HEADER = "x-hindsight-ops-token";
