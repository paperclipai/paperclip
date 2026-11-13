/** Read-only closed-metadata reporting. No result, diagnosis, or campaign mutation. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { campaignSummary, campaignCleanupResolved, type CampaignAttempt, type CampaignScenario, type ChatCampaign } from "./chat-campaign.js";
import { chatQueryWithAttachments, type ChatQueryAttachmentReceipt } from "./chat-query-attachments.js";

type Json = Record<string, unknown>;
const object = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export interface ReportProof { path: string; sha256: string }
export interface ReportStage { state: "proven" | "unknown" | "not-applicable"; proofs: ReportProof[] }
export interface RetainedReportDocument { path: string; sha256: string; value: unknown }
/** Documents are supplied only from a result-bound attempt directory by the reader. */
export function extractCampaignStages(scenario: CampaignScenario, attempt: CampaignAttempt, documents: Record<string, RetainedReportDocument>) {
  const stage = (): ReportStage => ({ state: "unknown", proofs: [] });
  const stages = { setupBlockedBeforeCanonical: stage(), canonicalDispatch: stage(), canonicalPersisted: stage(), canonicalNativeAdmission: stage(), featureGradingReturned: stage(), observationGradeRecorded: stage(), intentionalNoChatBoundary: stage() };
  const use = (target: ReportStage, ...names: string[]) => { target.state = "proven"; target.proofs = [...new Set(names)].map(name => ({ path: documents[name]!.path, sha256: documents[name]!.sha256 })); };
  const value = (name: string) => object(documents[name]?.value);
  const result = value("result.json");
  if (!["paperclip.runner-e2e.result/v1", "paperclip.runner-e2e.result/v2"].includes(String(result.schema)) || result.executionId !== attempt.executionId || object(result.source).sha !== attempt.sourceRevision) return stages;
  const definition = value("chat-catalog-definition.json"), boundaryDefinition = value("chat-boundary-definition.json");
  const bound = (d: Json) => d.scenarioId === scenario.id && d.definitionDigest === attempt.definitionDigest && d.graderDigest === attempt.graderDigest;
  const boundaryIntent = value("chat-boundary-intent.json");
  const boundary = bound(boundaryDefinition) && boundaryDefinition.journeyKind === "browser-boundary" && boundaryIntent.scenarioId === scenario.id && boundaryIntent.originalQuery === scenario.query && boundaryIntent.querySent === false;
  if (boundary) {
    use(stages.intentionalNoChatBoundary, "result.json", "chat-boundary-definition.json", "chat-boundary-intent.json");
    for (const name of ["canonicalDispatch", "canonicalPersisted", "canonicalNativeAdmission"] as const) stages[name] = { state: "not-applicable", proofs: stages.intentionalNoChatBoundary.proofs };
  }
  const prerequisite = value("chat-catalog-input-prerequisite.json");
  if (prerequisite.scenarioId === scenario.id && prerequisite.phase === "reserved-setup" && prerequisite.querySent === false && prerequisite.modelAdmissions === 0 && array(prerequisite.blockers).length)
    use(stages.setupBlockedBeforeCanonical, "result.json", "chat-catalog-input-prerequisite.json");
  if (!bound(definition) && !boundary) return stages;
  const observationName = boundary ? "chat-boundary-observation.json" : documents["chat-feature.json"] ? "chat-feature.json" : "chat-catalog-observation.json";
  const observation = value(observationName), grade = object(observation.grade);
  const actualChecks = array(grade.checks).map(object).filter(check => typeof check.id === "string" && typeof check.passed === "boolean");
  if (observation.scenarioId === scenario.id && actualChecks.length) use(stages.observationGradeRecorded, "result.json", boundary ? "chat-boundary-definition.json" : "chat-catalog-definition.json", observationName);
  // Finally also writes observations. Only matching returned check receipts establish
  // normal feature grading/verifyResult completion; never infer it from an exception.
  const returned = array(result.matcherResults).map(object);
  const returnedGrade = stages.observationGradeRecorded.state === "proven" && actualChecks.every(check => returned.some(row => object(row.matcher).path === `chat.${check.id}` && row.passed === check.passed));
  if (boundary) { if (returnedGrade) use(stages.featureGradingReturned, "result.json", observationName); return stages; }
  const legacy = scenario.id === "tasks.create-backlog" || scenario.id === "tasks.committed-send-retry";
  const conversationName = legacy ? "chat-feature.json" : "chat-catalog-conversation.json";
  const conversation = legacy ? object(value(conversationName).observation) : value(conversationName);
  const source = object(conversation[legacy ? "source" : "issue"]);
  const binding = value("chat-catalog-query-binding.json"), attachments = value("chat-catalog-query-attachments-before-send.json");
  let query: string | undefined;
  if (legacy && conversation.query === scenario.query) query = scenario.query;
  if (!legacy && binding.scenarioId === scenario.id && binding.originalQuery === scenario.query && typeof binding.renderedQuery === "string") query = binding.renderedQuery;
  if (query && documents["chat-catalog-query-attachments-before-send.json"]) {
    const receipts = array(attachments.receipts).map(object);
    if (attachments.originalQuery !== scenario.query || attachments.renderedQuery !== query || receipts.length !== 1 || typeof receipts[0]?.originalFilename !== "string" || typeof receipts[0]?.contentPath !== "string") query = undefined;
    else {
      const formatted = chatQueryWithAttachments(query, receipts as unknown as ChatQueryAttachmentReceipt[]);
      query = attachments.persistedQuery === formatted ? formatted : undefined;
    }
  }
  const setup = value("chat-catalog-setup-boundary.json");
  if (!query || typeof source.id !== "string" || typeof source.companyId !== "string" || (!legacy && !Array.isArray(setup.humanCommentIds))) return stages;
  const comments = array(conversation.comments).map(object).filter(comment => typeof comment.id === "string" && comment.issueId === source.id && comment.companyId === source.companyId && !comment.authorAgentId && !!comment.authorUserId && (!source.conversationUserId || comment.authorUserId === source.conversationUserId) && comment.body === query && !array(setup.humanCommentIds).includes(comment.id));
  if (comments.length !== 1) return stages;
  const proofNames = ["result.json", "chat-catalog-definition.json", conversationName, ...(!legacy ? ["chat-catalog-query-binding.json", "chat-catalog-setup-boundary.json"] : []), ...(documents["chat-catalog-query-attachments-before-send.json"] ? ["chat-catalog-query-attachments-before-send.json"] : [])];
  use(stages.canonicalPersisted, ...proofNames); use(stages.canonicalDispatch, ...proofNames);
  // Contradictory retained receipts cannot establish pre-query setup blockage.
  stages.setupBlockedBeforeCanonical = stage();
  if (returnedGrade) use(stages.featureGradingReturned, ...proofNames, observationName);
  // A saved comment can precede a failed wake/admission (actual HTTP409 case).
  // A native run must bind this exact source and new human comment.
  if (array(conversation.runs).map(object).some(run => run.companyId === source.companyId && (!source.conversationAgentId || run.agentId === source.conversationAgentId) && run.runtimeMode === "native" && object(run.contextSnapshot).issueId === source.id && object(run.contextSnapshot).commentId === comments[0]!.id && !array(setup.runIds).includes(run.id))) use(stages.canonicalNativeAdmission, ...proofNames);
  return stages;
}

const snapshotNames = ["chat-catalog-definition.json", "chat-boundary-definition.json", "chat-boundary-intent.json", "chat-boundary-observation.json", "chat-catalog-input-prerequisite.json", "chat-catalog-conversation.json", "chat-catalog-query-binding.json", "chat-catalog-query-attachments-before-send.json", "chat-catalog-setup-boundary.json", "chat-catalog-observation.json", "chat-feature.json"];
export function readCampaignReportEvidence(root: string, attempt: CampaignAttempt) {
  const documents: Record<string, RetainedReportDocument> = {};
  const evidenceRoot = realpathSync(path.join(root, "tests/runner-e2e/results"));
  function read(filename: string, name: string) {
    try {
      const resolved = realpathSync(filename);
      if (!resolved.startsWith(`${evidenceRoot}${path.sep}`)) return;
      const bytes = readFileSync(resolved, "utf8");
      documents[name] = { path: path.relative(root, resolved), sha256: sha(bytes), value: JSON.parse(bytes) };
    } catch { /* Missing/corrupt/escaped evidence stays unknown. */ }
  }
  const results = attempt.evidencePaths.filter(p => p.endsWith("/result.json"));
  if (results.length !== 1) return documents;
  const filename = path.resolve(root, results[0]!); read(filename, "result.json");
  if (!documents["result.json"]) return documents;
  for (const name of snapshotNames) read(path.join(path.dirname(filename), "snapshots", name), name);
  return documents;
}
export function buildChatCampaignReport(campaign: ChatCampaign, root: string) {
  if (campaign.denominator !== 244 || campaign.areas !== 35 || campaign.capabilities !== 191 || campaign.requiredPasses !== 196 || campaign.scenarios.length !== 244 || new Set(campaign.scenarios.map(s => s.id)).size !== 244 || new Set(campaign.scenarios.map(s => s.feature)).size !== 35 || new Set(campaign.scenarios.flatMap(s => s.capabilities)).size !== 191) throw new Error("Report requires the complete frozen 244/35/191 inventory and 196 gate");
  const summary = campaignSummary(campaign, root);
  const scenarios = campaign.scenarios.map(scenario => {
    const eligibility = campaignSummary({ ...campaign, scenarios: [scenario] }, root);
    return { id: scenario.id, area: scenario.feature, capabilities: scenario.capabilities, readiness: scenario.readiness, authoringStatus: scenario.authoringStatus ?? "unknown",
      attempted: scenario.attempts.length > 0, initialEligiblePass: eligibility.initialPassed === 1, finalEligiblePass: eligibility.finalPassed === 1,
      attempts: scenario.attempts.map(attempt => ({ ordinal: attempt.ordinal, recordedOutcome: attempt.outcome, classification: attempt.classification, diagnosisHistoryCount: attempt.diagnosisHistory?.length ?? 0,
        sourceRevision: attempt.sourceRevision, workingTreeDigest: attempt.workingTreeDigest, definitionDigest: attempt.definitionDigest, graderDigest: attempt.graderDigest, suiteDefinitionDigest: attempt.suiteDefinitionDigest,
        model: attempt.model, profile: attempt.profile, environment: attempt.environment, databaseLane: attempt.databaseLane ?? { lane: "embedded-postgres" }, productIdentity: attempt.productIdentity ?? { kind: "unknown" },
        startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, usage: attempt.usage, dollars: attempt.usage.costUsd === null ? "unpriced-or-unknown" : "recorded",
        cleanup: attempt.cleanup, cleanupResolved: campaignCleanupResolved(attempt, root), corePrDependencies: attempt.corePrDependencies,
        evidencePaths: attempt.evidencePaths, stages: extractCampaignStages(scenario, attempt, readCampaignReportEvidence(root, attempt)) })) };
  });
  const attempts = scenarios.flatMap(s => s.attempts);
  return { schema: "paperclip.chat-campaign-report/v1", disposition: "incomplete-read-only-proof-summary", campaignId: campaign.campaignId, campaignSnapshotSha256: sha(JSON.stringify(campaign)), reportGeneratorSha256: sha(readFileSync(import.meta.filename, "utf8")), baselineRevision: campaign.baselineRevision, inventoryDigest: campaign.inventoryDigest,
    frozen: { denominator: 244, areas: 35, capabilities: 191, requiredPasses: 196 }, eligibility: summary,
    stageSemantics: { canonicalDispatch: "Exact persisted source human proves dispatch; query intent or unbound HTTP traffic does not.", canonicalPersisted: "Exact original/audited-rendered human body on independently bound source, excluding setup comments.", canonicalNativeAdmission: "Native run on that source bound to the exact new canonical comment; saved comment alone is insufficient.", featureGradingReturned: "Exact independent checks returned after verification, plus canonical or explicit boundary proof.", observationGradeRecorded: "Snapshot grade may originate in finally; does not establish completed grading.", setupBlockedBeforeCanonical: "Explicit reserved-setup blocker receipt only; missing outputs/zero runs remain unknown.", intentionalNoChatBoundary: "Selected fingerprinted boundary definition and actual exact unsent-query intent; not feature success." },
    proofCounts: Object.fromEntries(Object.keys(attempts[0]?.stages ?? {}).map(key => [key, { proven: attempts.filter(a => a.stages[key as keyof typeof a.stages].state === "proven").length, unknown: attempts.filter(a => a.stages[key as keyof typeof a.stages].state === "unknown").length, notApplicable: attempts.filter(a => a.stages[key as keyof typeof a.stages].state === "not-applicable").length }])),
    scenarios };
}
// Explicit read-only CLI: caller chooses an ignored output destination via stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, "../..");
  const manifest = JSON.parse(readFileSync(path.join(root, "tests/runner-e2e/chat-campaign-manifest.json"), "utf8")) as ChatCampaign;
  process.stdout.write(`${JSON.stringify(buildChatCampaignReport(manifest, root), null, 2)}\n`);
}
