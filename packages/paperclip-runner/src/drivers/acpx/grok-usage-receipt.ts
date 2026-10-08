import type { AcpSessionRecord } from "acpx/runtime";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const USD_TICKS_PER_USD = 10_000_000_000;

type ActiveTurn = { requestId: string; sessionId: string; signal: AbortSignal };
type Receipt = { promptId: string; tokens: Record<string, number>; costTicks: number | null };

/** Grok 1.0.13 reports whole-prompt usage in its private terminal notification.
 * The provider's PromptUsage contract includes cache in input, reasoning in
 * output, and server cost in 1e10 ticks/USD. Partial/zero cost is unreported.
 * https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/notification.rs
 */
export function parseGrokPromptUsage(value: unknown): Receipt | null {
  const update = object(value), usage = object(update.usage);
  if (update.sessionUpdate !== "turn_completed" || typeof update.prompt_id !== "string"
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(update.prompt_id)
    || usage.usageIsIncomplete !== undefined && usage.usageIsIncomplete !== false) return null;
  const fields = ["inputTokens", "outputTokens", "totalTokens", "cachedReadTokens", "cacheCreationTokens", "reasoningTokens"];
  if (!fields.every(field => count(usage[field]))) return null;
  const input = usage.inputTokens as number, output = usage.outputTokens as number;
  const cached = usage.cachedReadTokens as number, written = usage.cacheCreationTokens as number;
  if (input + output !== usage.totalTokens || cached + written > input || (usage.reasoningTokens as number) > output) return null;
  const costTicks = count(usage.costUsdTicks) && usage.costUsdTicks > 0
    && (usage.costIsPartial === undefined || usage.costIsPartial === false) ? usage.costUsdTicks : null;
  return { promptId: update.prompt_id, costTicks, tokens: {
    // Paperclip's ACPX buckets are disjoint; do not count cache or reasoning twice.
    input_tokens: input - cached - written, output_tokens: output,
    cache_read_input_tokens: cached, cache_creation_input_tokens: written,
    thought_tokens: 0, total_tokens: usage.totalTokens as number,
  } };
}

/** Capture only a terminal receipt received after this admitted prompt was sent.
 * Persist through ACPX's existing standard usage fields, so reload/recovery sees
 * the same receipt and repeated saves cannot add its charge a second time.
 */
export function createGrokUsageCapture(activeTurn: () => ActiveTurn | null) {
  let latest: AcpSessionRecord | undefined;
  let scope: { owner: ActiveTurn; beforeUserIds: Set<string>; baselineTicks: number | null; sent: boolean; receipt: Receipt | null; invalid: boolean } | null = null;
  const usedPromptIds = new Set<string>();
  const userIds = (record: AcpSessionRecord | undefined): string[] => (record?.messages ?? [])
    .flatMap(message => typeof message === "object" && message !== null && "User" in message ? [message.User.id] : []);
  return {
    remember(record: AcpSessionRecord) { latest = record; },
    admit() {
      const active = activeTurn();
      if (!active || active.signal.aborted) { scope = null; return; }
      const cost = object(latest?.cumulative_cost);
      const rawTicks = typeof cost.amount === "number" && cost.currency === "USD" ? Math.round(cost.amount * USD_TICKS_PER_USD) : null;
      const hasPriorWork = Object.keys(latest?.request_token_usage ?? {}).length > 0 || (latest?.messages ?? [])
        .some(message => typeof message === "object" && message !== null && "Agent" in message);
      const baselineTicks = count(rawTicks) ? rawTicks : hasPriorWork ? null : 0;
      // ACPX persists the new User message during preparation, before sending
      // session/prompt. Freeze the prior record at runner turn admission instead.
      scope = { owner: active, beforeUserIds: new Set(userIds(latest)), baselineTicks, sent: false, receipt: null, invalid: false };
    },
    observe(direction: "inbound" | "outbound", value: unknown) {
      const message = object(value), params = object(message.params), active = activeTurn();
      if (direction === "outbound" && message.method === "session/prompt") {
        if (!scope || active !== scope.owner || active.signal.aborted || params.sessionId !== active.sessionId) { scope = null; return; }
        if (scope.sent) scope.invalid = true;
        scope.sent = true;
        return;
      }
      // Grok sends live usage on session_notification. session/update is its
      // persistence/replay stream and cannot settle the current admitted turn.
      const meta = object(params._meta);
      if (direction !== "inbound" || message.method !== "_x.ai/session_notification" || Object.hasOwn(message, "id")
        || Object.hasOwn(meta, "isReplay") && meta.isReplay !== false
        || !scope?.sent || active !== scope.owner || active.signal.aborted || params.sessionId !== active.sessionId) return;
      const update = object(params.update);
      if (update.sessionUpdate !== "turn_completed") return;
      const receipt = parseGrokPromptUsage(update);
      // A second or reused terminal receipt cannot replace the current bill.
      if (!receipt || scope.receipt || usedPromptIds.has(receipt.promptId)) { scope.invalid = true; return; }
      scope.receipt = receipt;
      usedPromptIds.add(receipt.promptId);
    },
    project(record: AcpSessionRecord, previous: AcpSessionRecord | undefined): AcpSessionRecord {
      const retained = { ...previous?.request_token_usage, ...record.request_token_usage };
      const projected = { ...record, request_token_usage: retained,
        cumulative_cost: record.cumulative_cost ?? previous?.cumulative_cost };
      if (scope?.sent && record.lastRequestId === scope.owner.requestId && record.acpSessionId === scope.owner.sessionId) {
        const promptMessageId = userIds(record).at(-1);
        if (scope.receipt && !scope.invalid && promptMessageId && !scope.beforeUserIds.has(promptMessageId)) {
          retained[promptMessageId] = scope.receipt.tokens;
          const ticks = scope.baselineTicks === null || scope.receipt.costTicks === null ? null : scope.baselineTicks + scope.receipt.costTicks;
          projected.cumulative_cost = count(ticks) ? { amount: ticks / USD_TICKS_PER_USD, currency: "USD" } : undefined;
        } else if (scope.invalid) {
          projected.cumulative_cost = undefined;
        }
      }
      latest = projected;
      return projected;
    },
  };
}
