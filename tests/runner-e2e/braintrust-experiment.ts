import { evalAccountingStatus } from "./operations-report.js";
import { createHash } from "node:crypto";
import { buildCampaignAccounting } from "./attempt-accounting.js";
import { exportBraintrustAttemptParent, type EvalBraintrustConfig } from "./braintrust.js";
import { validateCampaignFeedbackReview } from "./feedback-dispositions.js";
import { validateEvalOperationsReport } from "./operations-report.js";
import { html, isPublicReportTimestamp } from "./report-format.js";
import type { RunnerE2ECampaign, RunnerE2EResult } from "./types.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
const modelName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@=,\[\]-]{0,255}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const invalid = (): never => { throw new Error("Invalid retained experiment evidence"); };

function attemptProjection(result: RunnerE2EResult, projectId: string) {
  if (result.schema !== "paperclip.runner-e2e.result/v2"
      || ![result.executionId, result.suiteId, result.profileId, result.caseId, result.provider,
        result.accountingIdentity?.campaignId, result.accountingIdentity?.attemptId].every(identifier)
      || !modelName(result.model)
      || !/^[0-9a-f]{64}$/.test(result.suiteDefinitionHash ?? "") || !/^[0-9a-f]{40}$/.test(result.source?.sha ?? "")
      || !count(result.attempt) || result.attempt < 1 || !count(result.durationMs)
      || !["passed", "failed"].includes(result.status) || !["passed", "failed", "not_started"].includes(result.cleanup)
      || !["native", "legacy"].includes(result.runtimeMode) || !["local", "daytona"].includes(result.environmentId)
      || !isPublicReportTimestamp(result.startedAt) || !isPublicReportTimestamp(result.finishedAt)
      || Date.parse(result.finishedAt) < Date.parse(result.startedAt)) invalid();
  const feedback = result.feedback;
  if (feedback && (![feedback.complaints, feedback.suggestions, feedback.invocations?.failed, feedback.invocations?.unknown].every(count)
      || !["complete", "partial", "unavailable", "not_started"].includes(feedback.collection)
      || !["complete", "partial", "unavailable", "not_started"].includes(feedback.invocationCollection))) invalid();
  const trace = result.tracing;
  if (trace) {
    exportBraintrustAttemptParent(trace);
    if (trace.projectId !== projectId || !["pending", "accepted", "failed"].includes(trace.status)) invalid();
  }
  return {
    input: { execution_id: result.executionId, suite_id: result.suiteId, profile_id: result.profileId,
      case_id: result.caseId, provider: result.provider, model: result.model, environment: result.environmentId,
      runtime: result.runtimeMode, source_revision: result.source!.sha, definition_hash: result.suiteDefinitionHash },
    output: { product: result.status, cleanup: result.cleanup },
    scores: { product_pass: Number(result.status === "passed"), cleanup_pass: Number(result.cleanup === "passed") },
    metrics: { start: Date.parse(result.startedAt) / 1000, end: Date.parse(result.finishedAt) / 1000 },
    metadata: { campaign_id: result.accountingIdentity!.campaignId, attempt_id: result.accountingIdentity!.attemptId,
      attempt_number: result.attempt, wall_duration_ms: result.durationMs, grader: "tests/runner-e2e/runner.spec.ts",
      feedback: feedback ? { collection: feedback.collection, invocation_collection: feedback.invocationCollection,
        complaints: feedback.complaints, suggestions: feedback.suggestions,
        failed_submissions: feedback.invocations.failed, unresolved_submissions: feedback.invocations.unknown } : null,
      trace: trace ? { project_id: trace.projectId, root_span_id: trace.traceId, span_id: trace.spanId,
        export_status: trace.status, indexed_verification: "unverified" } : null },
    span_attributes: { name: result.executionId, type: "eval" },
  };
}

export function buildBraintrustExperiment(projectId: string, campaign: RunnerE2ECampaign, originals: readonly RunnerE2EResult[]) {
  if (!uuid.test(projectId) || campaign.schema !== "paperclip.runner-e2e.campaign/v2" || !identifier(campaign.campaignId)
      || campaign.accounting?.scope !== "retained_attempts" || !Array.isArray(campaign.accounting.attempts)
      || !count(campaign.accounting.missingAttempts) || !Array.isArray(campaign.expected)
      || campaign.expected.length === 0 || !campaign.expected.every(identifier)
      || new Set(campaign.expected).size !== campaign.expected.length || !Array.isArray(originals)
      || originals.length > 10_000 || campaign.accounting.attempts.length === 0) invalid();
  if (campaign.operations) validateEvalOperationsReport(campaign.operations);
  if (campaign.feedbackReview) validateCampaignFeedbackReview(campaign, campaign.feedbackReview);
  const accounting = campaign.accounting!;
  const operations = campaign.operations?.status !== "unavailable" ? campaign.operations : undefined;
  if (operations && operations.ledgerCampaignId !== campaign.campaignId) invalid();
  const candidates = new Map<string, { original: RunnerE2EResult; projection: ReturnType<typeof attemptProjection> }>();
  for (const original of originals) {
    const projection = attemptProjection(original, projectId);
    if (!campaign.expected.includes(original.executionId)) invalid();
    const receipt = buildCampaignAccounting({ results: [original] }).attempts[0]!;
    const retained = accounting.attempts.find(attempt => attempt.id === receipt.id);
    if (!retained || JSON.stringify(retained) !== JSON.stringify(receipt)) invalid();
    const previous = candidates.get(receipt.id);
    if (previous && digest(previous.projection) !== digest(projection)) invalid();
    candidates.set(receipt.id, { original, projection });
  }
  if (candidates.size !== accounting.attempts.length) invalid();
  for (const selected of campaign.results.filter(result => result.attempt > 0)) {
    const id = buildCampaignAccounting({ results: [selected] }).attempts[0]!.id;
    const original = candidates.get(id);
    const selectedProjection = attemptProjection(selected, projectId);
    if (!original || digest(original.projection.input) !== digest(selectedProjection.input)
        || digest(original.projection.metrics) !== digest(selectedProjection.metrics)
        || digest(original.projection.metadata) !== digest(selectedProjection.metadata)) invalid();
  }
  const events = [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, { original, projection }]) => {
    const cost = operations && original.accountingIdentity!.campaignId === operations.ledgerCampaignId
      ? operations.attempts.find(row => row.executionId === original.executionId && row.attemptId === original.accountingIdentity!.attemptId)
      : undefined;
    return { ...projection, id, span_id: id, root_span_id: id,
      metadata: { ...projection.metadata, request_ledger: cost ? {
        known_usd: cost.knownUsd, additional_held_usd: cost.heldUsd, requests: cost.requests,
        unresolved_requests: cost.unresolvedRequests, journal_hash: operations!.journalHash,
      } : null } };
  });
  const metadata = { importer: "paperclip-retained-attempts-v1", campaign_id: campaign.campaignId,
    expected_execution_ids: [...campaign.expected].sort(), retained_attempts: events.length,
    missing_attempts: accounting.missingAttempts,
    request_ledger: operations ? { journal_hash: operations.journalHash, known_usd: operations.knownUsd,
      additional_held_usd: operations.heldUsd, committed_usd: operations.committedUsd,
      accounting_status: evalAccountingStatus(operations), bounded_unresolved_requests: operations.boundedUnresolvedRequests ?? 0,
      requests: operations.requests, unresolved_requests: operations.unresolvedRequests, breakdown: operations.breakdown } : null,
    feedback_review: campaign.feedbackReview ?? null,
    accounting_note: "Ledger amounts are separate observations, not additive trace metrics. Held reservations are not charges. Requests outside the gateway and infrastructure require separate accounting." };
  const payloadHash = digest({ projectId, metadata, events });
  return { projectId, payloadHash, name: `${campaign.campaignId}-${payloadHash}`, metadata: { ...metadata, payload_hash: payloadHash }, events };
}

export interface BraintrustExperimentReceipt {
  version: 1; projectId: string; experimentId: string; name: string; payloadHash: string;
  status: "created" | "accepted"; acceptedRows: number; expectedRows: number; verification: "unverified";
  evidenceHash: string; projectUrl?: string; experimentUrl?: string;
}

export function experimentEvidenceHash(campaign: RunnerE2ECampaign) {
  return digest({ campaignId: campaign.campaignId, expected: [...campaign.expected].sort(),
    selected: campaign.results.map(result => ({ executionId: result.executionId, accountingIdentity: result.accountingIdentity,
      attempt: result.attempt, startedAt: result.attempt === 0 ? null : result.startedAt, sourceRevision: result.source?.sha ?? null,
      suiteDefinitionHash: result.suiteDefinitionHash ?? null, suiteId: result.suiteId, profileId: result.profileId,
      caseId: result.caseId, provider: result.provider, model: result.model, environmentId: result.environmentId,
      runtimeMode: result.runtimeMode })).sort((a, b) => digest(a).localeCompare(digest(b))),
    accounting: campaign.accounting, operations: campaign.operations ?? null, feedbackReview: campaign.feedbackReview ?? null });
}

function safeBraintrustUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["braintrust.dev", "www.braintrust.dev"].includes(url.host)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith("/app/");
  } catch { return false; }
}

export function validateBraintrustExperimentReceipt(campaign: RunnerE2ECampaign, receipt: BraintrustExperimentReceipt): void {
  if (!receipt || Object.keys(receipt).some(key => !["version", "projectId", "experimentId", "name", "payloadHash", "status", "acceptedRows", "expectedRows", "verification", "evidenceHash", "projectUrl", "experimentUrl"].includes(key))
      || receipt.version !== 1 || !uuid.test(receipt.projectId) || !uuid.test(receipt.experimentId)
      || receipt.evidenceHash !== experimentEvidenceHash(campaign) || !/^[a-f0-9]{64}$/.test(receipt.payloadHash)
      || receipt.name !== `${campaign.campaignId}-${receipt.payloadHash}` || !["created", "accepted"].includes(receipt.status)
      || !count(receipt.acceptedRows) || receipt.expectedRows !== campaign.accounting?.attempts.length
      || receipt.acceptedRows > receipt.expectedRows || receipt.verification !== "unverified"
      || receipt.status === "accepted" && receipt.acceptedRows !== receipt.expectedRows
      || receipt.experimentUrl !== undefined && !safeBraintrustUrl(receipt.experimentUrl)
      || receipt.projectUrl !== undefined && !safeBraintrustUrl(receipt.projectUrl)) invalid();
}

export function renderBraintrustExperiment(campaign: RunnerE2ECampaign): string {
  const receipt = campaign.braintrustExperiment;
  if (!receipt) return "";
  validateBraintrustExperimentReceipt(campaign, receipt);
  return `<section aria-label="Braintrust experiment"><h2>Braintrust experiment</h2><p>${receipt.experimentUrl
    ? `<a href="${html(receipt.experimentUrl)}">Open retained attempt scores in Braintrust</a>`
    : `Experiment ${html(receipt.experimentId)}`}. ${receipt.acceptedRows}/${receipt.expectedRows} rows accepted.
    Original product and cleanup grades are separate. Indexing requires independent verification; no agents were rerun for this import.</p></section>`;
}

async function request(config: EvalBraintrustConfig, endpoint: string, payload: unknown, transport: typeof fetch) {
  const response = await transport(`https://api.braintrust.dev/v1/${endpoint}`, {
    method: payload === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    if (!response.ok) throw new Error("rejected");
    while (reader) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > 1_048_576) throw new Error("oversized");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } finally { await reader?.cancel().catch(() => {}); }
}

export async function importBraintrustExperiment(config: EvalBraintrustConfig, campaign: RunnerE2ECampaign,
  originals: readonly RunnerE2EResult[], persist: (receipt: BraintrustExperimentReceipt) => Promise<void>, transport: typeof fetch = fetch,
  previous?: BraintrustExperimentReceipt) {
  const plan = buildBraintrustExperiment(config.projectId, campaign, originals);
  if (!config.apiKey?.trim() || /[\r\n]/.test(config.apiKey)) throw new Error("Missing Braintrust ingestion credential");
  if (previous) {
    validateBraintrustExperimentReceipt(campaign, previous);
    if (previous.projectId !== plan.projectId || previous.payloadHash !== plan.payloadHash) invalid();
  }
  try {
    const created = await request(config, "experiment", { project_id: plan.projectId, name: plan.name,
      public: false, ensure_new: false, metadata: plan.metadata }, transport);
    if (!uuid.test(String(created?.id)) || created.project_id !== plan.projectId || created.name !== plan.name || created.public !== false
        || (created.metadata as Record<string, unknown> | undefined)?.payload_hash !== plan.payloadHash) throw new Error("conflicting_experiment");
    if (previous && previous.experimentId !== created.id) throw new Error("conflicting_experiment");
    const receipt: BraintrustExperimentReceipt = previous ? { ...previous } : { version: 1, projectId: plan.projectId, experimentId: String(created.id),
      name: plan.name, payloadHash: plan.payloadHash, evidenceHash: experimentEvidenceHash(campaign),
      status: "created", acceptedRows: 0, expectedRows: plan.events.length, verification: "unverified" };
    if (!previous) await persist({ ...receipt });
    for (let offset = 0; offset < plan.events.length; offset += 100) {
      const events = plan.events.slice(offset, offset + 100);
      const inserted = await request(config, `experiment/${receipt.experimentId}/insert`, { events }, transport);
      if (!Array.isArray(inserted?.row_ids) || JSON.stringify([...inserted.row_ids].sort()) !== JSON.stringify(events.map(event => event.id).sort())) throw new Error("missing_rows");
      receipt.acceptedRows = Math.max(receipt.acceptedRows, offset + events.length);
      if (receipt.acceptedRows === receipt.expectedRows) receipt.status = "accepted";
      await persist({ ...receipt });
    }
    const summary = await request(config, `experiment/${receipt.experimentId}/summarize`, undefined, transport).catch(() => undefined);
    if (summary?.experiment_name === plan.name && safeBraintrustUrl(summary.project_url) && safeBraintrustUrl(summary.experiment_url)) {
      receipt.projectUrl = summary.project_url; receipt.experimentUrl = summary.experiment_url;
      await persist({ ...receipt });
    }
    return receipt;
  } catch { throw new Error("Braintrust experiment import incomplete; retain the receipt and retry identical evidence. Remote details withheld."); }
}
