import { agentJourneyRuns, journeyRequiredChecks } from "./product-journeys/success-contract.js";
import { validateWorkerTiming } from "./worker-timing.js";
import { connectionCheckpoints, connectionEvidencePasses, connectionRunSignals } from "./connection-evidence.js";
import { githubJourneyCheckpoints, gradeGitHubReviewJourney } from "./github-review-evidence.js";
import { gradeAntigravityJourney, validateAntigravityJourneyEvidence } from "./antigravity-journey-evidence.js";
import { STARTUP_REUSE_LAYERS, STARTUP_REUSE_REASONS } from "../../packages/adapter-utils/src/startup-reuse.js";
import type { RunnerE2ECampaignAccounting, RunnerE2EResult } from "./types.js";
import { DEPENDABLE_CELLS } from "./dependable-qualification.js";
import { validateOnboardingConnectEvidence } from "./product-journeys/onboarding-connect.js";
import { validateOnboardingArtifact } from "./product-journeys/artifact-evidence.js";
import { validateOnboardingPreAcceptanceEvidence } from "./product-journeys/onboarding-pre-acceptance.js";

type Rule = (value: unknown, at: string) => void;
const invalid = (at: string): never => {
  throw new Error(`Invalid retained runner result field: ${at}`);
};
const string: Rule = (value, at) => {
  if (typeof value !== "string") invalid(at);
};
const matching = (pattern: RegExp): Rule => (value, at) => {
  string(value, at);
  if (!pattern.test(value as string)) invalid(at);
};
const number: Rule = (value, at) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid(at);
};
const integer: Rule = (value, at) => {
  number(value, at);
  if (!Number.isSafeInteger(value)) invalid(at);
};
const boolean: Rule = (value, at) => {
  if (typeof value !== "boolean") invalid(at);
};
const booleanRecord: Rule = (value, at) => {
  object(value, at);
  for (const [key, entry] of Object.entries(value as object)) boolean(entry, `${at}.${key}`);
};
const object: Rule = (value, at) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(at);
};
const optional =
  (rule: Rule): Rule =>
  (value, at) => {
    if (value !== undefined) rule(value, at);
  };
const nullable =
  (rule: Rule): Rule =>
  (value, at) => {
    if (value !== null) rule(value, at);
  };
const oneOf =
  (...values: string[]): Rule =>
  (value, at) => {
    if (typeof value !== "string" || !values.includes(value)) invalid(at);
  };
const array =
  (rule: Rule): Rule =>
  (value, at) => {
    if (!Array.isArray(value)) invalid(at);
    (value as unknown[]).forEach((item, index) =>
      rule(item, `${at}[${index}]`),
    );
  };
const shape =
  (fields: Record<string, Rule>): Rule =>
  (value, at) => {
    object(value, at);
    for (const [key, rule] of Object.entries(fields))
      rule((value as Record<string, unknown>)[key], `${at}.${key}`);
  };
const closedShape = (fields: Record<string, Rule>): Rule => (value, at) => {
  shape(fields)(value, at);
  for (const key of Object.keys(value as object)) if (!Object.hasOwn(fields, key)) invalid(`${at} (unexpected field)`);
};
const date: Rule = (value, at) => {
  string(value, at);
  if (!Number.isFinite(Date.parse(value as string))) invalid(at);
};
const finite: Rule = (value, at) => {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(at);
};
// Finite invalid bounds remain inspectable evidence with an inconclusive verdict.
const timingBound = nullable(shape({ ms: finite, inclusive: boolean }));
const latencyProbe: Rule = (value, at) => {
  shape({
    event: oneOf("acknowledgement", "first_visible_response", "message_creation", "final_settlement"),
    interval: shape({ lower: timingBound, upper: timingBound }),
    lastAbsentMs: nullable(finite), firstPresentMs: nullable(finite), resolutionMs: nullable(finite),
    invalid: optional(boolean),
    observationFailures: optional(integer),
    observationTimeouts: optional(integer),
    messageTimestamps: optional(shape({ createdAt: optional(string), editedAt: optional(string) })),
    target: shape({ operator: oneOf("<", "<="), ms: finite }),
    verdict: oneOf("pass", "fail", "inconclusive"),
    recordedVerdict: optional(oneOf("pass", "fail", "inconclusive")),
    reason: oneOf("within_target", "outside_target", "threshold_overlap", "missing_observations", "invalid_evidence", "unknown_resolution"),
  })(value, at);
};
const url: Rule = (value, at) => {
  string(value, at);
  try {
    const parsed = new URL(value as string);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      invalid(at);
  } catch {
    invalid(at);
  }
};
const relativeFile: Rule = (value, at) => {
  string(value, at);
  if (
    !/^[A-Za-z0-9_.\-/]+$/.test(value as string) ||
    (value as string).startsWith("/") ||
    (value as string)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    invalid(at);
};
const runtime = shape({
  provider: oneOf("local", "daytona"),
  agentRunDurationMs: nullable(number),
  leaseDurationMs: nullable(number),
  leaseCount: integer,
  cpuCores: optional(number),
  memoryGiB: optional(number),
  diskGiB: optional(number),
  estimatedListCostUsd: optional(number),
  costStatus: oneOf("estimated", "unavailable", "not_metered"),
  costSource: oneOf(
    "daytona_public_list_price",
    "provider_cost_unavailable",
    "local_not_metered",
  ),
  pricingAsOf: optional(string),
  pricingUrl: optional(url),
});
const assistant = shape({ provider: oneOf("openai", "anthropic"), model: string, observedModels: array(string), requests: integer, inputTokens: number, outputTokens: number, cachedInputTokens: number, estimatedCostUsd: number, pricingAsOf: string, pricingUrl: url });
const llm = shape({
  runCount: integer,
  runsWithTokenUsage: integer,
  runsWithReportedCost: integer,
  runsWithEstimatedCost: optional(integer),
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  totalTokens: number,
  reportedCostUsd: number,
  estimatedCostUsd: optional(number),
  costStatus: oneOf("reported", "estimated", "partial", "unpriced", "unavailable"),
});
const billing = shape({
  judge: optional(shape({ inputTokens: nullable(number), outputTokens: nullable(number), estimatedCostUsd: nullable(number), reservedCostUsd: number })),
  assistant: optional(assistant),
  llm,
  runtime,
  reportedCostUsd: number,
  estimatedRuntimeCostUsd: number,
  observedAndEstimatedCostUsd: nullable(number),
  complete: boolean,
});
const tracing = shape({
  projectId: string, traceId: string, spanId: string, status: oneOf("pending", "accepted", "failed"),
  verification: oneOf("unverified"), nativeConfiguration: oneOf("not_started", "configured", "failed"),
  companyId: optional(string), revision: optional(string), errorCode: optional(string), httpStatus: optional(number),
  finalization: optional(shape({ spanId: string, status: oneOf("accepted", "failed"), outcome: oneOf("passed", "failed"),
    verification: oneOf("unverified"), errorCode: optional(string), httpStatus: optional(number) })),
});
const feedback = shape({
  version: (value, at) => { if (value !== 1) invalid(at); },
  collection: oneOf("complete", "partial", "unavailable", "not_started"),
  invocationCollection: oneOf("complete", "partial", "unavailable", "not_started"),
  toolAvailability: oneOf("observed", "unknown"),
  complaints: integer, suggestions: integer, bodiesCollected: integer, runsInspected: integer,
  invocations: shape({ completed: integer, failed: integer, unknown: integer }),
  review: array(shape({ fingerprint: (value, at) => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(at); },
    kind: oneOf("complaint", "suggestion"), occurrences: integer, disposition: oneOf("needs_investigation") })),
});

export function validateCampaignAccounting(value: RunnerE2ECampaignAccounting) {
  shape({
    version: (version, at) => { if (version !== 1) invalid(at); },
    scope: oneOf("retained_attempts", "selected_results"),
    missingAttempts: integer,
    excludedArtifacts: integer,
    attempts: array(shape({
      id: string, executionId: string, attempt: integer,
      startedAt: date, finishedAt: date, durationMs: number,
      status: oneOf("passed", "failed"), cleanup: oneOf("not_started", "passed", "failed"), billing, feedback: optional(feedback), tracing: optional(tracing),
    })),
  })(value, "accounting");
  if (new Set(value.attempts.map(attempt => attempt.id)).size !== value.attempts.length) invalid("accounting.attempts duplicate id");
  for (const attempt of value.attempts) {
    if (attempt.workerTiming !== undefined) {
      try { validateWorkerTiming(attempt.workerTiming, attempt); } catch { invalid("accounting.attempts.workerTiming"); }
    }
  }
}
const matcher: Rule = (value, at) => {
  object(value, at);
  const item = value as Record<string, unknown>;
  string(item.kind, `${at}.kind`);
  const kinds: Record<string, Rule> = {
    message_exact: shape({ expected: string }),
    message_contains: shape({ expected: string }),
    message_occurrences: shape({ expected: string, count: integer }),
    message_regex: shape({ pattern: string, flags: optional(string) }),
    message_ordered: shape({ expected: array(string) }),
    issue_status: shape({ expected: string }),
    run_status: shape({ expected: string }),
    runtime_mode: shape({ expected: oneOf("legacy", "native") }),
    environment: shape({ expected: oneOf("local", "daytona") }),
    file_exists: shape({ path: string }),
    file_exact: shape({ path: string, expected: string }),
    file_contains: shape({ path: string, expected: string }),
    artifact_exists: shape({ name: string, mimeType: optional(string) }),
    artifact_exact: shape({ name: string, expected: string, mimeType: optional(string) }),
    json_path: shape({ path: string }),
    json_schema: shape({ schema: object }),
  };
  const rule = kinds[item.kind as string];
  if (!rule) invalid(`${at}.kind`);
  rule(value, at);
};
const fields = {
  accountingIdentity: optional(shape({ campaignId: string, attemptId: string })),
  publicMcp: optional(assistant),
  schema: oneOf(
    "paperclip.runner-e2e.result/v1",
    "paperclip.runner-e2e.result/v2",
  ),
  executionId: string,
  suiteId: optional(string),
  suiteDefinitionHash: optional(string),
  source: optional(
    shape({
      sha: nullable(string),
      ref: nullable(string),
      workflowRunUrl: nullable(url),
    }),
  ),
  rankingSnapshot: optional(
    shape({
      snapshotId: string,
      capturedAt: date,
      sourceUrl: url,
      rank: integer,
      canonicalModelId: string,
    }),
  ),
  attempt: integer,
  status: oneOf("passed", "failed"),
  failureClass: optional(
    oneOf(
      "candidate_failure",
      "provider_variance",
      "transient_infrastructure",
      "permanent_infrastructure",
      "secret_leak",
      "cleanup_failure",
    ),
  ),
  error: optional(string),
  profileId: string,
  environmentId: oneOf("local", "daytona"),
  caseId: string,
  provider: nullable(string),
  model: nullable(string),
  runtimeMode: oneOf("legacy", "native", "none"),
  targetUrl: optional(url),
  issueId: optional(string),
  issueIdentifier: optional(nullable(string)),
  runIds: optional(array(string)),
  dependableWork: optional(closedShape({
    campaignId: matching(/^[A-Za-z0-9_.-]{1,120}$/), cell: oneOf(...DEPENDABLE_CELLS), phase: oneOf("candidate", "staging"),
    evidence: closedShape({ definitionHash: matching(/^[a-f0-9]{64}$/), settingsHash: matching(/^[a-f0-9]{64}$/),
      instructionsHash: matching(/^[a-f0-9]{64}$/), runnerArtifact: matching(/^sha256:[a-f0-9]{64}$/),
      revisionAtStart: matching(/^[a-f0-9]{40}$/), revisionAtEnd: matching(/^[a-f0-9]{40}$/),
      target: oneOf("isolated-candidate", "isolated-staging") }),
  })),
  latencyProbes: optional(array(latencyProbe)),
  startupReuse: optional(array(shape({
    runId: string,
    warmth: oneOf("cold", "warm", "partial_reuse", "unknown"),
    providerLaunchCount: nullable(integer),
    layers: shape(Object.fromEntries(STARTUP_REUSE_LAYERS.map(layer => [layer, shape({
      state: oneOf("fresh", "reused", "unknown", "not_applicable"),
      reason: oneOf(...STARTUP_REUSE_REASONS),
    })]))),
  }))),
  turnTimings: optional(
    array(
      shape({
        turn: integer,
        submittedAt: date,
        runStartedAt: nullable(date),
        runFinishedAt: nullable(date),
        schedulerLatencyMs: nullable(number),
        runDurationMs: nullable(number),
        responseLatencyMs: nullable(number),
        runId: string,
        leaseAcquisitionOutcome: oneOf(
          "created",
          "resumed",
          "replacement",
          "unknown",
        ),
      }),
    ),
  ),
  startedAt: date,
  finishedAt: date,
  durationMs: number,
  workerTiming: optional(object),
  // Provider usage is intentionally opaque. Billing reads only finite numbers;
  // the dashboard shows opaque diagnostics through escaped JSON.
  usage: optional(nullable(object)),
  runtimeUsage: optional(runtime),
  billing: optional(billing),
  feedback: optional(feedback), tracing: optional(tracing),
  matcherResults: optional(
    array(shape({ matcher, passed: boolean, detail: string })),
  ),
  screenshots: optional(
    array(
      shape({
        id: string,
        label: string,
        file: relativeFile,
        publication: optional(oneOf("public-runner-fixture")),
        sha256: optional(string),
      }),
    ),
  ),
  taskChat: optional(closedShape({
    schema: oneOf("paperclip.runner-e2e.task-chat/v1"), capturedAt: date,
    status: oneOf("complete", "partial", "unavailable"),
    missing: array(oneOf("agent-names", "task-discovery", "chat-discovery", "task-read", "comments", "interactions", "progress", "thread-projection", "capture")),
    threads: array(closedShape({ issueId: string, identifier: nullable(string), title: string,
      status: oneOf("complete", "partial"), messages: array(closedShape({ id: string, at: nullable(date),
        role: oneOf("user", "agent", "system"), author: string,
        kind: oneOf("description", "comment", "interaction", "answer", "progress"), body: string,
      })),
    })),
  })),
  firstTask: optional(shape({
    caseId: string, nonce: string, onboardingIssueId: string, agentId: string,
    source: optional(shape({ sha: string, ref: string, dirty: boolean })),
    initialTaskIds: array(string), configuredModel: nullable(string), observedModels: array(string), runtimeSettings: optional(object),
    instructions: array(shape({ path: string, content: string, sha256: string, contentSha256: optional(string), redacted: optional(boolean) })),
    checkpoints: array(shape({ id: string, at: date, phase: oneOf("opening", "response", "clarified", "revised", "accepted", "rejected", "finished"), issueId: string,
      tasks: array(object), agents: array(object), comments: array(object), interactions: array(object), documents: array(object), attachments: optional(array(object)), runs: array(object) })),
    checks: array(shape({ id: string, passed: boolean, notReached: optional(string), evidence: array(string), detail: string })),
  })),
  productJourney: optional(shape({
    targetId: optional(string),
    campaignId: optional(string), attemptId: optional(string),
    onboardingConnect: optional((value, at) => { try { validateOnboardingConnectEvidence(value); } catch { invalid(at); } }),
    onboardingPreAcceptance: optional((value, at) => { try { validateOnboardingPreAcceptanceEvidence(value); } catch { invalid(at); } }),
    artifact: optional((value, at) => { try { validateOnboardingArtifact(value); } catch { invalid(at); } }),
    operations: optional(closedShape({ campaignId: string, attemptId: string, modelCostUsd: nullable(number), setupCostUsd: nullable(number), requestCount: integer,
      feedback: closedShape({ collection: oneOf("complete", "partial", "unavailable"), complaints: integer, suggestions: integer }), traceIds: array(string) })),
    outcome: oneOf("passed", "failed", "blocked", "unsupported"),
    deployment: optional(shape({ kind: oneOf("self-hosted", "cloud"), targetId: string, origin: url, commit: string, cloudRelease: nullable(string), runtimeImage: nullable(string), configurationHash: string,
      effectiveFeatures: optional(booleanRecord), executionEnvironment: optional(closedShape({ id: string, driver: string, status: string })) })),
    startingState: oneOf("recipe", "onboarding"), privacy: oneOf("private"),
    phases: array(shape({ phase: oneOf("authentication", "setup", "journey", "collection", "cleanup"), outcome: oneOf("passed", "failed", "blocked", "unsupported"), code: optional(string) })),
    checks: array(shape({ id: string, passed: boolean })),
    resourceDisposition: oneOf("released", "retained", "cleanup-failed"),
  })),
  providerConnection: optional(shape({
    version: integer,
    outcome: oneOf("running", "passed", "failed", "awaiting_user", "missing_credential", "blocked_target"),
    phase: string, assisted: boolean, authFreshness: oneOf("signed-in", "signed-out"),
    target: shape({ mode: oneOf("managed-local", "attach"), origin: url, commit: nullable(string), deploymentMode: nullable(string) }),
    entry: oneOf("apps", "agent"), method: string, checkpoints: shape(Object.fromEntries(connectionCheckpoints.map(key => [key, optional(boolean)]))),
    waits: array(shape({ kind: oneOf("board_login", "provider_login"), startedAt: date, finishedAt: optional(date) })),
    artifactChecks: optional(array(shape({ filename: string, runId: string, sha256: string, fields: object, exactFields: boolean }))),
    inputTransport: optional(oneOf("prompt_base64")),
    setupChecks: optional(array(shape({ code: string, level: oneOf("info", "warn", "error") }))),
    runDiagnostics: optional(array(shape({ runId: string, status: oneOf("succeeded", "failed", "cancelled", "interrupted", "timed_out", "unknown"), signals: array(oneOf(...connectionRunSignals)), logAvailable: boolean }))),
    creationFailure: optional(shape({ status: integer, code: oneOf("ai_connection_api_key_rejected", "ai_connection_verification_failed", "connection_request_rejected") })),
    connectionId: optional(string), agentId: optional(string), companyId: optional(string), artifactSha256: optional(string), model: optional(string), cleanupRetained: optional(boolean), companyArchived: optional(boolean),
  })),
  completionQuality: optional(array(shape({
    name: string, purpose: optional(oneOf("product", "calibration")), expectedPass: boolean, passed: boolean, status: oneOf("completed", "failed", "pending"), config: object, configHash: string, evidenceHash: string,
    criteria: array(shape({ id: string, passed: boolean, rationale: string, evidenceIds: array(string) })),
    reports: optional(array(shape({ replyId: string, rationale: string, completedTaskIdsReferenced: array(string), resultAccessTaskIds: optional(array(string)), correctsReplyIds: array(string) }))),
    inputTokens: nullable(integer), outputTokens: nullable(integer), estimatedCostUsd: nullable(number), reservedCostUsd: number, recordedAt: date, error: optional(string), rejectedVerdict: optional(string),
  }))),
  firstTaskQuality: optional(shape({
    status: oneOf("completed", "failed", "pending"), informational: boolean, config: object, configHash: string, evidenceHash: string,
    scores: array(shape({ dimension: oneOf("questionRelevance", "useOfFacts", "proposalUsefulness", "clarity", "lowFriction"), score: integer, rationale: string, evidence: array(string) })),
    inputTokens: nullable(integer), outputTokens: nullable(integer), estimatedCostUsd: nullable(number), reservedCostUsd: number, recordedAt: date, error: optional(string),
  })),
  antigravityJourney: optional((value, at) => { try { validateAntigravityJourneyEvidence(value); } catch { invalid(at); } }),
  githubReviewJourney: optional(closedShape({ version: integer, outcome: oneOf("running", "passed", "failed", "awaiting_user", "missing_credential", "blocked_target"),
    phase: string, setupId: string, hosting: oneOf("self-hosted", "paperclip-cloud"), targetCommit: nullable(string), assisted: boolean,
    dependencies: array(closedShape({ alias: string, consumer: oneOf("harness", "browser", "product-agent"), status: oneOf("ready", "unverified", "created-in-journey"), source: oneOf("onepassword", "environment", "browser-session", "product-connection") })),
    checkpoints: closedShape(Object.fromEntries(githubJourneyCheckpoints.map(id => [id, optional(boolean)]))),
    cleanup: closedShape({ endpoint: boolean, pullRequest: boolean, branch: boolean, app: boolean }), definitionHash: optional(string), score: optional(integer), conclusion: optional(string),
    budgetPolicyRead: optional(oneOf("verified", "unavailable")),
    budgetPolicies: optional(array(closedShape({ scopeType: oneOf("agent", "company"), amount: number, hardStopEnabled: boolean, unpricedUsagePolicy: oneOf("allow", "block") }))),
    execution: optional(closedShape({ reviewId: string, issueId: string, runId: nullable(string), runStatus: optional(string), issueStatus: optional(string),
      runtimeMode: optional(string), environmentId: optional(string), provider: optional(string), model: optional(string) })),
    review: optional(closedShape({ id: string, repository: string, pullNumber: integer, headSha: string, state: string, score: optional(integer), conclusion: nullable(string), summaryUrl: nullable(string), checkUrl: nullable(string) })),
    inlinePublication: optional(closedShape({ url: string, fileUrl: string, path: string, author: string, text: string })) })),
  cleanup: oneOf("not_started", "passed", "failed"),
} satisfies Record<keyof RunnerE2EResult, Rule>;
const result = shape(fields);

/** Validate every typed result field before upgrading, path construction or HTML rendering. */
export function validateRetainedRunnerResult(
  value: unknown,
): asserts value is RunnerE2EResult {
  result(value, "result");
  const checked = value as RunnerE2EResult;
  const artifact = checked.productJourney?.artifact;
  if (checked.productJourney?.onboardingPreAcceptance && (checked.suiteId !== "product-journeys" || checked.caseId !== "cloud-onboarding" ||
    checked.status !== "failed" || checked.productJourney.outcome !== "failed" ||
    checked.error !== "onboarding_work_before_acceptance")) invalid("result.productJourney.onboardingPreAcceptance");
  if (artifact && (checked.suiteId !== "product-journeys" || checked.caseId !== "cloud-onboarding" ||
    checked.runIds && !checked.runIds.includes(artifact.originatingRunId))) invalid("result.productJourney.artifact");
  if (checked.workerTiming !== undefined) {
    try { validateWorkerTiming(checked.workerTiming, checked); } catch { invalid("result.workerTiming"); }
  }
  if (checked.suiteId === "product-journeys" && checked.status === "passed") {
    const evidence = checked.productJourney;
    if (!evidence) return invalid("result.productJourney");
    const required = journeyRequiredChecks[checked.caseId];
    if (evidence.outcome !== "passed" || !evidence.deployment || !required || !required.every(id => evidence.checks.some(c => c.id === id && c.passed)) || evidence.checks.some(check => !check.passed) || evidence.phases.some(p => p.outcome !== "passed") || checked.cleanup !== "passed") invalid("result.productJourney");
    if (["task-properties", "task-create"].includes(checked.caseId) && (checked.runtimeMode !== "none" || checked.provider !== null || checked.model !== null || checked.runIds?.length)) invalid("result.browserOnly");
    if (Object.hasOwn(agentJourneyRuns, checked.caseId) && (checked.runIds?.length !== agentJourneyRuns[checked.caseId as keyof typeof agentJourneyRuns]
      || !checked.model || !checked.provider || checked.runtimeMode !== "native")) invalid("result.agentJourneyRun");
    if (checked.caseId === "cloud-onboarding" && (!checked.runIds?.length || !evidence.operations || !evidence.operations.requestCount || !evidence.operations.traceIds.length || evidence.operations.campaignId !== evidence.campaignId || evidence.operations.attemptId !== evidence.attemptId)) invalid("result.paidJourneyReceipt");
  }
  if (checked.suiteId === "provider-connections" && checked.status === "passed" && (!checked.providerConnection || !connectionEvidencePasses(checked.providerConnection))) invalid("result.providerConnection");
  if (checked.suiteId === "github-review-journey" && checked.status === "passed" && (!checked.githubReviewJourney || checked.githubReviewJourney.outcome !== "passed" || !checked.githubReviewJourney.targetCommit || !gradeGitHubReviewJourney(checked.githubReviewJourney).every(check => check.passed))) invalid("result.githubReviewJourney");
  if (checked.suiteId === "antigravity-agent-journey" && checked.status === "passed") {
    const evidence = checked.antigravityJourney;
    if (!evidence || evidence.outcome !== "passed" || evidence.assisted || !evidence.targetCommit || !gradeAntigravityJourney(evidence).every(check => check.passed)
      || checked.cleanup !== "passed" || checked.runtimeMode !== "native" || checked.model !== evidence.model || checked.provider !== "acpx"
      || checked.runIds?.length !== 2 || !evidence.turnEvidence.every(turn => checked.runIds!.includes(turn.runId))
      || !evidence.companyId || !evidence.agentId || !evidence.connectionId || !checked.issueId
      || !evidence.turnEvidence.every(turn => turn.companyId === evidence.companyId && turn.agentId === evidence.agentId && turn.connectionId === evidence.connectionId && turn.issueId === checked.issueId)
      || !checked.screenshots?.some(shot => shot.id === "persisted" && /^[a-f0-9]{64}$/u.test(shot.sha256 ?? ""))) invalid("result.antigravityJourney");
  }
}
