#!/usr/bin/env node
/**
 * Stage Next's standalone output into `standalone/` — the layout `bin/cli.js`
 * starts (`standalone/server.js`) and the published package ships.
 *
 * Implemented in Node rather than as the shell pipeline it replaced (`rm -rf` /
 * `find` / `cp`): npm runs a script through `cmd.exe` on Windows, where those
 * commands do not exist, so `npm run build` could not produce the package there.
 * The steps are the ones that pipeline performed:
 *
 *   1. drop any previous `standalone/`;
 *   2. copy the directory that holds the first `server.js` found outside a
 *      `node_modules` tree (in a monorepo the app is nested one level down, so
 *      the file is not at `.next/standalone` itself);
 *   3. copy `.next/standalone/node_modules`, `.next/static` and `public/`
 *      alongside it — the traced runtime, the static chunks, and the brand
 *      assets the pages reference.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// next.config.ts scopes distDir by PORT so a dev server on another port does not
// collide on the lock file; a build inherits that, so read the same directory here
// instead of assuming `.next`.
const distDirName =
  process.env.PORT && process.env.PORT !== "9999" ? `.next-${process.env.PORT}` : ".next";
const dist = path.join(packageRoot, distDirName);
const output = path.join(packageRoot, "standalone");

/** First `server.js` under `root`, skipping any `node_modules` tree. */
function findServerJs(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hit = entries.find((entry) => entry.isFile() && entry.name === "server.js");
    if (hit) return path.join(dir, hit.name);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules")
        stack.push(path.join(dir, entry.name));
    }
  }
  return null;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const serverJs = findServerJs(path.join(dist, "standalone"));
if (!serverJs) {
  fail(`server.js not found in ${distDirName}/standalone - standalone build failed`);
}

const tracedModules = path.join(dist, "standalone", "node_modules");
if (!existsSync(tracedModules)) {
  fail(`${distDirName}/standalone/node_modules not found - standalone build failed`);
}

rmSync(output, { recursive: true, force: true });
cpSync(path.dirname(serverJs), output, { recursive: true });
cpSync(tracedModules, path.join(output, "node_modules"), { recursive: true });
mkdirSync(path.join(output, ".next"), { recursive: true });
cpSync(path.join(dist, "static"), path.join(output, ".next", "static"), { recursive: true });

const publicDir = path.join(packageRoot, "public");
if (existsSync(publicDir)) {
  mkdirSync(path.join(output, "public"), { recursive: true });
  cpSync(publicDir, path.join(output, "public"), { recursive: true });
}

console.log(`Staged the standalone server at ${path.join(output, "server.js")}`);
