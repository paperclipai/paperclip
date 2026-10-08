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
  DotHarnessDriver,
  DotAssignment,
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
  NativeAcpxAgent,
  NativeAcpxPermissionMode,
  NativeCodexApprovalPolicy,
  NativeExecutionInput,
  NativeExecutionInputV4,
  NativeExecutionInputV5,
  NativeExecutionInputV6,
  DotBindingSnapshot,
  ExternalProviderPort,
  ExternalProviderOperation,
  NativeCompletionSource,
  NativeCompletionSources,
  NativeInteractionResponseEnvelope,
  NativeOpenCodePermissionMode,
  NativePlanningContext,
  NativeRunEvent,
  NativeRunResult,
  NativeRuntimeAssetReference,
  NativeRuntimeContextSnapshot,
  NativeSession,
  NativeSessionBackend,
  NativeSessionGoalControl,
  OpenControlPlaneRunInput,
  PersistedNativeSession,
  PrpEvent,
  PrpIgnoredAttentionRequest,
  PrpNormalizedAttentionRequest,
  PrpStructuredRunResult,
  PrpTerminalState,
  PrpVerificationReasonCode,
  PrpWireConnection,
  ReplayControlPlaneEventsInput,
  RunnerProcessHandle,
  RunnerProcessLaunchSpec,
  StrictCompletionContractInput,
  TransportCloseReason,
} from "@paperclipai/paperclip-runner";
export type DurablePrpControlPlane =
  import("@paperclipai/paperclip-runner").DurablePrpControlPlane;
export type PaperclipSemanticDispatcher =
  import("@paperclipai/paperclip-runner").PaperclipSemanticDispatcher;

const sourceUrl = new URL(
  "../../../../packages/paperclip-runner/src/index.ts",
  import.meta.url,
);
const runner = (await import(sourceUrl.href)) as RunnerModule;

export const DurablePrpControlPlane = runner.DurablePrpControlPlane;
export const runnerCodexDynamicToolsFit = runner.runnerCodexDynamicToolsFit;
export const inspectWarmRunTransition = runner.inspectWarmRunTransition;
export const readRunnerdArtifactBinding = runner.readRunnerdArtifactBinding;
export const NativeSessionCleanupQuarantinedError =
  runner.NativeSessionCleanupQuarantinedError;
export const NativeSessionProtocolIntegrityError =
  runner.NativeSessionProtocolIntegrityError;
export const SemanticToolOutcomeUnknownError = runner.SemanticToolOutcomeUnknownError;
export const PaperclipSemanticDispatcher = runner.PaperclipSemanticDispatcher;
export const CAPABILITY_SEMANTIC_TOOL_CATALOG =
  runner.CAPABILITY_SEMANTIC_TOOL_CATALOG;
export const HarnessRuntimeRequestResolutionError =
  runner.HarnessRuntimeRequestResolutionError;
export const NATIVE_RUNTIME_ASSET_SCHEMA = runner.NATIVE_RUNTIME_ASSET_SCHEMA;
export const PAPERCLIP_EXECUTION_PROMPT = runner.PAPERCLIP_EXECUTION_PROMPT;
export const PAPERCLIP_EXECUTION_PROMPT_REVISION =
  runner.PAPERCLIP_EXECUTION_PROMPT_REVISION;
export const acpxRuntimeSessionDirectoryName =
  runner.acpxRuntimeSessionDirectoryName;
export const canonicalNativeRuntimeContextDigest =
  runner.canonicalNativeRuntimeContextDigest;
export const createNativeSessionBackend = runner.createNativeSessionBackend;
export const describeRunnerdNativeSessionBackend = runner.describeRunnerdNativeSessionBackend;
export const createPaperclipRunnerAuthorizedToolSet =
  runner.createPaperclipRunnerAuthorizedToolSet;
export const createRunnerdCodexTransport: (
  options?: import("@paperclipai/paperclip-runner").RunnerdCodexTransportOptions,
) => import("@paperclipai/paperclip-runner").RunnerdCodexTransport =
  runner.createRunnerdCodexTransport;
export const defaultCapabilityRunnerdBinary =
  runner.defaultCapabilityRunnerdBinary;
export const executeNativeSession = runner.executeNativeSession;
export const applyNativeSessionGoalControl =
  runner.applyNativeSessionGoalControl;
export const completeRetainedNativeSessionCleanup = runner.completeRetainedNativeSessionCleanup;
export const settleRetainedRunnerdSession = runner.settleRetainedRunnerdSession;
export const retainedRunnerdMaintenanceIsIdle =
  runner.retainedRunnerdMaintenanceIsIdle;
export const drainRetainedRunnerdMaintenanceOperations =
  runner.drainRetainedRunnerdMaintenanceOperations;
export const nativeRuntimePromptDigest = runner.nativeRuntimePromptDigest;
export const normalizePrpResultSignals = runner.normalizePrpResultSignals;
export const parseCodexTurnDiff = runner.parseCodexTurnDiff;
export const parseHarnessRuntimeRequestResolution =
  runner.parseHarnessRuntimeRequestResolution;
export const parseNativeExecutionInput = runner.parseNativeExecutionInput;
export const isProviderMode = runner.isProviderMode;
export const parseNativeRuntimeContext = runner.parseNativeRuntimeContext;
export const parsePaperclipQuestionSet = runner.parsePaperclipQuestionSet;
export const parsePaperclipQuestionResponse =
  runner.parsePaperclipQuestionResponse;
export const resolveQualifiedAcpxProfile = runner.resolveQualifiedAcpxProfile;
export const probeQualifiedAcpxEnvironment = runner.probeQualifiedAcpxEnvironment;
// Keep the source-mode shim typed while a serving checkout's previous dist
// declarations remain intact. The server build replaces this shim entirely.
type NativeRunnerProbe = (options: {
  runtimeDirectory: string; provider: "codex" | "opencode"; model: string | null;
  reasoningEffort?: string; environment: NodeJS.ProcessEnv; timeoutMs?: number; workingDirectory?: string;
  transportOptions?: import("@paperclipai/paperclip-runner").RunnerdCodexTransportOptions;
  onCodexCredentialRefresh?: (filename: string) => Promise<void>;
  onCleanupConfirmed?: () => Promise<void>;
}) => Promise<{ provider: "codex" | "opencode"; providerDriver: string; effectiveModel: string; helloProbePassed: true }>;
export const probeNativeRunnerEnvironment: NativeRunnerProbe = (runner as RunnerModule & { probeNativeRunnerEnvironment: NativeRunnerProbe }).probeNativeRunnerEnvironment;
export const QUALIFIED_ACPX_PROFILES = runner.QUALIFIED_ACPX_PROFILES;
export const QUALIFIED_ACPX_VERSION = runner.QUALIFIED_ACPX_VERSION;
export const CURSOR_DISTRIBUTION_PINS = runner.CURSOR_DISTRIBUTION_PINS;
export const resolveSourceCodexHome = runner.resolveSourceCodexHome;
export const resolvePinnedCodexCommand = runner.resolvePinnedCodexCommand;
export const resolvePinnedClaudeCommand = runner.resolvePinnedClaudeCommand;
export const resolvePinnedOpenCodeCommand = runner.resolvePinnedOpenCodeCommand;
export const QUALIFIED_OPENCODE_VERSION = runner.QUALIFIED_OPENCODE_VERSION;
export const validatePrpEvent = runner.validatePrpEvent;
export const validatePrpStructuredRunResult =
  runner.validatePrpStructuredRunResult;

export const NativeProviderTerminalFailure = runner.NativeProviderTerminalFailure;
export const nativeRestartInterruptedTurnId = runner.nativeRestartInterruptedTurnId;

export const completeTerminatedRemoteNativeSessionCleanup = runner.completeTerminatedRemoteNativeSessionCleanup;
export const completeTerminatedLocalNativeSessionCleanup = runner.completeTerminatedLocalNativeSessionCleanup;

export const externalOperationDigest = runner.externalOperationDigest;
export const bundledRemoteProviderPackManifestPath = runner.bundledRemoteProviderPackManifestPath;
export const bundledRemoteRunnerBinary = runner.bundledRemoteRunnerBinary;

export const CONFIGURED_ENVIRONMENT_KEYS = runner.CONFIGURED_ENVIRONMENT_KEYS;
export const GENERATED_RUNTIME_ENVIRONMENT_KEYS = runner.GENERATED_RUNTIME_ENVIRONMENT_KEYS;
export const configuredEnvironmentProjection = runner.configuredEnvironmentProjection;
export const configuredEnvironment = runner.configuredEnvironment;
