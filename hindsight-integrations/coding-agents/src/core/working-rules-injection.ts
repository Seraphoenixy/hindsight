import type { WorkingRulesProjection } from "./hindsight";

export const WORKING_RULES_TAG = "hindsight_working_rules";

export function buildWorkingRulesInjection(
  projection: WorkingRulesProjection | undefined,
  previousRevision?: string
): string {
  if (!projection) return "";
  const text = projection.text.trim();
  if (!text && (!previousRevision || previousRevision === projection.revision)) return "";
  const attrs = [
    `revision="${projection.revision}"`,
    `entries="${projection.entries.length}"`,
    ...(projection.truncated ? ['truncated="true"'] : []),
  ].join(" ");
  return (
    `<${WORKING_RULES_TAG} ${attrs}>\n` +
    `This block replaces all earlier Hindsight working rules in this session.\n` +
    (text
      ? `Apply the rules below unless explicitly overridden in the current request. ` +
        `Use hindsight_working_rules to inspect rules or hindsight_manage_working_rules when the user sets, updates, or removes one.\n` +
        `${text}\n`
      : `No standing working rules apply in the current context.\n`) +
    `</${WORKING_RULES_TAG}>`
  );
}

export async function fetchWorkingRulesInjection(
  client: {
    getWorkingRulesProjection?(opts?: {
      timeoutMs?: number;
    }): Promise<WorkingRulesProjection | undefined>;
    workingRulesSupported?: boolean;
  },
  opts: { timeoutMs?: number; previousRevision?: string } = {}
): Promise<{ projection?: WorkingRulesProjection; block: string }> {
  if (!client.getWorkingRulesProjection || client.workingRulesSupported === false) {
    return { block: "" };
  }
  try {
    const projection = await client.getWorkingRulesProjection({
      timeoutMs: opts.timeoutMs ?? 2_000,
    });
    if (!projection) return { block: "" };
    return {
      projection,
      block: buildWorkingRulesInjection(projection, opts.previousRevision),
    };
  } catch {
    return { block: "" };
  }
}
