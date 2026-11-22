import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Options persist across host restarts, so consume each explicit click once. */
export async function openManagementPage(port: number, request?: string): Promise<void> {
  if (!request) return;
  if (!/^\d{13}-[a-z0-9]{6,16}$/.test(request)) throw new Error("Invalid browser request");
  const dir = join(homedir(), ".hindsight", "magpie");
  const marker = join(dir, "opened-request");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if (readFileSync(marker, "utf8") === request) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(marker, request, { mode: 0o600 });
  try {
    // A navigated Magpie frame retains its opaque origin. Open the full UI in
    // a browser with native URL handlers, without a shell or sandbox changes.
    if (process.platform === "win32") {
      await run("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true });
    } else {
      await run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
    }
  } catch (error) {
    unlinkSync(marker);
    throw error;
  }
}
