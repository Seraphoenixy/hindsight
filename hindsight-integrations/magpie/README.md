# Hindsight for Magpie

Build with npm run build in ../coding-agents.
Install with: `magpie plugin add <repo-root>/hindsight-integrations/magpie`

Open Plugins → Hindsight. The page shows the management UI's live health, profile,
port, URL, backend health and last check. It refreshes every three seconds.
Start, stop and restart control the management UI through hindsight-embed.
Open management starts it if needed and opens the full UI in the system browser.
Both the management UI and the memory service have independent lifecycles.

The page also connects Hindsight's LLM to Magpie. When the plugin loads, it reads
the model Magpie installed in Codex's config and, if that profile has no manual
LLM settings, writes the Magpie gateway URL, token and model to the profile.
The profile's own LLM settings win; automatic sync never overwrites them. The
first takeover records the replaced values in ~/.hindsight/magpie/llm.json.

Use the model list to follow Magpie's current model or pin one model. Following
re-applies the model whenever Codex's config changes. A running backend picks
up a change with "sync and apply"; otherwise the page reports that a restart is
needed. Automatic sync never restarts a backend.

Loading the plugin only observes state: it does not undo an explicit stop.
Changing the port option (default 18888) requires the host to reload.
The host uses coding-agents configuration, including daemon profile and embed
package paths. Keep each profile's management port distinct.

The full control plane cannot run inside Magpie's sandbox: navigating its frame
retains an opaque origin and breaks storage and API calls. The entry stays in
Magpie, and lifecycle actions use its options bridge. The host publishes only
process metadata through a generated script in the plugin's own asset directory;
no additional HTTP server, CORS exception or ops token is involved.

The generated state script lives in page/.runtime, a hidden directory excluded
from Magpie's source watcher. Updating status therefore does not reload the host.
On Windows, embed uses the existing local WMI process provider when called from
a job-bound plugin host, so the UI survives Magpie's process-tree cleanup. The
broker runs under the current user; no service or scheduled task is installed.
Its one-use environment document is deleted before the UI is launched.

Each click has an exclusive receipt under ~/.hindsight/magpie/requests to prevent
replaying commands after host reloads. Progress and errors appear on the page.
An interrupted host is reported so a new request can be made. Closing Magpie
does not stop the shared Hindsight services. Local desktop / local magpie web only.

DSH provides memory hooks and tools without a sidebar or UI warm-up.
