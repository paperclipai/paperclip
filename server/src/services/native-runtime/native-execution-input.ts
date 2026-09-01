import type {
  NativeAcpxAgent,
  NativeAcpxPermissionMode,
  NativeCodexApprovalPolicy,
  NativeExecutionInputV4,
  NativeInteractionResponseEnvelope,
  NativeOpenCodePermissionMode,
  NativePlanningContext,
  NativeRuntimeContextSnapshot,
  StrictCompletionContractInput,
} from "../../vendor/paperclip-runner/index.js";
import {
  parseNativeExecutionInput,
  resolveQualifiedAcpxProfile,
} from "../../vendor/paperclip-runner/index.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";

/** Closed constructor: callers cannot spread legacy context or environment data. */
export function buildNativeExecutionInput(input: {
  companyId: string;
  runId: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    workMode: string;
  };
  taskPrompt: string;
  /**
   * The already-sanitized Paperclip wake envelope for this run. Native drivers
   * receive a closed execution input rather than the legacy adapter context,
   * so the constructor must deliberately project the same bounded wake delta
   * that legacy adapters place in their provider prompt.
   */
  wakePayload?: unknown;
  resumedSession?: boolean;
  agentId: string;
  workspace: {
    id: string;
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  normalizedSessionId: string | null;
  provider?: "codex" | "opencode" | "acpx";
  acpxAgent?: NativeAcpxAgent;
  codexApprovalPolicy?: NativeCodexApprovalPolicy;
  opencodePermissionMode?: NativeOpenCodePermissionMode;
  acpxPermissionMode?: NativeAcpxPermissionMode;
  model?: string | null;
  lifecyclePolicy?: NativeExecutionInputV4["session"]["lifecyclePolicy"];
  executionMode?: "default" | "plan";
  planningContext?: NativePlanningContext | null;
  interactionResponses?: NativeInteractionResponseEnvelope[];
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
  runtimeContext: NativeRuntimeContextSnapshot;
}): NativeExecutionInputV4 {
  if (input.issue.workMode !== "standard" && input.issue.workMode !== "planning" && input.issue.workMode !== "ask") {
    throw new Error("native_execution_input_invalid: issue work mode must be standard, planning, or ask");
  }
  const executionMode = input.executionMode
    ?? (input.issue.workMode === "planning" ? "plan" : "default");
  const acpxProfile = input.provider === "acpx"
    ? resolveQualifiedAcpxProfile(
        input.acpxAgent ?? "pi",
        input.model ?? "",
      )
    : null;
  const wakePrompt = renderPaperclipWakePrompt(input.wakePayload, {
    resumedSession: input.resumedSession === true,
    suppressIssueDescription: input.taskPrompt.trim().length > 0,
  });
  const taskPrompt = [wakePrompt, input.taskPrompt.trim()]
    .filter((section) => section.length > 0)
    .join("\n\n");
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v4",
    executionMode,
    planningContext: input.planningContext ?? null,
    binding: {
      companyId: input.companyId,
      runId: input.runId,
      issueId: input.issue.id,
      agentId: input.agentId,
      executionWorkspaceId: input.workspace.id,
    },
    task: {
      identifier: input.issue.identifier ?? input.issue.id,
      title: input.issue.title,
      description: input.issue.description,
      prompt: taskPrompt,
      workMode: input.issue.workMode,
    },
    workspace: {
      cwd: input.workspace.cwd,
      repoUrl: input.workspace.repoUrl,
      repoRef: input.workspace.repoRef,
      branchName: input.workspace.branchName,
    },
    session: {
      normalizedSessionId: input.normalizedSessionId,
      driverKind: input.provider === "opencode"
        ? "opencode_server"
        : input.provider === "acpx"
          ? "acpx_runtime"
          : "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: input.lifecyclePolicy ?? { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: input.provider === "acpx"
      ? {
          kind: "acpx",
          agent: acpxProfile!.agent,
          model: input.model,
          permissionMode: input.acpxPermissionMode ?? "approve-all",
          profile: {
            driverKind: acpxProfile!.driverKind,
            protocolVersion: acpxProfile!.protocolVersion,
            acpxVersion: acpxProfile!.acpxVersion,
            agent: acpxProfile!.agent,
            agentProfileVersion: acpxProfile!.agentProfileVersion,
            agentServerPackage: acpxProfile!.agentServerPackage,
            agentServerVersion: acpxProfile!.agentServerVersion,
            agentRuntimePackage: acpxProfile!.agentRuntimePackage,
            agentRuntimeVersion: acpxProfile!.agentRuntimeVersion,
            commandDigest: acpxProfile!.commandDigest,
          },
        }
      : input.provider === "opencode"
        ? {
            kind: "opencode",
            model: input.model,
            permissionMode: input.opencodePermissionMode ?? "allow",
          }
        : {
            kind: "codex",
            model: input.model ?? null,
            approvalPolicy: input.codexApprovalPolicy ?? "untrusted",
          },
    completionContract: input.completionContract,
    interactionResponses: input.interactionResponses ?? [],
    credentialBindings: [],
    runtimeContext: input.runtimeContext,
  }) as NativeExecutionInputV4;
}
