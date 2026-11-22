import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("DSH memory-only packaging", () => {
  it("keeps the host patch without publishing a browser client", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(manifest.dsh.client).toBeUndefined();
    expect(manifest.exports["./client"]).toBeUndefined();
    expect(manifest.exports["./dsh/client"]).toBeUndefined();
  });
});
