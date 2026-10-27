import { usdToUnits } from "../../packages/shared/src/money.js";
import { evalAccountingStatus } from "./operations-report.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evalBraintrustConfig } from "./braintrust.js";
import { openExperimentIngestion } from "./experiment-ingestion.js";
import { collectScheduledIngestion } from "./ingestion-usage.js";
import { importBraintrustExperiment, type BraintrustExperimentReceipt } from "./braintrust-experiment.js";
import { verifyBraintrustIndexing } from "./braintrust-indexing.js";
import { verifyBraintrustGatewayIndexing } from "./braintrust-gateway-indexing.js";
import { runnerMatrix } from "./catalog.js";
import { feedbackReviewTemplate, validateCampaignFeedbackReview, type CampaignFeedbackReview } from "./feedback-dispositions.js";
import { expectedFixtureFeedback } from "./feedback-persistence.js";
import { feedbackReview, summarizeCampaignFeedback, type FeedbackEvidence } from "./feedback.js";
import type { EvalOperationsManifest } from "./operations.js";
import type { RunnerE2ECampaign, RunnerE2EResult } from "./types.js";

export function reviewScheduledFeedback(campaign: RunnerE2ECampaign,
  evidence: Array<{ result: RunnerE2EResult; feedback: FeedbackEvidence | null }>, now: string): CampaignFeedbackReview {
  const synthetic = new Set<string>();
  for (const { result, feedback } of evidence) {
    if (result.suiteId !== "feedback-persistence" || !feedback || result.feedback?.collection !== "complete"
        || result.feedback.invocationCollection !== "complete") continue;
    const marker = result.matcherResults?.find(row => row.matcher.kind === "message_exact")?.matcher;
    const nonce = marker?.kind === "message_exact" ? /^PAPERCLIP_E2E_OK_([a-z0-9]+-[1-9][0-9]*)$/.exec(marker.expected)?.[1] : undefined;
    if (!nonce) continue;
    const checks = ["complete-retained-evidence", "one-of-each", "complaint-body-and-attribution", "complaint-completed-tool",
      "suggestion-body-and-attribution", "suggestion-completed-tool", "only-expected-submissions"];
    if (!checks.every(id => result.matcherResults?.some(row => row.matcher.kind === "json_path"
        && row.matcher.path === `feedbackPersistence.${id}` && row.passed))) continue;
    const bodies = expectedFixtureFeedback(nonce);
    if (feedback.entries.length !== 2 || !["complaint", "suggestion"].every(kind => feedback.entries.filter(entry =>
      entry.kind === kind && entry.body === bodies[kind as keyof typeof bodies]).length === 1)) continue;
    for (const group of feedbackReview(feedback.entries)) synthetic.add(group.fingerprint);
  }
  const template = feedbackReviewTemplate(campaign);
  const review: CampaignFeedbackReview = { ...template, version: 1, reviewedAt: now, reviewedBy: "agent",
    decisions: template.decisions.map(row => ({ fingerprint: row.fingerprint,
      disposition: synthetic.has(row.fingerprint) ? "unsupported" : "needs_investigation" })) };
  validateCampaignFeedbackReview(campaign, review);
  return review;
}

export function scheduledCampaignFindings(campaign: RunnerE2ECampaign): string[] {
  const findings: string[] = [];
  if (campaign.failed || campaign.results.length !== campaign.expected.length || campaign.accounting?.missingAttempts) findings.push("product_or_missing_attempt");
  if (campaign.accounting?.attempts.some(row => row.cleanup !== "passed")) findings.push("cleanup_failure");
  const operations = campaign.operations;
  if (!operations || operations.status === "unavailable") findings.push("accounting_unavailable");
  else {
    if (evalAccountingStatus(operations) === "blocked") findings.push("accounting_incomplete");
    if (usdToUnits(operations.committedUsd) > usdToUnits(operations.limitUsd)) findings.push("accounting_over_budget");
  }
  const feedback = summarizeCampaignFeedback(campaign.accounting?.attempts ?? campaign.results);
  if (feedback.incomplete || feedback.failedSubmissions || feedback.unknownSubmissions) findings.push("feedback_collection_incomplete");
  if (!campaign.feedbackReview || campaign.feedbackReview.decisions.some(row => ["actionable", "needs_investigation"].includes(row.disposition))) findings.push("feedback_needs_review");
  if (campaign.results.some(row => row.tracing?.status !== "accepted" || row.tracing.nativeConfiguration !== "configured"
      || row.tracing.finalization?.status !== "accepted")) findings.push("trace_export_incomplete");
  return findings;
}

export async function finalizeScheduledCampaign(env: NodeJS.ProcessEnv) {
  if (!env.PAPERCLIP_E2E_OPERATIONS_MANIFEST || !env.GITHUB_WORKSPACE) throw new Error("Missing scheduled campaign manifest");
  const manifest = JSON.parse(await readFile(env.PAPERCLIP_E2E_OPERATIONS_MANIFEST, "utf8")) as EvalOperationsManifest;
  const directory = path.dirname(env.PAPERCLIP_E2E_OPERATIONS_MANIFEST);
  const root = path.join(env.GITHUB_WORKSPACE, "tests/runner-e2e/results", manifest.limits.campaignId);
  const campaign = JSON.parse(await readFile(path.join(root, "campaign.json"), "utf8")) as RunnerE2ECampaign;
  const originals: RunnerE2EResult[] = [], evidence: Array<{ result: RunnerE2EResult; feedback: FeedbackEvidence | null }> = [];
  for (const selected of campaign.results) {
    if (selected.attempt < 1) continue;
    if (!manifest.executionIds.includes(selected.executionId) || selected.attempt !== 1) throw new Error("Unexpected scheduled attempt");
    const resultPath = path.join(root, ...selected.executionId.split("."), "attempt-1");
    const result = JSON.parse(await readFile(path.join(resultPath, "result.json"), "utf8")) as RunnerE2EResult;
    originals.push(result);
    let feedback: FeedbackEvidence | null = null;
    try { feedback = JSON.parse(await readFile(path.join(resultPath, "snapshots/agent-feedback.json"), "utf8")); } catch {}
    evidence.push({ result, feedback });
  }
  campaign.feedbackReview = reviewScheduledFeedback(campaign, evidence, new Date().toISOString());
  await writeFile(path.join(directory, "feedback-review.json"), `${JSON.stringify(campaign.feedbackReview, null, 2)}\n`, { mode: 0o600 });
  const findings = scheduledCampaignFindings(campaign);
  const config = evalBraintrustConfig(env);
  let experiment: BraintrustExperimentReceipt | undefined;
  let ingestion: Awaited<ReturnType<typeof openExperimentIngestion>> | undefined;
  try {
    if (!config) throw new Error("Missing Braintrust export configuration");
    if (config.projectId !== manifest.projectId || campaign.campaignId !== manifest.limits.campaignId) throw new Error("Scheduled ingestion identity mismatch");
    ingestion = await openExperimentIngestion({ projectId: config.projectId, campaignId: manifest.limits.campaignId,
      receiptPath: `${manifest.ledgerPath}.experiment-ingestion.jsonl`, deadlineAt: Date.now() + 60_000 });
    await importBraintrustExperiment(config, campaign, originals, async receipt => {
      await writeFile(path.join(directory, "experiment-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      experiment = receipt;
    }, ingestion.transport);
  } catch { findings.push("experiment_import_incomplete"); }
  finally {
    try { await ingestion?.close(); }
    catch { findings.push("experiment_ingestion_accounting_incomplete"); }
  }
  try {
    if (!config) throw new Error("Missing Braintrust ingestion configuration");
    const usage = await collectScheduledIngestion({ ledgerPath: manifest.ledgerPath, campaignId: manifest.limits.campaignId,
      projectId: config.projectId, executionIds: manifest.executionIds });
    await writeFile(path.join(directory, "ingestion-usage.json"), `${JSON.stringify(usage, null, 2)}\n`, { mode: 0o600 });
    if (usage.status !== "complete") findings.push("ingestion_accounting_incomplete");
  } catch { findings.push("ingestion_accounting_unavailable"); }
  let indexing = "unavailable";
  try {
    if (!config) throw new Error("Missing Braintrust query configuration");
    const receipt = await verifyBraintrustIndexing(config, campaign, originals, experiment);
    indexing = receipt.status;
    await writeFile(path.join(directory, "indexing-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  } catch {}
  if (indexing !== "verified") findings.push("trace_or_experiment_indexing_incomplete");
  let gatewayIndexing = "unavailable";
  try {
    if (!config || config.projectId !== manifest.projectId || manifest.route !== "braintrust") throw new Error("Missing gateway index scope");
    const expected = manifest.executionIds.map(executionId => {
      const execution = runnerMatrix.find(row => row.id === executionId);
      if (!execution) throw new Error("Missing gateway execution");
      const provider = execution.profile.credential === "ANTHROPIC_API_KEY" ? "anthropic" as const : "openai" as const;
      if (!manifest.models.some(model => model.provider === provider && model.price.model === execution.profile.model)) throw new Error("Missing gateway model");
      return { executionId, provider, model: execution.profile.model };
    });
    const receipt = await verifyBraintrustGatewayIndexing(config, { ledgerPath: manifest.ledgerPath,
      campaignId: manifest.limits.campaignId, expected });
    gatewayIndexing = receipt.status;
    await writeFile(path.join(directory, "gateway-indexing-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  } catch {}
  if (gatewayIndexing !== "verified") findings.push("gateway_indexing_incomplete");
  await writeFile(path.join(directory, "findings.json"), `${JSON.stringify({ version: 1, findings,
    nativeIndexVerification: indexing, gatewayIndexVerification: gatewayIndexing, invoiceReconciliation: "pending",
    accountingStatus: campaign.operations ? evalAccountingStatus(campaign.operations) : "unavailable",
    feedbackReviewMethod: "Only exact synthetic fixture bodies with all corroborating graders are automatically dismissed; all other feedback requires review" }, null, 2)}\n`, { mode: 0o600 });
  for (const finding of findings) console.error(`::error title=Eval operations::${finding}`);
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if ((await finalizeScheduledCampaign(process.env)).length) process.exitCode = 1;
}
