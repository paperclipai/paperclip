import { trustCodexStartupRoot } from "./codex-startup-trust.js";
import { readCodexThreadState, readCodexTurnMetadata } from "./codex-history.js";
import { codexExecutableReadOnlyRoots } from "./codex-security-config.js";
import { resolve } from "node:path";

import type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessRuntimeRequest,
  HarnessSession,
  HarnessSessionRecoveryOptions,
  HarnessSessionRecoveryResult,
  HarnessThreadGoal,
  HarnessThreadLineageEntry,
  OpenHarnessSessionInput,
  PersistedHarnessSemanticResult,
  PersistedHarnessSession,
  PersistedHarnessTurnTerminal,
} from "../../contracts/harness-driver.js";
import { NativeSessionProtocolIntegrityError } from "../../contracts/native-session-backend.js";
import { HarnessReconciliationError } from "../../contracts/harness-driver.js";
import {
  CODEX_CODEX_PROTOCOL_VERSION,
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
} from "../../contracts/codex.js";
import { providerFamilyCapabilities } from "../../provider-events.js";
import {
  CodexRpcError,
  ProcessCodexAppServerTransport,
  createSanitizedCodexEnvironment,
  isCodexMethodUnavailable,
  redactCodexDiagnostic,
  type CodexAppServerTransport,
  type CodexTransportProcessInfo,
} from "./app-server-transport.js";
import {
  boundedCodexValue,
  validateCodexWorkingDirectory as validateWorkingDirectory,
} from "./codex-boundaries.js";
import {
  codexCommandEnvironment,
  createIsolatedCodexAppServerArgs,
  codexNetworkAccess,
  createSecuredCodexThreadParams,
  createSkilllessCodexThreadConfig,
} from "./codex-security-config.js";
import {
  codexThreadLineage as lineageFromThread,
  codexThreadStatus as threadStatus,
  parseCodexThreadGoal as parseThreadGoal,
} from "./codex-thread-normalization.js";
import { CodexHarnessSession } from "./codex-harness-session.js";
import type {
  CodexAppServerDriverOptions,
  CodexCapabilities,
  CodexGoalAvailability,
  OpenedCodexThread,
} from "./codex-driver-types.js";
import {
  boundedText,
  canonicalJson,
  codexSemanticToolSpecs,
  differingJsonPaths,
  parseProviderIdentity,
  record,
  text,
} from "./codex-driver-values.js";

const DRIVER_KIND = "codex_app_server";
const DRIVER_VERSION = "codex-v2";

interface BootstrapCancellation {
  close(): Promise<void>;
  detach(): void;
  wait<T>(operation: Promise<T>): Promise<T>;
}

function bootstrapCancellation(
  transport: CodexAppServerTransport,
  signal: AbortSignal | undefined,
): BootstrapCancellation {
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= transport.close();
    return closePromise;
  };
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  let abortStarted = false;
  const onAbort = (): void => {
    if (abortStarted) return;
    abortStarted = true;
    // Provider bootstrap owns a local process. Do not report cancellation
    // until its pending RPCs have been rejected and TERM/KILL cleanup has
    // completed. The cancellation reason remains authoritative if cleanup
    // itself reports a secondary failure.
    void close().then(
      () =>
        rejectAborted(signal?.reason ?? new Error("Codex bootstrap aborted")),
      () =>
        rejectAborted(signal?.reason ?? new Error("Codex bootstrap aborted")),
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // Close the construction/listener race after the caller's preflight abort
  // check without creating a provider for an already-aborted operation.
  if (signal?.aborted) onAbort();
  return {
    close,
    detach(): void {
      signal?.removeEventListener("abort", onAbort);
    },
    async wait<T>(operation: Promise<T>): Promise<T> {
      if (signal === undefined) return await operation;
      const result = await Promise.race([operation, aborted]);
      // An operation and abort cleanup may settle in the same microtask turn.
      // Cancellation wins until session admission, and still awaits cleanup.
      if (signal.aborted) return await aborted;
      return result;
    },
  };
}

export class CodexAppServerDriver implements HarnessDriver {
  readonly #options: CodexAppServerDriverOptions;
  readonly #caps: CodexCapabilities;
  #goalAvailability: CodexGoalAvailability;
  #goalReasonCode: string | null = null;
  #goalReason: string | null = null;
  readonly #goalCapability: NonNullable<
    CodexAppServerDriverOptions["goalCapability"]
  >;
  readonly #persistedProcessIdentities = new WeakMap<object, string>();

  constructor(options: CodexAppServerDriverOptions) {
    this.#options = options;
    this.#caps = {
      resume: true,
      read: true,
      steering: true,
      interruption: true,
      usage: true,
      reconciliation: true,
      dynamicTools: true,
      runtimeRequestResolution: true,
      goals: true,
      threadLineage: true,
      ...options.capabilities,
    };
    this.#goalAvailability = this.#caps.goals ? "available" : "unsupported";
    this.#goalCapability = options.goalCapability ?? {
      actions: ["set", "pause", "resume", "clear"],
      autonomousUpdates: true,
      persistentAcrossResume: true,
      maxObjectiveChars: 4_000,
      tokenBudgetControl: true,
      usageReporting: true,
    };
    if (!this.#caps.goals) {
      this.#goalReasonCode = "codex_goal_api_unavailable";
      this.#goalReason = "This Codex app-server does not expose thread goals.";
    }
    if (!this.#caps.read) this.#caps.reconciliation = false;
  }

  #direct(): boolean {
    return this.#options.conversationMode === "direct";
  }

  #providerDynamicTools(): readonly Readonly<Record<string, unknown>>[] {
    if (!this.#caps.dynamicTools) return [];
    const supplied = this.#options.dynamicTools ?? [];
    if (this.#direct()) {
      // Direct chat deliberately excludes the general semantic/governance
      // catalog. Keep only the server-authorized question, file handoff, and
      // current-wake tools so the harness can ask a structured provider
      // question or return requested files without reopening general task
      // authority.
      return supplied.filter(
        (tool) =>
          text(tool.name) === "register_deliverable" ||
          text(tool.name) === "request_human_input" ||
          text(tool.name) === "read_current_wake_comments" ||
          text(tool.name) === "list_chat_attachments" ||
          text(tool.name) === "reuse_chat_attachment" ||
          text(tool.name) === "read_chat_attachment",
      );
    }
    return [...supplied, ...codexSemanticToolSpecs()];
  }

  #baseInstructions(): string {
    return this.#options.baseInstructions ?? CODEX_SKILLLESS_BASE_INSTRUCTIONS;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    const unsupported = Object.entries(this.#caps)
      .filter(([, supported]) => !supported)
      .map(([operation]) => operation);
    return {
      kind: this.#options.driverIdentity?.kind ?? DRIVER_KIND,
      displayName:
        this.#options.driverIdentity?.displayName ?? "Codex app-server",
      version: this.#options.driverIdentity?.version ?? DRIVER_VERSION,
      protocolVersion: CODEX_CODEX_PROTOCOL_VERSION,
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "native",
        mcp: "native",
      },
      capabilities: {
        resume: this.#caps.resume,
        typedEvents: true,
        typedEventFamilies: providerFamilyCapabilities({
          plan: "available",
          tool_execution: "available",
          research: "available",
          delegation: "available",
          model_identity: "available",
          context: "available",
          artifact: "policy_disabled",
          review: "available",
          hook: "available",
          memory: "available",
          safety: "available",
          terminal: "available",
          wait: "available",
          provider_notice: "available",
        }),
        steering: this.#caps.steering,
        interruption: this.#caps.interruption,
        structuredResult: true,
        read: this.#caps.read,
        reconciliation: this.#caps.reconciliation,
        usage: this.#caps.usage,
        dynamicTools: this.#caps.dynamicTools,
        runtimeRequestResolution: this.#caps.runtimeRequestResolution,
        runtimeRequestHandoff: this.#caps.runtimeRequestResolution,
        goals: this.#caps.goals,
        threadLineage: this.#caps.threadLineage,
        collaborationModes: [
          ...(this.#options.collaborationModes ?? ["default", "plan"]),
        ],
        unsupported,
      },
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    input.signal?.throwIfAborted();
    const workingDirectory = validateWorkingDirectory(
      input.workingDirectory,
      this.#options.environment,
      this.#options.workingDirectoryAuthority,
    );
    const transport = this.#transport({ workingDirectory });
    const cancellation = bootstrapCancellation(transport, input.signal);
    try {
      await cancellation.wait(this.#persistProcessOwnership(transport));
      const initialize = await cancellation.wait(this.#initialize(transport));
      const requestedMode =
        this.#options.requestedCollaborationMode ?? "default";
      const response = await cancellation.wait(
        transport.request("thread/start", {
          ...createSecuredCodexThreadParams(
            workingDirectory,
            requestedMode,
            this.#options.includeCollaborationModeInstructions ?? true,
            this.#options.includeSkillInstructions ?? false,
            this.#options.environment,
          ),
          approvalPolicy: this.#options.approvalPolicy ?? "untrusted",
          ...(this.#options.model ? { model: this.#options.model } : {}),
          ...(this.#direct()
            ? {}
            : {
                baseInstructions: this.#baseInstructions(),
                completionContract: {
                  revision:
                    this.#options.taskEnvelope.completionContract.revision,
                  criterionIds:
                    this.#options.taskEnvelope.completionContract.criteria.map(
                      (criterion) => criterion.id,
                    ),
                },
              }),
          dynamicTools: this.#providerDynamicTools(),
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        }),
      );
      await cancellation.wait(this.#persistProcessOwnership(transport));
      const collaborationMode = await cancellation.wait(
        this.#negotiateCollaborationMode(transport, response, requestedMode),
      );
      const opened = this.#openedThread(
        response,
        initialize,
        workingDirectory,
        collaborationMode,
      );
      const goal = await cancellation.wait(
        this.#discoverGoal(transport, opened.threadId),
      );
      if (opened.context.liveConsole)
        opened.context.liveConsole.goals = this.#caps.goals;
      return this.#session({
        transport,
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        opened,
        goal,
        goalAvailability: this.#goalAvailability,
        goalReasonCode: this.#goalReasonCode,
        goalReason: this.#goalReason,
        resumed: false,
        sourceSequence: 0,
      });
    } catch (error) {
      // Cleanup must never replace the provider/bootstrap failure that caused
      // the session open to abort. Remote transports may perform checkpoint
      // work during close; when no durable provider identity exists that
      // cleanup can fail independently.
      await cancellation.close().catch(() => {});
      if (error instanceof NativeSessionProtocolIntegrityError) throw error;
      if (input.signal?.aborted) input.signal.throwIfAborted();
      throw error;
    } finally {
      cancellation.detach();
    }
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
    options: HarnessSessionRecoveryOptions = {
      signal: new AbortController().signal,
    },
  ): Promise<HarnessSessionRecoveryResult> {
    options.signal.throwIfAborted();
    if (!this.#caps.resume) {
      return { recovered: false, reason: "resume capability is unavailable" };
    }
    if (!this.#caps.read) {
      return {
        recovered: false,
        reason: "read capability is required for safe resume",
      };
    }
    if (
      !snapshot.runId ||
      !snapshot.normalizedSessionId ||
      !snapshot.driverSessionId
    ) {
      return {
        recovered: false,
        reason: "persisted session identity is incomplete",
      };
    }
    const transport = this.#transport({
      workingDirectory: snapshot.workingDirectory
        ? validateWorkingDirectory(snapshot.workingDirectory, this.#options.environment, this.#options.workingDirectoryAuthority)
        : undefined,
      providerRecoveryPolicy: snapshot.providerRecoveryPolicy,
      persistedSession: {
        driverSessionId: snapshot.driverSessionId,
        providerSessionId: snapshot.providerSessionId,
        providerIdentity: snapshot.providerIdentity,
        activeTurnId: snapshot.activeTurnId,
      },
    });
    const cancellation = bootstrapCancellation(transport, options.signal);
    try {
      await cancellation.wait(this.#persistProcessOwnership(transport));
      const initialize = await cancellation.wait(this.#initialize(transport));
      const existing = await cancellation.wait(
        readCodexThreadState(transport, snapshot.driverSessionId),
      );
      await cancellation.wait(this.#persistProcessOwnership(transport));
      const existingThread = record(existing.thread);
      existingThread.turns = await cancellation.wait(readCodexTurnMetadata(transport, snapshot.driverSessionId));
      if (text(existingThread.id) !== snapshot.driverSessionId) {
        await cancellation.wait(cancellation.close());
        return {
          recovered: false,
          reason: "provider read a different session",
        };
      }
      const workingDirectory = validateWorkingDirectory(
        text(existingThread.cwd),
        this.#options.environment,
        this.#options.workingDirectoryAuthority,
      );
      const response = await cancellation.wait(
        transport.request("thread/resume", {
          excludeTurns: true,
          threadId: snapshot.driverSessionId,
          ...createSecuredCodexThreadParams(
            workingDirectory,
            this.#options.requestedCollaborationMode ?? "default",
            this.#options.includeCollaborationModeInstructions ?? true,
            this.#options.includeSkillInstructions ?? false,
            this.#options.environment,
          ),
          baseInstructions: this.#direct() ? "" : this.#baseInstructions(),
          approvalPolicy: this.#options.approvalPolicy ?? "untrusted",
          ...(this.#options.model ? { model: this.#options.model } : {}),
          dynamicTools: this.#providerDynamicTools(),
          persistExtendedHistory: false,
        }),
      );
      await cancellation.wait(this.#persistProcessOwnership(transport));
      const collaborationMode = await cancellation.wait(
        this.#negotiateCollaborationMode(
          transport,
          response,
          this.#options.requestedCollaborationMode ?? "default",
        ),
      );
      const opened = this.#openedThread(
        response,
        initialize,
        workingDirectory,
        collaborationMode,
      );
      if (opened.threadId !== snapshot.driverSessionId) {
        await cancellation.wait(cancellation.close());
        return {
          recovered: false,
          reason: "provider resumed a different session",
        };
      }
      if (
        snapshot.providerSessionId &&
        opened.providerSessionId !== snapshot.providerSessionId
      ) {
        await cancellation.wait(cancellation.close());
        return {
          recovered: false,
          reason: "provider resumed a different provider session",
        };
      }
      if (
        snapshot.providerIdentity !== undefined &&
        canonicalJson(opened.providerIdentity) !==
          canonicalJson(snapshot.providerIdentity)
      ) {
        await cancellation.wait(cancellation.close());
        return {
          recovered: false,
          reason: "provider resumed with a different tagged session identity",
        };
      }
      const checkpointedActiveTurnId = snapshot.activeTurnId ?? null;
      // A terminal fingerprint is the durable provider fact. A crash can
      // persist it before the following active-turn clear reaches the same
      // checkpoint, so never resurrect that already-terminal turn as active.
      const checkpointedActiveTurnIsTerminal =
        checkpointedActiveTurnId !== null &&
        (snapshot.terminalTurns ?? []).some(
          (terminal) => terminal.turnId === checkpointedActiveTurnId,
        );
      let recoveredActiveTurnId = checkpointedActiveTurnIsTerminal
        ? null
        : checkpointedActiveTurnId;
      let dispositionOnlyRecoveryConsumed =
        snapshot.dispositionOnlyRecoveryConsumed ?? false;
      let dispositionOnlyRecoveryTurnId =
        snapshot.dispositionOnlyRecoveryTurnId ?? null;
      let reconcileUncheckpointedDispositionTurn = false;
      let providerTurnIds: Set<string> | null = null;
      const goal = await cancellation.wait(
        this.#discoverGoal(transport, opened.threadId),
      );
      const recoveringAutonomousGoal = snapshot.goal?.status === "active"
        && goal != null
        && goal.createdAt === snapshot.goal.createdAt;
      if (recoveringAutonomousGoal) {
        // Goal activation and continuation have no turn/start response. The
        // provider can advance beyond the last controller checkpoint while
        // disconnected, so bind the single live turn from the authenticated,
        // identity-checked thread read before draining its notifications.
        // Never infer a turn from an arbitrary notification or another goal.
        const turns = Array.isArray(existingThread.turns)
          ? existingThread.turns.map(record)
          : null;
        const active = turns?.filter((turn) => text(turn.status) === "inProgress");
        if (!active || active.length > 1 || (active.length === 1 && (
          !text(active[0]?.id)
          || (snapshot.terminalTurns ?? []).some((turn) => turn.turnId === text(active[0]?.id))
        ))) {
          await cancellation.wait(cancellation.close());
          return { recovered: false, reason: "provider exposed ambiguous autonomous goal turn history" };
        }
        recoveredActiveTurnId = active.length === 1 ? text(active[0]?.id) : recoveredActiveTurnId;
      }
      if (
        !recoveringAutonomousGoal &&
        !this.#direct() &&
        snapshot.semanticResult == null &&
        recoveredActiveTurnId === null &&
        (snapshot.terminalTurns?.length ?? 0) > 0
      ) {
        const providerHistory = existingThread.turns;
        const providerHistoryIsArray = Array.isArray(providerHistory);
        const turns = providerHistoryIsArray ? providerHistory.map(record) : [];
        const terminalIds = new Set(
          (snapshot.terminalTurns ?? []).map((turn) => turn.turnId),
        );
        let lastKnownTerminalIndex = -1;
        turns.forEach((turn, index) => {
          if (terminalIds.has(text(turn.id))) lastKnownTerminalIndex = index;
        });
        // Releasing a consumed marker requires both an actual history array
        // and a checkpointed terminal that anchors its ordering. An array that
        // omits every durable terminal may be truncated or inconsistent, so
        // absence from it is not proof that the provider rejected the turn.
        if (providerHistoryIsArray && lastKnownTerminalIndex >= 0) {
          providerTurnIds = new Set(
            turns
              .map((turn) => text(turn.id))
              .filter((turnId) => turnId.length > 0),
          );
        }
        const laterTurns =
          lastKnownTerminalIndex < 0
            ? []
            : turns.slice(lastKnownTerminalIndex + 1);
        if (laterTurns.length > 1) {
          await cancellation.wait(cancellation.close());
          return {
            recovered: false,
            reason:
              "provider exposed multiple uncheckpointed disposition recovery turns",
          };
        }
        const uncheckpointedTurnId = text(laterTurns[0]?.id);
        if (laterTurns.length === 1 && uncheckpointedTurnId.length === 0) {
          await cancellation.wait(cancellation.close());
          return {
            recovered: false,
            reason:
              "provider exposed an unidentifiable disposition recovery turn",
          };
        }
        if (uncheckpointedTurnId.length > 0) {
          if (
            dispositionOnlyRecoveryTurnId !== null &&
            dispositionOnlyRecoveryTurnId !== uncheckpointedTurnId
          ) {
            await cancellation.wait(cancellation.close());
            return {
              recovered: false,
              reason: "provider changed the bound disposition recovery turn",
            };
          }
          // A previous process reached the provider but crashed before it
          // could checkpoint the accepted turn or durably append its terminal.
          // Inspect provider history even when the one-shot submitted marker
          // was checkpointed, and adopt the exact turn instead of waiting on a
          // reconstructed terminal session or submitting a duplicate.
          recoveredActiveTurnId = uncheckpointedTurnId;
          dispositionOnlyRecoveryConsumed = true;
          dispositionOnlyRecoveryTurnId = uncheckpointedTurnId;
          reconcileUncheckpointedDispositionTurn = true;
        }
      }
      if (
        dispositionOnlyRecoveryConsumed &&
        recoveredActiveTurnId === null &&
        !reconcileUncheckpointedDispositionTurn &&
        providerTurnIds !== null &&
        (dispositionOnlyRecoveryTurnId === null ||
          (!providerTurnIds.has(dispositionOnlyRecoveryTurnId) &&
            !(snapshot.terminalTurns ?? []).some(
              (terminal) => terminal.turnId === dispositionOnlyRecoveryTurnId,
            )))
      ) {
        // Older or crash-raced checkpoints could persist the pre-request
        // one-shot marker, including a requested turn id, without an accepted
        // provider turn. With no matching provider history or checkpointed
        // terminal, the marker alone is not acceptance evidence. The native
        // runtime still checks durable replay before allowing a retry, and the
        // reconstructed session must retain disposition-only mode so that a
        // safe retry cannot repeat the original task envelope.
        dispositionOnlyRecoveryConsumed = false;
        dispositionOnlyRecoveryTurnId = null;
      }
      if (opened.context.liveConsole)
        opened.context.liveConsole.goals = this.#caps.goals;
      const session = this.#session({
        transport,
        runId: snapshot.runId,
        normalizedSessionId: snapshot.normalizedSessionId,
        opened,
        goal,
        goalAvailability: this.#goalAvailability,
        goalReasonCode: this.#goalReasonCode,
        goalReason: this.#goalReason,
        resumed: true,
        activeTurnId: recoveredActiveTurnId,
        semanticResult: snapshot.semanticResult ?? null,
        terminalTurns: snapshot.terminalTurns ?? [],
        codexUsageBaseline: snapshot.codexUsageBaseline,
        dispositionOnlyRecoveryConsumed,
        dispositionOnlyRecoveryTurnId,
        stalePendingRuntimeRequests: snapshot.pendingRuntimeRequests ?? [],
        lineage: snapshot.lineage,
        sourceSequence: snapshot.lastSourceSequence ?? 0,
      });
      // A provider may settle the checkpointed turn while this controller is
      // disconnected (including during timeout cleanup). Reopening a thread
      // does not replay that terminal notification. Reconcile the exact turn
      // before exposing the session so callers neither wait on a dead turn
      // nor submit the original work again. Missing/conflicting history still
      // fails closed in reconcile().
      if (
        recoveredActiveTurnId !== null ||
        reconcileUncheckpointedDispositionTurn
      ) {
        await cancellation.wait(session.reconcile?.() ?? Promise.resolve({}));
      }
      return {
        recovered: true,
        session,
      };
    } catch (error) {
      await cancellation.close().catch(() => {});
      if (error instanceof NativeSessionProtocolIntegrityError) throw error;
      if (options.signal.aborted) options.signal.throwIfAborted();
      return { recovered: false, reason: redactCodexDiagnostic(String(error)) };
    } finally {
      cancellation.detach();
    }
  }

  #transport(context?: {
    workingDirectory?: string;
    providerRecoveryPolicy?: PersistedHarnessSession["providerRecoveryPolicy"];
    persistedSession?: Pick<
      PersistedHarnessSession,
      | "driverSessionId"
      | "providerSessionId"
      | "providerIdentity"
      | "activeTurnId"
    >;
  }): CodexAppServerTransport {
    const workingDirectory = context?.workingDirectory ?? this.#options.environment?.PAPERCLIP_WORKSPACE_CWD;
    if (!this.#options.transportFactory && this.#options.environment?.CODEX_HOME && workingDirectory) {
      trustCodexStartupRoot(this.#options.environment.CODEX_HOME, workingDirectory);
    }
    return (
      this.#options.transportFactory?.(context) ??
      new ProcessCodexAppServerTransport({
        workingDirectory,
        args: createIsolatedCodexAppServerArgs(this.#options.environment, codexExecutableReadOnlyRoots(this.#options.environment ?? process.env)),
        environment: createSanitizedCodexEnvironment(this.#options.environment),
        onDiagnostic: this.#options.onDiagnostic,
        processGroup: true,
      })
    );
  }

  async #negotiateCollaborationMode(
    transport: CodexAppServerTransport,
    threadResponse: Record<string, unknown>,
    requested: "default" | "plan",
  ): Promise<Record<string, unknown> | null> {
    if (requested !== "plan") return null;
    try {
      const response = await transport.request("collaborationMode/list", {});
      const preset = Array.isArray(response.data)
        ? response.data
            .map(record)
            .find((candidate) => text(candidate.mode) === "plan")
        : undefined;
      if (!preset) throw new Error("plan preset is absent");
      const model = text(
        preset.model,
        text(threadResponse.model, text(record(threadResponse.thread).model)),
      );
      if (model.length === 0)
        throw new Error("plan preset did not resolve a model");
      return {
        mode: "plan",
        settings: {
          model,
          reasoning_effort: preset.reasoning_effort ?? null,
          developer_instructions: null,
        },
      };
    } catch (cause) {
      if (cause instanceof NativeSessionProtocolIntegrityError) throw cause;
      const error = new Error(
        `planning_mode_unsupported: installed Codex app-server did not expose a usable native plan collaboration mode (${redactCodexDiagnostic(String(cause))})`,
      );
      error.name = "PlanningModeUnsupportedError";
      throw error;
    }
  }

  async #persistProcessOwnership(
    transport: CodexAppServerTransport,
  ): Promise<void> {
    if (!this.#options.onSpawn) return;
    const processInfo: CodexTransportProcessInfo | undefined =
      transport.processInfo?.();
    if (!processInfo || processInfo.exited || processInfo.pid === null) return;
    const identity = `${processInfo.pid}:${processInfo.processGroupId ?? ""}:${processInfo.startedAt}`;
    if (this.#persistedProcessIdentities.get(transport) === identity) return;
    await this.#options.onSpawn({
      pid: processInfo.pid,
      processGroupId: processInfo.processGroupId,
      startedAt: processInfo.startedAt,
    });
    this.#persistedProcessIdentities.set(transport, identity);
  }

  async #initialize(
    transport: CodexAppServerTransport,
  ): Promise<Record<string, unknown>> {
    const initialized = await transport.request("initialize", {
      clientInfo: {
        name: "paperclip-runner",
        title: "Paperclip Runner",
        version: DRIVER_VERSION,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    transport.notify("initialized");
    return initialized;
  }

  async #discoverGoal(
    transport: CodexAppServerTransport,
    threadId: string,
  ): Promise<HarnessThreadGoal | null | undefined> {
    if (!this.#caps.goals) return undefined;
    try {
      const response = await transport.request("thread/goal/get", { threadId });
      return parseThreadGoal(response.goal);
    } catch (error) {
      if (error instanceof NativeSessionProtocolIntegrityError) throw error;
      const policyDisabled =
        error instanceof CodexRpcError
        && (error.message.toLowerCase().includes("policy")
          || error.message.toLowerCase().includes("disabled"));
      if (policyDisabled || isCodexMethodUnavailable(error)) {
        // The provider answered, and its answer is that this build has no goal
        // API. That is the only evidence that retires the capability.
        this.#caps.goals = false;
        if (policyDisabled) {
          this.#goalAvailability = "policy_disabled";
          this.#goalReasonCode = "codex_goal_policy_disabled";
          this.#goalReason =
            "Session goals are disabled by the Codex provider policy.";
        } else {
          this.#goalAvailability = "unsupported";
          this.#goalReasonCode = "codex_goal_api_unavailable";
          this.#goalReason =
            "This Codex app-server does not expose thread goals.";
        }
        this.#options.onDiagnostic?.(
          redactCodexDiagnostic(`thread goals unavailable: ${String(error)}`),
        );
        return undefined;
      }
      // A transport or protocol failure says nothing about what the provider
      // supports, so the capability stays as advertised and the goal is merely
      // unknown until the next call.
      this.#options.onDiagnostic?.(
        redactCodexDiagnostic(`thread goal probe failed: ${String(error)}`),
      );
      return undefined;
    }
  }

  #openedThread(
    response: Record<string, unknown>,
    initialize: Record<string, unknown>,
    workingDirectory: string,
    collaborationMode: Record<string, unknown> | null,
  ): OpenedCodexThread {
    const thread = record(response.thread);
    const threadId = text(thread.id);
    if (threadId.length === 0)
      throw new Error("Codex thread response omitted thread.id");
    const providerSessionId = text(thread.sessionId) || null;
    if (
      this.#options.requireProviderSessionIdentity &&
      providerSessionId === null
    ) {
      throw new Error(
        `provider_initialize_protocol_error: provider=${this.#options.driverIdentity?.kind ?? "codex"} stage=session.open omitted provider session identity`,
      );
    }
    const activePermissionProfile = record(thread.activePermissionProfile);
    const permissionProfileId = text(activePermissionProfile.id);
    const requestedMode = this.#options.requestedCollaborationMode ?? "default";
    const requiredPermissionProfile =
      text(createSecuredCodexThreadParams(workingDirectory, requestedMode, true, false, this.#options.environment).permissions);
    if (
      permissionProfileId.length > 0 &&
      permissionProfileId !== requiredPermissionProfile
    ) {
      throw new Error(
        "Codex thread did not activate the required filesystem permission profile",
      );
    }
    const configuredPermissionProfile = {
      ...activePermissionProfile,
      id: requiredPermissionProfile,
    };
    const returnedWorkingDirectory = text(response.cwd, workingDirectory);
    if (resolve(returnedWorkingDirectory) !== workingDirectory) {
      throw new Error(
        "Codex thread response changed the assigned working directory",
      );
    }
    const providerIdentity = parseProviderIdentity(thread.providerIdentity);
    return {
      threadId,
      providerSessionId,
      ...(providerIdentity === undefined ? {} : { providerIdentity }),
      collaborationMode,
      context: {
        protocolVersion: CODEX_CODEX_PROTOCOL_VERSION,
        codexVersion: boundedText(initialize.userAgent),
        clientInfo: {
          name: "paperclip-runner",
          title: "Paperclip Runner",
          version: DRIVER_VERSION,
        },
        model: boundedText(response.model),
        modelProvider: boundedText(
          response.modelProvider,
          boundedText(thread.modelProvider),
        ),
        workingDirectory,
        collaborationMode: collaborationMode === null ? "default" : "plan",
        sandbox: {
          permissionProfile: boundedCodexValue(configuredPermissionProfile),
          legacyPolicy: boundedCodexValue(response.sandbox ?? null),
          rootAccess: "none",
          minimalRuntimeAccess: "read",
          workspaceAccess: requestedMode === "plan" ? "read" : "write",
          networkAccess: codexNetworkAccess(this.#options.environment),
          githubAuthenticationMode: this.#options.environment?.PAPERCLIP_GITHUB_AUTH_MODE ?? "managed",
        },
        approvalPolicy: boundedCodexValue(
          response.approvalPolicy ??
            this.#options.approvalPolicy ??
            "untrusted",
        ),
        baseInstructions: this.#baseInstructions(),
        instructionSources: Array.isArray(response.instructionSources)
          ? response.instructionSources
              .filter((value): value is string => typeof value === "string")
              .slice(0, 32)
              .map((value) => boundedText(value))
          : [],
        instructionPolicy: {
          skillInstructions: this.#options.includeSkillInstructions ?? false,
          appInstructions: false,
          collaborationInstructions:
            this.#options.includeCollaborationModeInstructions ?? true,
        },
        environmentKeys: Object.keys(
          codexCommandEnvironment(this.#options.environment),
        ).sort(),
        dynamicToolNames: this.#providerDynamicTools().map((tool) =>
          text(tool.name),
        ),
        modelInputKinds: ["text"],
        liveConsole: {
          conversationMode: this.#direct() ? "direct" : "task",
          runtimeRequestResolution: this.#caps.runtimeRequestResolution,
          goals: this.#caps.goals,
          threadLineage: this.#caps.threadLineage,
        },
        envelope: structuredClone(this.#options.taskEnvelope),
      },
      lineage: lineageFromThread(thread),
    };
  }

  #session(input: {
    transport: CodexAppServerTransport;
    runId: string;
    normalizedSessionId: string;
    opened: OpenedCodexThread;
    goal?: HarnessThreadGoal | null;
    goalAvailability: CodexGoalAvailability;
    goalReasonCode: string | null;
    goalReason: string | null;
    resumed: boolean;
    activeTurnId?: string | null;
    semanticResult?: PersistedHarnessSemanticResult | null;
    terminalTurns?: PersistedHarnessTurnTerminal[];
    codexUsageBaseline?: PersistedHarnessSession["codexUsageBaseline"];
    dispositionOnlyRecoveryConsumed?: boolean;
    dispositionOnlyRecoveryTurnId?: string | null;
    stalePendingRuntimeRequests?: HarnessRuntimeRequest[];
    lineage?: HarnessThreadLineageEntry[];
    sourceSequence: number;
  }): CodexHarnessSession {
    return new CodexHarnessSession({
      ...input,
      taskEnvelope: this.#options.taskEnvelope,
      conversationMode: this.#direct() ? "direct" : "task",
      now: this.#options.now ?? (() => new Date()),
      runnerInstanceId: this.#options.runnerInstanceId ?? "runner-codex",
      driverKind: this.#options.driverIdentity?.kind ?? DRIVER_KIND,
      capabilities: this.#caps,
      goalCapability: this.#goalCapability,
      dynamicTools: this.#providerDynamicTools(),
      dynamicToolHandler: this.#options.dynamicToolHandler,
      completionFeedback: this.#options.completionFeedback,
    });
  }
}
