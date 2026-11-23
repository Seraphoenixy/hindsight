import { loadConfig } from "./core/config";
import { fileURLToPath } from "node:url";
import {
  executeProcessRequest,
  publishProcessState,
  type ProcessRequest,
} from "./core/magpie-process";
import { autoSyncMagpieLlm } from "./core/magpie-llm";

let monitor: ReturnType<typeof setInterval> | undefined;

/** Magpie owns UI startup; harnesses continue to own memory ingestion. */
export default {
  id: "hindsight",
  server: async (
    _input: unknown,
    options: { port?: number; processRequest?: ProcessRequest } = {}
  ) => {
    const port = Number(options.port ?? 19077);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid Hindsight port");
    const cfg = loadConfig({ harness: "magpie" });
    if (monitor) clearInterval(monitor);
    const stateFile = fileURLToPath(new URL("../page/.runtime/state.js", import.meta.url));
    const publish = () => publishProcessState(cfg, port, stateFile, options.processRequest);
    const refresh = async () => {
      // Onboarding is best-effort: an unavailable gateway, a missing embed or a
      // manually configured profile must not stop the process page from loading.
      await autoSyncMagpieLlm(cfg).catch((error) =>
        console.error("Hindsight LLM sync:", error)
      );
      await publish();
    };
    // Loading/reloading the plugin only observes. Otherwise a successful stop
    // would be undone by Magpie's next plugin-host restart. LLM onboarding is
    // the one write: it makes the memory backend usable instead of inventing a
    // server with no model configured.
    await refresh();
    monitor = setInterval(() => {
      // The sync is cached until Codex's config changes; the status probe is not.
      void refresh().catch((error) => console.error("Hindsight status:", error));
    }, 3000);
    monitor.unref();
    if (options.processRequest)
      await executeProcessRequest(cfg, port, options.processRequest, stateFile);
    return {};
  },
};
