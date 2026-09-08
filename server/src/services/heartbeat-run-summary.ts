import type {
  RunPresentationDecision,
  RunPresentationSource,
} from "@paperclipai/shared";

export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

function truncateSummaryText(
  value: unknown,
  maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS,
) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? (record[key] ?? null) : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (
    !resultJson ||
    typeof resultJson !== "object" ||
    Array.isArray(resultJson)
  ) {
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

  const numericFieldAliases = [
    "total_cost_usd",
    "cost_usd",
    "costUsd",
  ] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

// An untyped adapter summary can be raw inter-tool narration (assistantTexts
// concatenated by the adapter), which must never be published verbatim to the
// board — see BRO-1507 / BRO-1516. Typed final messages and accepted PRP results
// are semantic output, so they intentionally bypass this legacy safety check.
// Apostrophes are matched as a character class so both the straight (') and
// curly (’) forms count — agents emit either. Openers are narration phrases a
// declarative status summary would not begin with ("Fixed X", "13/13 pass").
const NARRATION_OPENERS =
  /^(let me\b|i['’]ll\b|i['’]m going\b|i need to\b|i can see\b|now i['’]ll\b|next,? i['’]ll\b|looking at\b|fetching\b|checking\b|first,)/i;

export const LEGACY_WITHHELD_RUN_COMMENT =
  "Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).";

export const RUN_PRESENTATION_RESOLVER_VERSION = "1";

export type RunPresentationCommentAction = "reuse" | "create" | "none";
export type { RunPresentationDecision } from "@paperclipai/shared";

export interface ResolvedHeartbeatRunResponse {
  text: string | null;
  decision: RunPresentationDecision;
}

export interface CompletedFinalAgentMessageCandidate {
  seq: number;
  text: string;
  sourceEventId: string | null;
  channel: "final" | "unknown";
}

/**
 * A bounded native retry can exist solely because a completed provider turn
 * omitted its semantic result. In that case the retry is a disposition-only
 * recovery turn: prose it emits must not displace the real final response
 * already produced by the completed work turn. The boundary is protocol
 * state, not a length heuristic or narration regex.
 */
export function selectHeartbeatRunFinalAgentMessage(input: {
  candidates: CompletedFinalAgentMessageCandidate[];
  semanticResultRecoveryAfterSeq?: number | null;
}): (CompletedFinalAgentMessageCandidate & { reasonCode: string }) | null {
  const candidates = [...input.candidates].sort((a, b) => b.seq - a.seq);
  if (candidates.length === 0) return null;
  const boundary = input.semanticResultRecoveryAfterSeq;
  const preRecovery =
    typeof boundary === "number"
      ? candidates.filter((candidate) => candidate.seq < boundary)
      : [];
  const eligible = preRecovery.length > 0 ? preRecovery : candidates;
  const selected =
    eligible.find((candidate) => candidate.channel === "final") ??
    eligible.find((candidate) => candidate.channel === "unknown");
  if (!selected) return null;
  const beforeRecovery = preRecovery.includes(selected);
  return {
    ...selected,
    reasonCode:
      selected.channel === "final"
        ? beforeRecovery
          ? "pre_semantic_result_recovery_final_agent_message"
          : "latest_non_empty_completed_final_agent_message"
        : beforeRecovery
          ? "pre_semantic_result_recovery_terminal_assistant_message"
          : "latest_non_empty_completed_terminal_assistant_message",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read only completed assistant prose that can participate in final-response
 * presentation. A canonical `final` is authoritative; `unknown` is retained
 * solely for the compatibility fallback selected by the resolver. Other
 * channels and item kinds remain activity, never durable reply candidates.
 */
export function readCompletedAssistantMessageCandidate(input: {
  seq: number;
  prpEvent: unknown;
}): CompletedFinalAgentMessageCandidate | null {
  const prpEvent = record(input.prpEvent);
  const payload = record(prpEvent.payload);
  // `assistant_message` is the shipped PRP v1 spelling used by older replay
  // fixtures and persisted native runs. New providers emit `agentMessage`,
  // but both represent the same canonical assistant item at this boundary.
  if (payload.kind !== "agentMessage" && payload.kind !== "assistant_message") {
    return null;
  }
  if (payload.channel !== "final" && payload.channel !== "unknown") {
    return null;
  }
  const text = readCommentText(payload.text);
  if (!text) return null;
  return {
    seq: input.seq,
    text,
    sourceEventId: readCommentText(prpEvent.sourceEventId),
    channel: payload.channel,
  };
}

function readAcceptedSemanticSummary(resultJson: Record<string, unknown>) {
  const candidates = semanticResultCandidates(resultJson);
  for (const candidate of candidates) {
    if (candidate.schema !== "paperclip.run_result.v1") continue;
    // A yielded result is a control-plane liveness fact, not a final assistant
    // response. Its summary belongs in diagnostics/system state while the
    // durable interaction card remains the user-facing surface.
    if (candidate.reportedWorkDisposition === "yielded") continue;
    const summary = readCommentText(candidate.summary);
    if (summary) return summary;
  }
  return null;
}

function semanticResultCandidates(resultJson: Record<string, unknown>) {
  return [
    record(resultJson.nativeResult),
    record(resultJson.acceptedResult),
    record(record(resultJson.semanticResult).result),
  ];
}

export function hasAcceptedSemanticResult(
  resultJson: Record<string, unknown> | null | undefined,
) {
  return semanticResultCandidates(record(resultJson)).some(
    (candidate) => candidate.schema === "paperclip.run_result.v1",
  );
}

function hasYieldedSemanticResult(resultJson: Record<string, unknown>) {
  return semanticResultCandidates(resultJson).some(
    (candidate) =>
      candidate.schema === "paperclip.run_result.v1" &&
      candidate.reportedWorkDisposition === "yielded",
  );
}

export function projectHistoricalHeartbeatRunComment(
  body: string,
  resultJson: Record<string, unknown> | null | undefined,
) {
  if (body !== LEGACY_WITHHELD_RUN_COMMENT) return body;
  return readAcceptedSemanticSummary(record(resultJson)) ?? body;
}

function readMarkedAdapterFinalResponse(resultJson: Record<string, unknown>) {
  const structured = record(resultJson.finalResponse);
  if (structured.disposition === "final" || structured.final === true) {
    return (
      readCommentText(structured.text) ?? readCommentText(structured.message)
    );
  }
  if (resultJson.finalResponseDisposition === "final") {
    return (
      readCommentText(resultJson.finalResponseText) ??
      readCommentText(resultJson.finalResponse)
    );
  }
  return null;
}

function isStructuredSemanticResultText(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).schema === "paperclip.run_result.v1",
    );
  } catch {
    return false;
  }
}

function decision(
  chosenSource: RunPresentationSource,
  input: {
    sourceEventId?: string | null;
    commentAction: RunPresentationCommentAction;
    commentId?: string | null;
    reasonCodes: string[];
  },
): RunPresentationDecision {
  return {
    schema: "paperclip.run_presentation_decision.v1",
    resolverVersion: RUN_PRESENTATION_RESOLVER_VERSION,
    chosenSource,
    sourceEventId: input.sourceEventId ?? null,
    commentAction: input.commentAction,
    commentId: input.commentId ?? null,
    activityDisposition: "collapse",
    reasonCodes: input.reasonCodes,
  };
}

/**
 * Resolve durable user-facing prose independently from the semantic run status.
 * The returned text is never truncated. Callers may persist only the bounded
 * decision record and materialize the exact text as an issue comment.
 */
export function resolveHeartbeatRunResponse(input: {
  resultJson: Record<string, unknown> | null | undefined;
  existingComment?: { id: string; body?: string | null } | null;
  finalAgentMessage?: {
    text: string;
    sourceEventId: string | null;
    channel: "final" | "unknown";
    reasonCode?: string;
  } | null;
}): ResolvedHeartbeatRunResponse {
  const existingText = readCommentText(input.existingComment?.body);
  if (input.existingComment && existingText) {
    return {
      text: existingText,
      decision: decision("existing_issue_comment", {
        commentAction: "reuse",
        commentId: input.existingComment.id,
        reasonCodes: ["explicit_non_progress_comment_precedence"],
      }),
    };
  }

  const resultJson = record(input.resultJson);
  // A governed wait is not a completed assistant turn. Provider adapters may
  // still emit terminal-looking prose while the control plane is yielding for
  // an interaction; keep that prose in activity and let the durable
  // interaction own the visible waiting state.
  if (hasYieldedSemanticResult(resultJson)) {
    return {
      text: null,
      decision: decision("none", {
        commentAction: "none",
        reasonCodes: ["yielded_control_plane_wait"],
      }),
    };
  }

  const finalAgentText = readCommentText(input.finalAgentMessage?.text);
  const explicitProviderFinal = input.finalAgentMessage?.channel === "final";
  const compatibleTerminalAssistant =
    input.finalAgentMessage?.channel === "unknown";
  if (
    explicitProviderFinal &&
    finalAgentText &&
    !isStructuredSemanticResultText(finalAgentText)
  ) {
    return {
      text: finalAgentText,
      decision: decision("final_agent_message", {
        sourceEventId: input.finalAgentMessage?.sourceEventId,
        commentAction: "create",
        reasonCodes: [
          input.finalAgentMessage?.reasonCode ??
            "latest_non_empty_completed_final_agent_message",
        ],
      }),
    };
  }

  const adapterFinal = readMarkedAdapterFinalResponse(resultJson);
  if (adapterFinal) {
    return {
      text: adapterFinal,
      decision: decision("adapter_final_response", {
        commentAction: "create",
        reasonCodes: ["adapter_output_marked_final"],
      }),
    };
  }

  if (
    compatibleTerminalAssistant &&
    finalAgentText &&
    !isStructuredSemanticResultText(finalAgentText)
  ) {
    return {
      text: finalAgentText,
      decision: decision("final_agent_message", {
        sourceEventId: input.finalAgentMessage?.sourceEventId,
        commentAction: "create",
        reasonCodes: [
          input.finalAgentMessage?.reasonCode ??
            "latest_non_empty_completed_terminal_assistant_message",
        ],
      }),
    };
  }

  const semanticSummary = readAcceptedSemanticSummary(resultJson);
  if (semanticSummary) {
    return {
      text: semanticSummary,
      decision: decision("semantic_result_summary", {
        commentAction: "create",
        reasonCodes: ["accepted_semantic_result_summary"],
      }),
    };
  }

  const legacyText =
    readCommentText(resultJson.summary) ??
    readCommentText(resultJson.result) ??
    readCommentText(resultJson.message);
  if (legacyText && !NARRATION_OPENERS.test(legacyText.trimStart())) {
    return {
      text: legacyText,
      decision: decision("adapter_final_response", {
        commentAction: "create",
        reasonCodes: ["legacy_adapter_summary_compatibility"],
      }),
    };
  }

  return {
    text: null,
    decision: decision("none", {
      commentAction: "none",
      reasonCodes: legacyText
        ? ["legacy_adapter_summary_ambiguous"]
        : ["no_user_facing_response"],
    }),
  };
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  return resolveHeartbeatRunResponse({ resultJson }).text;
}

export function findHeartbeatRunCompletionComment<T extends { id: string }>(
  comments: T[],
  resultJson: Record<string, unknown> | null | undefined,
): T | null {
  const receipts = resultJson?.semanticToolReceipts;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) {
    return comments[0] ?? null;
  }

  const progressCommentIds = new Set<string>();
  for (const receipt of Object.values(receipts)) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      continue;
    const receiptRecord = receipt as Record<string, unknown>;
    if (receiptRecord.operationId !== "report_progress") continue;
    const result = receiptRecord.result;
    if (!result || typeof result !== "object" || Array.isArray(result))
      continue;
    const commentId = (result as Record<string, unknown>).commentId;
    if (typeof commentId === "string" && commentId.length > 0) {
      progressCommentIds.add(commentId);
    }
  }

  return (
    comments.find((comment) => !progressCommentIds.has(comment.id)) ?? null
  );
}
