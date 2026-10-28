import type { BrowserContext, Page } from "@playwright/test";
import type { ConnectionApi } from "../connection-target.js";

export type JourneyOutcome = "passed" | "failed" | "blocked" | "unsupported";
export type JourneyId = "task-properties" | "cloud-onboarding";
export type TargetMode = "managed-self-hosted" | "existing-cloud" | "new-cloud";
export interface DeploymentIdentity {
  kind: "self-hosted" | "cloud";
  targetId: string;
  origin: string;
  commit: string;
  cloudRelease: string | null;
  runtimeImage: string | null;
  configurationHash: string;
  effectiveFeatures?: Record<string, boolean>;
  executionEnvironment?: { id: string; driver: string; status: string };
}
export interface JourneyEvidence {
  targetId?: string;
  outcome: JourneyOutcome;
  deployment?: DeploymentIdentity;
  startingState: "recipe" | "onboarding";
  phases: Array<{ phase: "authentication" | "setup" | "journey" | "collection" | "cleanup"; outcome: JourneyOutcome; code?: string }>;
  checks: Array<{ id: string; passed: boolean }>;
  resourceDisposition: "released" | "retained" | "cleanup-failed";
  privacy: "private";
  campaignId?: string;
  attemptId?: string;
  operations?: JourneyOperations;
  artifact?: OnboardingArtifactEvidence;
  onboardingConnect?: import("./onboarding-connect.js").OnboardingConnectEvidence;
  onboardingPreAcceptance?: import("./onboarding-pre-acceptance.js").OnboardingPreAcceptanceEvidence;
}
export interface OnboardingArtifactEvidence {
  schema: "paperclip.product-journey.artifact/v1";
  id: string;
  originatingRunId: string;
  filename: "connection-proof.json";
  byteSize: number;
  sha256: string;
  contentBase64: string;
  input: string;
  expected: { nonce: string; count: number; total: number; sha256: string };
}
/** Normalized receipt from the private, Cloud-qualified eval-operations adapter. */
export interface JourneyOperations {
  campaignId: string;
  attemptId: string;
  modelCostUsd: number | null;
  setupCostUsd: number | null;
  requestCount: number;
  feedback: { collection: "complete" | "partial" | "unavailable"; complaints: number; suggestions: number };
  traceIds: string[];
}
export interface JourneyCollection {
  journeyId: JourneyId;
  runIds: string[];
  usage: { runs: Array<{ runId: string; usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number } }> };
  operations?: JourneyOperations;
}
export interface TargetConfig {
  version: 1;
  id: string;
  mode: TargetMode;
  adapterModule?: string;
  adapterConfig?: Record<string, unknown>;
  journeys: JourneyId[];
  executionEnvironment: "local" | "daytona";
  baseline: { features: Record<string, boolean>; connections: string[] };
  limits: { durationMs: number; modelBudgetCents: number; maxRuns: number };
  headed: boolean;
  modelProfileId?: "runner-codex" | "runner-codex-mini";
}
export interface JourneyContext {
  page: Page;
  api: ConnectionApi;
  company: { id: string; issuePrefix: string };
  user: { id: string; name: string };
  environmentId?: string;
  identity: DeploymentIdentity;
  capabilities: string[];
  startingState: "recipe" | "onboarding";
  fixtures?: { backlogTask?: PreparedBacklogTask };
}
export interface PreparedBacklogTask {
  id: string;
  title: string;
  identifier: string;
}
export interface TargetLifecycleInput {
  signal: AbortSignal;
  deadlineAt: number;
}
export interface TargetSession {
  context?: JourneyContext;
  authenticate(): Promise<void>;
  prepare(): Promise<JourneyContext>;
  onboard?(evidence: JourneyEvidence): Promise<JourneyContext>;
  identity(): Promise<DeploymentIdentity>;
  collect(input?: TargetLifecycleInput): Promise<JourneyCollection[] | void>;
  release(outcome: JourneyOutcome, input?: TargetLifecycleInput): Promise<"released" | "retained">;
  /** Stop only run-owned work; never delete fixtures or release leases. */
  stop?(input?: TargetLifecycleInput): Promise<void>;
  /** Durable final evidence must precede releasing a Cloud target's held leases. */
  finalizeEvidence?(input?: TargetLifecycleInput): Promise<void>;
  /** Publish the observed finalization failure without releasing resources or leases. */
  checkpointEvidence?(input?: TargetLifecycleInput): Promise<void>;
  /** Durable intent before creation; receipt immediately after creation. */
  own(resource: { kind: "issue" | "agent" | "connection"; name: string; id?: string }): Promise<void>;
}
export interface TargetProvider {
  version: 1;
  acquire(input: {
    config: TargetConfig; campaignId: string; deadlineAt: number;
    browser: BrowserContext; signal: AbortSignal; repositoryRoot: string; outputDir: string;
    harness: { revision: string | null; definitionHash: string };
  }): Promise<TargetSession>;
}
export class JourneyError extends Error {
  constructor(readonly outcome: Exclude<JourneyOutcome, "passed">, readonly code: string) { super(code); }
}
