import type {
  HarnessRuntimeRequest,
  HarnessRuntimeRequestResolution,
  HarnessThreadLineageEntry,
  PersistedHarnessProviderIdentity,
  PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import type {
  CodexModelContextSnapshot,
  CodexTaskEnvelope,
} from "../../contracts/codex.js";
import type { CodexAppServerTransport } from "./app-server-transport.js";
import type { CodexWorkingDirectoryAuthority } from "./codex-boundaries.js";
import type { CodexQuestionResponseContext } from "./codex-question-adapter.js";

export interface CodexAppServerDriverOptions {
  taskEnvelope: CodexTaskEnvelope;
  /** Explicit provider model selected by the persisted native execution. */
  model?: string;
  approvalPolicy?: "never" | "on-request" | "untrusted";
  baseInstructions?: string;
  includeSkillInstructions?: boolean;
  conversationMode?: "task" | "direct";
  requestedCollaborationMode?: "default" | "plan";
  /**
   * Include Codex's built-in collaboration instructions. Defaults to true so
   * interactive runs receive native commentary/preambles. Deterministic evals
   * may opt out explicitly without changing the production default.
   */
  includeCollaborationModeInstructions?: boolean;
  transportFactory?: (context?: {
    providerRecoveryPolicy?: PersistedHarnessSession["providerRecoveryPolicy"];
    persistedSession?: Pick<
      PersistedHarnessSession,
      | "driverSessionId"
      | "providerSessionId"
      | "providerIdentity"
      | "activeTurnId"
    >;
  }) => CodexAppServerTransport;
  /** Additional control-plane tools exposed to the provider for this run. */
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  /** Executes an admitted additional tool call. Completion tools remain driver-owned. */
  dynamicToolHandler?: (call: {
    tool: string;
    callId: string;
    threadId: string;
    turnId: string;
    arguments: unknown;
  }) => Promise<unknown>;
  environment?: NodeJS.ProcessEnv;
  /** Filesystem that authoritatively admits the workspace path. */
  workingDirectoryAuthority?: CodexWorkingDirectoryAuthority;
  now?: () => Date;
  runnerInstanceId?: string;
  onDiagnostic?: (message: string) => void;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  capabilities?: Partial<{
    resume: boolean;
    read: boolean;
    steering: boolean;
    interruption: boolean;
    usage: boolean;
    reconciliation: boolean;
    dynamicTools: boolean;
    runtimeRequestResolution: boolean;
    goals: boolean;
    threadLineage: boolean;
  }>;
  /** Provider-specific identity retained when the Codex protocol facade is backed by runnerd. */
  driverIdentity?: {
    kind: string;
    displayName: string;
    version: string;
  };
  collaborationModes?: readonly ("default" | "plan")[];
  requireProviderSessionIdentity?: boolean;
}

export type CodexCapabilities = Required<
  NonNullable<CodexAppServerDriverOptions["capabilities"]>
>;

export type SemanticResultAdmission = "committed" | "identical" | "conflict";

export interface TerminalReplayConflict {
  code: "conflicting_semantic_result" | "conflicting_turn_terminal";
  message: string;
}

export interface OpenedCodexThread {
  threadId: string;
  providerSessionId: string | null;
  providerIdentity?: PersistedHarnessProviderIdentity;
  collaborationMode: Record<string, unknown> | null;
  context: CodexModelContextSnapshot;
  lineage: HarnessThreadLineageEntry;
}

export interface PendingRuntimeRequest {
  request: HarnessRuntimeRequest;
  responseContext: CodexQuestionResponseContext;
  settle: (response: Record<string, unknown>) => void;
  settlingResolution?: HarnessRuntimeRequestResolution;
}
