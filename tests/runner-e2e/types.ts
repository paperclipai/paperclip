export const CREDENTIAL_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "KIMI_MODEL_API_KEY",
  "KIMI_API_KEY",
  "XAI_API_KEY",
  "GROK_AUTH_JSON",
  "CODEX_AUTH_JSON",
  "GEMINI_API_KEY",
  "DAYTONA_API_KEY",
  "GITHUB_TOKEN",
  "CURSOR_AUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN",
] as const;

export type CredentialName = (typeof CREDENTIAL_NAMES)[number];
export type RunnerGeneration = "legacy" | "native";
export type RunnerEnvironmentId = "local" | "daytona";
export type RunnerTaskWorkMode = "standard" | "planning" | "ask";
export type RunnerTaskFlow =
  | "case_handoff"
  | "task_workspaces"
  | "automatic_repository"
  | "repository_verification"
  | "finalization_recovery"
  | "followup_stop_resume"
  | "repository_skills"
  | "provider_connection"
  | "github_review_journey"
  | "antigravity_agent_journey"
  | "plan_task_guidance"
  | "blocker_guidance"
  | "public_mcp"
  | "everyday_workflow"
  | "context_integrity"

  | "continuation_accounting"
  | "continuation"
  | "first_task"
  | "agent_chat"
  | "governed_tool_review"
  | "single_turn"
  | "plan_revision_acceptance"
  | "question_resume_completion"
  | "plan_approval_completion"
  | "warm_three_turn"
  | "instruction_persistence"
  | "pi_native"
  | "pi_controls"
  | "native_active_stop"
  | "kimi_native_lifecycle"
  | "copilot_protection"
  | "native_provider_loss"
  | "cursor_native";

export interface SecretReference {
  type: "secret_ref";
  secretId: string;
  version: "latest";
}

export type SecretReferenceMap = Partial<
  Record<CredentialName, SecretReference>
>;

export interface AgentFixtureBuildInput {
  environmentId: string;
  environmentFixtureId: RunnerEnvironmentId;
  workspacePath: string;
  secretRefs: SecretReferenceMap;
  executionId: string;
}

export interface EnvironmentFixtureBuildInput {
  secretRefs: SecretReferenceMap;
  daytonaImage?: string;
  executionId: string;
}

export interface RunnerProfileFixture {
  id: string;
  label: string;
  generation: RunnerGeneration;
  groups: readonly string[];
  adapterType: string;
  provider: string;
  model: string;
  modelQualification: {
    source:
      | "adapter_constant"
      | "qualified_runner_profile"
      | "candidate_runner_profile"
      | "openrouter_rankings_snapshot";
    qualificationId: string;
  };
  qualificationCandidate?: "cursor" | "copilot" | "pi" | "kimi";
  ranking?: {
    rank: number;
    canonicalModelId: string;
    snapshotId: string;
    capturedAt: string;
    sourceUrl: string;
  };
  credential: Exclude<CredentialName, "DAYTONA_API_KEY">;
  supportedEnvironments: readonly RunnerEnvironmentId[];
  expectedRuntimeMode: RunnerGeneration;
  expectedRuntimeMetadata: {
    adapterType: string;
    provider: string;
  };
  buildAgent(input: AgentFixtureBuildInput): Record<string, unknown>;
}

export interface EnvironmentFixture {
  id: RunnerEnvironmentId;
  /** Distinguishes materially different configurations that share a provider ID. */
  configurationKey?: string;
  label: string;
  groups: readonly string[];
  driver: "local" | "sandbox";
  provider: "local" | "daytona";
  credential?: "DAYTONA_API_KEY";
  lifecycle: {
    setup: "instance_managed" | "create_via_api";
    probe: "run_context_via_api";
    cleanup: "instance_shutdown" | "delete_via_api_and_destroy_leases";
  };
  expectedExecutionTarget: {
    kind: "local" | "remote";
    transport?: "sandbox";
  };
  buildEnvironment(
    input: EnvironmentFixtureBuildInput,
  ): Record<string, unknown>;
}

export type Matcher =
  | { kind: "message_exact"; expected: string }
  | { kind: "message_contains"; expected: string }
  | { kind: "message_occurrences"; expected: string; count: number }
  | { kind: "message_regex"; pattern: string; flags?: string }
  | { kind: "message_ordered"; expected: readonly string[] }
  | { kind: "issue_status"; expected: string }
  | { kind: "run_status"; expected: string }
  | { kind: "runtime_mode"; expected: RunnerGeneration }
  | { kind: "environment"; expected: RunnerEnvironmentId }
  | { kind: "file_exists"; path: string }
  | { kind: "file_exact"; path: string; expected: string }
  | { kind: "file_contains"; path: string; expected: string }
  | { kind: "artifact_exists"; name: string; mimeType?: string }
  | { kind: "artifact_exact"; name: string; expected: string; mimeType?: string }
  | { kind: "json_path"; path: string; expected: unknown }
  | { kind: "json_schema"; schema: Record<string, unknown> };

export interface RunnerTaskFixture {
  requiredCredentials?: readonly CredentialName[];
  id: string;
  label: string;
  groups: readonly string[];
  workMode: RunnerTaskWorkMode;
  flow: RunnerTaskFlow;
  expectedRunCount: number;
  /** Optional lower bound; expectedRunCount remains the maximum/cost estimate. */
  minimumExpectedRunCount?: number;
  /** Admit only the first attempt, including provider or infrastructure failures. */
  automaticRetryPolicy?: "single_attempt";
  attemptTimeoutMs: Readonly<Record<RunnerEnvironmentId, number>>;
  expectedTerminalState: {
    issue: "done" | "in_review" | "blocked" | "in_progress";
    /** Only the Copilot denial flow admits this with a verified recovery settlement. */
    alternativeIssue?: "blocked";
    run: "succeeded" | "failed" | "cancelled";
  };
  buildTitle(nonce: string): string;
  buildPrompt(nonce: string): string;
  buildVisibleMarker(nonce: string): string;
  buildRevisionRequest?(nonce: string): string;
  buildFollowupMessages?(nonce: string): readonly [string, string];
  turnTimeoutMs?: number;
  buildQuestionAnswer?(nonce: string): {
    optionLabel: string;
    expectedMarker: string;
  };
  /** Restart the isolated Paperclip server after the waiting turn settles. */
  restartServerBeforeQuestionAnswer?: boolean;
  toolReviewDecision?: "approve" | "decline" | "always" | "restart";
  buildPlanMarkers?(nonce: string): {
    draft: string;
    revised: string;
  };
  buildMatchers(nonce: string, execution: MatrixExecution): readonly Matcher[];
}

export interface MatrixExecution {
  id: string;
  suite: RunnerSuiteFixture;
  suiteDefinitionHash: string;
  profile: RunnerProfileFixture;
  environment: EnvironmentFixture;
  task: RunnerTaskFixture;
  groups: readonly string[];
  requiredCredentials: readonly CredentialName[];
}

export interface RunnerSuiteFixture {
  id: string;
  label: string;
  description: string;
  groups: readonly string[];
  profiles: readonly RunnerProfileFixture[];
  environments: readonly EnvironmentFixture[];
  environmentOverrides?: Readonly<Record<string, Partial<Record<RunnerEnvironmentId, EnvironmentFixture>>>>;
  tasks: readonly RunnerTaskFixture[];
  excludedExecutionIds?: readonly string[];
  expectedMatrixSize: number;
  definitionMetadata?: Readonly<Record<string, unknown>>;
  /** Requires an explicit suite or execution ID; excluded from scheduled --all. */
  manualOnly?: boolean;
}

export interface MatrixJob {
  executionId: string;
  suiteId: string;
  profileId: string;
  credentialName: Exclude<CredentialName, "DAYTONA_API_KEY">;
  environmentId: RunnerEnvironmentId;
  caseId: string;
  timeoutMinutes: number;
  needsDaytona: boolean;
}

export type FailureClass =
  | "candidate_failure"
  | "provider_variance"
  | "transient_infrastructure"
  | "permanent_infrastructure"
  | "secret_leak"
  | "cleanup_failure";

export type RunnerE2ECostStatus =
  | "reported"
  | "estimated"
  | "partial"
  | "unpriced"
  | "unavailable"
  | "not_metered";

export interface RunnerE2ERuntimeUsage {
  provider: RunnerEnvironmentId;
  /** Sum of the selected Paperclip heartbeat-run spans. */
  agentRunDurationMs: number | null;
  /** Sum of provider lease windows when the environment exposes leases. */
  leaseDurationMs: number | null;
  leaseCount: number;
  cpuCores?: number;
  memoryGiB?: number;
  diskGiB?: number;
  estimatedListCostUsd?: number;
  costStatus: "estimated" | "unavailable" | "not_metered";
  costSource:
    | "daytona_public_list_price"
    | "provider_cost_unavailable"
    | "local_not_metered";
  pricingAsOf?: string;
  pricingUrl?: string;
}

export interface RunnerE2EBillingSummary {
  assistant?: import("./public-mcp-model.js").AssistantUsage;
  llm: {
    runCount: number;
    runsWithTokenUsage: number;
    runsWithReportedCost: number;
    runsWithEstimatedCost?: number;
    runsWithPartialReportedCost?: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    reportedCostUsd: number;
    estimatedCostUsd?: number;
    costStatus: Exclude<RunnerE2ECostStatus, "not_metered">;
  };
  runtime: RunnerE2ERuntimeUsage;
  reportedCostUsd: number;
  /** Public-list-price estimate for metered execution infrastructure. */
  estimatedRuntimeCostUsd: number;
  /** Separately recorded post-processing judge usage; absent when not judged. */
  judge?: { inputTokens: number | null; outputTokens: number | null; estimatedCostUsd: number | null; reservedCostUsd: number };
  /** Reported model subtotal plus runtime and judge list-price estimates. */
  observedAndEstimatedCostUsd: number | null;
  complete: boolean;
}

export interface RunnerE2EResult {
  schema: "paperclip.runner-e2e.result/v1" | "paperclip.runner-e2e.result/v2";
  accountingIdentity?: { campaignId: string; attemptId: string };
  executionId: string;
  suiteId?: string;
  suiteDefinitionHash?: string;
  source?: {
    sha: string | null;
    ref: string | null;
    workflowRunUrl: string | null;
  };
  dependableWork?: {
    campaignId: string;
    cell: import("./dependable-qualification.js").DependableCell;
    phase: "candidate" | "staging";
    evidence: Omit<import("./dependable-qualification.js").DependableAttempt["evidence"], "manifestVerified" | "secretScanPassed">;
  };
  rankingSnapshot?: {
    snapshotId: string;
    capturedAt: string;
    sourceUrl: string;
    rank: number;
    canonicalModelId: string;
  };
  attempt: number;
  status: "passed" | "failed";
  failureClass?: FailureClass;
  error?: string;
  profileId: string;
  environmentId: RunnerEnvironmentId;
  caseId: string;
  provider: string | null;
  model: string | null;
  runtimeMode: RunnerGeneration | "none";
  /** Recorded application URL; retained by reviewed public evidence projections. */
  targetUrl?: string;
  issueId?: string;
  issueIdentifier?: string | null;
  runIds?: string[];
  latencyProbes?: import("./latency-timing.js").LatencyResult[];
  startupReuse?: Array<{ runId: string } & import("../../packages/adapter-utils/src/startup-reuse.js").StartupReuseSummary>;
  turnTimings?: Array<{
    turn: number;
    submittedAt: string;
    runStartedAt: string | null;
    runFinishedAt: string | null;
    schedulerLatencyMs: number | null;
    runDurationMs: number | null;
    responseLatencyMs: number | null;
    runId: string;
    leaseAcquisitionOutcome: "created" | "resumed" | "replacement" | "unknown";
  }>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  workerTiming?: import("./worker-timing.js").WorkerTiming;
  usage?: Record<string, unknown> | null;
  runtimeUsage?: RunnerE2ERuntimeUsage;
  billing?: RunnerE2EBillingSummary;
  feedback?: import("./feedback.js").FeedbackSummary;
  tracing?: import("./braintrust.js").EvalTraceReceipt;
  matcherResults?: Array<{
    matcher: Matcher;
    passed: boolean;
    detail: string;
  }>;
  screenshots?: Array<{
    id: string;
    label: string;
    file: string;
    publication?: "public-runner-fixture";
    /** Absent in historical results; new captures bind the exact PNG bytes. */
    sha256?: string;
  }>;
  productJourney?: import("./product-journeys/types.js").JourneyEvidence;
  firstTask?: import("./first-task-scoring.js").FirstTaskEvidence;
  taskChat?: import("./task-chat.js").TaskChatEvidence;
  providerConnection?: import("./connection-evidence.js").ConnectionEvidence;
  githubReviewJourney?: import("./github-review-evidence.js").GitHubReviewJourneyEvidence;
  antigravityJourney?: import("./antigravity-journey-evidence.js").AntigravityJourneyEvidence;
  completionQuality?: import("./completion-quality.js").CompletionQualityRecord[];
  firstTaskQuality?: import("./first-task-quality.js").FirstTaskQuality;
  /** External assistant API calls, separate from the team's heartbeat executions. */
  publicMcp?: import("./public-mcp-model.js").AssistantUsage;
  cleanup: "not_started" | "passed" | "failed";
}

export interface RunnerE2ESuiteSummary {
  suiteId: string;
  suiteDefinitionHash: string;
  expected: number;
  selected: number;
  executed: number;
  passed: number;
  failed: number;
  incomplete?: number;
  retries: number;
  cleanupPassed: boolean;
  complete: boolean;
  durationMs: number;
  billing: RunnerE2EAggregateBillingSummary;
}

export interface RunnerE2EJudgeBillingSummary {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  reservedCostUsd: number;
  attemptsWithUnknownUsage: number;
}

export interface RunnerE2EAggregateBillingSummary {
  assistant?: { requests: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; estimatedCostUsd: number };
  judge?: RunnerE2EJudgeBillingSummary;
  testCount: number;
  agentRunDurationMs: number | null;
  leaseDurationMs: number | null;
  llm: RunnerE2EBillingSummary["llm"];
  reportedLlmCostUsd: number;
  estimatedLlmCostUsd?: number;
  estimatedRuntimeCostUsd: number;
  observedAndEstimatedCostUsd: number | null;
  testsWithCompleteBilling: number;
}

export interface RunnerE2EAttemptReceipt {
  id: string;
  executionId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  workerTiming?: import("./worker-timing.js").WorkerTiming;
  status: RunnerE2EResult["status"];
  cleanup: RunnerE2EResult["cleanup"];
  billing: RunnerE2EBillingSummary;
  feedback?: import("./feedback.js").FeedbackSummary;
  tracing?: import("./braintrust.js").EvalTraceReceipt;
}

export interface RunnerE2ECampaignAccounting {
  version: 1;
  scope: "retained_attempts" | "selected_results";
  attempts: RunnerE2EAttemptReceipt[];
  missingAttempts: number;
  excludedArtifacts: number;
}

export interface RunnerE2ECampaign {
  schema: "paperclip.runner-e2e.campaign/v2";
  campaignId: string;
  generatedAt: string;
  source: {
    sha: string | null;
    ref: string | null;
    workflowRunUrl: string | null;
    eventName: string | null;
  };
  expected: string[];
  complete: boolean;
  selected: number;
  executed: number;
  passed: number;
  failed: number;
  incomplete?: number;
  retries: number;
  cleanupPassed: boolean;
  rankingSnapshots: Array<{
    snapshotId: string;
    capturedAt: string;
    sourceUrl: string;
  }>;
  billing: RunnerE2EAggregateBillingSummary;
  accounting?: RunnerE2ECampaignAccounting;
  operations?: import("./operations-report.js").EvalOperationsReport;
  feedbackReview?: import("./feedback-dispositions.js").CampaignFeedbackReview;
  braintrustExperiment?: import("./braintrust-experiment.js").BraintrustExperimentReceipt;
  suites: RunnerE2ESuiteSummary[];
  results: RunnerE2EResult[];
}

export interface RunnerE2EHistoryExecution {
  executionId: string;
  suiteId: string;
  profileId: string;
  environmentId: RunnerEnvironmentId;
  caseId: string;
  provider: string | null;
  model: string | null;
  /** Absent in older records; never infer the application from the worker. */
  targetUrl?: string;
  runtimeMode?: RunnerE2EResult["runtimeMode"];
  status: "passed" | "failed" | "incomplete";
  durationMs: number;
  attempt: number;
  cleanup: RunnerE2EResult["cleanup"];
  billing: RunnerE2EBillingSummary;
}

export interface RunnerE2EHistoryCampaign {
  campaignId: string;
  generatedAt: string;
  source: RunnerE2ECampaign["source"];
  complete: boolean;
  selected: number;
  executed: number;
  passed: number;
  failed: number;
  incomplete?: number;
  retries: number;
  cleanupPassed: boolean;
  publicUrl: string;
  billing: RunnerE2EAggregateBillingSummary;
  suites: RunnerE2ESuiteSummary[];
  executions: RunnerE2EHistoryExecution[];
  /** A named case selection, independent of suite and deployment target. */
  preset?: string;
}

export interface RunnerE2EHistoryIndex {
  schema: "paperclip.runner-e2e.history/v1";
  updatedAt: string;
  latestCampaignId: string | null;
  latestGreenCampaignId: string | null;
  latestBySuite: Record<string, string>;
  latestGreenBySuite: Record<string, string>;
  campaigns: RunnerE2EHistoryCampaign[];
}
