/**
 * Development shim for the package-local runner runtime.
 *
 * Source-mode server entry points do not build workspace dependencies first,
 * so this shim loads the package source through the TypeScript runtime. The
 * server build replaces the emitted shim with the package's compiled `dist`
 * tree so published server packages have no workspace runtime dependency.
 * Keep server imports pointed at this relative boundary.
 */
type RunnerModule = typeof import("@paperclipai/paperclip-runner");

export type {
  PaperclipJsonValue,
  PaperclipQuestionResponse,
  PaperclipSemanticActionBinding,
  PaperclipSemanticActionId,
  PaperclipSemanticAuthorizationRecord,
  PaperclipSemanticRunContext,
  PaperclipSemanticToolCall,
  PaperclipSemanticToolDefinition,
  PaperclipSemanticToolResult,
  PaperclipRunnerAuthorizedToolSet,
  PaperclipQuestionSet,
  PaperclipRuntimeInputRequest,
  CompleteControlPlaneRunInput,
  ControlPlanePort,
  HarnessRuntimeRequestKind,
  HarnessRuntimeRequestResolution,
  NativeCodexApprovalPolicy,
  NativeExecutionInput,
  NativeExecutionInputV4,
  NativeInteractionResponseEnvelope,
  NativePlanningContext,
  NativeRunEvent,
  NativeRunResult,
  NativeRuntimeAssetReference,
  NativeRuntimeContextSnapshot,
  NativeSession,
  NativeSessionBackend,
  OpenControlPlaneRunInput,
  PersistedNativeSession,
  PrpEvent,
  PrpIgnoredAttentionRequest,
  PrpNormalizedAttentionRequest,
  PrpStructuredRunResult,
  PrpTerminalState,
  PrpVerificationReasonCode,
  ReplayControlPlaneEventsInput,
  StrictCompletionContractInput,
} from "@paperclipai/paperclip-runner";
export type DurablePrpControlPlane =
  import("@paperclipai/paperclip-runner").DurablePrpControlPlane;
export type PaperclipSemanticDispatcher =
  import("@paperclipai/paperclip-runner").PaperclipSemanticDispatcher;

const sourceUrl = new URL(
  "../../../../packages/paperclip-runner/src/index.ts",
  import.meta.url,
);
const runner = await import(sourceUrl.href) as RunnerModule;

export const DurablePrpControlPlane = runner.DurablePrpControlPlane;
export const PaperclipSemanticDispatcher = runner.PaperclipSemanticDispatcher;
export const CAPABILITY_SEMANTIC_TOOL_CATALOG =
  runner.CAPABILITY_SEMANTIC_TOOL_CATALOG;
export const HarnessRuntimeRequestResolutionError =
  runner.HarnessRuntimeRequestResolutionError;
export const NATIVE_RUNTIME_ASSET_SCHEMA = runner.NATIVE_RUNTIME_ASSET_SCHEMA;
export const PAPERCLIP_EXECUTION_PROMPT = runner.PAPERCLIP_EXECUTION_PROMPT;
export const PAPERCLIP_EXECUTION_PROMPT_REVISION =
  runner.PAPERCLIP_EXECUTION_PROMPT_REVISION;
export const canonicalNativeRuntimeContextDigest =
  runner.canonicalNativeRuntimeContextDigest;
export const createNativeSessionBackend = runner.createNativeSessionBackend;
export const createPaperclipRunnerAuthorizedToolSet =
  runner.createPaperclipRunnerAuthorizedToolSet;
export const createRunnerdCodexTransport: (
  options?: import("@paperclipai/paperclip-runner").RunnerdCodexTransportOptions,
) => import("@paperclipai/paperclip-runner").RunnerdCodexTransport =
  runner.createRunnerdCodexTransport;
export const defaultCapabilityRunnerdBinary =
  runner.defaultCapabilityRunnerdBinary;
export const executeNativeSession = runner.executeNativeSession;
export const nativeRuntimePromptDigest = runner.nativeRuntimePromptDigest;
export const normalizePrpResultSignals = runner.normalizePrpResultSignals;
export const parseCodexTurnDiff = runner.parseCodexTurnDiff;
export const parseHarnessRuntimeRequestResolution =
  runner.parseHarnessRuntimeRequestResolution;
export const parseNativeExecutionInput = runner.parseNativeExecutionInput;
export const parseNativeRuntimeContext = runner.parseNativeRuntimeContext;
export const parsePaperclipQuestionSet = runner.parsePaperclipQuestionSet;
export const parsePaperclipQuestionResponse = runner.parsePaperclipQuestionResponse;
export const validatePrpEvent = runner.validatePrpEvent;
export const validatePrpStructuredRunResult =
  runner.validatePrpStructuredRunResult;
