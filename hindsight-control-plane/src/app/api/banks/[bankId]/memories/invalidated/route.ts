import { NextRequest, NextResponse } from "next/server";
import { localizeApiErrorPayload } from "@/lib/i18n/api-errors";
import { dataplaneBankUrl, getDataplaneHeaders } from "@/lib/hindsight-client";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ bankId: string }> }
) {
  try {
    const { bankId } = await params;

    if (!bankId) {
      return NextResponse.json(
        localizeApiErrorPayload(request, {
          error: "bank_id is required",
          errorKey: "api.errors.validation.bankIdRequired",
        }),
        { status: 400 }
      );
    }

    const query = request.nextUrl.searchParams.toString();
    const url = dataplaneBankUrl(bankId, `/memories/invalidated${query ? `?${query}` : ""}`);
    const response = await fetch(url, {
      method: "DELETE",
      headers: getDataplaneHeaders(),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        localizeApiErrorPayload(request, {
          error: data.detail || "Failed to clear invalidated memories",
          errorKey: "api.errors.memories.delete",
        }),
        { status: response.status }
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    console.error("Error clearing invalidated memories:", error);
    return NextResponse.json(
      localizeApiErrorPayload(request, {
        error: "Failed to clear invalidated memories",
        errorKey: "api.errors.memories.delete",
      }),
      { status: 500 }
    );
  }
}
