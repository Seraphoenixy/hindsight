import { loadConfig } from "./core/config";
import { fileURLToPath } from "node:url";
import {
  executeProcessRequest,
  publishProcessState,
  type ProcessRequest,
} from "./core/magpie-process";

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
    // Loading/reloading the plugin only observes. Otherwise a successful stop
    // would be undone by Magpie's next plugin-host restart.
    await publish();
    monitor = setInterval(() => {
      void publish().catch((error) => console.error("Hindsight status:", error));
    }, 3000);
    monitor.unref();
    if (options.processRequest)
      await executeProcessRequest(cfg, port, options.processRequest, stateFile);
    return {};
  },
};
