import type { PrpStructuredRunResult, PrpTerminalState } from "../protocol/replay-contract.js";
import { parseNativeRuntimeContext, type NativeRuntimeContextSnapshot } from "./runtime-context.js";

export const NATIVE_EXECUTION_INPUT_SCHEMA_V1 = "paperclip.native-execution-input.v1" as const;
export const NATIVE_EXECUTION_INPUT_SCHEMA_V2 = "paperclip.native-execution-input.v2" as const;
export const NATIVE_EXECUTION_INPUT_SCHEMA_V3 = "paperclip.native-execution-input.v3" as const;
export const NATIVE_EXECUTION_INPUT_SCHEMA = "paperclip.native-execution-input.v4" as const;
export const NATIVE_MODEL_ENVELOPE_SCHEMA_V1 = "paperclip.native-model-envelope.v1" as const;
export const NATIVE_MODEL_ENVELOPE_SCHEMA = "paperclip.native-model-envelope.v2" as const;

export type NativeExecutionMode = "default" | "plan";

export interface NativePlanningContext {
  documentId: string | null;
  baseRevisionId: string | null;
  baseRevisionNumber: number;
  markdown: string;
  sha256: string;
  reviewContext: Record<string, unknown>;
}

export interface StrictCompletionContractInput {
  revision: string;
  objective: string;
  criteria: Array<{ id: string; requirement: string }>;
}

export interface NativeInteractionResponseEnvelope {
  interactionId: string;
  kind:
    | "suggest_tasks"
    | "ask_user_questions"
    | "request_confirmation"
    | "request_checkbox_confirmation"
    | "request_item_verdicts";
  response: Record<string, unknown>;
}

export interface NativeCredentialBindingRef {
  bindingId: string;
  service: string;
  destination: string;
  expiresAt: string | null;
  displayName: string | null;
}

export type NativeSessionLifecyclePolicy =
  | { mode: "per_turn"; idleTimeoutMs: null }
  | { mode: "warm"; idleTimeoutMs: number };

export interface NativeManagedAgentProfileSnapshot {
  profileId: string;
  anthropicAgentId: string;
  agentVersion: string;
  environmentId: string;
  betaVersion: "managed-agents-2026-04-01";
}

export interface NativeAwsAgentCoreProfileSnapshot {
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
}

export type NativeAcpxAgent = "pi" | "claude" | "codex";
export type NativeCodexApprovalPolicy = "never" | "on-request" | "untrusted";
export type NativeOpenCodePermissionMode = "allow" | "ask" | "deny";
export type NativeAcpxPermissionMode = "approve-all" | "approve-reads" | "deny-all";

export interface NativeAcpxProfileSnapshot {
  driverKind: "acpx_runtime";
  protocolVersion: 1;
  acpxVersion: "0.13.1";
  agent: NativeAcpxAgent;
  agentProfileVersion: 1;
  agentServerPackage: string;
  agentServerVersion: string;
  agentRuntimePackage: string | null;
  agentRuntimeVersion: string | null;
  commandDigest: string;
}

export type NativeProviderConfig =
  | { kind: "codex"; model: string | null; approvalPolicy?: NativeCodexApprovalPolicy }
  | { kind: "opencode"; model: string; permissionMode?: NativeOpenCodePermissionMode }
  | {
      kind: "claude_managed";
      model: string;
      managedProfile: NativeManagedAgentProfileSnapshot;
      maxSessionListCostUsd: number;
    }
  | {
      kind: "aws_agentcore";
      model: string;
      agentCoreProfile: NativeAwsAgentCoreProfileSnapshot;
      maxEstimatedSessionCostUsd: number;
      invocationLimits: {
        maxIterations: number;
        maxOutputTokens: number;
        timeoutSeconds: number;
      };
    }
  | {
      kind: "acpx";
      agent: NativeAcpxAgent;
      model: string;
      permissionMode?: NativeAcpxPermissionMode;
      /** Present only in persisted v1-v3 inputs. */
      permissionPolicy?: "interactive";
      profile: NativeAcpxProfileSnapshot;
    };

export type NativeProviderConfigV4 =
  | { kind: "codex"; model: string | null; approvalPolicy: NativeCodexApprovalPolicy }
  | { kind: "opencode"; model: string; permissionMode: NativeOpenCodePermissionMode }
  | Extract<NativeProviderConfig, { kind: "claude_managed" | "aws_agentcore" }>
  | {
      kind: "acpx";
      agent: NativeAcpxAgent;
      model: string;
      permissionMode: NativeAcpxPermissionMode;
      profile: NativeAcpxProfileSnapshot;
    };

export interface NativeExecutionInputV1 {
  schema: typeof NATIVE_EXECUTION_INPUT_SCHEMA_V1;
  binding: {
    companyId: string;
    runId: string;
    issueId: string;
    agentId: string;
    executionWorkspaceId: string;
  };
  task: {
    identifier: string;
    title: string;
    description: string | null;
    /** Redacted, server-authored task markdown including the current wake comment. */
    prompt: string;
    workMode: "standard";
  };
  workspace: {
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  session: {
    normalizedSessionId: string | null;
    driverKind: "codex_app_server" | "opencode_server" | "claude_managed_agents_api" | "aws_agentcore_harness_api" | "acpx_runtime";
    protocolVersion: 1;
    lifecyclePolicy: NativeSessionLifecyclePolicy;
  };
  provider: NativeProviderConfig;
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
  interactionResponses: NativeInteractionResponseEnvelope[];
  credentialBindings: NativeCredentialBindingRef[];
}

export interface NativeExecutionInputV2 extends Omit<NativeExecutionInputV1, "schema" | "task"> {
  schema: typeof NATIVE_EXECUTION_INPUT_SCHEMA_V2;
  executionMode: NativeExecutionMode;
  task: Omit<NativeExecutionInputV1["task"], "workMode"> & {
    workMode: "standard" | "planning" | "ask";
  };
  planningContext: NativePlanningContext | null;
}

export interface NativeExecutionInputV3 extends Omit<NativeExecutionInputV2, "schema"> {
  schema: typeof NATIVE_EXECUTION_INPUT_SCHEMA_V3;
  runtimeContext: NativeRuntimeContextSnapshot;
}

export interface NativeExecutionInputV4 extends Omit<NativeExecutionInputV3, "schema" | "provider"> {
  schema: typeof NATIVE_EXECUTION_INPUT_SCHEMA;
  provider: NativeProviderConfigV4;
}

export type NativeExecutionInput = NativeExecutionInputV1 | NativeExecutionInputV2 | NativeExecutionInputV3 | NativeExecutionInputV4;

/** The only task data that may enter provider-visible model input. */
export interface NativeModelEnvelopeV1 {
  schema: typeof NATIVE_MODEL_ENVELOPE_SCHEMA_V1;
  task: NativeExecutionInputV1["task"];
  /** Remote providers have no Paperclip workspace mounted in their service. */
  workspace: Pick<NativeExecutionInputV1["workspace"], "cwd"> | null;
  completionContract: StrictCompletionContractInput;
  interactionResponses: NativeInteractionResponseEnvelope[];
}

export interface NativeModelEnvelopeV2 {
  schema: typeof NATIVE_MODEL_ENVELOPE_SCHEMA;
  task: NativeExecutionInputV2["task"];
  executionMode: NativeExecutionMode;
  planningContext: NativePlanningContext | null;
  workspace: Pick<NativeExecutionInputV2["workspace"], "cwd"> | null;
  completionContract: StrictCompletionContractInput;
  interactionResponses: NativeInteractionResponseEnvelope[];
}

export interface NativeSessionExecutionResult {
  result: PrpStructuredRunResult;
  terminal: PrpTerminalState;
  turnId: string | null;
  normalizedSessionId: string;
  providerSessionId: string | null;
  driverKind: string;
  driverVersion: string;
  nativeEventCount: number;
  highestContiguousSourceSeq: number;
  usage: Record<string, unknown> | null;
}

export class NativeExecutionInputError extends Error {
  readonly code = "native_execution_input_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "NativeExecutionInputError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeExecutionInputError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new NativeExecutionInputError(`${path} contains unknown field ${unknown[0]}`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NativeExecutionInputError(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

/**
 * Strictly validates the closed Paperclip-to-runner launch contract. This is
 * intentionally not an extensible metadata bag: new fields require a contract
 * revision and an explicit security review.
 */
export function parseNativeExecutionInput(value: unknown): NativeExecutionInput {
  const input = record(value, "input");
  const isV4 = input.schema === NATIVE_EXECUTION_INPUT_SCHEMA;
  const isV3 = isV4 || input.schema === NATIVE_EXECUTION_INPUT_SCHEMA_V3;
  const isV2 = isV3 || input.schema === NATIVE_EXECUTION_INPUT_SCHEMA_V2;
  exactKeys(input, [
    "schema",
    "binding",
    "task",
    "workspace",
    "session",
    "provider",
    "completionContract",
    "interactionResponses",
    "credentialBindings",
    ...(isV2 ? ["executionMode", "planningContext"] : []),
    ...(isV3 ? ["runtimeContext"] : []),
  ], "input");
  if (!isV2 && input.schema !== NATIVE_EXECUTION_INPUT_SCHEMA_V1) {
    throw new NativeExecutionInputError(
      `input.schema must be ${NATIVE_EXECUTION_INPUT_SCHEMA_V1}, ${NATIVE_EXECUTION_INPUT_SCHEMA_V2}, ${NATIVE_EXECUTION_INPUT_SCHEMA_V3}, or ${NATIVE_EXECUTION_INPUT_SCHEMA}`,
    );
  }

  const binding = record(input.binding, "input.binding");
  exactKeys(binding, ["companyId", "runId", "issueId", "agentId", "executionWorkspaceId"], "input.binding");
  const task = record(input.task, "input.task");
  exactKeys(task, ["identifier", "title", "description", "prompt", "workMode"], "input.task");
  const workspace = record(input.workspace, "input.workspace");
  exactKeys(workspace, ["cwd", "repoUrl", "repoRef", "branchName"], "input.workspace");
  const session = record(input.session, "input.session");
  exactKeys(session, ["normalizedSessionId", "driverKind", "protocolVersion", "lifecyclePolicy"], "input.session");
  const completionContract = record(input.completionContract, "input.completionContract");
  exactKeys(completionContract, ["id", "sha256", "schemaVersion", "contract"], "input.completionContract");
  const contract = record(completionContract.contract, "input.completionContract.contract");
  exactKeys(contract, ["revision", "objective", "criteria"], "input.completionContract.contract");

  if (task.workMode !== "standard" && (!isV2 || task.workMode !== "planning" && task.workMode !== "ask")) {
    throw new NativeExecutionInputError("input.task.workMode must be standard, planning, or ask");
  }
  const executionMode: NativeExecutionMode = isV2 && input.executionMode === "plan" ? "plan" : "default";
  if (isV2 && input.executionMode !== "default" && input.executionMode !== "plan") {
    throw new NativeExecutionInputError("input.executionMode must be default or plan");
  }
  if (isV2 && task.workMode !== "planning" && executionMode === "plan") {
    throw new NativeExecutionInputError("plan execution mode requires planning work mode");
  }
  let planningContext: NativePlanningContext | null = null;
  if (isV2 && input.planningContext !== null) {
    const context = record(input.planningContext, "input.planningContext");
    exactKeys(context, [
      "documentId", "baseRevisionId", "baseRevisionNumber", "markdown", "sha256", "reviewContext",
    ], "input.planningContext");
    if (!Number.isSafeInteger(context.baseRevisionNumber) || Number(context.baseRevisionNumber) < 0) {
      throw new NativeExecutionInputError("input.planningContext.baseRevisionNumber must be a non-negative integer");
    }
    planningContext = {
      documentId: context.documentId === null ? null : text(context.documentId, "input.planningContext.documentId"),
      baseRevisionId: context.baseRevisionId === null
        ? null
        : text(context.baseRevisionId, "input.planningContext.baseRevisionId"),
      baseRevisionNumber: Number(context.baseRevisionNumber),
      markdown: typeof context.markdown === "string"
        ? context.markdown
        : (() => { throw new NativeExecutionInputError("input.planningContext.markdown must be a string"); })(),
      sha256: text(context.sha256, "input.planningContext.sha256"),
      reviewContext: structuredClone(record(context.reviewContext, "input.planningContext.reviewContext")),
    };
  }
  if (isV2 && executionMode === "plan" && planningContext === null) {
    throw new NativeExecutionInputError("input.planningContext is required in plan execution mode");
  }
  if (isV2 && executionMode === "default" && input.planningContext !== null) {
    throw new NativeExecutionInputError("input.planningContext is only valid in plan execution mode");
  }
  if (
    (
      session.driverKind !== "codex_app_server"
      && session.driverKind !== "opencode_server"
      && session.driverKind !== "claude_managed_agents_api"
      && session.driverKind !== "aws_agentcore_harness_api"
      && session.driverKind !== "acpx_runtime"
    )
    || session.protocolVersion !== 1
  ) {
    throw new NativeExecutionInputError("input.session must select a supported protocol version 1 driver");
  }
  const driverKind = session.driverKind as NativeExecutionInputV1["session"]["driverKind"];
  const lifecyclePolicyValue = session.lifecyclePolicy === undefined
    ? { mode: "per_turn", idleTimeoutMs: null }
    : record(session.lifecyclePolicy, "input.session.lifecyclePolicy");
  exactKeys(lifecyclePolicyValue, ["mode", "idleTimeoutMs"], "input.session.lifecyclePolicy");
  let lifecyclePolicy: NativeSessionLifecyclePolicy;
  if (lifecyclePolicyValue.mode === "per_turn") {
    if (lifecyclePolicyValue.idleTimeoutMs !== null) {
      throw new NativeExecutionInputError("input.session.lifecyclePolicy.idleTimeoutMs must be null for per_turn");
    }
    lifecyclePolicy = { mode: "per_turn", idleTimeoutMs: null };
  } else if (lifecyclePolicyValue.mode === "warm") {
    if (!Number.isSafeInteger(lifecyclePolicyValue.idleTimeoutMs) || Number(lifecyclePolicyValue.idleTimeoutMs) <= 0) {
      throw new NativeExecutionInputError("input.session.lifecyclePolicy.idleTimeoutMs must be a positive integer for warm");
    }
    lifecyclePolicy = { mode: "warm", idleTimeoutMs: Number(lifecyclePolicyValue.idleTimeoutMs) };
  } else {
    throw new NativeExecutionInputError("input.session.lifecyclePolicy.mode must be per_turn or warm");
  }
  const provider = input.provider === undefined
    ? { kind: "codex", model: null }
    : record(input.provider, "input.provider");
  if (
    provider.kind !== "codex"
    && provider.kind !== "opencode"
    && provider.kind !== "claude_managed"
    && provider.kind !== "aws_agentcore"
    && provider.kind !== "acpx"
  ) {
    throw new NativeExecutionInputError("input.provider.kind must be codex, opencode, claude_managed, aws_agentcore, or acpx");
  }
  exactKeys(
    provider,
    provider.kind === "claude_managed"
      ? ["kind", "model", "managedProfile", "maxSessionListCostUsd"]
      : provider.kind === "aws_agentcore"
        ? ["kind", "model", "agentCoreProfile", "maxEstimatedSessionCostUsd", "invocationLimits"]
      : provider.kind === "acpx"
        ? ["kind", "agent", "model", isV4 ? "permissionMode" : "permissionPolicy", "profile"]
      : provider.kind === "codex" && isV4
        ? ["kind", "model", "approvalPolicy"]
        : provider.kind === "opencode" && isV4
          ? ["kind", "model", "permissionMode"]
          : ["kind", "model"],
    "input.provider",
  );
  if (
    (provider.kind === "codex" && session.driverKind !== "codex_app_server")
    || (provider.kind === "opencode" && session.driverKind !== "opencode_server")
    || (provider.kind === "claude_managed" && session.driverKind !== "claude_managed_agents_api")
    || (provider.kind === "aws_agentcore" && session.driverKind !== "aws_agentcore_harness_api")
    || (provider.kind === "acpx" && session.driverKind !== "acpx_runtime")
  ) {
    throw new NativeExecutionInputError("input.provider.kind does not match input.session.driverKind");
  }
  const providerModel = provider.model === null || provider.model === undefined
    ? null
    : text(provider.model, "input.provider.model");
  if (provider.kind === "opencode" && (providerModel === null || !providerModel.includes("/"))) {
    throw new NativeExecutionInputError("input.provider.model is required for opencode in provider/model form");
  }
  let parsedProvider: NativeProviderConfig;
  if (provider.kind === "claude_managed") {
    if (providerModel === null) {
      throw new NativeExecutionInputError("input.provider.model is required for claude_managed");
    }
    const managedProfile = record(provider.managedProfile, "input.provider.managedProfile");
    exactKeys(
      managedProfile,
      ["profileId", "anthropicAgentId", "agentVersion", "environmentId", "betaVersion"],
      "input.provider.managedProfile",
    );
    if (managedProfile.betaVersion !== "managed-agents-2026-04-01") {
      throw new NativeExecutionInputError(
        "input.provider.managedProfile.betaVersion must be managed-agents-2026-04-01",
      );
    }
    if (
      typeof provider.maxSessionListCostUsd !== "number"
      || !Number.isFinite(provider.maxSessionListCostUsd)
      || provider.maxSessionListCostUsd <= 0
    ) {
      throw new NativeExecutionInputError("input.provider.maxSessionListCostUsd must be a positive finite number");
    }
    parsedProvider = {
      kind: "claude_managed",
      model: providerModel,
      managedProfile: {
        profileId: text(managedProfile.profileId, "input.provider.managedProfile.profileId"),
        anthropicAgentId: text(
          managedProfile.anthropicAgentId,
          "input.provider.managedProfile.anthropicAgentId",
        ),
        agentVersion: text(managedProfile.agentVersion, "input.provider.managedProfile.agentVersion"),
        environmentId: text(managedProfile.environmentId, "input.provider.managedProfile.environmentId"),
        betaVersion: "managed-agents-2026-04-01",
      },
      maxSessionListCostUsd: provider.maxSessionListCostUsd,
    };
  } else if (provider.kind === "aws_agentcore") {
    if (providerModel === null) {
      throw new NativeExecutionInputError("input.provider.model is required for aws_agentcore");
    }
    const profile = record(provider.agentCoreProfile, "input.provider.agentCoreProfile");
    exactKeys(profile, [
      "profileId", "region", "accountId", "harnessArn", "harnessVersion", "endpointArn",
      "endpointQualifier", "agentRuntimeArn", "memoryArn", "memoryId", "invocationRoleArn",
      "contextBucket", "contextPrefix", "contextKmsKeyArn", "qualificationRevision", "eventExpiryDays",
    ], "input.provider.agentCoreProfile");
    if (profile.eventExpiryDays !== 90) {
      throw new NativeExecutionInputError("input.provider.agentCoreProfile.eventExpiryDays must be 90");
    }
    if (
      typeof provider.maxEstimatedSessionCostUsd !== "number"
      || !Number.isFinite(provider.maxEstimatedSessionCostUsd)
      || provider.maxEstimatedSessionCostUsd <= 0
    ) {
      throw new NativeExecutionInputError("input.provider.maxEstimatedSessionCostUsd must be a positive finite number");
    }
    const limits = record(provider.invocationLimits, "input.provider.invocationLimits");
    exactKeys(limits, ["maxIterations", "maxOutputTokens", "timeoutSeconds"], "input.provider.invocationLimits");
    const positiveInteger = (value: unknown, path: string): number => {
      if (!Number.isSafeInteger(value) || Number(value) <= 0) {
        throw new NativeExecutionInputError(`${path} must be a positive integer`);
      }
      return Number(value);
    };
    const maxIterations = positiveInteger(limits.maxIterations, "input.provider.invocationLimits.maxIterations");
    const maxOutputTokens = positiveInteger(limits.maxOutputTokens, "input.provider.invocationLimits.maxOutputTokens");
    const timeoutSeconds = positiveInteger(limits.timeoutSeconds, "input.provider.invocationLimits.timeoutSeconds");
    if (maxIterations > 8) throw new NativeExecutionInputError("input.provider.invocationLimits.maxIterations exceeds 8");
    if (maxOutputTokens > 4096) throw new NativeExecutionInputError("input.provider.invocationLimits.maxOutputTokens exceeds 4096");
    if (timeoutSeconds > 300) throw new NativeExecutionInputError("input.provider.invocationLimits.timeoutSeconds exceeds 300");
    parsedProvider = {
      kind: "aws_agentcore",
      model: providerModel,
      agentCoreProfile: {
        profileId: text(profile.profileId, "input.provider.agentCoreProfile.profileId"),
        region: text(profile.region, "input.provider.agentCoreProfile.region"),
        accountId: text(profile.accountId, "input.provider.agentCoreProfile.accountId"),
        harnessArn: text(profile.harnessArn, "input.provider.agentCoreProfile.harnessArn"),
        harnessVersion: text(profile.harnessVersion, "input.provider.agentCoreProfile.harnessVersion"),
        endpointArn: text(profile.endpointArn, "input.provider.agentCoreProfile.endpointArn"),
        endpointQualifier: text(profile.endpointQualifier, "input.provider.agentCoreProfile.endpointQualifier"),
        agentRuntimeArn: text(profile.agentRuntimeArn, "input.provider.agentCoreProfile.agentRuntimeArn"),
        memoryArn: text(profile.memoryArn, "input.provider.agentCoreProfile.memoryArn"),
        memoryId: text(profile.memoryId, "input.provider.agentCoreProfile.memoryId"),
        invocationRoleArn: text(profile.invocationRoleArn, "input.provider.agentCoreProfile.invocationRoleArn"),
        contextBucket: text(profile.contextBucket, "input.provider.agentCoreProfile.contextBucket"),
        contextPrefix: text(profile.contextPrefix, "input.provider.agentCoreProfile.contextPrefix"),
        contextKmsKeyArn: text(profile.contextKmsKeyArn, "input.provider.agentCoreProfile.contextKmsKeyArn"),
        qualificationRevision: text(profile.qualificationRevision, "input.provider.agentCoreProfile.qualificationRevision"),
        eventExpiryDays: 90,
      },
      maxEstimatedSessionCostUsd: provider.maxEstimatedSessionCostUsd,
      invocationLimits: { maxIterations, maxOutputTokens, timeoutSeconds },
    };
  } else if (provider.kind === "acpx") {
    if (providerModel === null) {
      throw new NativeExecutionInputError("input.provider.model is required for acpx");
    }
    if (provider.agent !== "pi" && provider.agent !== "claude" && provider.agent !== "codex") {
      throw new NativeExecutionInputError("input.provider.agent must be pi, claude, or codex");
    }
    if (isV4) {
      if (provider.permissionMode !== "approve-all" && provider.permissionMode !== "approve-reads" && provider.permissionMode !== "deny-all") {
        throw new NativeExecutionInputError("input.provider.permissionMode must be approve-all, approve-reads, or deny-all");
      }
    } else if (provider.permissionPolicy !== "interactive") {
      throw new NativeExecutionInputError("input.provider.permissionPolicy must be interactive");
    }
    const profile = record(provider.profile, "input.provider.profile");
    exactKeys(profile, [
      "driverKind",
      "protocolVersion",
      "acpxVersion",
      "agent",
      "agentProfileVersion",
      "agentServerPackage",
      "agentServerVersion",
      "agentRuntimePackage",
      "agentRuntimeVersion",
      "commandDigest",
    ], "input.provider.profile");
    if (
      profile.driverKind !== "acpx_runtime"
      || profile.protocolVersion !== 1
      || profile.acpxVersion !== "0.13.1"
      || profile.agent !== provider.agent
      || profile.agentProfileVersion !== 1
    ) {
      throw new NativeExecutionInputError("input.provider.profile does not match the qualified ACPX v1 profile");
    }
    const runtimePackage = nullableText(profile.agentRuntimePackage, "input.provider.profile.agentRuntimePackage");
    const runtimeVersion = nullableText(profile.agentRuntimeVersion, "input.provider.profile.agentRuntimeVersion");
    if ((runtimePackage === null) !== (runtimeVersion === null)) {
      throw new NativeExecutionInputError("input.provider.profile agent runtime package and version must both be present or null");
    }
    parsedProvider = {
      kind: "acpx",
      agent: provider.agent,
      model: providerModel,
      ...(isV4
        ? { permissionMode: provider.permissionMode as NativeAcpxPermissionMode }
        : { permissionPolicy: "interactive" as const }),
      profile: {
        driverKind: "acpx_runtime",
        protocolVersion: 1,
        acpxVersion: "0.13.1",
        agent: provider.agent,
        agentProfileVersion: 1,
        agentServerPackage: text(profile.agentServerPackage, "input.provider.profile.agentServerPackage"),
        agentServerVersion: text(profile.agentServerVersion, "input.provider.profile.agentServerVersion"),
        agentRuntimePackage: runtimePackage,
        agentRuntimeVersion: runtimeVersion,
        commandDigest: text(profile.commandDigest, "input.provider.profile.commandDigest"),
      },
    };
  } else if (provider.kind === "opencode") {
    if (isV4 && provider.permissionMode !== "allow" && provider.permissionMode !== "ask" && provider.permissionMode !== "deny") {
      throw new NativeExecutionInputError("input.provider.permissionMode must be allow, ask, or deny");
    }
    parsedProvider = {
      kind: "opencode",
      model: providerModel!,
      ...(isV4
        ? { permissionMode: provider.permissionMode as NativeOpenCodePermissionMode }
        : {}),
    };
  } else {
    if (isV4 && provider.approvalPolicy !== "never" && provider.approvalPolicy !== "on-request" && provider.approvalPolicy !== "untrusted") {
      throw new NativeExecutionInputError("input.provider.approvalPolicy must be never, on-request, or untrusted");
    }
    parsedProvider = {
      kind: "codex",
      model: providerModel,
      ...(isV4
        ? { approvalPolicy: provider.approvalPolicy as NativeCodexApprovalPolicy }
        : {}),
    };
  }
  if (!Array.isArray(contract.criteria) || contract.criteria.length === 0) {
    throw new NativeExecutionInputError("input.completionContract.contract.criteria must not be empty");
  }
  const criteria = contract.criteria.map((entry, index) => {
    const criterion = record(entry, `input.completionContract.contract.criteria[${index}]`);
    exactKeys(criterion, ["id", "requirement"], `input.completionContract.contract.criteria[${index}]`);
    return { id: text(criterion.id, `criteria[${index}].id`), requirement: text(criterion.requirement, `criteria[${index}].requirement`) };
  });

  if (!Array.isArray(input.interactionResponses) || !Array.isArray(input.credentialBindings)) {
    throw new NativeExecutionInputError("interactionResponses and credentialBindings must be arrays");
  }
  const interactionResponses = input.interactionResponses.map((entry, index) => {
    const response = record(entry, `input.interactionResponses[${index}]`);
    exactKeys(response, ["interactionId", "kind", "response"], `input.interactionResponses[${index}]`);
    if (![
      "suggest_tasks",
      "ask_user_questions",
      "request_confirmation",
      "request_checkbox_confirmation",
      "request_item_verdicts",
    ].includes(String(response.kind))) {
      throw new NativeExecutionInputError(`input.interactionResponses[${index}].kind is unsupported`);
    }
    const kind = response.kind as NativeInteractionResponseEnvelope["kind"];
    return {
      interactionId: text(response.interactionId, `input.interactionResponses[${index}].interactionId`),
      kind,
      response: structuredClone(record(response.response, `input.interactionResponses[${index}].response`)),
    };
  });
  const credentialBindings = input.credentialBindings.map((entry, index) => {
    const bindingRef = record(entry, `input.credentialBindings[${index}]`);
    exactKeys(bindingRef, ["bindingId", "service", "destination", "expiresAt", "displayName"], `input.credentialBindings[${index}]`);
    return {
      bindingId: text(bindingRef.bindingId, `credentialBindings[${index}].bindingId`),
      service: text(bindingRef.service, `credentialBindings[${index}].service`),
      destination: text(bindingRef.destination, `credentialBindings[${index}].destination`),
      expiresAt: nullableText(bindingRef.expiresAt, `credentialBindings[${index}].expiresAt`),
      displayName: nullableText(bindingRef.displayName, `credentialBindings[${index}].displayName`),
    };
  });

  const common = {
    binding: {
      companyId: text(binding.companyId, "input.binding.companyId"),
      runId: text(binding.runId, "input.binding.runId"),
      issueId: text(binding.issueId, "input.binding.issueId"),
      agentId: text(binding.agentId, "input.binding.agentId"),
      executionWorkspaceId: text(binding.executionWorkspaceId, "input.binding.executionWorkspaceId"),
    },
    task: {
      identifier: text(task.identifier, "input.task.identifier"),
      title: text(task.title, "input.task.title"),
      description: nullableText(task.description, "input.task.description"),
      // `prompt` was added after native run inputs were already persisted.
      // Recovery must retain those runs, so derive the same bounded model
      // prompt from their task fields instead of making them unrecoverable.
      prompt: text(task.prompt ?? task.description ?? task.title, "input.task.prompt"),
      workMode: task.workMode as "standard" | "planning" | "ask",
    },
    workspace: {
      cwd: text(workspace.cwd, "input.workspace.cwd"),
      repoUrl: nullableText(workspace.repoUrl, "input.workspace.repoUrl"),
      repoRef: nullableText(workspace.repoRef, "input.workspace.repoRef"),
      branchName: nullableText(workspace.branchName, "input.workspace.branchName"),
    },
    session: {
      normalizedSessionId: nullableText(session.normalizedSessionId, "input.session.normalizedSessionId"),
      driverKind,
      protocolVersion: 1 as const,
      lifecyclePolicy,
    },
    provider: parsedProvider,
    completionContract: {
      id: text(completionContract.id, "input.completionContract.id"),
      sha256: text(completionContract.sha256, "input.completionContract.sha256"),
      schemaVersion: text(completionContract.schemaVersion, "input.completionContract.schemaVersion"),
      contract: {
        revision: text(contract.revision, "input.completionContract.contract.revision"),
        objective: text(contract.objective, "input.completionContract.contract.objective"),
        criteria,
      },
    },
    interactionResponses,
    credentialBindings,
  };
  if (!isV2) {
    return {
      ...common,
      schema: NATIVE_EXECUTION_INPUT_SCHEMA_V1,
      task: { ...common.task, workMode: "standard" },
    };
  }
  const current = {
    ...common,
    executionMode,
    planningContext,
  };
  if (!isV3) return { ...current, schema: NATIVE_EXECUTION_INPUT_SCHEMA_V2 };
  const withRuntimeContext = { ...current, runtimeContext: parseNativeRuntimeContext(input.runtimeContext) };
  if (!isV4) return { ...withRuntimeContext, schema: NATIVE_EXECUTION_INPUT_SCHEMA_V3 };
  return {
    ...withRuntimeContext,
    schema: NATIVE_EXECUTION_INPUT_SCHEMA,
    provider: parsedProvider as NativeProviderConfigV4,
  };
}

export function buildNativeModelEnvelope(input: NativeExecutionInput): NativeModelEnvelopeV1 | NativeModelEnvelopeV2 {
  if (input.schema === NATIVE_EXECUTION_INPUT_SCHEMA_V1) {
    return {
      schema: NATIVE_MODEL_ENVELOPE_SCHEMA_V1,
      task: structuredClone(input.task),
      workspace: input.provider.kind === "claude_managed" || input.provider.kind === "aws_agentcore"
        ? null
        : { cwd: input.workspace.cwd },
      completionContract: structuredClone(input.completionContract.contract),
      interactionResponses: structuredClone(input.interactionResponses),
    };
  }
  return {
    schema: NATIVE_MODEL_ENVELOPE_SCHEMA,
    task: structuredClone(input.task),
    executionMode: input.executionMode,
    planningContext: structuredClone(input.planningContext),
    workspace: input.provider.kind === "claude_managed" || input.provider.kind === "aws_agentcore"
      ? null
      : { cwd: input.workspace.cwd },
    completionContract: structuredClone(input.completionContract.contract),
    interactionResponses: structuredClone(input.interactionResponses),
  };
}
