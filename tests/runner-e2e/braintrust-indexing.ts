import { setTimeout as delay } from "node:timers/promises";
import { queryBraintrustRows as query } from "./braintrust-query.js";
import { buildBraintrustExperiment, experimentEvidenceHash, type BraintrustExperimentReceipt } from "./braintrust-experiment.js";
import { exportBraintrustAttemptParent, type EvalBraintrustConfig } from "./braintrust.js";
import type { RunnerE2ECampaign, RunnerE2EResult } from "./types.js";

type IndexStatus = "verified" | "incomplete" | "unavailable";
export interface BraintrustIndexReceipt {
  version: 1; projectId: string; evidenceHash: string; checkedAt: string;
  status: IndexStatus;
  traces: Array<{ attemptId: string; traceId: string | null; status: IndexStatus;
    records?: number; roots?: number; finalizations?: number; nativeApiRecords?: number;
    complaints?: number; suggestions?: number }>;
  experiment: { id: string | null; status: IndexStatus; expectedRows: number; indexedRows?: number };
}


export function braintrustTraceIndexQuery(projectId: string, result: RunnerE2EResult): string {
  const trace = result.tracing;
  if (!trace || trace.projectId !== projectId || !/^[0-9a-f]{16}$/.test(trace.finalization?.spanId ?? "")) throw new Error("Missing trace identity");
  exportBraintrustAttemptParent(trace);
  if (!(result.profileId === "runner-codex" && result.provider === "codex")
      && !(result.profileId === "runner-acpx-claude" && result.provider === "acpx")) throw new Error("Unsupported native index contract");
  const nativeRequest = result.profileId === "runner-codex" ? `metadata."event.name" = 'codex.api_request'`
    : `span_attributes.name = 'claude_code.llm_request' AND span_attributes.type = 'llm'`;
  const tool = (name: string) => result.profileId === "runner-codex"
    ? `metadata."event.name" = 'codex.tool_result' AND metadata.tool_name = '${name}' AND metadata.success = 'true'`
    : `span_attributes.type = 'tool' AND span_attributes.name = 'mcp__paperclip__${name}'`;
  return `SELECT COUNT(*) AS records,
    SUM(CASE WHEN span_id = '${trace.spanId}' AND span_attributes.name = 'paperclip.eval.attempt' THEN 1 ELSE 0 END) AS roots,
    SUM(CASE WHEN span_id = '${trace.finalization!.spanId}' AND span_attributes.name = 'paperclip.eval.finalization' THEN 1 ELSE 0 END) AS finalizations,
    SUM(CASE WHEN ${nativeRequest} THEN 1 ELSE 0 END) AS native_api_records,
    SUM(CASE WHEN ${tool("submit_complaint")} THEN 1 ELSE 0 END) AS complaints,
    SUM(CASE WHEN ${tool("submit_suggestion")} THEN 1 ELSE 0 END) AS suggestions
    FROM project_logs('${projectId}') WHERE root_span_id = '${trace.traceId}'`;
}

function counts(rows: Record<string, unknown>[]) {
  if (rows.length !== 1) throw new Error("Invalid trace aggregate");
  const row = rows[0]!;
  const fields = ["records", "roots", "finalizations", "native_api_records", "complaints", "suggestions"];
  if (row.records === 0) for (const key of fields.slice(1)) if (row[key] === null) row[key] = 0;
  if (fields.some(key => !Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) throw new Error("Invalid trace counts");
  return { records: Number(row.records), roots: Number(row.roots), finalizations: Number(row.finalizations),
    nativeApiRecords: Number(row.native_api_records), complaints: Number(row.complaints), suggestions: Number(row.suggestions) };
}

export async function verifyBraintrustIndexing(config: EvalBraintrustConfig, campaign: RunnerE2ECampaign,
  originals: readonly RunnerE2EResult[], experiment: BraintrustExperimentReceipt | undefined,
  transport: typeof fetch = fetch, options: { rounds?: number; pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<BraintrustIndexReceipt> {
  const plan = buildBraintrustExperiment(config.projectId, campaign, originals);
  const receipt: BraintrustIndexReceipt = { version: 1, projectId: config.projectId,
    evidenceHash: experimentEvidenceHash(campaign), checkedAt: new Date().toISOString(), status: "incomplete",
    traces: originals.map(result => ({ attemptId: result.accountingIdentity!.attemptId,
      traceId: result.tracing?.traceId ?? null, status: "incomplete" })),
    experiment: { id: experiment?.experimentId ?? null, status: "incomplete", expectedRows: plan.events.length } };
  if (!config.apiKey?.trim() || /[\r\n]/.test(config.apiKey)) throw new Error("Missing Braintrust query credential");
  const rounds = options.rounds ?? 3;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("Invalid index verification limit");
  const signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(options.signal ? [options.signal] : [])]);
  const pause = options.pause ?? (() => delay(2_000, undefined, { signal }));
  for (let round = 0; round < rounds && !signal.aborted; round++) {
    for (let index = 0; index < originals.length && !signal.aborted; index++) {
      const result = originals[index]!, row = receipt.traces[index]!;
      if (row.status === "verified") continue;
      try {
        const values = counts(await query(config, braintrustTraceIndexQuery(config.projectId, result), transport, signal));
        Object.assign(row, values);
        row.status = values.roots > 0 && values.finalizations > 0 && values.nativeApiRecords > 0
          && (result.feedback?.complaints ?? 0) <= values.complaints
          && (result.feedback?.suggestions ?? 0) <= values.suggestions ? "verified" : "incomplete";
      } catch { row.status = "unavailable"; }
    }
    if (!signal.aborted && receipt.experiment.status !== "verified" && experiment?.status === "accepted"
        && experiment.projectId === config.projectId && /^[0-9a-f-]{36}$/.test(experiment.experimentId)
        && experiment.payloadHash === plan.payloadHash && experiment.evidenceHash === receipt.evidenceHash) {
      try {
        const rows = await query(config, `SELECT id, input, output, scores, metadata FROM experiment('${experiment.experimentId}') LIMIT ${plan.events.length + 1}`, transport, signal);
        receipt.experiment.indexedRows = rows.length;
        const equal = (left: unknown, right: unknown): boolean => {
          if (left === right) return true;
          if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return false;
          const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
          return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => equal(a[key], b[key]));
        };
        receipt.experiment.status = rows.length === plan.events.length && new Set(rows.map(row => row.id)).size === rows.length
          && plan.events.every(expected => rows.some(row => row.id === expected.id && equal(row.input, expected.input)
            && equal(row.output, expected.output) && equal(row.scores, expected.scores)
            && (row.metadata as Record<string, unknown> | undefined)?.attempt_id === expected.metadata.attempt_id)) ? "verified" : "incomplete";
      } catch { receipt.experiment.status = "unavailable"; }
    }
    if (receipt.experiment.status === "verified" && receipt.traces.every(row => row.status === "verified")) break;
    if (round + 1 < rounds && !signal.aborted) { try { await pause(); } catch { break; } }
  }
  receipt.checkedAt = new Date().toISOString();
  const statuses = [...receipt.traces.map(row => row.status), receipt.experiment.status];
  receipt.status = statuses.every(status => status === "verified") ? "verified"
    : statuses.some(status => status === "unavailable") || signal.aborted ? "unavailable" : "incomplete";
  return receipt;
}
