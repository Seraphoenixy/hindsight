import { NextRequest, NextResponse } from "next/server";
import {
  applyMemoryOrganization,
  MemoryOrganizationError,
  validateOrganizationApplyBody,
} from "@/lib/memory-organization";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bankId: string }> }
) {
  const { bankId } = await params;
  try {
    const body = validateOrganizationApplyBody(await request.json());
    const response = await applyMemoryOrganization({ bankId, ...body });
    return NextResponse.json(response);
  } catch (error) {
    const status = error instanceof MemoryOrganizationError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "Failed to apply memory organization changes.";
    return NextResponse.json({ error: message }, { status });
  }
}
