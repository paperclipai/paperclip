export const CREDENTIAL_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "DAYTONA_API_KEY",
] as const;

export type CredentialName = (typeof CREDENTIAL_NAMES)[number];
export type RunnerGeneration = "legacy" | "native";
export type RunnerEnvironmentId = "local" | "daytona";
export type RunnerTaskWorkMode = "standard" | "planning" | "ask";
export type RunnerTaskFlow =
  | "single_turn"
  | "plan_revision_acceptance"
  | "question_resume_completion"
  | "plan_approval_completion";

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
      | "openrouter_rankings_snapshot";
    qualificationId: string;
  };
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
  | { kind: "file_contains"; path: string; expected: string }
  | { kind: "artifact_exists"; name: string; mimeType?: string }
  | { kind: "json_path"; path: string; expected: unknown }
  | { kind: "json_schema"; schema: Record<string, unknown> };

export interface RunnerTaskFixture {
  id: string;
  label: string;
  groups: readonly string[];
  workMode: RunnerTaskWorkMode;
  flow: RunnerTaskFlow;
  expectedRunCount: number;
  attemptTimeoutMs: Readonly<Record<RunnerEnvironmentId, number>>;
  expectedTerminalState: {
    issue: "done";
    run: "succeeded";
  };
  buildTitle(nonce: string): string;
  buildPrompt(nonce: string): string;
  buildVisibleMarker(nonce: string): string;
  buildRevisionRequest?(nonce: string): string;
  buildQuestionAnswer?(nonce: string): {
    optionLabel: string;
    expectedMarker: string;
  };
  /** Restart the isolated Paperclip server after the waiting turn settles. */
  restartServerBeforeQuestionAnswer?: boolean;
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
  tasks: readonly RunnerTaskFixture[];
  excludedExecutionIds?: readonly string[];
  expectedMatrixSize: number;
  definitionMetadata?: Readonly<Record<string, unknown>>;
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
  agentRunDurationMs: number;
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
  llm: {
    runCount: number;
    runsWithTokenUsage: number;
    runsWithReportedCost: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    reportedCostUsd: number;
    costStatus: Exclude<RunnerE2ECostStatus, "estimated" | "not_metered">;
  };
  runtime: RunnerE2ERuntimeUsage;
  /** Provider-reported model spend only; never includes unknown/unpriced runs. */
  reportedCostUsd: number;
  /** Public-list-price estimate for metered execution infrastructure. */
  estimatedRuntimeCostUsd: number;
  /** Reported model subtotal plus the runtime list-price estimate. */
  observedAndEstimatedCostUsd: number;
  complete: boolean;
}

export interface RunnerE2EResult {
  schema: "paperclip.runner-e2e.result/v1" | "paperclip.runner-e2e.result/v2";
  executionId: string;
  suiteId?: string;
  suiteDefinitionHash?: string;
  source?: {
    sha: string | null;
    ref: string | null;
    workflowRunUrl: string | null;
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
  provider: string;
  model: string;
  runtimeMode: RunnerGeneration;
  issueId?: string;
  issueIdentifier?: string | null;
  runIds?: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  usage?: Record<string, unknown> | null;
  runtimeUsage?: RunnerE2ERuntimeUsage;
  billing?: RunnerE2EBillingSummary;
  matcherResults?: Array<{
    matcher: Matcher;
    passed: boolean;
    detail: string;
  }>;
  screenshots?: Array<{
    id: string;
    label: string;
    file: string;
  }>;
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
  retries: number;
  cleanupPassed: boolean;
  complete: boolean;
  durationMs: number;
  billing: RunnerE2EAggregateBillingSummary;
}

export interface RunnerE2EAggregateBillingSummary {
  testCount: number;
  agentRunDurationMs: number;
  leaseDurationMs: number;
  llm: RunnerE2EBillingSummary["llm"];
  reportedLlmCostUsd: number;
  estimatedRuntimeCostUsd: number;
  observedAndEstimatedCostUsd: number;
  testsWithCompleteBilling: number;
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
  retries: number;
  cleanupPassed: boolean;
  rankingSnapshots: Array<{
    snapshotId: string;
    capturedAt: string;
    sourceUrl: string;
  }>;
  billing: RunnerE2EAggregateBillingSummary;
  suites: RunnerE2ESuiteSummary[];
  results: RunnerE2EResult[];
}

export interface RunnerE2EHistoryExecution {
  executionId: string;
  suiteId: string;
  profileId: string;
  environmentId: RunnerEnvironmentId;
  caseId: string;
  provider: string;
  model: string;
  status: "passed" | "failed";
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
  retries: number;
  cleanupPassed: boolean;
  publicUrl: string;
  billing: RunnerE2EAggregateBillingSummary;
  suites: RunnerE2ESuiteSummary[];
  executions: RunnerE2EHistoryExecution[];
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
