import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/hindsight-client", async () => {
  const { createClient, createConfig, sdk } = await import("@vectorize-io/hindsight-client");
  return {
    sdk,
    lowLevelClient: createClient(createConfig({ baseUrl: "http://dataplane" })),
  };
});

import { GET as list } from "@/app/api/working-rules/route";
import { GET as exportRules } from "@/app/api/working-rules/export/route";
import { GET as projection } from "@/app/api/working-rules/projection/route";

afterEach(() => vi.restoreAllMocks());

it.each([
  [list, "", "include_archived=true&q=deploy&limit=10&offset=20"],
  [exportRules, "/export", "include_archived=false"],
  [projection, "/projection", "max_chars=1000"],
])("forwards supported working-rule parameters through the real SDK: %s", async (handler, path, query) => {
  const payload = { items: [] };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })
  );
  const response = await handler(
    new NextRequest(
      `http://cp/api/working-rules${path}?${query}&scope=project&project_id=old-project&branch=old-branch`
    )
  );
  const sent = fetchSpy.mock.calls[0][0] as Request;
  const url = new URL(sent.url);
  expect(url.pathname).toBe(`/v1/default/working-rules${path}`);
  expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(new URLSearchParams(query)));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(payload);
});
