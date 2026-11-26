export interface RecallCandidate {
  text: string;
  state?: string;
  mentioned_at?: string | null;
  scores?: { semantic?: number | null; keyword?: number | null };
}

export function selectRecallCandidates<Candidate extends RecallCandidate>(
  records: Candidate[],
  minSimilarity = 0.5
): Candidate[] {
  return records
    .filter(
      (record) =>
        record.text.trim() &&
        (!record.state || record.state === "valid") &&
        ((record.scores?.semantic ?? -1) >= minSimilarity || (record.scores?.keyword ?? 0) > 0)
    )
    .sort(
      (left, right) =>
        (right.scores?.semantic ?? 0) - (left.scores?.semantic ?? 0) ||
        (right.scores?.keyword ?? 0) - (left.scores?.keyword ?? 0) ||
        (Date.parse(right.mentioned_at ?? "") || 0) - (Date.parse(left.mentioned_at ?? "") || 0)
    );
}
