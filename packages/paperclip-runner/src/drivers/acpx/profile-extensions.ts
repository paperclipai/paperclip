import { createCursorProfileExtensionAdapter, CURSOR_CLIENT_CAPABILITIES } from "./cursor-extensions.js";
import type { HarnessRuntimeRequestResolution } from "../../contracts/harness-driver.js";
import { parsePaperclipQuestionSet, type PaperclipQuestionSet } from "../../contracts/question-set.js";
import { isCanonicalProviderEventType, type CanonicalProviderEvent } from "../../provider-events.js";
import { validatePrpEvent } from "../../protocol/replay-contract.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

export const ACPX_CANONICAL_INPUT_METHODS = [
  "elicitation/create", "cursor/ask_question", "cursor/create_plan",
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
}

/** Provider branches install their closed, pinned adapters here after qualification research. */
export function createAcpxProfileExtensionAdapter(
  agent: QualifiedAcpxAgent,
  context: AcpxProfileExtensionContext,
): AcpxProfileExtensionAdapter | null {
  if (agent === "cursor") return createCursorProfileExtensionAdapter(context);
  return null;
}
export function acpxProfileClientCapabilities(agent: QualifiedAcpxAgent): Record<string, unknown> {
  return agent === "cursor" ? structuredClone(CURSOR_CLIENT_CAPABILITIES) : {};
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
