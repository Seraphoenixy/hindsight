/**
 * `/api/local/profiles/<profile>/env` — the profile's raw `.env`, verbatim.
 *
 * Read returns the file including the API key: this is a local, single-user
 * surface behind two gates (loopback origin + ops token), and a raw editor that
 * masked the key could not round-trip it. Write accepts the whole file, so the
 * editor and the settings form stay interchangeable.
 */
import { localRoute, readJsonBody } from "@/lib/local-route";
import { getEnvFile, writeEnvFile } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => getEnvFile(profile));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, async () => {
    const body = await readJsonBody(request);
    const content = body.content;
    if (typeof content !== "string") {
      throw new Error("content must be a string");
    }
    return writeEnvFile(profile, content);
  });
}
