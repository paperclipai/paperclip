import { randomBytes } from "node:crypto";
import { finalizeEvalAttemptTrace, type EvalBraintrustConfig, type EvalFinalizationReceipt } from "./braintrust.js";
import { startEvalOtlpRelay } from "./eval-otlp-relay.js";

export const EVAL_FINALIZATION_LIMITS = { maxRequests: 1, maxRequestBytes: 64 * 1024,
  maxTotalBytes: 64 * 1024, maxConcurrent: 1, maxExpandedBytes: 1024 * 1024, maxRecords: 256 } as const;

export async function finalizeEvalAttemptThroughRelay(config: EvalBraintrustConfig,
  input: Parameters<typeof finalizeEvalAttemptTrace>[1], receiptPath: string, transport?: typeof fetch): Promise<EvalFinalizationReceipt> {
  let relay: Awaited<ReturnType<typeof startEvalOtlpRelay>> | undefined;
  let receipt: EvalFinalizationReceipt = { spanId: randomBytes(8).toString("hex"), status: "failed",
    outcome: input.result.status === "passed" && input.result.cleanup === "passed" ? "passed" : "failed", verification: "unverified" };
  try {
    relay = await startEvalOtlpRelay({ projectId: config.projectId, apiKey: config.apiKey,
      campaignId: input.identity.campaignId, attemptId: input.identity.attemptId, receiptPath,
      deadlineAt: Date.now() + 30_000, limits: EVAL_FINALIZATION_LIMITS, transport });
    receipt = await finalizeEvalAttemptTrace({ ...config, apiKey: relay.token, endpointBaseUrl: relay.baseUrl }, input);
  } catch { receipt.errorCode = "finalization_ingestion_unavailable"; }
  finally {
    try { await relay?.close(); }
    catch { receipt.status = "failed"; receipt.errorCode = "finalization_ingestion_persistence_failed"; }
  }
  return receipt;
}
