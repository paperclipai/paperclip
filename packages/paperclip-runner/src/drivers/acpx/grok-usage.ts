type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);

export interface TerminalPromptUsage {
  requestId: string;
  promptId: string;
  event: RecordValue;
}

export function grokPromptUsage(metaValue: unknown, sessionId: string): Omit<TerminalPromptUsage, "requestId"> | null {
  const meta = record(metaValue), usage = record(meta.usage);
  if (meta.sessionId !== sessionId || !id(meta.promptId) || meta.requestId !== meta.promptId
    || (usage.usageIsIncomplete !== undefined && usage.usageIsIncomplete !== false)) return null;
  const { inputTokens, outputTokens, totalTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens, modelCalls } = usage;
  if (![inputTokens, outputTokens, totalTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens, modelCalls].every(integer)
    || Number(inputTokens) + Number(outputTokens) !== totalTokens
    || Number(cachedReadTokens) + Number(cacheCreationTokens) > Number(inputTokens)
    || Number(reasoningTokens) > Number(outputTokens)) return null;
  const costKnown = integer(usage.costUsdTicks) && (usage.costIsPartial === undefined || usage.costIsPartial === false);
  return {
    promptId: meta.promptId,
    event: {
      type: "status", tag: "usage_update", text: "terminal prompt usage",
      ...(costKnown ? { cost: { amount: Number(usage.costUsdTicks) / 10_000_000_000, currency: "USD", basis: "turn" } } : {}),
      breakdown: {
        inputTokens: Number(inputTokens) - Number(cachedReadTokens) - Number(cacheCreationTokens),
        outputTokens, totalTokens, cachedReadTokens, cachedWriteTokens: cacheCreationTokens, thoughtTokens: 0,
      },
    },
  };
}

export function createGrokPromptUsageCollector() {
  let active: { requestId: string; sessionId: string; wireId?: string | number; invalid: boolean; receipt: TerminalPromptUsage | null } | null = null;
  let previousPromptId: string | undefined;
  return {
    begin(requestId: string, sessionId: string) {
      previousPromptId = active?.receipt?.promptId ?? previousPromptId;
      active = { requestId, sessionId, invalid: false, receipt: null };
    },
    observe(direction: "inbound" | "outbound", value: unknown) {
      if (!active || active.invalid) return;
      const message = record(value);
      if (direction === "outbound") {
        if (message.method !== "session/prompt" || record(message.params).sessionId !== active.sessionId) return;
        if (active.wireId !== undefined || !(id(message.id) || integer(message.id))) { active.invalid = true; return; }
        active.wireId = message.id;
        return;
      }
      if (active.wireId === undefined || message.id !== active.wireId || message.method !== undefined) return;
      const receipt = message.error === undefined ? grokPromptUsage(record(message.result)._meta, active.sessionId) : null;
      if (!receipt || receipt.promptId === previousPromptId) { active.invalid = true; return; }
      const bound = { ...receipt, requestId: active.requestId };
      if (active.receipt && JSON.stringify(active.receipt) !== JSON.stringify(bound)) { active.invalid = true; return; }
      active.receipt = bound;
    },
    snapshot(): TerminalPromptUsage | null {
      return active && !active.invalid ? structuredClone(active.receipt) : null;
    },
  };
}
