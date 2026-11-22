/**
 * `/local` — this machine's profile settings and daemon control.
 *
 * A SERVER component, which is the whole reason this page exists as a file
 * separate from its panel: the ops token is read here, server-side, and handed
 * to the client component as a prop. The browser never fetches the token, so a
 * page on another origin cannot read it (no CORS on server-rendered HTML) and
 * the cookie-less CSRF route is closed as well.
 *
 * Deliberately outside the memory-bank routes: this page is not about a bank,
 * it is about the stack that serves them.
 */
import { getOrCreateOpsToken } from "@/lib/ops-token";
import { resolveEmbedCommand } from "@/lib/ops";
import { LocalSettingsPanel } from "@/components/local-settings-panel";

export const dynamic = "force-dynamic";

export default async function LocalPage() {
  const token = await getOrCreateOpsToken();
  return <LocalSettingsPanel token={token} embedCommand={resolveEmbedCommand().join(" ")} />;
}
