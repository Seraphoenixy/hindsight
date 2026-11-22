#!/usr/bin/env node
/**
 * Start the Next.js dev server on `PORT`, defaulting to 9999.
 *
 * Replaces the inline `-p ${PORT:-9999}` that the npm script used to expand: npm
 * runs a script through `cmd.exe` on Windows, which passes that expression through
 * literally, so `npm run dev` there failed with "'${PORT:-9999}' is not a
 * non-negative number". The default and the empty-PORT case match the shell's
 * `${PORT:-9999}` (default when unset or empty).
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "9999";

const child = spawn(
  process.execPath,
  [require.resolve("next/dist/bin/next"), "dev", "--turbopack", "-p", port],
  {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (err) => {
  console.error("Failed to start the Next.js dev server:", err.message);
  process.exit(1);
});

child.on("close", (code) => process.exit(code ?? 0));
