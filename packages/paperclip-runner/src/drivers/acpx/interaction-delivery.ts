import type {
  AcpElicitationContext,
  AcpElicitationHandler,
  AcpPermissionDecision,
  AcpPermissionRequest,
} from "acpx/runtime";

/**
 * Runner-owned interaction callbacks. ACPX invokes the stock callbacks; the
 * adapter adds `responseDelivery`, which resolves only once the selected
 * response has been handed to ACPX as the provider reply.
 *
 * - Permission replies are visible to `onAcpMessage`, so delivery waits for
 *   the exact outbound reply (see createAcpxPermissionReplyConfirmations).
 * - ACPX hides elicitation and extension replies from observers, so their
 *   delivery resolves when the callback returns its response to ACPX.
 */
export type AcpxHostPermissionHandler = (
  request: AcpPermissionRequest,
  context: { signal: AbortSignal; responseDelivery: Promise<void> },
) => Promise<AcpPermissionDecision | undefined>;
export type AcpxHostElicitationHandler = (
  request: Parameters<AcpElicitationHandler>[0],
  context: AcpElicitationContext & { responseDelivery: Promise<void> },
) => ReturnType<AcpElicitationHandler>;
export type AcpxHostExtensionRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  context: { requestId: string | number; signal: AbortSignal; responseDelivery: Promise<void> },
) => Promise<Record<string, unknown>>;

/** Run a callback whose reply ACPX writes after it returns. */
export async function withReturnedResponseDelivery<T>(
  invoke: (responseDelivery: Promise<void>) => Promise<T>,
  accept: (value: T) => T = value => value,
): Promise<T> {
  const delivered = deferred();
  // A declined interaction may never await its receipt.
  delivered.promise.catch(() => undefined);
  try {
    const value = accept(await invoke(delivered.promise));
    delivered.resolve();
    return value;
  } catch (error) {
    delivered.reject(new Error("ACP interaction ended before its response was handed to ACPX"));
    throw error;
  }
}

/** Adapt a Runner elicitation callback to the stock ACPX callback. */
export function acpxElicitationHandler(handler: AcpxHostElicitationHandler): AcpElicitationHandler {
  return (request, context) => withReturnedResponseDelivery(responseDelivery => Promise.resolve(handler(request, { ...context, responseDelivery })));
}

/**
 * Confirms that ACPX wrote the host's permission decision as the JSON-RPC
 * reply to the exact provider request.
 *
 * `onAcpMessage` sees each inbound `session/request_permission` before ACPX
 * dispatches it, and each outbound reply just before the pipe write. Pairing
 * the two by session and tool call recovers the request id, which the stock
 * permission callback does not expose. Delivery resolves only when that reply
 * selects exactly the host decision: the chosen option for an option id, the
 * single offered option of a decision kind, or a cancellation for a cancel.
 * An error reply, any other result, an ambiguous request, a turn abort, or a
 * missing reply rejects it.
 */
type JsonRpcId = string | number;

export interface AcpxPermissionReplyBinding {
  readonly delivery: Promise<void>;
  /** Record the decision the host callback is about to return to ACPX. */
  select(decision: PermissionDecision | undefined): void;
  /** Reject delivery when the callback throws or its turn expires. */
  fail(error: Error): void;
}

export interface AcpxPermissionReplyConfirmations {
  observe(direction: "inbound" | "outbound", message: unknown): void;
  bind(request: { sessionId: string; raw?: unknown }, signal: AbortSignal): AcpxPermissionReplyBinding;
}

type PermissionDecision = { outcome: string; optionId?: string };
type OfferedOption = { optionId: string; kind: string };

const MAX_PENDING = 128;
const DEFAULT_REPLY_TIMEOUT_MS = 10_000;

export function createAcpxPermissionReplyConfirmations(options: { replyTimeoutMs?: number } = {}): AcpxPermissionReplyConfirmations {
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const requestIds = new Map<string, JsonRpcId>();
  const keysById = new Map<JsonRpcId, string>();
  const offeredById = new Map<JsonRpcId, readonly OfferedOption[]>();
  const ambiguous = new Set<string>();
  const waiting = new Map<JsonRpcId, (reply: Record<string, unknown>) => void>();
  const forget = (id: JsonRpcId): void => {
    const key = keysById.get(id);
    keysById.delete(id);
    offeredById.delete(id);
    if (key !== undefined && requestIds.get(key) === id) requestIds.delete(key);
  };
  return {
    observe(direction, message) {
      const value = record(message);
      const id = jsonRpcId(value.id);
      if (id === undefined) return;
      if (direction === "inbound" && value.method === "session/request_permission") {
        const key = permissionKey(value.params);
        if (key === undefined) return;
        if (requestIds.has(key) || keysById.size >= MAX_PENDING) ambiguous.add(key);
        else {
          requestIds.set(key, id);
          keysById.set(id, key);
          offeredById.set(id, offeredOptions(value.params));
        }
        return;
      }
      if (direction !== "outbound" || value.method !== undefined) return;
      const settle = waiting.get(id);
      waiting.delete(id);
      // ACPX can answer from its own policy without the host callback.
      forget(id);
      settle?.(value);
    },
    bind(request, signal) {
      const reply = deferred();
      // A declined interaction may never await its receipt.
      reply.promise.catch(() => undefined);
      const key = permissionKey(request.raw) ?? permissionKey({ sessionId: request.sessionId });
      const id = key === undefined || ambiguous.has(key) ? undefined : requestIds.get(key);
      const offered = id === undefined ? [] : offeredById.get(id) ?? [];
      let selected: PermissionDecision | undefined | null = null;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (id !== undefined) {
          waiting.delete(id);
          forget(id);
        }
        if (error) reply.reject(error);
        else reply.resolve();
      };
      const onAbort = (): void => finish(new Error("ACP permission reply was cancelled or disconnected"));
      if (id === undefined) {
        finish(new Error("ACP permission request has no unique provider request id"));
      } else {
        waiting.set(id, (reply) => {
          if (selected === null) return finish(new Error("ACP replied before the host selected a permission decision"));
          if ("error" in reply || !("result" in reply)) return finish(new Error("ACP wrote an error instead of the selected permission decision"));
          if (!replySelects(reply.result, selected, offered)) {
            return finish(new Error("ACP changed the selected permission decision"));
          }
          finish();
        });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      return {
        delivery: reply.promise,
        select(decision) {
          if (settled) return;
          selected = decision;
          // The SDK writes the reply right after the callback returns.
          timer = setTimeout(() => finish(new Error("ACP permission reply was not written")), replyTimeoutMs);
          timer.unref?.();
        },
        fail(error) {
          finish(error);
        },
      };
    },
  };
}

function offeredOptions(params: unknown): OfferedOption[] {
  const options = record(params).options;
  if (!Array.isArray(options)) return [];
  return options.map(record).flatMap(option =>
    typeof option.optionId === "string" && typeof option.kind === "string" ? [{ optionId: option.optionId, kind: option.kind }] : []);
}

/** Whether the written reply is exactly the host's decision. */
function replySelects(result: unknown, decision: PermissionDecision | undefined, offered: readonly OfferedOption[]): boolean {
  const outcome = record(record(result).outcome);
  if (decision === undefined || decision.outcome === "cancel") return outcome.outcome === "cancelled";
  if (outcome.outcome !== "selected" || typeof outcome.optionId !== "string") return false;
  if (decision.outcome === "selected") return outcome.optionId === decision.optionId;
  // ACPX resolves a decision kind to the offered option of that kind.
  const ofKind = offered.filter(option => option.kind === decision.outcome);
  return ofKind.length === 1 && ofKind[0]!.optionId === outcome.optionId;
}

function permissionKey(params: unknown): string | undefined {
  const value = record(params);
  const toolCallId = record(value.toolCall).toolCallId;
  if (typeof value.sessionId !== "string" || typeof toolCallId !== "string") return undefined;
  return JSON.stringify([value.sessionId, toolCallId]);
}

function jsonRpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
