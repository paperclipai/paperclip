import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export type CursorCostMetadata = {
  costSource: "cursor_usage_api" | "paperclip_pricing_fallback" | "unknown";
  costEstimated: boolean;
  cursorAgentId?: string;
  cursorRunId?: string;
  prUrl?: string;
};

export function buildCursorCostMetadata(
  result: AdapterExecutionResult,
): CursorCostMetadata | null {
  const resultJson = result.resultJson;
  if (!resultJson || typeof resultJson !== "object") return null;
  const record = resultJson as Record<string, unknown>;
  const costSource = record.costSource;
  if (
    costSource !== "cursor_usage_api"
    && costSource !== "paperclip_pricing_fallback"
    && costSource !== "unknown"
  ) {
    return null;
  }
  return {
    costSource,
    costEstimated: record.costEstimated === true,
    cursorAgentId: typeof record.cursorAgentId === "string" ? record.cursorAgentId : undefined,
    cursorRunId: typeof record.cursorRunId === "string" ? record.cursorRunId : undefined,
    prUrl: typeof record.prUrl === "string" ? record.prUrl : undefined,
  };
}

export function mergeCursorCostIntoResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  metadata: CursorCostMetadata | null,
): Record<string, unknown> | null {
  if (!metadata) return resultJson ?? null;
  return {
    ...(resultJson ?? {}),
    costMetadata: metadata,
  };
}
