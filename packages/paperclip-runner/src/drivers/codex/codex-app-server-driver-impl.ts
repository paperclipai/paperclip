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
import { HarnessReconciliationError } from "../../contracts/harness-driver.js";
import {
  CODEX_CODEX_PROTOCOL_VERSION,
  CODEX_SEMANTIC_TOOL_NAMES,
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
} from "../../contracts/codex.js";
import { providerFamilyCapabilities } from "../../provider-events.js";
import {
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
  CODEX_PLANNING_PERMISSION_PROFILE as PLANNING_PERMISSION_PROFILE,
  CODEX_SKILLLESS_PERMISSION_PROFILE as SKILLLESS_PERMISSION_PROFILE,
  codexCommandEnvironment,
  createIsolatedCodexAppServerArgs,
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
  OpenedCodexThread,
} from "./codex-driver-types.js";
import {
  boundedText,
  codexSemanticToolSpecs,
  differingJsonPaths,
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
      () => rejectAborted(signal?.reason ?? new Error("Codex bootstrap aborted")),
      () => rejectAborted(signal?.reason ?? new Error("Codex bootstrap aborted")),
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
    if (!this.#caps.read) this.#caps.reconciliation = false;
  }

  #direct(): boolean {
    return this.#options.conversationMode === "direct";
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
      runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
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
    );
    const transport = this.#transport();
    const cancellation = bootstrapCancellation(transport, input.signal);
    try {
      await cancellation.wait(this.#persistProcessOwnership(transport));
      const initialize = await cancellation.wait(this.#initialize(transport));
      const requestedMode =
        this.#options.requestedCollaborationMode ?? "default";
      const response = await cancellation.wait(transport.request("thread/start", {
        ...createSecuredCodexThreadParams(
          workingDirectory,
          requestedMode,
          this.#options.includeCollaborationModeInstructions ?? true,
          this.#options.includeSkillInstructions ?? false,
        ),
        approvalPolicy: this.#options.approvalPolicy ?? "never",
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
        dynamicTools: this.#direct()
          ? []
          : this.#caps.dynamicTools
            ? [
                ...(this.#options.dynamicTools ?? []),
                ...codexSemanticToolSpecs(),
              ]
            : [],
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      }));
      const collaborationMode = await cancellation.wait(this.#negotiateCollaborationMode(
        transport,
        response,
        requestedMode,
      ));
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
        resumed: false,
        sourceSequence: 0,
      });
    } catch (error) {
      // Cleanup must never replace the provider/bootstrap failure that caused
      // the session open to abort. Remote transports may perform checkpoint
      // work during close; when no durable provider identity exists that
      // cleanup can fail independently.
      await cancellation.close().catch(() => {});
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
      providerRecoveryPolicy: snapshot.providerRecoveryPolicy,
    });
    const cancellation = bootstrapCancellation(transport, options.signal);
    try {
      await cancellation.wait(this.#persistProcessOwnership(transport));
      const initialize = await cancellation.wait(this.#initialize(transport));
      const existing = await cancellation.wait(transport.request("thread/read", {
        threadId: snapshot.driverSessionId,
        includeTurns: true,
      }));
      const existingThread = record(existing.thread);
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
      );
      const response = await cancellation.wait(transport.request("thread/resume", {
        threadId: snapshot.driverSessionId,
        ...createSecuredCodexThreadParams(
          workingDirectory,
          this.#options.requestedCollaborationMode ?? "default",
          this.#options.includeCollaborationModeInstructions ?? true,
          this.#options.includeSkillInstructions ?? false,
        ),
        baseInstructions: this.#direct()
          ? ""
          : this.#baseInstructions(),
        approvalPolicy: this.#options.approvalPolicy ?? "never",
        ...(this.#options.model ? { model: this.#options.model } : {}),
        persistExtendedHistory: false,
      }));
      const collaborationMode = await cancellation.wait(this.#negotiateCollaborationMode(
        transport,
        response,
        this.#options.requestedCollaborationMode ?? "default",
      ));
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
      if (
        !this.#direct()
        && snapshot.semanticResult == null
        && recoveredActiveTurnId === null
        && (snapshot.terminalTurns?.length ?? 0) > 0
      ) {
        const providerHistory = existingThread.turns;
        const providerHistoryIsArray = Array.isArray(providerHistory);
        const turns = providerHistoryIsArray
          ? providerHistory.map(record)
          : [];
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
        const laterTurns = lastKnownTerminalIndex < 0
          ? []
          : turns.slice(lastKnownTerminalIndex + 1);
        if (laterTurns.length > 1) {
          await cancellation.wait(cancellation.close());
          return {
            recovered: false,
            reason: "provider exposed multiple uncheckpointed disposition recovery turns",
          };
        }
        const uncheckpointedTurnId = text(laterTurns[0]?.id);
        if (laterTurns.length === 1 && uncheckpointedTurnId.length === 0) {
          await cancellation.wait(cancellation.close());
          return {
            recovered: false,
            reason: "provider exposed an unidentifiable disposition recovery turn",
          };
        }
        if (uncheckpointedTurnId.length > 0) {
          if (
            dispositionOnlyRecoveryTurnId !== null
            && dispositionOnlyRecoveryTurnId !== uncheckpointedTurnId
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
        dispositionOnlyRecoveryConsumed
        && recoveredActiveTurnId === null
        && !reconcileUncheckpointedDispositionTurn
        && providerTurnIds !== null
        && (
          dispositionOnlyRecoveryTurnId === null
          || (
            !providerTurnIds.has(dispositionOnlyRecoveryTurnId)
            && !(snapshot.terminalTurns ?? []).some(
              (terminal) => terminal.turnId === dispositionOnlyRecoveryTurnId,
            )
          )
        )
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
      const goal = await cancellation.wait(
        this.#discoverGoal(transport, opened.threadId),
      );
      if (opened.context.liveConsole)
        opened.context.liveConsole.goals = this.#caps.goals;
      const session = this.#session({
        transport,
        runId: snapshot.runId,
        normalizedSessionId: snapshot.normalizedSessionId,
        opened,
        goal,
        resumed: true,
        activeTurnId: recoveredActiveTurnId,
        semanticResult: snapshot.semanticResult ?? null,
        terminalTurns: snapshot.terminalTurns ?? [],
        dispositionOnlyRecoveryConsumed,
        dispositionOnlyRecoveryTurnId,
        stalePendingRuntimeRequests: snapshot.pendingRuntimeRequests ?? [],
        lineage: snapshot.lineage,
        sourceSequence: snapshot.lastSourceSequence ?? 0,
      });
      if (reconcileUncheckpointedDispositionTurn) {
        await cancellation.wait(session.reconcile?.() ?? Promise.resolve({}));
      }
      return {
        recovered: true,
        session,
      };
    } catch (error) {
      await cancellation.close().catch(() => {});
      if (options.signal.aborted) options.signal.throwIfAborted();
      return { recovered: false, reason: redactCodexDiagnostic(String(error)) };
    } finally {
      cancellation.detach();
    }
  }

  #transport(context?: {
    providerRecoveryPolicy?: PersistedHarnessSession["providerRecoveryPolicy"];
  }): CodexAppServerTransport {
    return (
      this.#options.transportFactory?.(context) ??
      new ProcessCodexAppServerTransport({
        args: createIsolatedCodexAppServerArgs(this.#options.environment),
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
    await this.#options.onSpawn({
      pid: processInfo.pid,
      processGroupId: processInfo.processGroupId,
      startedAt: processInfo.startedAt,
    });
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
      if (isCodexMethodUnavailable(error)) {
        // The provider answered, and its answer is that this build has no goal
        // API. That is the only evidence that retires the capability.
        this.#caps.goals = false;
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
    if (this.#options.requireProviderSessionIdentity && providerSessionId === null) {
      throw new Error(
        `provider_initialize_protocol_error: provider=${this.#options.driverIdentity?.kind ?? "codex"} stage=session.open omitted provider session identity`,
      );
    }
    const activePermissionProfile = record(thread.activePermissionProfile);
    const permissionProfileId = text(activePermissionProfile.id);
    const requestedMode = this.#options.requestedCollaborationMode ?? "default";
    const requiredPermissionProfile =
      requestedMode === "plan"
        ? PLANNING_PERMISSION_PROFILE
        : SKILLLESS_PERMISSION_PROFILE;
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
    return {
      threadId,
      providerSessionId,
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
          networkAccess: false,
        },
        approvalPolicy: boundedCodexValue(
          response.approvalPolicy ?? this.#options.approvalPolicy ?? "never",
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
        dynamicToolNames: this.#direct()
          ? []
          : this.#caps.dynamicTools
            ? [
                ...(this.#options.dynamicTools ?? []).map((tool) =>
                  text(tool.name),
                ),
                ...CODEX_SEMANTIC_TOOL_NAMES,
              ]
            : [],
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
    resumed: boolean;
    activeTurnId?: string | null;
    semanticResult?: PersistedHarnessSemanticResult | null;
    terminalTurns?: PersistedHarnessTurnTerminal[];
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
      dynamicTools: this.#options.dynamicTools ?? [],
      dynamicToolHandler: this.#options.dynamicToolHandler,
    });
  }
}
