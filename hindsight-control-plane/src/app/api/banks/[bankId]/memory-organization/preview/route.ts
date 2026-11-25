import { NextRequest, NextResponse } from "next/server";
import {
  MemoryOrganizationError,
  previewMemoryOrganization,
  validateOrganizationInput,
} from "@/lib/memory-organization";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bankId: string }> }
) {
  const { bankId } = await params;
  try {
    const input = validateOrganizationInput(await request.json());
    const preview = await previewMemoryOrganization({ bankId, ...input });
    return NextResponse.json(preview);
  } catch (error) {
    const status = error instanceof MemoryOrganizationError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "Failed to generate memory organization preview.";
    return NextResponse.json({ error: message }, { status });
  }
}
