#!/bin/bash
set -e

# Export the schema locally for the TypeScript SDK, with no model credentials.

PROJECT_DIR="$(cd "$(dirname "$0")/../hindsight-dev" && pwd)"
export HINDSIGHT_API_LLM_PROVIDER=${HINDSIGHT_API_LLM_PROVIDER:-mock}
if [ "$#" -gt 0 ]; then
    uv run --project "$PROJECT_DIR" python -m hindsight_dev.generate_openapi "$1"
else
    uv run --project "$PROJECT_DIR" generate-openapi
fi
