/**
 * `/api/local/profiles/<profile>/settings` — read the grouped settings catalog
 * and write back the form's values.
 *
 * The body of a POST is `{ values: { ENV_KEY: "value" } }`. Only keys the
 * catalog owns are accepted (the CLI rejects the rest), and an empty value
 * removes the key so the daemon falls back to its own default.
 */
import { localRoute, normalizeOptionalValues, readJsonBody } from "@/lib/local-route";
import { getSettings, saveSettings } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => getSettings(profile));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    return saveSettings(profile, normalizeOptionalValues(body.values) ?? {});
  });
}
