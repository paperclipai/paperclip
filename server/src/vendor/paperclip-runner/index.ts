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
  EventEpochTransition,
  SourceCursor,
  AuthorityCommit,
  AuthorityPage,
  AuthorityRecord,
  AuthoritySnapshot,
  AuthorityWorkRecord,
  AuthorityWorkChange,
  AuthorityWorkPage,
  DurableAuthorityStore,
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

export const authorityInteger = runner.authorityInteger;
export const authorityGeneration = runner.authorityGeneration;
export const authorityDirectlyFollows = runner.authorityDirectlyFollows;
export const authorityJson = runner.authorityJson;
export const validateAuthorityCommit = runner.validateAuthorityCommit;
export const validateAuthorityPage = runner.validateAuthorityPage;
export const validateAuthorityWorkKey = runner.validateAuthorityWorkKey;
export const validateAuthorityWorkPage = runner.validateAuthorityWorkPage;
export const DurableAuthorityStoreError = runner.DurableAuthorityStoreError;

export const DurablePrpControlPlane = runner.DurablePrpControlPlane;
export const DURABLE_PRP_CONTROL_PLANE_MAX_STATE_BYTES =
  runner.DURABLE_PRP_CONTROL_PLANE_MAX_STATE_BYTES;
export const runnerCodexDynamicToolsFit = runner.runnerCodexDynamicToolsFit;
export const inspectWarmRunTransition = runner.inspectWarmRunTransition;
export const readRunnerdArtifactBinding = runner.readRunnerdArtifactBinding;
export const NativeSessionCleanupQuarantinedError =
  runner.NativeSessionCleanupQuarantinedError;
export const NativeSessionProtocolIntegrityError =
  runner.NativeSessionProtocolIntegrityError;
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
export const parseNativeRuntimeContext = runner.parseNativeRuntimeContext;
export const parsePaperclipQuestionSet = runner.parsePaperclipQuestionSet;
export const parsePaperclipQuestionResponse =
  runner.parsePaperclipQuestionResponse;
export const resolveQualifiedAcpxProfile = runner.resolveQualifiedAcpxProfile;
export const resolveSourceCodexHome = runner.resolveSourceCodexHome;
export const validatePrpEvent = runner.validatePrpEvent;
export const validatePrpStructuredRunResult =
  runner.validatePrpStructuredRunResult;

export const NativeProviderTerminalFailure = runner.NativeProviderTerminalFailure;

export const completeTerminatedRemoteNativeSessionCleanup = runner.completeTerminatedRemoteNativeSessionCleanup;
export const completeTerminatedLocalNativeSessionCleanup = runner.completeTerminatedLocalNativeSessionCleanup;

export { readDurableControlPlaneState, parseAuthorityLocator, type AuthorityLocation, type AuthorityLocator, type ExternalAuthorityReader } from "@paperclipai/paperclip-runner";
export { materializeCurrentAuthority } from "@paperclipai/paperclip-runner";

export { readIndexedLocalState, suspendIndexedRunnerState } from "@paperclipai/paperclip-runner";
export type { IndexedLocalSnapshot } from "@paperclipai/paperclip-runner";
export { IndexedInspectionDecoder } from "@paperclipai/paperclip-runner";
export { migrateLegacySessionAuthority, assertNoPendingLegacyMigration, type LegacySessionMigrationOptions, type PreparedLocalSession } from "@paperclipai/paperclip-runner";
export type { DurableRecoveryIdentity } from "@paperclipai/paperclip-runner";

export const isEventEpochTransition = runner.isEventEpochTransition;
export const normalizedEventId = runner.normalizedEventId;
export const advanceSourceCursor = runner.advanceSourceCursor;

export const isProviderProcessGeneration = runner.isProviderProcessGeneration;
