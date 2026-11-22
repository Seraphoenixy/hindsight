/**
 * `POST /api/local/profiles/<profile>/delete` — stop the profile's processes,
 * then remove it.
 *
 * A refused delete (the default profile, or a process that would not stop) is a
 * 200 with `{ ok: false, message }`: the profile is still there, which is a state
 * the page has to display, not a transport failure.
 */
import { localRoute } from "@/lib/local-route";
import { deleteProfile } from "@/lib/ops";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ profile: string }> }
): Promise<Response> {
  const { profile } = await params;
  return localRoute(request, () => deleteProfile(profile));
}
