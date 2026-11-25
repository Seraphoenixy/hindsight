export type MemoryOrganizationAction = "rewrite" | "archive" | "verify" | "merge";
export type MemoryOrganizationWriteAction = Exclude<MemoryOrganizationAction, "verify">;

/** The fields that determine whether a previewed record is still safe to change. */
export interface MemoryOrganizationRecord {
  id: string;
  text: string;
  tags: string[];
  state: "valid" | "invalidated";
  edited_at: string | null;
  invalidated_at: string | null;
  invalidation_reason: string | null;
}

export interface MemoryOrganizationChange {
  number: number;
  action: MemoryOrganizationAction;
  reason: string;
  record: MemoryOrganizationRecord;
  text?: string;
  target?: MemoryOrganizationRecord;
}

export interface MemoryOrganizationApplyRequestChange extends MemoryOrganizationChange {
  applied?: MemoryOrganizationRecord;
}

export interface MemoryOrganizationPreview {
  preview_id: string;
  records: MemoryOrganizationRecord[];
  changes: MemoryOrganizationChange[];
}

export interface MemoryOrganizationApplyResult {
  number: number;
  ok: boolean;
  error?: string;
  applied?: MemoryOrganizationRecord;
  restored?: MemoryOrganizationRecord;
}

export interface MemoryOrganizationApplyResponse {
  results: MemoryOrganizationApplyResult[];
}
