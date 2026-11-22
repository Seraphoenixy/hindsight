import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Prettier defaults to `endOfLine: "lf"`. Git for Windows installs
// `core.autocrlf=true`, so a Windows worktree is CRLF while the committed blobs
// are LF; with the default, every `prettier --write` rewrites the whole package
// to LF and `git status` reports hundreds of files whose diff is empty. That
// buries the files actually changed and makes the lint gate unusable locally.
//
// Both configs must say `auto`, which keeps each file's existing line endings:
// a CRLF worktree stays CRLF, CI's LF worktree stays LF, and the formatting that
// is enforced (spacing, quotes, wrapping) is identical on both.
//
// Asserted from the config files because a regression here produces no failing
// code path — it silently rewrites the tree.
const CONFIGS = [
  fileURLToPath(new URL("../../.prettierrc.json", import.meta.url)),
  fileURLToPath(new URL("../../hindsight-control-plane/.prettierrc", import.meta.url)),
];

describe("prettier end-of-line policy", () => {
  it.each(CONFIGS)("%s pins endOfLine to auto", (path) => {
    const config = JSON.parse(readFileSync(path, "utf8")) as { endOfLine?: string };

    expect(config.endOfLine).toBe("auto");
  });
});
