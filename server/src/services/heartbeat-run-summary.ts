import type {
  RunPresentationDecision,
  RunPresentationSource,
} from "@paperclipai/shared";

export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

/** Operator diagnostics are untrusted provider data, not model handoff prose. */
export function summarizeRunErrorForModel(error: string | null, terminalFailureCategory?: unknown): string | null {
  if (terminalFailureCategory == null) return error;
  const category = typeof terminalFailureCategory === "string"
    && ["connection", "access", "limit", "service", "request", "unknown"].includes(terminalFailureCategory)
    ? terminalFailureCategory
    : "unknown";
  return `ACP agent reported a terminal ${category} failure. Provider diagnostics are available in the run record.`;
}

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

/**
 * Splits a message around one `<proposed_plan>` block. The tags must sit on
 * their own lines outside fenced code, so quoting or documenting the tag never
 * creates a proposal.
 */
function splitProposedPlanBlock(value: string): { plan: string | null; rest: string; unclosedStart: number | null } {
  const lines = value.split("\n");
  let fence: string | null = null;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    // Fences are tracked inside the block too, so a fenced example tag in
    // the plan never opens or closes it.
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker) {
      fence = fence === null ? marker[0]! : (trimmed.startsWith(fence) ? null : fence);
      continue;
    }
    if (fence !== null) continue;
    if (start < 0 && /^<proposed_plan>$/i.test(trimmed)) start = index;
    else if (start >= 0 && /^<\/proposed_plan>$/i.test(trimmed)) {
      return {
        plan: lines.slice(start + 1, index).join("\n").trim(),
        rest: [...lines.slice(0, start), ...lines.slice(index + 1)].join("\n").trim(),
        unclosedStart: null,
      };
    }
  }
  // An opening tag outside fences that never closes: a cut-off preview.
  return {
    plan: null,
    rest: value,
    unclosedStart: start < 0 ? null : lines.slice(0, start).join("\n").length,
  };
}

/**
 * Marker the runner appends when it cuts provider text to a run-log display
 * preview. Text ending with it is an incomplete copy, never a final reply.
 */
export const RUN_EVENT_TEXT_BOUND_MARKER = "…[truncated]";

export function isBoundedRunEventText(value: unknown): boolean {
  return typeof value === "string" && value.endsWith(RUN_EVENT_TEXT_BOUND_MARKER);
}

/**
 * The posted reply leaves a proposal to its Plan document. A stored message
 * preview can be cut inside the block; its cut-off remainder is hidden too.
 */
function withoutProposedPlanBlock(value: string): string {
  const { plan, rest, unclosedStart } = splitProposedPlanBlock(value);
  if (plan !== null) return rest;
  if (!isBoundedRunEventText(value) || unclosedStart === null) return value;
  return value.slice(0, unclosedStart).trim();
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

export const RUN_PRESENTATION_RESOLVER_VERSION = "2";
export const CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON =
  "allow_chat_run_presentation";

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
  /** The run log kept only a display preview of this message. */
  bounded?: boolean;
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

function requiresChatOriginProof(source: string): boolean {
  return source === "tool_action_review" || source === "issue.monitor" || source === "native_status_decision" ||
    source.startsWith("issue.comment") || source.startsWith("issue.interaction.") ||
    source === "external_chat.interaction.resolve" || source === "connection_intent.resolved" || source === "issue.update";
}

export function isExternalChatPresentationContext(
  contextSnapshot: unknown,
  verifiedToolReviewChatOrigin = false,
): boolean {
  const context = record(contextSnapshot);
  const wake = record(context.paperclipWake);
  const source =
    typeof context.source === "string" ? context.source.trim() : "";
  // Approvals and Board comments also resume ordinary internal tasks. Only
  // durable source-run or mirrored-comment proof authorizes an external reply.
  if (requiresChatOriginProof(source))
    return verifiedToolReviewChatOrigin;
  return (
    source.startsWith("chat:") ||
    context.externalChatContinuation === true ||
    wake.externalInteractionContinuation === true
  );
}

export function isChatOriginPublicationCandidate(contextSnapshot: unknown): boolean {
  const context = record(contextSnapshot);
  const source = typeof context.source === "string" ? context.source.trim() : "";
  return requiresChatOriginProof(source) || isExternalChatPresentationContext(contextSnapshot);
}

/**
 * Read only completed assistant prose that can participate in final-response
 * presentation. A canonical `final` is authoritative; `unknown` is retained
 * solely for the compatibility fallback selected by the resolver. Other
 * channels and item kinds remain activity, never durable reply candidates.
 */
/**
 * Item ids whose `<proposed_plan>` block became a completed `plan.proposed`
 * event. Only those replies leave the plan to its Plan document.
 */
export function completedPlanProposalIds(rows: readonly { payload: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const payload = record(record(record(row.payload).prpEvent).payload);
    if (payload.status === "completed" && typeof payload.proposalId === "string") {
      ids.add(payload.proposalId);
    }
  }
  return ids;
}

export function readCompletedAssistantMessageCandidate(input: {
  seq: number;
  prpEvent: unknown;
  /** Item ids with a recorded proposal; other replies keep their plan text. */
  proposedItemIds?: ReadonlySet<string>;
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
  // A harness's `<proposed_plan>` block that became a recorded proposal is the
  // task's Plan document and approval card; that reply keeps only the
  // surrounding prose. Without a recorded proposal the reply keeps the plan.
  const itemId = typeof prpEvent.itemId === "string" ? prpEvent.itemId
    : typeof payload.itemId === "string" ? payload.itemId : null;
  const proposed = itemId !== null && input.proposedItemIds?.has(itemId) === true;
  const text = readCommentText(
    typeof payload.text === "string" && proposed ? withoutProposedPlanBlock(payload.text) : payload.text,
  );
  if (!text) return null;
  return {
    seq: input.seq,
    text,
    sourceEventId: readCommentText(prpEvent.sourceEventId),
    channel: payload.channel,
    ...(isBoundedRunEventText(payload.text) ? { bounded: true } : {}),
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

export function readAcceptedTaskContinuationSummary(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  const result = record(resultJson);
  if (result.finalizationPhase !== "committed") return null;
  const kind = result.finalizationReasonCode === "live_continuation_registered" ? "same_agent"
    : ["scheduled_monitor_waiting", "scheduled_monitor_dispatched", "scheduled_monitor_preserved"].includes(String(result.finalizationReasonCode)) ? "monitor" : null;
  if (!kind) return null;
  for (const candidate of semanticResultCandidates(result)) {
    const continuation = record(candidate.continuation);
    if (candidate.schema === "paperclip.run_result.v1" && candidate.reportedWorkDisposition === "yielded" &&
        continuation.kind === kind && readCommentText(continuation.idempotencyKey)) {
      return readCommentText(candidate.summary);
    }
  }
  return null;
}

function readAcceptedExternalChatResponseWakeSummary(
  resultJson: Record<string, unknown>,
  reviewPresentationAuthorized = false,
  committedResponseAuthorized = false,
) {
  const nativeResult = record(resultJson.nativeResult);
  const continuation = record(nativeResult.continuation);
  if (
    resultJson.finalizationPhase !== "committed" ||
    (!committedResponseAuthorized &&
      resultJson.finalizationReasonCode !== "external_chat_response_waiting" &&
      !(
        reviewPresentationAuthorized &&
        resultJson.finalizationReasonCode === "governed_response_waiting"
      )) ||
    nativeResult.schema !== "paperclip.run_result.v1" ||
    nativeResult.reportedWorkDisposition !== "yielded" ||
    continuation.kind !== "response_wake" ||
    !readCommentText(continuation.summary) ||
    !readCommentText(continuation.idempotencyKey)
  ) {
    return null;
  }
  return readCommentText(nativeResult.summary);
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
  /** Server-owned conversation finalization, after normal governance checks. */
  conversationTurnFinished?: boolean;
  existingComment?: { id: string; body?: string | null } | null;
  interactionOwnsResponse?: boolean;
  preferFinalResponseOverExistingComment?: boolean;
  nativeConversationFinalResponse?: boolean;
  externalChatResponseWakeSummaryAuthorized?: boolean;
  /** Server-only proof of the exact accepted response after durable status
   * finalization. Never read this capability from provider/context JSON. */
  externalChatCommittedResponseWakeSummaryAuthorized?: boolean;
  externalChatReviewResponseSummaryAuthorized?: boolean;
  finalAgentMessage?: {
    text: string;
    sourceEventId: string | null;
    channel: "final" | "unknown";
    reasonCode?: string;
    bounded?: boolean;
  } | null;
}): ResolvedHeartbeatRunResponse {
  const resultJson = record(input.resultJson);
  const continuationSummary = readAcceptedTaskContinuationSummary(resultJson);
  if (continuationSummary) {
    if (input.interactionOwnsResponse) return {
      text: null,
      decision: decision("none", { commentAction: "none", reasonCodes: ["interaction_owns_response"] }),
    };
    const existing = input.existingComment;
    const reuse = existing?.body === continuationSummary;
    return {
      text: continuationSummary,
      decision: decision("semantic_result_summary", {
        commentAction: reuse ? "reuse" : "create",
        ...(reuse ? { commentId: existing.id } : {}),
        reasonCodes: [resultJson.finalizationReasonCode === "live_continuation_registered"
          ? "accepted_task_continuation_summary" : "accepted_scheduled_monitor_summary"],
      }),
    };
  }
  const rawFinalAgentText = readCommentText(input.finalAgentMessage?.text);
  // A run-log preview is an incomplete copy of the agent's message. It never
  // outranks a complete source; it is posted only when no complete text exists.
  const boundedFinalAgentText =
    rawFinalAgentText &&
    (input.finalAgentMessage?.bounded === true || isBoundedRunEventText(rawFinalAgentText))
      ? rawFinalAgentText
      : null;
  const finalAgentText = boundedFinalAgentText ? null : rawFinalAgentText;
  const explicitProviderFinal = input.finalAgentMessage?.channel === "final";
  const compatibleTerminalAssistant =
    input.finalAgentMessage?.channel === "unknown";
  const resolveCompletedUpstreamResponse = (allowCompatibility = true) => {
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
      } satisfies ResolvedHeartbeatRunResponse;
    }

    const adapterFinal = readMarkedAdapterFinalResponse(resultJson);
    if (allowCompatibility && adapterFinal) {
      return {
        text: adapterFinal,
        decision: decision("adapter_final_response", {
          commentAction: "create",
          reasonCodes: ["adapter_output_marked_final"],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }

    if (
      allowCompatibility && compatibleTerminalAssistant &&
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
      } satisfies ResolvedHeartbeatRunResponse;
    }

    const semanticSummary = readAcceptedSemanticSummary(resultJson);
    if (semanticSummary) {
      return {
        text: semanticSummary,
        decision: decision("semantic_result_summary", {
          commentAction: "create",
          reasonCodes: boundedFinalAgentText
            ? ["bounded_final_agent_message_replaced_by_semantic_summary"]
            : ["accepted_semantic_result_summary"],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }

    if (boundedFinalAgentText && !isStructuredSemanticResultText(boundedFinalAgentText)) {
      // No complete source exists. The visible marker says the text was cut.
      return {
        text: boundedFinalAgentText,
        decision: decision("final_agent_message", {
          sourceEventId: input.finalAgentMessage?.sourceEventId,
          commentAction: "create",
          reasonCodes: ["bounded_final_agent_message_without_complete_source"],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }

    const legacyText =
      readCommentText(resultJson.summary) ??
      readCommentText(resultJson.result) ??
      readCommentText(resultJson.message);
    if (allowCompatibility && legacyText && !NARRATION_OPENERS.test(legacyText.trimStart())) {
      return {
        text: legacyText,
        decision: decision("adapter_final_response", {
          commentAction: "create",
          reasonCodes: ["legacy_adapter_summary_compatibility"],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }
    return null;
  };

  if (input.preferFinalResponseOverExistingComment === true) {
    if (hasYieldedSemanticResult(resultJson)) {
      const responseWakeSummary =
        input.externalChatResponseWakeSummaryAuthorized === true
          ? readAcceptedExternalChatResponseWakeSummary(
              resultJson,
              input.externalChatReviewResponseSummaryAuthorized === true,
              input.externalChatCommittedResponseWakeSummaryAuthorized === true,
            )
          : null;
      if (responseWakeSummary) {
        return {
          text: responseWakeSummary,
          decision: decision("semantic_result_summary", {
            commentAction: "create",
            reasonCodes: [
              "accepted_external_chat_response_wake_summary",
              "external_chat_final_precedence",
            ],
          }),
        };
      }
      return {
        text: null,
        decision: decision("none", {
          commentAction: "none",
          reasonCodes: ["yielded_control_plane_wait"],
        }),
      };
    }
    const upstream = resolveCompletedUpstreamResponse();
    if (upstream) {
      return {
        ...upstream,
        decision: {
          ...upstream.decision,
          reasonCodes: [
            ...upstream.decision.reasonCodes,
            "external_chat_final_precedence",
          ],
        },
      };
    }
    return {
      text: null,
      decision: decision("none", {
        commentAction: "none",
        reasonCodes: ["external_chat_final_response_unavailable"],
      }),
    };
  }

  const existingText = readCommentText(input.existingComment?.body);
  if (input.nativeConversationFinalResponse) {
    if (input.interactionOwnsResponse || (hasYieldedSemanticResult(resultJson) && !input.conversationTurnFinished)) return {
      text: null,
      decision: decision("none", { commentAction: "none", reasonCodes: ["interaction_owns_conversation_response"] }),
    };
    const final = resolveCompletedUpstreamResponse(false)
      ?? (input.conversationTurnFinished && compatibleTerminalAssistant && finalAgentText
        && !isStructuredSemanticResultText(finalAgentText) ? {
          text: finalAgentText,
          decision: decision("final_agent_message", { sourceEventId: input.finalAgentMessage?.sourceEventId,
            commentAction: "create", reasonCodes: ["server_finished_conversation_terminal_message"] }),
        } : null);
    if (final) {
      const reuse = !!input.existingComment && final.text === existingText;
      return { ...final, decision: { ...final.decision,
        commentAction: reuse ? "reuse" : "create",
        commentId: reuse ? input.existingComment!.id : null,
        reasonCodes: [...final.decision.reasonCodes, "native_conversation_final_precedence"],
      } };
    }
    if (!existingText) return {
      text: null,
      decision: decision("none", { commentAction: "none", reasonCodes: ["native_conversation_final_response_unavailable"] }),
    };
  }
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

  // A governed wait is not a completed assistant turn. Provider adapters may
  // still emit terminal-looking prose while the control plane is yielding for
  // an interaction; keep that prose in activity and let the durable
  // interaction own the visible waiting state.
  if (hasYieldedSemanticResult(resultJson) && !input.conversationTurnFinished) {
    return {
      text: null,
      decision: decision("none", {
        commentAction: "none",
        reasonCodes: ["yielded_control_plane_wait"],
      }),
    };
  }

  const upstream = resolveCompletedUpstreamResponse();
  if (upstream) return upstream;

  const legacyText =
    readCommentText(resultJson.summary) ??
    readCommentText(resultJson.result) ??
    readCommentText(resultJson.message);

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

export function findHeartbeatRunCompletionComment<T extends { id: string; presentation?: unknown }>(
  comments: T[],
  resultJson: Record<string, unknown> | null | undefined,
): T | null {
  const completionComments = comments.filter(comment => record(comment.presentation).kind !== "system_notice");
  const receipts = resultJson?.semanticToolReceipts;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) {
    return completionComments[0] ?? null;
  }

  const generatedCommentIds = new Set<string>();
  for (const receipt of Object.values(receipts)) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      continue;
    const receiptRecord = receipt as Record<string, unknown>;
    const result = receiptRecord.result;
    if (!result || typeof result !== "object" || Array.isArray(result))
      continue;
    const receiptResult = result as Record<string, unknown>;
    if (receiptRecord.operationId === "report_progress") {
      const commentId = receiptResult.commentId;
      if (typeof commentId === "string" && commentId.length > 0) {
        generatedCommentIds.add(commentId);
      }
    } else if (
      receiptRecord.operationId === "register_deliverable" &&
      typeof receiptResult.attachmentId === "string" &&
      receiptResult.commandId === `deliverable-prepared:${receiptResult.attachmentId}` &&
      ["applied", "duplicate"].includes(String(receiptResult.disposition)) &&
      Array.isArray(receiptResult.entityRefs)
    ) {
      // File preparation binds an attachment to a generated comment. That
      // receipt is not the agent's final answer. Use the server-issued entity
      // references, never the comment's wording, to exclude its comment from
      // final-response deduplication. The attachment and binding stay intact.
      for (const ref of receiptResult.entityRefs) {
        if (typeof ref === "string") generatedCommentIds.add(ref);
      }
    }
  }

  return (
    completionComments.find((comment) => !generatedCommentIds.has(comment.id)) ?? null
  );
}
