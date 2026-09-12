import type {
  CapabilityLiveSessionSnapshot,
  CreateCapabilityLiveSessionInput,
} from "../live/live-session.js";
import type { QualifiedAcpxAgent } from "../drivers/acpx/qualified-profiles.js";
import {
  estimateModelCostNanodollars,
  type EstimatedModelCost,
} from "../evals/model-pricing.js";

export const EVAL_SESSION_REQUEST_SCHEMA =
  "paperclip-runner/eval-session-request/v1" as const;
export const EVAL_SESSION_ARTIFACT_SCHEMA =
  "paperclip-runner/eval-session-artifact/v1" as const;

export type EvalSessionProvider =
  | "codex"
  | "opencode"
  | "claude_managed"
  | "aws_agentcore"
  | "acpx";
export type EvalSessionDriver =
  | "codex_app_server"
  | "opencode_server"
  | "claude_managed_agents_api"
  | "aws_agentcore_harness_api"
  | "acpx_runtime";

export interface EvalSessionManagedProfile {
  profileId: string;
  anthropicAgentId: string;
  agentVersion: string;
  environmentId: string;
  betaVersion: "managed-agents-2026-04-01";
  maxSessionListCostUsd: number;
}

export interface EvalSessionAgentCoreProfile {
  profileId: string;
  region: string;
  accountId: string;
  harnessArn: string;
  harnessVersion: string;
  endpointArn: string;
  endpointQualifier: string;
  agentRuntimeArn: string;
  memoryArn: string;
  memoryId: string;
  invocationRoleArn: string;
  contextBucket: string;
  contextPrefix: string;
  contextKmsKeyArn: string;
  qualificationRevision: string;
  eventExpiryDays: 90;
  maxEstimatedSessionCostUsd: number;
  maxIterations: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
}

export interface EvalSessionRequest {
  schema: typeof EVAL_SESSION_REQUEST_SCHEMA;
  attemptId: string;
  prompt: string;
  model: string;
  provider?: EvalSessionProvider;
  driver?: EvalSessionDriver;
  opencodeVersion?: string;
  acpxAgent?: Exclude<QualifiedAcpxAgent, "pi">;
  managedProfile?: EvalSessionManagedProfile;
  agentCoreProfile?: EvalSessionAgentCoreProfile;
  runnerd: { path: string; sha256: string };
  limits: {
    turnTimeoutMs: number;
    maxAgentTurns: number;
    maxEstimatedCostNanodollars: number;
  };
  session: CreateCapabilityLiveSessionInput;
  nativeResume?: { operationId: string };
  /** Current live sessions always use Codex collaboration instructions. */
  includeCollaborationModeInstructions?: true;
}

export interface EvalSessionUsage extends EstimatedModelCost {
  agentTurns: number;
  providerRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  providerReportedCostNanodollars: number;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return Number(value);
}

export function expectedEvalSessionDriver(
  provider: EvalSessionProvider,
): EvalSessionDriver {
  return provider === "opencode"
    ? "opencode_server"
    : provider === "claude_managed"
      ? "claude_managed_agents_api"
      : provider === "aws_agentcore"
        ? "aws_agentcore_harness_api"
    : provider === "acpx" ? "acpx_runtime" : "codex_app_server";
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive finite number`);
  }
  return value;
}

function parseManagedProfile(value: unknown): EvalSessionManagedProfile {
  const profile = object(value, "request.managedProfile");
  if (profile.betaVersion !== "managed-agents-2026-04-01") {
    throw new Error("request.managedProfile.betaVersion is not qualified");
  }
  const agentVersion = text(
    profile.agentVersion,
    "request.managedProfile.agentVersion",
  );
  if (
    !/^[1-9][0-9]*$/.test(agentVersion) ||
    BigInt(agentVersion) > 2_147_483_647n
  ) {
    throw new Error(
      "request.managedProfile.agentVersion must be a canonical positive int32 string",
    );
  }
  return {
    profileId: text(profile.profileId, "request.managedProfile.profileId"),
    anthropicAgentId: text(
      profile.anthropicAgentId,
      "request.managedProfile.anthropicAgentId",
    ),
    agentVersion,
    environmentId: text(
      profile.environmentId,
      "request.managedProfile.environmentId",
    ),
    betaVersion: "managed-agents-2026-04-01",
    maxSessionListCostUsd: positiveNumber(
      profile.maxSessionListCostUsd,
      "request.managedProfile.maxSessionListCostUsd",
    ),
  };
}

function parseAgentCoreProfile(value: unknown): EvalSessionAgentCoreProfile {
  const profile = object(value, "request.agentCoreProfile");
  if (profile.eventExpiryDays !== 90) {
    throw new Error("request.agentCoreProfile.eventExpiryDays must be 90");
  }
  const requiredText = (name: string): string =>
    text(profile[name], `request.agentCoreProfile.${name}`);
  return {
    profileId: requiredText("profileId"),
    region: requiredText("region"),
    accountId: requiredText("accountId"),
    harnessArn: requiredText("harnessArn"),
    harnessVersion: requiredText("harnessVersion"),
    endpointArn: requiredText("endpointArn"),
    endpointQualifier: requiredText("endpointQualifier"),
    agentRuntimeArn: requiredText("agentRuntimeArn"),
    memoryArn: requiredText("memoryArn"),
    memoryId: requiredText("memoryId"),
    invocationRoleArn: requiredText("invocationRoleArn"),
    contextBucket: requiredText("contextBucket"),
    contextPrefix: requiredText("contextPrefix"),
    contextKmsKeyArn: requiredText("contextKmsKeyArn"),
    qualificationRevision: requiredText("qualificationRevision"),
    eventExpiryDays: 90,
    maxEstimatedSessionCostUsd: positiveNumber(
      profile.maxEstimatedSessionCostUsd,
      "request.agentCoreProfile.maxEstimatedSessionCostUsd",
    ),
    maxIterations: positiveInteger(
      profile.maxIterations,
      "request.agentCoreProfile.maxIterations",
    ),
    maxOutputTokens: positiveInteger(
      profile.maxOutputTokens,
      "request.agentCoreProfile.maxOutputTokens",
    ),
    timeoutSeconds: positiveInteger(
      profile.timeoutSeconds,
      "request.agentCoreProfile.timeoutSeconds",
    ),
  };
}

/** Fail-closed validation for the executable boundary. */
export function parseEvalSessionRequest(value: unknown): EvalSessionRequest {
  const input = object(value, "request");
  if (input.schema !== EVAL_SESSION_REQUEST_SCHEMA) {
    throw new Error("unsupported request schema");
  }
  const providerValue = input.provider ?? "codex";
  if (
    providerValue !== "codex" &&
    providerValue !== "opencode" &&
    providerValue !== "claude_managed" &&
    providerValue !== "aws_agentcore" &&
    providerValue !== "acpx"
  ) {
    throw new Error(
      "eval-session provider is unsupported by CapabilityLiveSessionService",
    );
  }
  const provider = providerValue;
  const driver = expectedEvalSessionDriver(provider);
  if (input.driver !== undefined && input.driver !== driver) {
    throw new Error("eval-session provider/driver mismatch");
  }
  // The original Evalbook v1 producer serialized absent provider-specific
  // options as JSON null. Preserve compatibility with those immutable request
  // artifacts while continuing to reject non-null values for the wrong lane.
  const acpxAgent = input.acpxAgent === null ? undefined : input.acpxAgent;
  if (acpxAgent === "pi") throw new Error("The Pi ACPX profile is not available");
  if (
    acpxAgent !== undefined &&
    acpxAgent !== "codex" &&
    acpxAgent !== "claude"
  ) {
    throw new Error("eval-session acpxAgent must be codex or claude");
  }
  if (provider !== "acpx" && acpxAgent !== undefined) {
    throw new Error("eval-session acpxAgent requires provider acpx");
  }
  const managedProfileInput = input.managedProfile === null
    ? undefined
    : input.managedProfile;
  const agentCoreProfileInput = input.agentCoreProfile === null
    ? undefined
    : input.agentCoreProfile;
  const managedProfile = provider === "claude_managed"
    ? parseManagedProfile(managedProfileInput)
    : undefined;
  const agentCoreProfile = provider === "aws_agentcore"
    ? parseAgentCoreProfile(agentCoreProfileInput)
    : undefined;
  if (provider !== "claude_managed" && managedProfileInput !== undefined) {
    throw new Error("eval-session managedProfile requires provider claude_managed");
  }
  if (provider !== "aws_agentcore" && agentCoreProfileInput !== undefined) {
    throw new Error("eval-session agentCoreProfile requires provider aws_agentcore");
  }
  if (input.nativeResume !== undefined) {
    throw new Error(
      "eval-session nativeResume requires a retained live-session checkpoint",
    );
  }
  if (input.includeCollaborationModeInstructions === false) {
    throw new Error(
      "current CapabilityLiveSessionService requires collaboration-mode instructions",
    );
  }

  const runnerd = object(input.runnerd, "request.runnerd");
  const digest = text(runnerd.sha256, "request.runnerd.sha256");
  if (!/^(?:sha256:)?[a-f0-9]{64}$/i.test(digest)) {
    throw new Error("request.runnerd.sha256 must be a SHA-256 digest");
  }
  const limits = object(input.limits, "request.limits");
  const sessionInput = object(input.session, "request.session");
  const session = sessionInput as unknown as CreateCapabilityLiveSessionInput;
  const model = text(input.model, "request.model");
  if (provider === "claude_managed" && model !== "claude-sonnet-5") {
    throw new Error("Claude Managed evals require exact model claude-sonnet-5");
  }
  if (
    provider === "aws_agentcore" &&
    model !== "global.anthropic.claude-sonnet-4-6"
  ) {
    throw new Error(
      "AWS AgentCore evals require exact model global.anthropic.claude-sonnet-4-6",
    );
  }
  if (sessionInput.provider !== undefined && sessionInput.provider !== provider) {
    throw new Error("request.session.provider must match request.provider");
  }
  if (
    session.requestedModel !== undefined &&
    session.requestedModel !== model
  ) {
    throw new Error("request.session.requestedModel must match request.model");
  }
  if (session.acpxAgent === "pi") {
    throw new Error("The Pi ACPX profile is not available");
  }

  return {
    schema: EVAL_SESSION_REQUEST_SCHEMA,
    attemptId: text(input.attemptId, "request.attemptId"),
    prompt: text(input.prompt, "request.prompt"),
    model,
    provider,
    driver,
    ...(typeof input.opencodeVersion === "string"
      ? { opencodeVersion: text(input.opencodeVersion, "request.opencodeVersion") }
      : {}),
    ...(acpxAgent === undefined ? {} : { acpxAgent }),
    ...(managedProfile === undefined ? {} : { managedProfile }),
    ...(agentCoreProfile === undefined ? {} : { agentCoreProfile }),
    runnerd: {
      path: text(runnerd.path, "request.runnerd.path"),
      sha256: digest,
    },
    limits: {
      turnTimeoutMs: positiveInteger(
        limits.turnTimeoutMs,
        "request.limits.turnTimeoutMs",
      ),
      maxAgentTurns: positiveInteger(
        limits.maxAgentTurns,
        "request.limits.maxAgentTurns",
      ),
      maxEstimatedCostNanodollars: positiveInteger(
        limits.maxEstimatedCostNanodollars,
        "request.limits.maxEstimatedCostNanodollars",
      ),
    },
    session,
    ...(input.includeCollaborationModeInstructions === true
      ? { includeCollaborationModeInstructions: true }
      : {}),
  };
}

export function evalSessionUsage(
  model: string,
  snapshot: CapabilityLiveSessionSnapshot,
): EvalSessionUsage {
  const unique = new Map(
    (snapshot.usageLedger ?? []).map((receipt) => [receipt.receiptId, receipt]),
  );
  const totals = [...unique.values()].reduce((result, receipt) => ({
    agentTurns: result.agentTurns + receipt.providerCalls,
    providerRequests: result.providerRequests + receipt.providerRequests,
    inputTokens: result.inputTokens + receipt.inputTokens,
    outputTokens: result.outputTokens + receipt.outputTokens,
    cachedInputTokens: result.cachedInputTokens + receipt.cachedInputTokens,
    reasoningTokens: result.reasoningTokens + receipt.reasoningTokens,
    providerReportedCostNanodollars:
      result.providerReportedCostNanodollars + receipt.costNanodollars,
  }), {
    agentTurns: 0,
    providerRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    providerReportedCostNanodollars: 0,
  });
  if (unique.size === 0) {
    throw new Error("completed turn omitted usage accounting");
  }
  return {
    ...totals,
    ...estimateModelCostNanodollars(model, totals),
  };
}
