#!/usr/bin/env bash
set -e

# This checkout ships the TypeScript SDK. Pass an exported OpenAPI file or
# generate one at the default location with scripts/generate-openapi.sh.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENAPI_SPEC="${1:-$PROJECT_ROOT/hindsight-docs/static/openapi.json}"

if [ ! -f "$OPENAPI_SPEC" ]; then
    echo "OpenAPI spec not found: $OPENAPI_SPEC. Run scripts/generate-openapi.sh first." >&2
    exit 1
fi
OPENAPI_SPEC="$(cd "$(dirname "$OPENAPI_SPEC")" && pwd)/$(basename "$OPENAPI_SPEC")"

cd "$PROJECT_ROOT/hindsight-clients/typescript"
npm run generate -- --input "$OPENAPI_SPEC" --no-log-file

# Deno reserves RequestInit.client for its own HTTP client. Drop the SDK's
# internal client field before passing the options to the Request constructor.
node --input-type=module - <<'PATCH_CLIENT'
import { readFileSync, writeFileSync } from "node:fs";

const file = "generated/client/client.gen.ts";
const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const original = `      const requestInit: ReqInit = {
        redirect: "follow",
        ...opts,
        body: getValidRequestBody(opts),
      };`;
const replacement = `      // Exclude hey-api internal fields that conflict with Deno's RequestInit.client
      const { client: _client, ...optsForRequest } = opts as typeof opts & { client?: unknown };
      const requestInit: ReqInit = {
        redirect: "follow",
        ...optsForRequest,
        body: getValidRequestBody(opts),
      };`;

if (!source.includes(original)) {
  throw new Error("Generated client changed. Check the RequestInit patch for Deno.");
}
writeFileSync(file, source.replace(original, replacement));
PATCH_CLIENT
