/**
 * `POST /api/local/profiles/<profile>/models` — ask the provider which models
 * its API currently serves.
 *
 * The body is `{ provider?, api_key?, base_url? }`, carrying the Settings form's
 * unsaved values. An omitted/null `api_key` means "use the saved key"; a string
 * (including "") is used exactly as sent, so a user can test a new key without
 * persisting it or clearing one without losing the saved value first. Nothing is
 * written. The provider call lives in `hindsight-embed ops models`.
 */
import { localRoute, readJsonBody } from "@/lib/local-route";
import { listModels } from "@/lib/ops";

export const dynamic = "force-dynamic";

function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string or null`);
  return value;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    return listModels(profile, {
      provider: optionalString(body, "provider"),
      api_key: optionalString(body, "api_key"),
      base_url: optionalString(body, "base_url"),
    });
  });
}
