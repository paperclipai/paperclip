import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import type { NativeExecutionInput, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { priceAnthropicReceipt } from "../anthropic-pricing.js";
import { priceCodexReceipt } from "../codex-pricing.js";
import { liveRunUsageCostCents } from "../budget-live-usage.js";
import { receiptFingerprint } from "../receipt-fingerprint.js";
import { persistUsageReceipt, type UsageReceiptEnvelope } from "../usage-receipts.js";
import { createNativeTurnAccounting, nativeUsageCostUsd, normalizeNativeUsage } from "./native-usage-accounting.js";

const terminal = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]);
const uuid = (identity: string) => {
  const hex = createHash("sha256").update(identity).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export async function createNativeUsageDelivery(db: Db, input: {
  companyId: string; runId: string; runnerInstanceId: string;
  provider: NativeExecutionInput["provider"];
  billing: Pick<AdapterUsageCheckpoint, "provider" | "biller" | "billingType">;
}) {
  const sourceId = uuid(`${input.runId}:${input.runnerInstanceId}`);
  const [bound] = await db.update(heartbeatRuns).set({ usageJson: sql`
    coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || '{"accountingReceiptOwner":"native_producer"}'::jsonb ||
    case when ${heartbeatRuns.usageJson}->>'accountingReceiptSourceId' = ${sourceId}
      then '{}'::jsonb else ${JSON.stringify({ accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0, accountingReceiptReady: false })}::jsonb end`
  }).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    isNull(heartbeatRuns.costAccountedAt))).returning({ id: heartbeatRuns.id });
  if (!bound) throw new Error("native_usage_run_not_available");
  const saved = await db.select({ receipt: runUsageReceipts.receiptJson }).from(runUsageReceipts).where(and(
    eq(runUsageReceipts.companyId, input.companyId), eq(runUsageReceipts.runId, input.runId),
    eq(runUsageReceipts.sourceId, sourceId))).orderBy(asc(runUsageReceipts.sequence));
  const accepted = new Map<string, UsageReceiptEnvelope>();
  const turnAccounting = ["opencode", "acpx"].includes(input.provider.kind) ? createNativeTurnAccounting(input.provider) : null;
  let observedUsage: Record<string, unknown> | null = null;
  let observedTurn: string | undefined;
  let activeProviderTurn: string | undefined;
  const observe = (envelope: UsageReceiptEnvelope) => {
    const fact = envelope.producerEvent!;
    if (fact.eventType === "turn.started") activeProviderTurn = fact.providerTurnId ?? fact.sourceEventId;
    const accountingTurn = fact.providerTurnId ?? activeProviderTurn ?? fact.turnId;
    const interpretedUsage = fact.usage ? { ...fact.usage, runDeltaComplete: fact.usage.runDeltaComplete === true
      && (input.provider.kind !== "codex" || fact.usage.runDeltaBasis === "run") } : undefined;
    const event = { sourceInstanceId: input.runnerInstanceId, sourceSeq: envelope.sequence,
      turnId: accountingTurn, eventType: fact.eventType,
      payload: interpretedUsage ? { kind: "usage", usage: interpretedUsage } : {} } as PrpEvent;
    if (turnAccounting) {
      turnAccounting.observe(event);
      return turnAccounting.snapshot();
    }
    if (fact.eventType === "turn.started") observedTurn = undefined;
    if (interpretedUsage) {
      observedUsage = interpretedUsage;
      observedTurn = normalizeNativeUsage(observedUsage, { inputIncludesCacheReads: input.provider.kind === "codex" }) ? accountingTurn : undefined;
    }
    return { usage: observedUsage, complete: terminal.has(fact.eventType) && observedTurn !== undefined && observedTurn === accountingTurn };
  };
  for (const row of saved) {
    const envelope = row.receipt as UsageReceiptEnvelope;
    if (!envelope.producerEvent) throw new Error("native_usage_receipt_missing_producer");
    accepted.set(envelope.producerEvent.sourceEventId, envelope);
    observe(envelope);
  }
  let pending: UsageReceiptEnvelope | undefined;
  let chain = Promise.resolve();
  const capture = async (event: PrpEvent) => {
    if (event.eventType !== "usage.reported" && event.eventType !== "turn.started" && !terminal.has(event.eventType)) return;
    if (event.runId !== input.runId || event.sourceInstanceId !== input.runnerInstanceId) throw new Error("native_usage_source_mismatch");
    const payload = event.payload as Record<string, unknown>;
    const fact: NonNullable<UsageReceiptEnvelope["producerEvent"]> = {
      sourceEventId: event.sourceEventId, turnId: event.turnId, eventType: event.eventType,
      ...(typeof payload.providerTurnId === "string" ? { providerTurnId: payload.providerTurnId } : {}),
      ...(event.eventType === "usage.reported" ? { usage: { runDelta: payload.runDelta, runDeltaComplete: payload.runDeltaAvailable === true, runDeltaBasis: payload.runDeltaBasis,
        ...(payload.reconciliation && typeof payload.reconciliation === "object" ? { reconciliation: payload.reconciliation } : {}) } } : {}),
    };
    const previous = accepted.get(event.sourceEventId) ?? (pending?.producerEvent?.sourceEventId === event.sourceEventId ? pending : undefined);
    if (previous && (previous.sequence !== event.sourceSeq || previous.receivedAt !== event.emittedAt
      || receiptFingerprint(previous.producerEvent) !== receiptFingerprint(fact))) throw new Error("native_usage_source_conflict");
    if (accepted.has(event.sourceEventId)) return;
    if (pending && pending.producerEvent?.sourceEventId !== event.sourceEventId) throw new Error("native_usage_report_pending");
    if (!pending) {
      const envelope: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1",
        id: uuid(`${input.runId}:${input.runnerInstanceId}:${event.sourceEventId}`), companyId: input.companyId,
        runId: input.runId, adapterType: "paperclip_runner", sourceId, sequence: event.sourceSeq,
        receivedAt: event.emittedAt, producerEvent: fact, receipt: { complete: false } };
      const snapshot = observe(envelope);
      const usage = normalizeNativeUsage(snapshot.usage, { inputIncludesCacheReads: input.provider.kind === "codex" });
      envelope.receipt = priceAnthropicReceipt(priceCodexReceipt({ ...input.billing,
        model: input.provider.model ?? "unknown", usage, usageBasis: "per_run", complete: snapshot.complete && usage !== undefined,
        costUsd: usage ? nativeUsageCostUsd(snapshot.usage, input.provider) ?? null : null,
        costUsdExact: typeof snapshot.usage?.accountingCostUsdExact === "string" ? snapshot.usage.accountingCostUsdExact : undefined,
        costStatus: usage === undefined || snapshot.usage?.accountingCostIncomplete === true ? "unpriced"
          : input.provider.kind === "aws_agentcore" ? "estimated" : undefined,
      }));
      envelope.liveCostCents = liveRunUsageCostCents(envelope.receipt as AdapterUsageCheckpoint);
      pending = envelope;
    }
    await persistUsageReceipt(db, pending);
    accepted.set(event.sourceEventId, pending);
    pending = undefined;
  };
  return { capture(event: PrpEvent) {
    const result = chain.then(() => capture(event));
    chain = result.catch(() => undefined);
    return result;
  } };
}
