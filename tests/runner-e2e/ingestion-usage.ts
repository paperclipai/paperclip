import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readEvalCostLedger, validEvalLedgerId } from "./cost-ledger.js";
import { EVAL_OTLP_LIMITS } from "./eval-otlp-relay.js";
import { EVAL_FINALIZATION_LIMITS } from "./eval-finalization-relay.js";
import { EVAL_EXPERIMENT_LIMITS } from "./experiment-ingestion.js";

type Kind = "native" | "finalization" | "experiment";
interface ReceiptScope { kind: Kind; file: string; campaignId: string; projectId: string; attemptId?: string }
async function readReceipt(scope: ReceiptScope) {
  const bytes = await readFile(scope.file);
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Oversized ingestion receipt");
  const rows: Array<Record<string, any>> = [];
  let malformed = false;
  for (const line of bytes.toString("utf8").trim().split("\n")) {
    try { rows.push(JSON.parse(line)); }
    catch { malformed = true; break; }
  }
  const policy = rows[0], closed = rows.at(-1);
  const maximum = scope.kind === "native" ? EVAL_OTLP_LIMITS : scope.kind === "finalization" ? EVAL_FINALIZATION_LIMITS : EVAL_EXPERIMENT_LIMITS;
  const expanded = scope.kind !== "experiment" && policy?.version === 2;
  if (policy?.type !== "policy" || !(policy.version === 1 || expanded && policy.sizing === "otlp-v1.9-expanded-source-json")
      || policy.campaignId !== scope.campaignId || policy.projectId !== scope.projectId
      || (scope.kind === "experiment" ? policy?.kind !== "experiment" : policy?.attemptId !== scope.attemptId)) {
    throw new Error("Invalid ingestion receipt identity");
  }
  if (!policy.limits || Object.entries(maximum).filter(([key]) => expanded || !["maxExpandedBytes", "maxRecords"].includes(key))
    .some(([key, max]) => !Number.isSafeInteger(policy.limits[key])
      || policy.limits[key] < 1 || policy.limits[key] > max)) throw new Error("Invalid ingestion receipt limits");
  const admissions = new Map<string, { bodyBytes: number; scores: number }>();
  const outcomes = new Map<string, string>();
  let payloadBytes = 0, scores = 0, expandedBytes = 0, recordCount = 0;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.type === "admitted") {
      const scoreCount = scope.kind === "experiment" ? row.scores : 0;
      if (typeof row.id !== "string" || admissions.has(row.id) || !count(row.bodyBytes) || !count(scoreCount)
          || scope.kind !== "experiment" && row.bodyBytes > policy.limits.maxRequestBytes
          || expanded && (!count(row.expandedBytes) || !count(row.recordCount))
          || !/^[0-9a-f]{64}$/.test(row.payloadSha256)) throw new Error("Invalid ingestion admission");
      admissions.set(row.id, { bodyBytes: row.bodyBytes, scores: scoreCount });
      payloadBytes += row.bodyBytes; scores += scoreCount;
      if (expanded) { expandedBytes += row.expandedBytes; recordCount += row.recordCount; }
    } else if (row.type === "outcome") {
      const allowed = scope.kind === "experiment" ? ["response", "unconfirmed"] : ["accepted", "partial", "rejected", "uncertain", "not_dispatched"];
      if (!admissions.has(row.id) || outcomes.has(row.id) || !allowed.includes(row.outcome)
          || ["response", "accepted", "partial", "rejected"].includes(row.outcome)
            && (!Number.isInteger(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599)) throw new Error("Invalid ingestion outcome");
      outcomes.set(row.id, row.outcome);
    } else if (row.type === "closed") {
      if (index !== rows.length - 1 || row.admittedRequests !== admissions.size || row.admittedBytes !== payloadBytes
          || expanded && (row.admittedExpandedBytes !== expandedBytes || row.admittedRecords !== recordCount)
          || scope.kind === "experiment" && row.admittedScores !== scores || row.poisoned) throw new Error("Invalid ingestion closure");
    } else if (row.type !== "quota_exhausted" || scope.kind === "experiment") throw new Error("Unexpected ingestion record");
  }
  if (admissions.size > policy.limits.maxRequests || payloadBytes > policy.limits.maxTotalBytes
      || expanded && (expandedBytes > policy.limits.maxExpandedBytes || recordCount > policy.limits.maxRecords)
      || scope.kind === "experiment" && scores > policy.limits.maxScores) throw new Error("Ingestion allowance exceeded");
  const unresolved = [...admissions.keys()].filter(id => !outcomes.has(id) || ["uncertain", "unconfirmed"].includes(outcomes.get(id)!)).length;
  return { kind: scope.kind, ...(scope.attemptId ? { attemptId: scope.attemptId } : {}),
    receiptSha256: createHash("sha256").update(bytes).digest("hex"),
    status: !malformed && closed?.type === "closed" && unresolved === 0 ? "complete" : "incomplete",
    admittedRequests: admissions.size, admittedPayloadBytes: payloadBytes, admittedScores: scope.kind === "experiment" ? scores : null,
    admittedExpandedSourceBytes: expanded ? expandedBytes : null, admittedRecords: expanded ? recordCount : null,
    unresolvedRequests: unresolved };
}

export async function collectScheduledIngestion(input: {
  ledgerPath: string; campaignId: string; projectId: string; executionIds: string[];
}) {
  if (!input.executionIds.length || new Set(input.executionIds).size !== input.executionIds.length
      || !input.executionIds.every(validEvalLedgerId)) throw new Error("Invalid ingestion execution selection");
  const ledger = await readEvalCostLedger(input.ledgerPath);
  if (ledger.state.limits.campaignId !== input.campaignId) throw new Error("Ingestion ledger campaign mismatch");
  const attempts = ledger.state.snapshot().admittedAttempts;
  if (attempts.some(row => !input.executionIds.includes(row.executionId))) throw new Error("Foreign ingestion attempt");
  const missingExecutions = input.executionIds.filter(id => !attempts.some(row => row.executionId === id));
  const scopes: ReceiptScope[] = attempts.flatMap(row => {
    const name = createHash("sha256").update(row.attemptId).digest("hex");
    return (["native", "finalization"] as const).map(kind => ({ kind, attemptId: row.attemptId,
      campaignId: input.campaignId, projectId: input.projectId,
      file: path.join(`${input.ledgerPath}.otlp`, `${name}${kind === "finalization" ? "-finalization" : ""}.jsonl`) }));
  });
  scopes.push({ kind: "experiment", file: `${input.ledgerPath}.experiment-ingestion.jsonl`, campaignId: input.campaignId, projectId: input.projectId });
  const receipts = await Promise.all(scopes.map(async scope => {
    try { return await readReceipt(scope); }
    catch { return { kind: scope.kind, ...(scope.attemptId ? { attemptId: scope.attemptId } : {}), status: "unavailable" }; }
  }));
  const complete = missingExecutions.length === 0 && receipts.every(row => row.status === "complete");
  return { version: 1, campaignId: input.campaignId, projectId: input.projectId, ledgerHash: ledger.previous,
    status: complete ? "complete" : "incomplete", missingExecutions, receipts,
    observedAdmittedPayloadBytes: receipts.reduce((sum, row) => sum + ("admittedPayloadBytes" in row ? row.admittedPayloadBytes : 0), 0),
    totalAdmittedPayloadBytes: complete ? receipts.reduce((sum, row) => sum + ("admittedPayloadBytes" in row ? row.admittedPayloadBytes : 0), 0) : null,
    billedCostUsd: null, billingStatus: "unreconciled",
    scope: "Bounded attempt relay, controller finalization and retained experiment requests; not vendor processed bytes or provider model charges" };
}
