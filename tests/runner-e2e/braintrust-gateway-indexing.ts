import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EvalBraintrustConfig } from "./braintrust.js";
import { queryBraintrustRows } from "./braintrust-query.js";
import { readEvalCostLedger, validEvalLedgerId } from "./cost-ledger.js";

type Status = "verified" | "incomplete" | "unavailable";
interface ExpectedExecution { executionId: string; provider: "openai" | "anthropic"; model: string }
interface RequestIndex {
  requestId: string; executionId: string; attemptId: string; phase: string;
  status: Status; reason?: string; receiptSha256?: string;
  gatewayRowId?: string; spanId?: string; traceId?: string;
  campaignMetadataPresent?: boolean;
}
export interface BraintrustGatewayIndexReceipt {
  version: 1; projectId: string; campaignId: string; checkedAt: string;
  ledgerCheckpoint: string; status: Status; expectedRequests: number; verifiedRequests: number;
  requests: RequestIndex[];
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const spanIdentity = (value: unknown): value is string => uuid(value) || typeof value === "string" && /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(value) && !/^0+$/.test(value);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
async function readReceipt(file: string) {
  if ((await stat(file)).size > 262_144) throw new Error("Oversized gateway receipt");
  const bytes = await readFile(file);
  if (bytes.length > 262_144) throw new Error("Oversized gateway receipt");
  return { bytes, value: object(JSON.parse(bytes.toString("utf8"))) };
}

export async function verifyBraintrustGatewayIndexing(config: EvalBraintrustConfig, input: {
  ledgerPath: string; campaignId: string; expected: ExpectedExecution[];
}, transport: typeof fetch = fetch, options: { rounds?: number; pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<BraintrustGatewayIndexReceipt> {
  if (!uuid(config.projectId) || !config.apiKey?.trim() || /[\r\n]/.test(config.apiKey)
      || !path.isAbsolute(input.ledgerPath) || !validEvalLedgerId(input.campaignId)
      || !input.expected.length || input.expected.length > 1000 || new Set(input.expected.map(row => row.executionId)).size !== input.expected.length
      || input.expected.some(row => !validEvalLedgerId(row.executionId) || !validEvalLedgerId(row.model) || !["openai", "anthropic"].includes(row.provider))) {
    throw new Error("Invalid gateway index scope");
  }
  const rounds = options.rounds ?? 3;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("Invalid gateway index verification limit");
  const ledger = await readEvalCostLedger(input.ledgerPath);
  if (ledger.state.limits.campaignId !== input.campaignId) throw new Error("Gateway index campaign mismatch");
  const expected = new Map(input.expected.map(row => [row.executionId, row]));
  const modelRequests = [...ledger.state.requests].filter(([, request]) => request.identity.phase !== "infrastructure");
  if (modelRequests.length > 1000 || modelRequests.some(([id, request]) => !uuid(id) || !expected.has(request.identity.executionId))) {
    throw new Error("Gateway index request selection mismatch");
  }
  const receipt: BraintrustGatewayIndexReceipt = { version: 1, projectId: config.projectId, campaignId: input.campaignId,
    checkedAt: new Date().toISOString(), ledgerCheckpoint: ledger.previous, status: "incomplete",
    expectedRequests: modelRequests.length, verifiedRequests: 0, requests: [] };
  for (const [requestId, request] of modelRequests) {
    const row: RequestIndex = { requestId, ...request.identity, status: "incomplete" };
    receipt.requests.push(row);
    if (!request.finished) { row.reason = "request_in_flight"; continue; }
    try {
      const { bytes, value } = await readReceipt(path.join(`${input.ledgerPath}.requests`, `${requestId}.json`));
      row.receiptSha256 = digest(bytes);
      const planned = expected.get(request.identity.executionId)!;
      if (value.requestId !== requestId || value.route !== "braintrust"
          || request.observations.some(observation => observation.route !== "braintrust" || observation.provider !== planned.provider
            || observation.model !== undefined && observation.model !== planned.model)
          || object(value.usage).provider !== undefined && object(value.usage).provider !== planned.provider
          || object(value.usage).model !== undefined && object(value.usage).model !== planned.model) {
        row.reason = "receipt_identity_conflict"; continue;
      }
      if (!uuid(value.gatewaySpanId)) { row.reason = "missing_gateway_row_id"; continue; }
      row.gatewayRowId = value.gatewaySpanId;
      row.reason = "row_not_indexed";
    } catch { row.status = "unavailable"; row.reason = "receipt_unavailable"; }
  }
  const rowIds = new Map<string, RequestIndex[]>();
  for (const row of receipt.requests) if (row.gatewayRowId) rowIds.set(row.gatewayRowId, [...(rowIds.get(row.gatewayRowId) ?? []), row]);
  for (const rows of rowIds.values()) if (rows.length !== 1) for (const row of rows) row.reason = "duplicate_gateway_row_id";
  const signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(options.signal ? [options.signal] : [])]);
  const pause = options.pause ?? (() => delay(2_000, undefined, { signal }));
  for (let round = 0; round < rounds && !signal.aborted; round++) {
    const pending = receipt.requests.filter(row => row.reason === "row_not_indexed" || row.reason === "query_unavailable");
    if (!pending.length) break;
    for (let offset = 0; offset < pending.length && !signal.aborted; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      try {
        const rows = await queryBraintrustRows(config, `SELECT id, span_id, root_span_id, metadata.provider AS provider, metadata.model AS model, metadata.paperclip_eval_request_id AS request_id, metadata.paperclip_eval_campaign_id AS campaign_id, metadata.paperclip_eval_execution_id AS execution_id, metadata.paperclip_eval_attempt_id AS attempt_id, metadata.paperclip_eval_phase AS phase FROM project_logs('${config.projectId}') WHERE id IN (${batch.map(row => `'${row.gatewayRowId}'`).join(",")}) LIMIT ${batch.length + 1}`, transport, signal);
        if (rows.length > batch.length || rows.some(row => !batch.some(expected => expected.gatewayRowId === row.id))) throw new Error("Unexpected gateway index rows");
        for (const row of batch) {
          const matches = rows.filter(value => value.id === row.gatewayRowId);
          row.status = "incomplete"; row.reason = "row_not_indexed";
          if (!matches.length) continue;
          const found = matches[0]!, planned = expected.get(row.executionId)!;
          const identity = { request_id: row.requestId, campaign_id: input.campaignId,
            execution_id: row.executionId, attempt_id: row.attemptId, phase: row.phase };
          if (matches.length !== 1 || !spanIdentity(found.span_id) || !spanIdentity(found.root_span_id)
              || found.model !== planned.model || found.provider !== planned.provider
              || Object.entries(identity).some(([field, value]) => found[field] != null && found[field] !== value)) {
            row.reason = "indexed_identity_conflict"; continue;
          }
          row.status = "verified"; delete row.reason;
          row.spanId = found.span_id; row.traceId = found.root_span_id;
          row.campaignMetadataPresent = Object.entries(identity).every(([field, value]) => found[field] === value);
        }
      } catch { for (const row of batch) { row.status = "unavailable"; row.reason = "query_unavailable"; } }
    }
    if (round + 1 < rounds && receipt.requests.some(row => ["row_not_indexed", "query_unavailable"].includes(row.reason ?? "")) && !signal.aborted) {
      try { await pause(); } catch { break; }
    }
  }
  for (const row of receipt.requests) if (row.receiptSha256) {
    try {
      const { bytes } = await readReceipt(path.join(`${input.ledgerPath}.requests`, `${row.requestId}.json`));
      if (digest(bytes) !== row.receiptSha256) throw new Error("Gateway receipt changed");
    } catch { row.status = "unavailable"; row.reason = "receipt_changed"; }
  }
  const after = await readEvalCostLedger(input.ledgerPath);
  if (after.previous !== ledger.previous || after.sequence !== ledger.sequence) {
    for (const row of receipt.requests) { row.status = "unavailable"; row.reason = "ledger_changed"; }
  }
  receipt.checkedAt = new Date().toISOString();
  receipt.verifiedRequests = receipt.requests.filter(row => row.status === "verified").length;
  receipt.status = receipt.expectedRequests > 0 && receipt.verifiedRequests === receipt.expectedRequests ? "verified"
    : signal.aborted || receipt.requests.some(row => row.status === "unavailable") ? "unavailable" : "incomplete";
  return receipt;
}
