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
import {
  isPaperclipExternalChatContractTurn,
  isPaperclipExternalChatQuestionResponseTurn,
  renderPaperclipWakePrompt,
} from "@paperclipai/adapter-utils/server-utils";

const NATIVE_EXTERNAL_CHAT_QUESTION_GUIDANCE = [
  "## Native external-chat questions",
  "A request for clickable choices, buttons, or a decision needed before continuing is not a self-contained text answer. The zero-API-call shortcut does not prohibit the structured question tool.",
  'Use the available request_human_input tool with interactionKind="questions", continuationPolicy="wake_assignee", a title, prompt, and a stable idempotencyKey. Put the actual requested choices in payload.questions: each question needs an id, prompt, selectionMode="single", and options with stable id and label fields. Reuse the same key if that creation call must be retried.',
  "Paperclip renders the supported question controls and authenticates the answer. Never fabricate answer URLs, query-string choice links, callback tokens, or fake Markdown buttons. Do not manually post a duplicate question card or use call_api as a substitute.",
  "For one question at a time, read the current request and authoritative prior answers, then create only the next unanswered question. Wait for its real answer before asking another; do not infer a selection or answer your own interaction. Keep completion and disposition truthful while waiting, and preserve existing review or approval gates.",
  "If the tool is unavailable or creation fails, report that actual limitation plainly; do not pretend interactive controls were created.",
].join("\n");

const NATIVE_GITHUB_ATTACHMENT_RECOVERY_GUIDANCE = [
  "## GitHub attachment recovery navigation",
  "Paperclip owns recovery navigation for unavailable GitHub attachments. It may append an authenticated task link after an accepted response, only when the current source remains authorized and a safe configured Board URL is available. The model does not select or authorize that link.",
  "A task URL missing from your prompt or tool results is not evidence that no task link can be provided; do not claim that a link is unavailable merely because you cannot see its URL. Do not invent a URL or promise that a link will appear. Briefly explain the unavailable input and ask the user to attach it directly to this Paperclip task or paste the needed text. Never infer the file's contents or substitute an older file.",
].join("\n");

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
  conversationMode?: boolean;
  agentId: string;
  workspace: {
    id: string;
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  normalizedSessionId: string | null;
  provider?: "codex" | "opencode" | "claude_managed" | "aws_agentcore" | "acpx";
  acpxAgent?: NativeAcpxAgent;
  codexApprovalPolicy?: NativeCodexApprovalPolicy;
  opencodePermissionMode?: NativeOpenCodePermissionMode;
  acpxPermissionMode?: NativeAcpxPermissionMode;
  model?: string | null;
  managedProfile?: Extract<
    NativeExecutionInputV4["provider"],
    { kind: "claude_managed" }
  >["managedProfile"];
  maxSessionListCostUsd?: number;
  agentCoreProfile?: Extract<
    NativeExecutionInputV4["provider"],
    { kind: "aws_agentcore" }
  >["agentCoreProfile"];
  maxEstimatedSessionCostUsd?: number;
  invocationLimits?: Extract<
    NativeExecutionInputV4["provider"],
    { kind: "aws_agentcore" }
  >["invocationLimits"];
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
        input.acpxAgent ?? "codex",
        input.model ?? "",
      )
    : null;
  // Answers are materialized from the authoritative interaction only for this
  // invocation; do not persist a duplicate answer in the durable wake snapshot.
  const wake =
    input.wakePayload &&
    typeof input.wakePayload === "object" &&
    !Array.isArray(input.wakePayload)
      ? (input.wakePayload as Record<string, unknown>)
      : null;
  const question = wake?.externalChatQuestionResponse
    ? input.interactionResponses?.find(
        (response) =>
          response.interactionId === wake.interactionId &&
          response.kind === "ask_user_questions" &&
          response.response.status === "answered",
      )
    : null;
  const answerResult = question?.response.result as
    Record<string, unknown> | undefined;
  // The server supplies only the revalidated answer chain, in source order.
  // Keep prior choices available even when this continuation starts a fresh
  // provider session; never recover them from model prose or a transcript.
  const answerChain = question
    ? input.interactionResponses?.filter((response) =>
        response.kind === "ask_user_questions" &&
        response.response.status === "answered" &&
        typeof (response.response.result as Record<string, unknown> | undefined)
          ?.summaryMarkdown === "string")
    : null;
  const answerSummary =
    answerChain && answerChain.length > 1 &&
    answerChain.at(-1)?.interactionId === question?.interactionId
      ? answerChain.map((response, index) => {
          const label = index === answerChain.length - 1
            ? "Latest answered question" : `Earlier answer ${index + 1}`;
          return `${label}:\n${(response.response.result as Record<string, unknown>).summaryMarkdown}`;
        }).join("\n\n")
      : answerResult?.summaryMarkdown;
  const wakePayload =
    question && typeof answerSummary === "string"
      ? {
          ...wake,
          questionResponse: {
            interactionId: question.interactionId,
            summaryMarkdown: answerSummary,
          },
        }
      : input.wakePayload;
  const wakePrompt = renderPaperclipWakePrompt(wakePayload, {
    resumedSession: input.resumedSession === true,
    conversationMode: input.conversationMode === true,
    suppressIssueDescription: input.taskPrompt.trim().length > 0,
    nativeWakeReaderAvailable: true,
  });
  const externalChatTurn =
    isPaperclipExternalChatContractTurn(wakePayload) ||
    isPaperclipExternalChatQuestionResponseTurn(wakePayload);
  const taskPrompt = [
    wakePrompt,
    externalChatTurn ? NATIVE_EXTERNAL_CHAT_QUESTION_GUIDANCE : "",
    externalChatTurn && wake?.externalChatProvider === "github"
      ? NATIVE_GITHUB_ATTACHMENT_RECOVERY_GUIDANCE
      : "",
    input.taskPrompt.trim(),
  ]
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
      // The issue title is durable background context and may itself contain an
      // exact-output instruction from the thread's first message. Repeating it
      // as the native turn title can override a newer provider message in small
      // models. Keep the canonical title and description in task.prompt as
      // explicitly labeled background, but give authenticated external-chat
      // turns neutral structured fields.
      title: externalChatTurn ? "External chat follow-up" : input.issue.title,
      description: externalChatTurn ? null : input.issue.description,
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
        : input.provider === "claude_managed"
          ? "claude_managed_agents_api"
          : input.provider === "aws_agentcore"
            ? "aws_agentcore_harness_api"
        : input.provider === "acpx"
            ? "acpx_runtime"
            : "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: input.lifecyclePolicy ?? { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: input.provider === "claude_managed"
      ? {
          kind: "claude_managed",
          model: input.model,
          managedProfile: input.managedProfile,
          maxSessionListCostUsd: input.maxSessionListCostUsd,
        }
      : input.provider === "aws_agentcore"
        ? {
            kind: "aws_agentcore",
            model: input.model,
            agentCoreProfile: input.agentCoreProfile,
            maxEstimatedSessionCostUsd: input.maxEstimatedSessionCostUsd,
            invocationLimits: input.invocationLimits,
          }
      : input.provider === "acpx"
      ? {
          kind: "acpx",
          agent: acpxProfile!.agent,
          model: input.model,
          permissionMode: input.acpxPermissionMode ?? "approve-reads",
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
            permissionMode: input.opencodePermissionMode ?? "ask",
          }
        : {
            kind: "codex",
            model: input.model ?? null,
            approvalPolicy: input.codexApprovalPolicy ?? "never",
          },
    completionContract: input.completionContract,
    interactionResponses: input.interactionResponses ?? [],
    credentialBindings: [],
    runtimeContext: input.runtimeContext,
  }) as NativeExecutionInputV4;
}
