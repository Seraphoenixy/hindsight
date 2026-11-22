/**
 * This fork ships the integration README, not the upstream documentation site.
 * Bind install sections to the registry without requiring removed site assets.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { HARNESS_NAMES } from "./harness/registry";

it("documents an install section for every registered harness", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n"
  );
  const sections = readme.split(/^#### /m).slice(1);
  const intro = readme.split("\n").slice(0, 8).join("\n");
  for (const name of HARNESS_NAMES) {
    const installName = name === "antigravity-cli" ? "agy" : name;
    const section = sections.find((s) =>
      s.includes("hindsight-coding-agents install " + installName + "\n")
    );
    expect(section, name).toBeDefined();
    const label = section!.split("\n")[0].replace(/^.*\/> /, "");
    expect(intro, name).toContain("**" + label + "**");
  }
});
