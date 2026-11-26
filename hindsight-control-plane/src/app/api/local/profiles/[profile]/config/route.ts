/**
 * `/api/local/profiles/<profile>/config` — the editable non-catalog settings:
 * ports and per-profile component version pins, plus the LLM fields as optional
 * inputs.
 *
 * The LLM provider/key/model are written by the settings route; a POST here
 * leaves them untouched unless a field is present, which is what lets the
 * ports form save without restating (and possibly clobbering) them.
 */
import { localRoute, readJsonBody } from "@/lib/local-route";
import { saveConfig, type SaveConfigRequest } from "@/lib/ops";

export const dynamic = "force-dynamic";

const STRING_FIELDS = [
  "provider",
  "api_key",
  "model",
  "base_url",
  "api_port",
  "ui_port",
  "api_version",
  "cp_version",
] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    // Only carry the fields the caller actually sent: an absent field means
    // "leave it alone", and the CLI distinguishes absent (undefined) from ""
    // (clear), so inventing an empty string here would erase stored values.
    const payload: SaveConfigRequest = {};
    for (const field of STRING_FIELDS) {
      const value = body[field];
      if (value === undefined) continue;
      payload[field] = value === null ? "" : String(value);
    }
    return saveConfig(profile, payload);
  });
}
