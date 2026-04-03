function truncateSummaryText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readStringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArrayField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

export type HeartbeatSemanticOutcome =
  | "done_with_evidence"
  | "blocked_with_unblock_task"
  | "needs_human_decision"
  | "noop_telemetry_only";

export type HeartbeatCostObservation =
  | "reported"
  | "unknown"
  | "subscription_included"
  | "no_usage";

type UsageLike = {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
};

function asFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasTokenUsage(usage: UsageLike | null | undefined) {
  return (
    (asFiniteNumber(usage?.inputTokens) ?? 0) > 0 ||
    (asFiniteNumber(usage?.cachedInputTokens) ?? 0) > 0 ||
    (asFiniteNumber(usage?.outputTokens) ?? 0) > 0
  );
}

function buildSignalText(input: {
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  workspaceWarnings?: string[];
}) {
  const sources: string[] = [];
  const record = input.resultJson;
  if (record) {
    for (const key of ["summary", "result", "message", "error", "stdout", "stderr"] as const) {
      const value = readStringField(record, key);
      if (value) sources.push(value);
    }
  }
  if (input.stdoutExcerpt) sources.push(input.stdoutExcerpt);
  if (input.stderrExcerpt) sources.push(input.stderrExcerpt);
  if (input.workspaceWarnings?.length) sources.push(...input.workspaceWarnings);
  return sources.join("\n").toLowerCase();
}

export function detectHeartbeatLowSignalReasons(input: {
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  workspaceWarnings?: string[];
}) {
  const signalText = buildSignalText(input);
  const reasons: string[] = [];
  if (signalText.includes("using fallback workspace")) reasons.push("fallback_workspace");
  if (signalText.includes("no assigned tasks")) reasons.push("no_assigned_tasks");
  if (signalText.includes("inbox empty")) reasons.push("inbox_empty");
  if (signalText.includes("skip all")) reasons.push("skip_all");
  return [...new Set(reasons)];
}

export function classifyHeartbeatSemanticOutcome(input: {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  issueId?: string | null;
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  workspaceWarnings?: string[];
}) {
  const reasons = detectHeartbeatLowSignalReasons(input);
  const hasFallbackWorkspace = reasons.includes("fallback_workspace");
  const hasNoopSignals = reasons.some((reason) =>
    ["no_assigned_tasks", "inbox_empty", "skip_all"].includes(reason),
  );

  if (hasFallbackWorkspace) {
    return {
      semanticOutcome: (input.issueId ? "blocked_with_unblock_task" : "needs_human_decision") as HeartbeatSemanticOutcome,
      lowSignalReasons: reasons,
    };
  }

  if (hasNoopSignals) {
    return {
      semanticOutcome: "noop_telemetry_only" as HeartbeatSemanticOutcome,
      lowSignalReasons: reasons,
    };
  }

  if (input.status === "failed" || input.status === "timed_out") {
    return {
      semanticOutcome: (input.issueId ? "blocked_with_unblock_task" : "needs_human_decision") as HeartbeatSemanticOutcome,
      lowSignalReasons: reasons,
    };
  }

  if (input.status === "cancelled") {
    return {
      semanticOutcome: "needs_human_decision" as HeartbeatSemanticOutcome,
      lowSignalReasons: reasons,
    };
  }

  return {
    semanticOutcome: "done_with_evidence" as HeartbeatSemanticOutcome,
    lowSignalReasons: reasons,
  };
}

export function classifyHeartbeatCostObservation(input: {
  billingType?: string | null;
  costUsd?: number | null;
  usage?: UsageLike | null;
}) {
  if ((input.billingType ?? null) === "subscription_included") {
    return "subscription_included" as HeartbeatCostObservation;
  }
  if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd)) {
    return "reported" as HeartbeatCostObservation;
  }
  if (hasTokenUsage(input.usage)) {
    return "unknown" as HeartbeatCostObservation;
  }
  return "no_usage" as HeartbeatCostObservation;
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  const semanticOutcome = readStringField(resultJson, "semanticOutcome");
  if (semanticOutcome) {
    summary.semanticOutcome = semanticOutcome;
  }

  const costObservation = readStringField(resultJson, "costObservation");
  if (costObservation) {
    summary.costObservation = costObservation;
  }

  if (typeof resultJson.costObserved === "boolean") {
    summary.costObserved = resultJson.costObserved;
  }

  const lowSignalReasons = readStringArrayField(resultJson, "lowSignalReasons");
  if (lowSignalReasons.length > 0) {
    summary.lowSignalReasons = lowSignalReasons.slice(0, 4);
  }

  const workspaceWarnings = readStringArrayField(resultJson, "workspaceWarnings");
  if (workspaceWarnings.length > 0) {
    summary.workspaceWarnings = workspaceWarnings.slice(0, 3).map((warning) => truncateSummaryText(warning, 180));
  }

  return Object.keys(summary).length > 0 ? summary : null;
}
