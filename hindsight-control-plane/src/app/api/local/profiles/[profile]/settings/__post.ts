/**
 * `POST /api/local/profiles/<profile>/settings` — write grouped settings values.
 *
 * The body is `{ values: { ENV_KEY: "value" } }`. Only keys the catalog owns are
 * accepted (the CLI rejects the rest), and an empty value removes the key so the
 * daemon falls back to its own default.
 */
import { localRoute, readJsonBody } from "@/lib/local-route";
import { saveSettings } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    const values = body.values;
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("values must be an object of env-var name -> string");
    }
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      normalized[key] = value === null || value === undefined ? "" : String(value);
    }
    return saveSettings(profile, normalized);
  });
}
