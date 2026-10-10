import { createCursorProfileExtensionAdapter, CURSOR_CLIENT_CAPABILITIES } from "./cursor-extensions.js";
import { createHash } from "node:crypto";
import type { HarnessRuntimeRequestResolution } from "../../contracts/harness-driver.js";
import { parsePaperclipQuestionSet, parsePaperclipQuestionResponse, type PaperclipQuestionSet } from "../../contracts/question-set.js";
import { isCanonicalProviderEventType, type AcpRuntimeEventShape, type CanonicalProviderEvent } from "../../provider-events.js";
import { validatePrpEvent } from "../../protocol/replay-contract.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";
import { parseProviderUsageBilling, type ProviderUsageBilling } from "../../contracts/usage-billing.js";
import { parseProviderTokenAccounting, type ProviderTokenAccounting } from "../../contracts/usage-tokens.js";

export const ACPX_CANONICAL_INPUT_METHODS = [
  "elicitation/create", "cursor/ask_question", "cursor/create_plan", "_hermes/ask_questions",
] as const;
export function isAcpxCanonicalInputMethod(method: string): boolean {
  return (ACPX_CANONICAL_INPUT_METHODS as readonly string[]).includes(method);
}

export interface AcpxExtensionInput {
  method: string;
  questionSet: PaperclipQuestionSet;
  details?: Record<string, unknown>;
  resolve(resolution: HarnessRuntimeRequestResolution): Record<string, unknown>;
  cancel(): Record<string, unknown>;
}
export type AcpxExtensionRequestResult =
  | { input: AcpxExtensionInput }
  | { events: CanonicalProviderEvent[]; response: Record<string, unknown> };
export interface AcpxProfileExtensionAdapter {
  request(method: string, params: Record<string, unknown>): Promise<AcpxExtensionRequestResult>;
  notification(method: string, params: Record<string, unknown>): Promise<CanonicalProviderEvent[]>;
}
export interface AcpxProfileExtensionContext {
  workspacePath: string;
  sessionId: string;
  turnId: string;
  onBilling?(receipt: ProviderUsageBilling): void;
  onTokenAccounting?(receipt: ProviderTokenAccounting): void;
}

/** ACPX 0.13.1 bounds the complete encoded extension response at 256 KiB.
 * Reserve its fixed fields and every selectable ID, then budget text for the
 * worst JSON escape (six bytes per JavaScript string code unit). The persisted
 * form and response validator must share this limit before a human submits.
 */
function boundedHermesQuestionSet(value: unknown): PaperclipQuestionSet {
  const input = parsePaperclipQuestionSet(value);
  const largestEmptyAnswers = Object.fromEntries(input.questions.map(question => [question.id, {
    selectedOptionIds: (question.options ?? []).map(option => option.id),
    ...(question.answerMode === "text" ? { text: "" }
      : question.customAnswer?.enabled ? { customText: "" } : {}),
  }]));
  const overhead = Buffer.byteLength(JSON.stringify({ outcome: "answered", answers: largestEmptyAnswers }));
  const maxLength = Math.min(65_536, Math.floor((256 * 1024 - overhead) / (6 * input.questions.length)));
  if (maxLength < 1) throw new Error("Hermes question answers exceed the encoded response limit");
  return parsePaperclipQuestionSet({ ...input, questions: input.questions.map(question => ({
    ...question, textValidation: { ...question.textValidation,
      maxLength: Math.min(question.textValidation?.maxLength ?? maxLength, maxLength),
    },
  })) });
}

/** Provider branches install their closed, pinned adapters here after qualification research. */
export function createAcpxProfileExtensionAdapter(
  agent: QualifiedAcpxAgent,
  context: AcpxProfileExtensionContext,
): AcpxProfileExtensionAdapter | null {
  if (agent === "cursor") return createCursorProfileExtensionAdapter(context);
  if (agent === "hermes") return {
    async request(method, params) {
      if (method !== "_hermes/ask_questions" || params.version !== 1 || params.sessionId !== context.sessionId) throw new Error("Unsupported Hermes question extension");
      const questionSet = boundedHermesQuestionSet(params.input);
      return { input: {
        method, questionSet,
        resolve(resolution) {
          if (resolution.action !== "submit") return { outcome: "cancelled" };
          if (!("response" in resolution)) throw new Error("Hermes requires a canonical question response");
          const response = parsePaperclipQuestionResponse(questionSet, resolution.response);
          return { outcome: "answered", answers: response.answers };
        },
        cancel: () => ({ outcome: "cancelled" }),
      } };
    },
    async notification(method, params) {
      if (method === "_hermes/delegation") {
        if (params.version !== 1 || params.sessionId !== context.sessionId
          || !["subagent.start", "subagent.progress", "subagent.tool", "subagent.complete"].includes(String(params.event))
          || typeof params.childId !== "string" || !params.childId || params.childId.length > 160
          || typeof params.delegationId !== "string" || !params.delegationId || params.delegationId.length > 160
          || typeof params.model !== "string" || params.model.length > 200
          || typeof params.summary !== "string" || params.summary.length > 4000
          || typeof params.status !== "string" || params.status.length > 100) throw new Error("Invalid Hermes delegation activity");
        const id = (value: string) => `hermes:${createHash("sha256").update(`${context.sessionId}:${context.turnId}:${value}`).digest("hex")}`;
        const delegationId = id(params.delegationId);
        const done = params.event === "subagent.complete";
        const status = done ? ["completed", "success", "done"].includes(params.status) ? "completed"
          : ["cancelled", "interrupted"].includes(params.status) ? "interrupted" : "failed" : "running";
        return [{ eventType: done ? "delegation.completed" : params.event === "subagent.start" ? "delegation.started" : "delegation.updated",
          itemId: delegationId, payload: { schema: "paperclip.delegation.v1", delegationId, action: "spawn", status,
            children: [{ childId: id(params.childId), role: null, model: params.model || null, status,
              summary: params.summary || null, activitySummary: null }] } }];
      }
      if (method === "_hermes/usage") {
        if (params.version !== 1 || params.sessionId !== context.sessionId
          || !["reported", "unavailable"].includes(String(params.tokens))
          || !["estimated", "unavailable"].includes(String(params.cost))
          || (params.cost === "estimated" && (typeof params.estimatedUsd !== "number" || !Number.isFinite(params.estimatedUsd) || params.estimatedUsd < 0))) {
          throw new Error("Invalid Hermes usage provenance");
        }
        const estimated = params.cost === "estimated";
        const billing = params.billing === undefined ? null : parseProviderUsageBilling(params.billing);
        const tokenAccounting = params.tokenAccounting === undefined ? null : parseProviderTokenAccounting(params.tokenAccounting);
        if (billing && tokenAccounting) throw new Error("Hermes supplied conflicting accounting authorities");
        if (tokenAccounting) {
          if (!context.onTokenAccounting) throw new Error("Hermes token accounting was not negotiated");
          context.onTokenAccounting(tokenAccounting);
        }
        if (billing) {
          if (!context.onBilling) throw new Error("Hermes billing receipts were not negotiated");
          context.onBilling(billing);
        }
        const itemId = `${context.turnId}:hermes-usage`;
        return [{ eventType: "provider.notice.recorded", itemId, payload: {
          schema: "paperclip.provider.notice.v1", noticeId: itemId, severity: "info", category: "hermes_usage_provenance", scope: "turn",
          recoverable: true, userActionable: false,
          summary: billing ? `OpenRouter reports $${billing.amountUsd.toFixed(6)}${billing.complete ? " for this turn." : "; remaining billing is unavailable."}`
            : estimated ? `Hermes estimates this turn at $${(params.estimatedUsd as number).toFixed(6)}. Billing cost is unverified.`
            : "Hermes billing cost is unavailable.",
          details: [{ name: "Token usage", value: String(params.tokens) }, { name: "Cost source", value: billing ? "OpenRouter response usage.cost" : estimated ? "Hermes model pricing estimate" : "Unavailable" },
            ...(billing ? [{ name: "Reported USD", value: billing.amountUsdExact }, { name: "Billing complete", value: String(billing.complete) },
              { name: "Reported requests", value: `${billing.reportedRequestCount}/${billing.requestCount}` }] : []),
            ...(tokenAccounting ? [{ name: "Usage source", value: "Selected-account API response usage" },
              { name: "Token accounting complete", value: String(tokenAccounting.complete) },
              { name: "Reported requests", value: `${tokenAccounting.reportedRequestCount}/${tokenAccounting.requestCount}` }] : []),
            ...(estimated ? [{ name: "Estimated USD", value: String(params.estimatedUsd) }] : [])],
        } }];
      }
      if (method !== "_hermes/turn_started") throw new Error("Unsupported Hermes notification");
      return [];
    },
  };
  return null;
}
export function acpxProfileClientCapabilities(agent: QualifiedAcpxAgent): Record<string, unknown> {
  if (agent === "cursor") return structuredClone(CURSOR_CLIENT_CAPABILITIES);
  return agent === "hermes" ? { _meta: { paperclipHermes: { version: 1, billingReceipts: 1, tokenAccountingReceipts: 1 } } } : {};
}

/** Delay this tool's display completion until its native prompt receipt is read.
 * This grants no wait or accounting authority; the controller validates both.
 */
export function isHermesCommittedHumanInputCompletion(event: AcpRuntimeEventShape, runId: string): boolean {
  if (event.type !== "tool_call" || event.tag !== "tool_call_update" || event.status !== "completed"
    || !(event.title === "mcp__paperclip__request_human_input"
      || event.title?.startsWith("mcp__paperclip__request_human_input: "))) return false;
  const object = (value: unknown): Record<string, unknown> | null => {
    if (typeof value === "string") {
      if (value.length > 65_536) return null;
      try { value = JSON.parse(value); } catch { return null; }
    }
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  };
  let result = object(event.rawOutput);
  if (!result || "error" in result) return false;
  if (!("disposition" in result)) {
    if (Object.keys(result).some(key => !["result", "structuredContent", "_meta"].includes(key))) return false;
    result = object(result.structuredContent ?? result.result);
  }
  if (!result || "error" in result || result.disposition !== "applied") return false;
  const interaction = object(result.interaction);
  return interaction !== null && typeof interaction.kind === "string"
    && ["ask_user_questions", "request_confirmation", "request_checkbox_confirmation"].includes(interaction.kind)
    && interaction.status === "pending"
    && interaction.continuationPolicy === "wake_assignee" && interaction.sourceRunId === runId
    && ["id", "companyId", "issueId"].every(key => typeof interaction[key] === "string" && Boolean(interaction[key]));
}

/** Reject an oversized approval document; never silently approve a truncated revision. */
export function validateAcpxExtensionInput(input: AcpxExtensionInput): void {
  if (!isAcpxCanonicalInputMethod(input.method)) throw new Error("Unsupported ACP input method");
  parsePaperclipQuestionSet(input.questionSet);
  if (Buffer.byteLength(JSON.stringify(input.questionSet)) > 196 * 1024) {
    throw new Error("ACP input exceeds its complete-document byte limit");
  }
}

/** Display-only extension channel cannot mint terminal events, tools, or approvals. */
export function validateAcpxRichEvent(event: CanonicalProviderEvent): void {
  if (!isCanonicalProviderEventType(event.eventType) || event.eventType === "harness.diagnostic"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(event.itemId)
    || Buffer.byteLength(JSON.stringify(event)) > 240 * 1024) {
    throw new Error("Unsupported ACP rich activity event");
  }
  if ((event.eventType === "artifact.generated" && event.payload.registered !== false)
    || (event.eventType === "plan.updated" && (event.payload.syncStatus !== "not_applicable"
      || (event.payload.documentRevision !== undefined && event.payload.documentRevision !== null)))) {
    throw new Error("ACP display activity cannot claim a control-plane mutation");
  }
  const validation = validatePrpEvent({
    schema: "paperclip.prp.event.v1",
    sourceEventId: "validation:1", sourceSeq: 1, sourceInstanceId: "validation",
    sourceKind: "runner", runId: "validation", normalizedSessionId: "validation",
    turnId: "validation", itemId: event.itemId, eventType: event.eventType,
    schemaVersion: 1, priority: 1, emittedAt: "2026-09-28T00:00:00.000Z", payload: event.payload,
  });
  if (!validation.ok) throw new Error("ACP rich activity failed its canonical schema");
}

export function bindAcpxExtensionTurn(input: {
  adapter: AcpxProfileExtensionAdapter | null;
  active(): boolean;
  sessionId: string;
  waitForInput(input: AcpxExtensionInput, context: { requestId: string | number; signal: AbortSignal; responseDelivery?: Promise<void> }): Promise<Record<string, unknown>>;
  emit(event: CanonicalProviderEvent): void;
}) {
  let queue = Promise.resolve();
  let pending = 0;
  let failure: unknown;
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    if (++pending > 64) {
      --pending;
      failure ??= new Error("ACP extension work queue exceeded its bound");
      return Promise.reject(failure);
    }
    const job = queue.then(async () => {
      if (failure) throw failure;
      if (!input.active()) throw new Error("ACP extension belongs to a stale turn");
      return work();
    }).finally(() => { --pending; });
    queue = job.then(() => {}, error => { failure ??= error; });
    return job;
  };
  const emit = (events: CanonicalProviderEvent[]) => {
    if (!Array.isArray(events) || events.length > 256) throw new Error("ACP extension event batch exceeds its bound");
    if (!input.active()) throw new Error("ACP extension belongs to a stale turn");
    for (const event of events) {
      validateAcpxRichEvent(event);
      input.emit(event);
    }
  };
  const assertSession = (params: Record<string, unknown>) => {
    if (params.sessionId !== input.sessionId) throw new Error("ACP extension session mismatch");
    if (!input.adapter) throw new Error("ACP extension adapter is unavailable");
  };
  return {
    async onExtensionRequest(method: string, params: Record<string, unknown>, context: { requestId: string | number; signal: AbortSignal; responseDelivery?: Promise<void> }) {
      assertSession(params);
      if (context.signal.aborted) throw new Error("ACP extension was cancelled");
      const result = await enqueue(() => input.adapter!.request(method, params));
      if (context.signal.aborted || !input.active()) {
        if ("input" in result) return result.input.cancel();
        throw new Error("ACP extension was cancelled");
      }
      if ("input" in result) {
        validateAcpxExtensionInput(result.input);
        return input.waitForInput(result.input, context);
      }
      emit(result.events);
      return result.response;
    },
    onExtensionNotification(method: string, params: Record<string, unknown>) {
      void enqueue(async () => {
        assertSession(params);
        emit(await input.adapter!.notification(method, params));
      }).catch(() => {});
    },
    async drain() {
      await queue;
      if (failure) throw failure;
    },
  };
}
