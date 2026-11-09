import { usdToUnits } from "@paperclipai/shared";
import type { NativeExecutionInput, PrpEvent } from "../../vendor/paperclip-runner/index.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function numericUsageField(
  usage: Record<string, unknown> | null,
  keys: string[],
): number | undefined {
  if (!usage) return undefined;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return undefined;
}

function nativeUsageMeasurement(usage: Record<string, unknown>) {
  const nestedUsage = record(usage.usage);
  // An explicit partial delta must not fall through to a full session total.
  if (Object.hasOwn(usage, "runDelta")) return record(usage.runDelta);
  if (Object.hasOwn(nestedUsage, "runDelta")) return record(nestedUsage.runDelta);
  const candidates = [
    record(usage.runDelta),
    record(nestedUsage.runDelta),
    record(usage.total),
    record(nestedUsage.total),
    record(usage.cumulative),
    record(nestedUsage.cumulative),
    nestedUsage,
    usage,
  ];
  return (
    candidates.find(
      (candidate) =>
        numericUsageField(candidate, [
          "inputTokens",
          "input",
          "promptTokens",
          "outputTokens",
          "output",
          "completionTokens",
        ]) !== undefined,
    ) ?? usage
  );
}

export function nativeUsageBiller(provider: NativeExecutionInput["provider"]): string {
  if (provider.kind === "cursor_cloud") return "cursor";
  if (provider.kind === "acpx") {
    if (provider.agent === "cursor") return "cursor";
    if (provider.agent === "copilot") return "github";
    if (provider.agent === "pi") return "openrouter";
    if (provider.agent === "grok") return "xai";
  }
  return "openai";
}

/** Provenance note for a receipt whose run includes a provider turn lost on
 * restore. That turn's usage can never be reported, so the receipt is final
 * but its usage and price are a lower bound. */
export const NATIVE_LOST_TURN_USAGE_EVIDENCE = "a provider turn was lost on restore and never reported its usage; observed usage is a lower bound";
export const NATIVE_TURN_LOST_ON_RESTORE = "provider_turn_lost_on_restore";
const LOST_ON_RESTORE = NATIVE_TURN_LOST_ON_RESTORE;

export function createNativeTurnAccounting(provider: NativeExecutionInput["provider"]) {
  const turns = new Map<string, { usage: Record<string, unknown> | null; terminal: boolean; lost?: boolean }>();
  const sequences = new Map<string, number>();
  let currentTurn: string | undefined;
  const terminalTypes = ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"];
  const snapshot = () => {
    if (turns.size === 0) return { usage: null, turnId: undefined, complete: false };
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
    let cost = 0n, costKnown = false, costIncomplete = false, complete = true, usageLost = false;
    for (const [turnId, turn] of turns) {
      const normalized = normalizeNativeUsage(turn.usage);
      // A turn the restored Runner reports as lost on restore can never report
      // its usage. It does not hold the receipt open; it makes it a lower bound.
      const lost = turn.lost === true && normalized === undefined;
      usageLost ||= lost;
      complete &&= turnId !== "unattributed" && turn.terminal && (normalized !== undefined || lost);
      inputTokens += (normalized?.inputTokens ?? 0) - (normalized?.cacheWriteTokens ?? 0);
      outputTokens += normalized?.outputTokens ?? 0;
      cacheReadTokens += normalized?.cachedInputTokens ?? 0;
      cacheWriteTokens += normalized?.cacheWriteTokens ?? 0;
      const price = nativeUsageCostUsd(turn.usage, provider);
      if (price === undefined) costIncomplete = true;
      else { cost += usdToUnits(price); costKnown = true; }
    }
    // A free empty attempt contributes no price evidence for later paid work.
    // Keep an incomplete zero subtotal absent so complete aggregate tokens can
    // still receive an estimate. Preserve positive known spend and true zero totals.
    const retainCost = costKnown && (!costIncomplete || cost > 0n);
    const runDelta = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
      ...(retainCost ? { providerCostUsd: Number(cost) / 1_000_000_000 } : {}) };
    const current = currentTurn ? turns.get(currentTurn) : undefined;
    return { usage: { runDelta, accountingCostIncomplete: costIncomplete, ...(usageLost ? { accountingUsageLost: true } : {}),
      ...(retainCost ? { accountingCostUsdExact: `${cost / 1_000_000_000n}.${String(cost % 1_000_000_000n).padStart(9, "0")}` } : {}) },
      turnId: current && normalizeNativeUsage(current.usage) ? currentTurn : undefined, complete };
  };
  return {
    observe(event: PrpEvent) {
      if (!event) return false;
      const payload = record(event.payload);
      const terminal = terminalTypes.includes(event.eventType);
      if (payload.kind !== "usage" && event.eventType !== "turn.started" && !terminal) return false;
      // Historical replay can revisit an earlier report after restoration.
      // Re-persist its aggregate, but never rewind or count that report twice.
      if (event.sourceInstanceId && Number.isSafeInteger(event.sourceSeq)) {
        if (event.sourceSeq <= (sequences.get(event.sourceInstanceId) ?? -1)) return true;
        sequences.set(event.sourceInstanceId, event.sourceSeq);
      }
      const key = event.turnId ?? "unattributed";
      const turn = turns.get(key) ?? { usage: null, terminal: false };
      if (event.eventType === "turn.started") {
        currentTurn = event.turnId;
        turn.usage = null;
        turn.terminal = false;
        turn.lost = false;
      } else if (payload.kind === "usage" && (!currentTurn || !turns.has(key))) currentTurn = event.turnId;
      if (payload.kind === "usage") {
        const usage = record(payload.usage);
        turn.usage = Object.hasOwn(usage, "runDelta")
          ? { runDelta: record(usage.runDelta), runDeltaComplete: usage.runDeltaComplete } : null;
      }
      if (terminal) turn.terminal = true;
      if (event.eventType === "turn.failed" && record(payload.error).code === LOST_ON_RESTORE) turn.lost = true;
      turns.set(key, turn);
      return true;
    },
    snapshot,
    finish(turnId: string | null) {
      const turn = turnId ? turns.get(turnId) : undefined;
      if (turn) turn.terminal = true;
      return snapshot();
    },
  };
}

export function nativeUsageCostUsd(
  usage: Record<string, unknown> | null,
  provider?: NativeExecutionInput["provider"],
) {
  if (provider?.kind === "cursor_cloud") return undefined;
  // The ACP normalization contract fills absent per-turn cost with zero and
  // reports actual cost cumulatively. Until it carries an authoritative run
  // delta with provenance, neither value is a candidate's billed USD receipt.
  if (provider?.kind === "acpx" && ["cursor", "copilot", "pi"].includes(provider.agent)) return undefined;
  if (!usage) return undefined;
  const measurement = nativeUsageMeasurement(usage);
  const hasRunDelta = Object.hasOwn(usage, "runDelta") || Object.hasOwn(record(usage.usage), "runDelta");
  const direct = numericUsageField(measurement, ["cacheAdjustedCostUsd", "providerCostUsd", "costUsd"])
    ?? (hasRunDelta ? undefined : numericUsageField(usage, ["cacheAdjustedCostUsd", "providerCostUsd", "costUsd"]));
  // PRP currently defaults an absent providerCostUsd to zero. That zero is
  // not proof of a free request when the runtime observed token consumption.
  if (direct !== undefined && direct > 0) return direct;
  const normalized = normalizeNativeUsage(usage);
  if (direct === 0 && normalized && Object.values(normalized).every(value => value === 0)) return 0;
  const cost = record(hasRunDelta ? measurement.cost : usage.cost);
  const currency =
    typeof cost.currency === "string" ? cost.currency.toUpperCase() : "USD";
  if (currency !== "USD") return undefined;
  return numericUsageField(cost, ["amount", "total"]);
}

export function normalizeNativeUsage(usage: Record<string, unknown> | null, options: { inputIncludesCacheReads?: boolean } = {}) {
  if (!usage || usage.runDeltaComplete === false || record(usage.usage).runDeltaComplete === false) return undefined;
  const measurement = nativeUsageMeasurement(usage);
  const cache = record(measurement.cache);
  const count = (source: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      if (source[key] === undefined) continue;
      const value = source[key];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : NaN;
    }
    return undefined;
  };
  const input = count(measurement, ["inputTokens", "input", "promptTokens"]);
  const outputTokens = count(measurement, ["outputTokens", "output", "completionTokens"]);
  const cachedInputTokens = count(measurement, ["cachedInputTokens", "cacheReadInputTokens", "cacheReadTokens", "cachedReadTokens"]) ?? count(cache, ["read"]);
  const cacheWriteTokens = count(measurement, ["cacheWriteTokens", "cacheCreationInputTokens", "cachedWriteTokens"]) ?? count(cache, ["write"]);
  if (input === undefined || outputTokens === undefined
    || ![input, outputTokens, cachedInputTokens ?? 0, cacheWriteTokens ?? 0].every(Number.isSafeInteger)) return undefined;
  const inputTokens = input - (options.inputIncludesCacheReads ? cachedInputTokens ?? 0 : 0)
    + (options.inputIncludesCacheReads ? 0 : cacheWriteTokens ?? 0);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < (cacheWriteTokens ?? 0)) return undefined;
  return {
    inputTokens, outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

export function usesNativeUsageDelivery(input: {
  runnerd: boolean; remote: boolean; provider?: NativeExecutionInput["provider"] | null;
}) {
  return input.runnerd && input.remote && input.provider !== undefined && input.provider !== null
    && ["codex", "opencode", "acpx", "claude_managed", "aws_agentcore"].includes(input.provider.kind);
}

export function isNativeUsageAccountingEvent(event: Pick<PrpEvent, "eventType">) {
  return ["usage.reported", "turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.eventType);
}
