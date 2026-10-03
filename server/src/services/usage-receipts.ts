import { priceCodexReceipt } from "./codex-pricing.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import type { AdapterExecutionResult, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { pricingProvenanceSchema, usdToUnits } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { receiptFingerprint } from "./receipt-fingerprint.js";
import { withAccountingTransaction } from "./accounting-transaction.js";

const token = z.number().int().nonnegative().max(2_147_483_647);
const price = z.number().finite().nonnegative().nullable().optional();
const usage = z.object({ inputTokens: token, outputTokens: token, cachedInputTokens: token.optional(), cacheWriteTokens: token.optional() });
const checkpointSchema = z.object({
  attemptId: z.string().uuid().optional(), usage: usage.optional(),
  usageByModel: z.array(z.object({ model: z.string().min(1).max(250), usage, costUsd: z.number().finite().nonnegative() })).max(500).optional(),
  usageBasis: z.enum(["per_run", "session_cumulative"]).nullable().optional(),
  provider: z.string().max(250).nullable().optional(), biller: z.string().max(250).nullable().optional(),
  model: z.string().max(250).nullable().optional(), billingType: z.string().max(100).nullable().optional(),
  costUsd: price, cacheAdjustedCostUsd: price,
  costStatus: z.enum(["reported", "estimated", "unpriced"]).optional(),
  pricingContext: z.object({ serviceTier: z.string().max(50).optional(), contextTier: z.enum(["short", "long"]).optional() }).optional(),
  pricingProvenance: pricingProvenanceSchema.optional(),
  costUsdExact: z.string().max(160).refine(value => { try { return !value.startsWith("-") && usdToUnits(value) >= 0n; } catch { return false; } }, "Invalid exact USD amount").nullable().optional(),
  providerRequestId: z.string().max(250).nullable().optional(), complete: z.boolean(),
});
const envelopeSchema = z.object({
  schema: z.literal("paperclip/accounting-receipt/v1"), id: z.string().uuid(), companyId: z.string().uuid(),
  runId: z.string().uuid(), sourceId: z.string().uuid(), sequence: z.number().int().positive(), receivedAt: z.iso.datetime(),
  adapterType: z.string().max(100), receipt: checkpointSchema,
});
export type UsageReceiptEnvelope = z.infer<typeof envelopeSchema>;
export const usageReceiptSpoolPath = () => path.join(resolvePaperclipInstanceRoot(), "accounting-receipts");

async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function spoolUsageReceipt(envelope: UsageReceiptEnvelope, directory = usageReceiptSpoolPath()) {
  const parsed = envelopeSchema.parse(envelope);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${parsed.id}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(parsed)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, target); await syncDirectory(directory);
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return target;
}

export async function persistUsageReceipt(db: Db, raw: UsageReceiptEnvelope) {
  const envelope = envelopeSchema.parse(raw);
  const hash = receiptFingerprint(envelope);
  return withAccountingTransaction(db, envelope.companyId, async tx => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, envelope.runId), eq(heartbeatRuns.companyId, envelope.companyId))).for("update");
    if (!run) throw notFound("Accounting run not found");
    const [existing] = await tx.select().from(runUsageReceipts).where(and(eq(runUsageReceipts.companyId, envelope.companyId), eq(runUsageReceipts.runId, envelope.runId), eq(runUsageReceipts.sourceId, envelope.sourceId), eq(runUsageReceipts.sequence, envelope.sequence)));
    if (existing && existing.receiptHash !== hash) throw conflict("Conflicting usage checkpoint replay");
    if (!existing) await tx.insert(runUsageReceipts).values({
      id: envelope.id, companyId: envelope.companyId, runId: envelope.runId, sourceId: envelope.sourceId,
      sequence: envelope.sequence, receiptHash: hash, receiptJson: envelope, complete: envelope.receipt.complete, receivedAt: new Date(envelope.receivedAt),
    });
    const previous = run.usageJson ?? {};
    // A restarted/replaced controller owns a fresh source. Old spool files
    // remain auditable but cannot overwrite its snapshots or acknowledged work.
    if (run.costAccountedAt || previous.accountingReceiptSourceId !== envelope.sourceId || Number(previous.accountingReceiptSequence ?? 0) >= envelope.sequence) return;
    const receipt = envelope.receipt;
    const billingType = receipt.billingType === "api" ? "metered_api" : receipt.billingType === "subscription" ? "subscription_included" : receipt.billingType ?? "unknown";
    await tx.update(heartbeatRuns).set({
      costAccountingPending: true,
      accountingLastError: null,
      usageJson: { ...previous, ...receipt.usage,
        provider: receipt.provider ?? "unknown", biller: receipt.biller ?? receipt.provider ?? "unknown", model: receipt.model ?? "unknown", billingType,
        costUsd: receipt.costUsd ?? null, costUsdExact: receipt.costUsdExact ?? null, cacheAdjustedCostUsd: receipt.cacheAdjustedCostUsd ?? null,
        usageByModel: receipt.usageByModel ?? null, usageSource: receipt.usageBasis ?? "per_run", providerRequestId: receipt.providerRequestId ?? null,
        accountingReceiptReady: receipt.complete && receipt.usageBasis !== "session_cumulative", accountingReceiptId: envelope.id,
        accountingReceiptSequence: envelope.sequence, accountingReceiptReceivedAt: envelope.receivedAt,
        costStatus: receipt.costStatus ?? null,
        pricingProvenance: receipt.pricingProvenance ?? { source: receipt.costUsd != null || receipt.costUsdExact != null ? "provider_reported" : "unknown", version: "accounting-receipt/v1" },
      },
    }).where(and(eq(heartbeatRuns.id, run.id), isNull(heartbeatRuns.costAccountedAt)));
  });
}

export async function replayUsageReceipts(db: Db, directory = usageReceiptSpoolPath(), limit = 100) {
  let files: string[];
  try { files = (await fs.readdir(directory)).filter(name => name.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { replayed: 0, failed: 0 }; throw error; }
  let replayed = 0, failed = 0;
  for (const name of files.slice(0, limit)) {
    const file = path.join(directory, name);
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Invalid accounting spool entry");
      await persistUsageReceipt(db, envelopeSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))));
      await fs.rm(file, { force: true }); replayed++;
    } catch (error) {
      failed++;
      // Rotate failures behind fresh entries without discarding the evidence.
      await fs.rename(file, path.join(directory, `retry-${Date.now()}-${randomUUID()}.json`)).catch(() => undefined);
      logger.error({ err: error, receiptFile: name }, "Accounting spool receipt remains pending");
    }
  }
  return { replayed, failed };
}

export async function createRunUsageRecorder(db: Db, input: { companyId: string; runId: string; adapterType: string }, directory = usageReceiptSpoolPath()) {
  const sourceId = randomUUID();
  // Verify durable storage before starting paid work, including a directory
  // sync. The database binding fences checkpoints from replaced controllers.
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const probe = await fs.open(path.join(directory, `${sourceId}.probe`), "wx", 0o600);
  try { await probe.sync(); } finally { await probe.close(); await fs.rm(path.join(directory, `${sourceId}.probe`)); }
  await syncDirectory(directory);
  const bound = await db.update(heartbeatRuns).set({ usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({ accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0 })}::jsonb` })
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), isNull(heartbeatRuns.costAccountedAt))).returning({ id: heartbeatRuns.id });
  if (bound.length !== 1) throw conflict("Run cannot accept a new usage recorder");
  let sequence = 0;
  let currentAttempt = "default";
  const attempts = new Map<string, AdapterUsageCheckpoint>();
  let chain = Promise.resolve();
  let captureFailed = false;
  async function capture(raw: AdapterUsageCheckpoint) {
    const parsed = checkpointSchema.parse(raw) as AdapterUsageCheckpoint;
    const attempt = parsed.attemptId ?? currentAttempt;
    if (!attempts.has(attempt)) currentAttempt = attempt;
    const previous = attempts.get(attempt);
    const priced = priceCodexReceipt({ ...parsed, usage: parsed.usage ?? previous?.usage,
      complete: parsed.complete && !(previous?.usage && !parsed.usage) });
    priced.pricingProvenance ??= {
      source: priced.costUsd != null || priced.costUsdExact != null || priced.cacheAdjustedCostUsd != null ? "provider_reported" : "unknown",
      version: "accounting-receipt/v1",
    };
    attempts.set(attempt, priced);
    const parts = [...attempts.values()];
    const latest = attempts.get(currentAttempt)!;
    const receipt: AdapterUsageCheckpoint = { ...latest, complete: latest.complete && !captureFailed, usage: {
      inputTokens: parts.reduce((sum, item) => sum + (item.usage?.inputTokens ?? 0), 0),
      cachedInputTokens: parts.reduce((sum, item) => sum + (item.usage?.cachedInputTokens ?? 0), 0),
      ...(parts.some(item => item.usage?.cacheWriteTokens !== undefined) ? { cacheWriteTokens: parts.reduce((sum, item) => sum + (item.usage?.cacheWriteTokens ?? 0), 0) } : {}),
      outputTokens: parts.reduce((sum, item) => sum + (item.usage?.outputTokens ?? 0), 0),
    } };
    if (parts.length > 1) {
      let total = 0n, priced = true;
      for (const part of parts) {
        const cost = part.cacheAdjustedCostUsd ?? part.costUsdExact ?? part.costUsd;
        if (cost == null) priced = false; else total += usdToUnits(cost);
      }
      if (new Set(parts.map(part => part.billingType ?? "unknown")).size > 1) receipt.billingType = "unknown";
      const decimal = `${total / 1_000_000_000n}.${String(total % 1_000_000_000n).padStart(9, "0")}`;
      receipt.costUsdExact = priced ? decimal : null;
      receipt.costUsd = priced ? Number(decimal) : null;
      receipt.cacheAdjustedCostUsd = null;
      receipt.usageByModel = undefined;
      receipt.costStatus = priced && parts.some(part => part.costStatus === "estimated") ? "estimated" : priced ? "reported" : "unpriced";
      receipt.pricingProvenance = { source: receipt.costStatus === "estimated" ? "rate_card" : "unknown", version: "per-attempt/v1", evidence: "Sum of attempted-run receipts; component prices are retained in the immutable receipt journal." };
      // Every attempted provider must supply a final receipt before the total
      // can be considered complete, even if a later attempt succeeded.
      receipt.complete = !captureFailed && parts.every(part => part.complete);
    }
    const envelope: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", id: randomUUID(), ...input, sourceId, sequence: ++sequence, receivedAt: new Date().toISOString(), receipt };
    const file = await spoolUsageReceipt(envelope, directory);
    try { await persistUsageReceipt(db, envelope); await fs.rm(file, { force: true }); }
    catch (error) { logger.warn({ err: error, runId: input.runId, receiptId: envelope.id }, "Usage receipt is durable on disk; database replay pending"); }
    return receipt;
  }
  return {
    capture: (receipt: AdapterUsageCheckpoint) => {
      const result = chain.then(() => capture(receipt)); chain = result.then(() => undefined, () => { captureFailed = true; }); return result;
    },
    complete: async (result: AdapterExecutionResult) => {
      await chain;
      return capture({ ...result, complete: result.usageComplete !== false });
    },
  };
}
