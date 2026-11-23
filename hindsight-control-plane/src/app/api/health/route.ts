import { NextResponse } from "next/server";
import { createClient, createConfig, sdk } from "@vectorize-io/hindsight-client";
import { getDataplaneHeaders } from "@/lib/hindsight-client";

const HEALTH_CHECK_TIMEOUT_MS = 3000;

export async function GET() {
  const status: {
    status: string;
    service: string;
    dataplane?: {
      status: string;
      url: string;
      error?: string;
    };
  } = {
    status: "ok",
    service: "hindsight-control-plane",
  };

  // Check dataplane connectivity with a short timeout
  const dataplaneUrl = process.env.HINDSIGHT_CP_DATAPLANE_API_URL || "http://localhost:8888";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    const healthClient = createClient(
      createConfig({
        baseUrl: dataplaneUrl,
        signal: controller.signal,
        headers: getDataplaneHeaders(),
      })
    );

    try {
      // A reachability probe, not a listing: ask for the smallest page the
      // endpoint will serve instead of pulling the default 100 banks.
      // The generated SDK defaults to returning `{ error }` instead of
      // throwing, so an unreachable dataplane would otherwise be reported as
      // connected. This probe has to fail loudly.
      await sdk.listBanks({ client: healthClient, query: { limit: 1 }, throwOnError: true });
      status.dataplane = {
        status: "connected",
        url: dataplaneUrl,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    let errorMessage = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "AbortError") {
      errorMessage = `Request timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`;
    }
    status.dataplane = {
      status: "disconnected",
      url: dataplaneUrl,
      error: errorMessage,
    };
  }

  return NextResponse.json(status, { status: 200 });
}
