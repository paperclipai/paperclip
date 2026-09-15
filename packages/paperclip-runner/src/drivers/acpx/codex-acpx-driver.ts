import { createHash, randomBytes } from "node:crypto";

import type {
  AcpElicitationContext,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpRuntimeEvent,
} from "acpx/runtime";

import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessRuntimeRequestResolutionError,
  HarnessStaleTurnError,
  harnessRuntimeInputExpiredOutcome,
  harnessRuntimeRequestOutcome,
  parseHarnessRuntimeRequestResolution,
  type HarnessDriver,
  type HarnessDriverConfigValidation,
  type HarnessDriverDescriptor,
  type HarnessSession,
  type HarnessSessionRecoveryOptions,
  type HarnessSessionRecoveryResult,
  type HarnessRuntimeRequest,
  type HarnessRuntimeRequestHandoff,
  type HarnessRuntimeRequestResolution,
  type HarnessTranscriptSnapshot,
  type OpenHarnessSessionInput,
  type PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import { PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2 } from "../../contracts/question-set.js";
import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import type { NativeUserMessage } from "../../contracts/types.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../../protocol/replay-contract.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import {
  canonicalProviderEventsFromAcpxRuntimeEvent,
  createAcpxToolEventNormalizer,
} from "../../provider-events.js";
import {
  canonicalRunnerToolName,
  type RunnerToolCall,
} from "../runner-tool-bridge.js";
import {
  DEFAULT_CODEX_ACPX_RUNTIME_SHUTDOWN_BOUND_MS,
  openCodexAcpxRuntime,
} from "./codex-runtime-adapter.js";
import {
  normalizeAcpFormElicitation,
  type NormalizedAcpForm,
} from "./acp-question-adapter.js";
import {
  acpxDriverDescriptor,
  validateAcpxDriverConfig,
} from "./driver-profile.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "./qualified-profiles.js";
import {
  ACPX_TURN_CANCELLATION_SHUTDOWN_BOUND_MS,
  AcpxRuntimeHost,
  type AcpxRetainedCleanupFailure,
  type AcpxRuntimeTurn,
  type OpenAcpxRuntimeHostOptions,
} from "./runtime-host.js";
import {
  readAcpxRecoveryWorkspace,
  type AcpxRecoveryWorkspaceLease,
} from "./runtime-sandbox.js";

const MAX_BUFFERED_EVENTS = 512;
const TERMINAL_EVENT_RESERVE = 3;
const TURN_START_EVENT_COUNT = 3;
const MAX_TRANSCRIPT_EVENTS = 1_024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_RECOVERY_TERMINAL_TURNS = 4_096;
const MAX_RECOVERY_TERMINAL_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_RUNTIME_REQUESTS = 16;
const CLOSE_TURN_SETTLEMENT_TIMEOUT_MS = 2_000;
const MAX_AUTONOMOUS_HOST_CLOSE_RETRIES = 3;
const MAX_QUARANTINED_HOST_CLOSE_RETRIES = 3;
const QUARANTINED_HOST_CLOSE_RETRY_MS = 60_000;
const MAX_QUARANTINED_HOST_ATTEMPT_RETRY_DELAY_MS = 1_000;
// Host shutdown first bounds active-turn cancellation and then performs the
// adapter's bounded protocol/TERM/KILL cleanup. Bound each ownership phase that
// admission observes: an inherited owner may install a distinct replacement
// recovery, which receives its own finite grace rather than inheriting an
// almost-expired deadline. Cover every attempt and bounded inter-attempt delay,
// plus one second of scheduling margin.
const QUARANTINED_HOST_CLOSE_ATTEMPT_BOUND_MS =
  ACPX_TURN_CANCELLATION_SHUTDOWN_BOUND_MS +
  DEFAULT_CODEX_ACPX_RUNTIME_SHUTDOWN_BOUND_MS;
const MAX_INHERITED_QUARANTINED_HOST_CLOSE_ATTEMPTS = 1;
const QUARANTINED_HOST_ADMISSION_GRACE_MS =
  (MAX_INHERITED_QUARANTINED_HOST_CLOSE_ATTEMPTS +
    MAX_QUARANTINED_HOST_CLOSE_RETRIES) *
    QUARANTINED_HOST_CLOSE_ATTEMPT_BOUND_MS +
  (MAX_QUARANTINED_HOST_CLOSE_RETRIES - 1) *
    MAX_QUARANTINED_HOST_ATTEMPT_RETRY_DELAY_MS +
  1_000;

interface PendingAcpxRuntimeRequest {
  request: HarnessRuntimeRequest;
  normalized: NormalizedAcpForm;
  settle(response: AcpElicitationResponse): void;
  cleanup(): void;
  settling: boolean;
}

export interface CodexAcpxDynamicToolCall {
  tool: string;
  callId: string;
  providerSessionId: string;
  turnId: string;
  arguments: unknown;
  signal: AbortSignal;
}

export interface CodexAcpxDriverOptions {
  /** Defaults to Codex for backward compatibility. */
  agent?: QualifiedAcpxAgent;
  runtimeDirectory: string;
  model: string;
  permissionMode?: NativeAcpxPermissionMode;
  systemInstructions?: string;
  environment?: NodeJS.ProcessEnv;
  managedCodexCredentialSourcePath?: string;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: (call: CodexAcpxDynamicToolCall) => Promise<unknown>;
  now?: () => Date;
}

interface CodexAcpxHost {
  identity(): ReturnType<AcpxRuntimeHost["identity"]>;
  binding(): ReturnType<AcpxRuntimeHost["binding"]>;
  status(): ReturnType<AcpxRuntimeHost["status"]>;
  startTurn(
    input: Parameters<AcpxRuntimeHost["startTurn"]>[0],
  ): AcpxRuntimeTurn;
  interruptActiveTurn(reason: string): Promise<void>;
  close(input: { reason: string }): Promise<void>;
}

interface QuarantinedHostCleanup {
  host: CodexAcpxHost;
  reason: string;
  attempt: Promise<void> | null;
  recovery: Promise<void> | null;
  recoveryMaxAttempts: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CodexAcpxDriverDependencies {
  openHost?: (options: OpenAcpxRuntimeHostOptions) => Promise<CodexAcpxHost>;
  /** Internal test seam; production uses the fixed close-settlement bound. */
  closeSettlementTimeoutMs?: number;
  /** Internal test seam; production uses the fixed event-retention bound. */
  maxBufferedEvents?: number;
  /** Internal test seam; production reserves fixed terminal-event capacity. */
  terminalEventReserve?: number;
  readRecoveryWorkspace?: (input: {
    runtimeDirectory: string;
    normalizedSessionId: string;
    signal?: AbortSignal;
  }) => Promise<AcpxRecoveryWorkspaceLease>;
}

export interface ProbeQualifiedAcpxEnvironmentOptions {
  runtimeDirectory: string;
  agent: QualifiedAcpxAgent;
  model: string;
  environment?: NodeJS.ProcessEnv;
}

export interface QualifiedAcpxEnvironmentProbe {
  effectiveModel: string;
  commandDigest: string;
}

/**
 * Admit and cleanly close the same qualified ACPX host used by production
 * sessions without exposing that host as part of the public package surface.
 */
export async function probeQualifiedAcpxEnvironment(
  options: ProbeQualifiedAcpxEnvironmentOptions,
): Promise<QualifiedAcpxEnvironmentProbe> {
  const profile = resolveQualifiedAcpxProfile(options.agent, options.model);
  const driver = new CodexAcpxDriver({
    runtimeDirectory: options.runtimeDirectory,
    agent: options.agent,
    model: options.model,
    permissionMode: "deny-all",
    systemInstructions:
      "Paperclip Runner environment qualification probe. Do not execute a provider turn.",
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    dynamicTools: [],
    dynamicToolHandler: async () => {
      throw new Error("environment probe exposes no semantic tools");
    },
  });
  const session = await driver.openSession({
    runId: "environment-probe",
    normalizedSessionId: "environment-probe",
    workingDirectory: options.runtimeDirectory,
  });
  try {
    const snapshot = await session.snapshot();
    if (snapshot.providerIdentity?.kind !== "acpx") {
      throw new Error("ACPX environment probe returned no provider identity");
    }
    return Object.freeze({
      effectiveModel: snapshot.providerIdentity.effectiveModel,
      commandDigest: profile.commandDigest,
    });
  } finally {
    // A successful return is authoritative proof that the driver's bounded
    // close released the provider, credential lease, semantic bridge, and
    // verified command. A failed close remains owned by the driver's retained
    // recovery/quarantine path, so callers must preserve runtimeDirectory.
    await session.close({ reason: "environment probe complete" });
  }
}

function openProductionAcpxHost(
  options: OpenAcpxRuntimeHostOptions,
): Promise<AcpxRuntimeHost> {
  return AcpxRuntimeHost.open(options, {
    openRuntime: openCodexAcpxRuntime,
    reportRetainedCleanupFailure: reportRetainedAcpxCleanupFailure,
  });
}

/** Qualified HarnessDriver backed by the admitted ACPX runtime host. */
export class CodexAcpxDriver implements HarnessDriver {
  readonly #options: CodexAcpxDriverOptions;
  readonly #openHost: NonNullable<CodexAcpxDriverDependencies["openHost"]>;
  readonly #closeSettlementTimeoutMs: number;
  readonly #maxBufferedEvents: number;
  readonly #terminalEventReserve: number;
  readonly #cleanupOwners = new Set<Promise<void>>();
  readonly #quarantinedHostCleanups = new Set<QuarantinedHostCleanup>();
  readonly #readRecoveryWorkspace: NonNullable<
    CodexAcpxDriverDependencies["readRecoveryWorkspace"]
  >;

  constructor(
    options: CodexAcpxDriverOptions,
    dependencies: CodexAcpxDriverDependencies = {},
  ) {
    if (options.agent === "pi") {
      throw new Error(
        "Pi ACPX driver is unavailable until descriptor-confined verified launch is implemented",
      );
    }
    this.#options = {
      ...options,
      agent: options.agent ?? "codex",
      ...(options.environment
        ? { environment: { ...options.environment } }
        : {}),
      ...(options.dynamicTools
        ? { dynamicTools: structuredClone(options.dynamicTools) }
        : {}),
    };
    this.#openHost = dependencies.openHost ?? openProductionAcpxHost;
    this.#closeSettlementTimeoutMs =
      dependencies.closeSettlementTimeoutMs ?? CLOSE_TURN_SETTLEMENT_TIMEOUT_MS;
    this.#terminalEventReserve = Math.max(
      0,
      Math.floor(dependencies.terminalEventReserve ?? TERMINAL_EVENT_RESERVE),
    );
    this.#maxBufferedEvents = Math.max(
      this.#terminalEventReserve + TURN_START_EVENT_COUNT,
      Math.floor(dependencies.maxBufferedEvents ?? MAX_BUFFERED_EVENTS),
    );
    this.#readRecoveryWorkspace =
      dependencies.readRecoveryWorkspace ?? readAcpxRecoveryWorkspace;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    const descriptor = acpxDriverDescriptor(this.#options.agent ?? "codex");
    return {
      ...descriptor,
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "unsupported",
        mcp: "native",
      },
      capabilities: {
        ...descriptor.capabilities,
        resume: true,
        runtimeRequestResolution: true,
        runtimeRequestHandoff: true,
        unsupported: ["steering", "goals", "threadLineage"],
      },
    };
  }

  async validateConfig(value: unknown): Promise<HarnessDriverConfigValidation> {
    const validation = validateAcpxDriverConfig(value);
    if (
      !validation.ok ||
      validation.config.agent === (this.#options.agent ?? "codex")
    )
      return validation;
    return {
      ok: false,
      config: null,
      issues: [
        {
          path: "agent",
          code: "unsupported_agent",
          message: `This ACPX driver is bound to ${this.#options.agent ?? "codex"}.`,
        },
      ],
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    await runAbortableDriverAdmission(input.signal, () =>
      this.#retryQuarantinedHostCleanups(),
    );
    return await this.#open(input, null);
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
    options: HarnessSessionRecoveryOptions = {
      signal: new AbortController().signal,
    },
  ): Promise<HarnessSessionRecoveryResult> {
    try {
      await runAbortableDriverAdmission(options.signal, () =>
        this.#retryQuarantinedHostCleanups(),
      );
      validateRecoverySnapshot(snapshot);
      const terminalTurnIds = new Set(
        (snapshot.terminalTurns ?? []).map(({ turnId }) => turnId),
      );
      if (
        snapshot.activeTurnId &&
        !terminalTurnIds.has(snapshot.activeTurnId)
      ) {
        return {
          recovered: false,
          reason: "active Codex ACPX turn continuity is unavailable",
        };
      }
      const workspaceLease = await this.#readRecoveryWorkspaceForAdmission(
        {
          runtimeDirectory: this.#options.runtimeDirectory,
          normalizedSessionId: snapshot.normalizedSessionId!,
          signal: options.signal,
        },
        options.signal,
      );
      let recoveredSession: HarnessSession | null = null;
      try {
        recoveredSession = await this.#open(
          {
            runId: snapshot.runId!,
            normalizedSessionId: snapshot.normalizedSessionId!,
            workingDirectory: workspaceLease.path,
            signal: options.signal,
          },
          snapshot,
          workspaceLease.assertHeld,
        );
        await workspaceLease.close();
        return { recovered: true, session: recoveredSession };
      } catch (error) {
        await workspaceLease.close().catch(() => undefined);
        if (recoveredSession) {
          await recoveredSession
            .close({
              reason: "ACPX recovery workspace lease cleanup failed",
              force: true,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      return { recovered: false, reason: safeMessage(error) };
    }
  }

  async #readRecoveryWorkspaceForAdmission(
    input: Parameters<
      NonNullable<CodexAcpxDriverDependencies["readRecoveryWorkspace"]>
    >[0],
    signal: AbortSignal | undefined,
  ): Promise<AcpxRecoveryWorkspaceLease> {
    if (signal === undefined) return await this.#readRecoveryWorkspace(input);
    signal.throwIfAborted();
    const pending = Promise.resolve().then(() =>
      this.#readRecoveryWorkspace(input),
    );
    try {
      return await raceDriverAdmissionWithAbort(pending, signal);
    } catch (error) {
      if (signal.aborted) {
        this.#retainCleanup(
          pending.then(
            (lease) => lease.close(),
            () => undefined,
          ),
        );
      }
      throw error;
    }
  }

  async #open(
    input: OpenHarnessSessionInput,
    snapshot: PersistedHarnessSession | null,
    assertWorkspaceHeld?: () => void,
  ): Promise<HarnessSession> {
    let session: CodexAcpxSession | null = null;
    const host = await this.#openHostForAdmission(
      {
        runtimeDirectory: this.#options.runtimeDirectory,
        normalizedSessionId: input.normalizedSessionId,
        workingDirectory: input.workingDirectory,
        agent: this.#options.agent ?? "codex",
        model: this.#options.model,
        permissionMode: this.#options.permissionMode ?? "approve-reads",
        systemInstructions: this.#options.systemInstructions,
        environment: this.#options.environment,
        managedCodexCredentialSourcePath:
          this.#options.managedCodexCredentialSourcePath,
        ...(assertWorkspaceHeld === undefined ? {} : { assertWorkspaceHeld }),
        ...(snapshot?.providerIdentity?.kind === "acpx"
          ? { expectedIdentity: snapshot.providerIdentity }
          : {}),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        semanticTools: {
          tools: this.#options.dynamicTools ?? [],
          handler: (call) => {
            if (!session) {
              throw new Error("Codex ACPX session is not ready for tool calls");
            }
            return session.dispatchTool(call);
          },
        },
      },
      input.signal,
    );
    try {
      input.signal?.throwIfAborted();
      session = new CodexAcpxSession({
        host,
        agent: this.#options.agent ?? "codex",
        input,
        dynamicToolHandler: this.#options.dynamicToolHandler,
        now: this.#options.now ?? (() => new Date()),
        closeSettlementTimeoutMs: this.#closeSettlementTimeoutMs,
        maxBufferedEvents: this.#maxBufferedEvents,
        terminalEventReserve: this.#terminalEventReserve,
        retainCleanup: (cleanup) => this.#retainCleanup(cleanup),
        quarantineCleanup: (hostToRetain, reason) =>
          this.#quarantineHostCleanup(hostToRetain, reason),
        snapshot,
      });
      return session;
    } catch (error) {
      const reason = "Codex ACPX session initialization failed";
      const cleanup = Promise.resolve().then(() => host.close({ reason }));
      this.#retainCleanup(cleanup);
      void cleanup.catch(() => this.#quarantineHostCleanup(host, reason));
      await settleWithin(cleanup, this.#closeSettlementTimeoutMs).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async #openHostForAdmission(
    options: OpenAcpxRuntimeHostOptions,
    signal: AbortSignal | undefined,
  ): Promise<CodexAcpxHost> {
    if (signal === undefined) return await this.#openHost(options);
    signal.throwIfAborted();
    const opening = Promise.resolve().then(() => this.#openHost(options));
    try {
      return await raceDriverAdmissionWithAbort(opening, signal);
    } catch (error) {
      if (signal.aborted) {
        const lateHostCleanup = opening.then(
          (host) => this.#closeLateAdmissionHost(host),
          () => undefined,
        );
        this.#retainCleanup(lateHostCleanup);
      }
      throw error;
    }
  }

  async #closeLateAdmissionHost(host: CodexAcpxHost): Promise<void> {
    const reason = "Codex ACPX host resolved after admission was aborted";
    const cleanup = Promise.resolve().then(() => host.close({ reason }));
    this.#retainCleanup(cleanup);
    try {
      await cleanup;
    } catch {
      this.#quarantineHostCleanup(host, reason);
    }
  }

  #retainCleanup(cleanup: Promise<void>): void {
    this.#cleanupOwners.add(cleanup);
    void cleanup
      .finally(() => this.#cleanupOwners.delete(cleanup))
      .catch(() => undefined);
  }

  #quarantineHostCleanup(host: CodexAcpxHost, reason: string): void {
    if (
      [...this.#quarantinedHostCleanups].some((entry) => entry.host === host)
    ) {
      return;
    }
    const cleanup: QuarantinedHostCleanup = {
      host,
      reason,
      attempt: null,
      recovery: null,
      recoveryMaxAttempts: null,
      timer: null,
    };
    this.#quarantinedHostCleanups.add(cleanup);
    this.#startQuarantinedHostCleanupRecovery(
      cleanup,
      MAX_QUARANTINED_HOST_CLOSE_RETRIES,
      "quarantined cleanup recovery",
    );
  }

  #startQuarantinedHostCleanupRecovery(
    cleanup: QuarantinedHostCleanup,
    maxAttempts: number,
    reason: string,
  ): Promise<void> {
    if (cleanup.recovery) return cleanup.recovery;
    const recovery = (async () => {
      for (
        let attemptCount = 0;
        attemptCount < maxAttempts &&
        this.#quarantinedHostCleanups.has(cleanup);
        attemptCount += 1
      ) {
        // Start the first retry immediately so admission's finite grace applies
        // to provider cleanup rather than to this rate-limit delay. Only later
        // attempts wait, preserving sequential bounded retry behavior.
        if (attemptCount > 0) {
          await waitForCleanupRetry(
            Math.max(
              1,
              Math.min(
                MAX_QUARANTINED_HOST_ATTEMPT_RETRY_DELAY_MS,
                this.#closeSettlementTimeoutMs,
              ),
            ),
          );
        }
        const attempt = Promise.resolve().then(() =>
          cleanup.host.close({
            reason: `${cleanup.reason} (${reason})`,
          }),
        );
        cleanup.attempt = attempt;
        try {
          await attempt;
          this.#quarantinedHostCleanups.delete(cleanup);
        } catch {
          // Retain the quarantine after this finite, sequential retry batch.
        } finally {
          if (cleanup.attempt === attempt) cleanup.attempt = null;
        }
      }
    })();
    cleanup.recovery = recovery;
    cleanup.recoveryMaxAttempts = maxAttempts;
    this.#retainCleanup(recovery);
    void recovery
      .finally(() => {
        if (cleanup.recovery === recovery) {
          cleanup.recovery = null;
          cleanup.recoveryMaxAttempts = null;
        }
        this.#scheduleQuarantinedHostCleanup(cleanup);
      })
      .catch(() => undefined);
    return recovery;
  }

  #scheduleQuarantinedHostCleanup(cleanup: QuarantinedHostCleanup): void {
    if (
      !this.#quarantinedHostCleanups.has(cleanup) ||
      cleanup.recovery ||
      cleanup.attempt ||
      cleanup.timer
    ) {
      return;
    }
    // A quarantined host remains actively owned, but recovery is rate-limited:
    // each entry holds at most one unref'd timer and one sequential close.
    // Admission may pull that timer forward; it never creates a parallel try.
    cleanup.timer = setTimeout(() => {
      cleanup.timer = null;
      if (!this.#quarantinedHostCleanups.has(cleanup)) return;
      this.#startQuarantinedHostCleanupRecovery(
        cleanup,
        1,
        "scheduled quarantined cleanup recovery",
      );
    }, QUARANTINED_HOST_CLOSE_RETRY_MS);
    cleanup.timer.unref?.();
  }

  async #retryQuarantinedHostCleanups(): Promise<void> {
    const observedOwners = new Set<Promise<void>>();
    const acceleratedCleanups = new Set<QuarantinedHostCleanup>();
    try {
      while (true) {
        // A close that is still pending has not entered quarantine yet, but it
        // owns the same provider resources. Observe every retained owner and any
        // replacement quarantine recovery it installs before admitting a host.
        const cleanupOwners = new Set<Promise<void>>(this.#cleanupOwners);
        for (const cleanup of this.#quarantinedHostCleanups) {
          if (cleanup.timer) {
            clearTimeout(cleanup.timer);
            cleanup.timer = null;
          }
          if (cleanup.recovery) {
            // A scheduled autonomous owner has only one attempt. Admission
            // observes it first, then starts one complete bounded batch if that
            // attempt fails. A pre-existing full batch already consumed that
            // allowance and must never be duplicated.
            if (
              (cleanup.recoveryMaxAttempts ?? 0) >=
              MAX_QUARANTINED_HOST_CLOSE_RETRIES
            ) {
              acceleratedCleanups.add(cleanup);
            }
            cleanupOwners.add(cleanup.recovery);
          } else if (!acceleratedCleanups.has(cleanup)) {
            acceleratedCleanups.add(cleanup);
            cleanupOwners.add(
              this.#startQuarantinedHostCleanupRecovery(
                cleanup,
                MAX_QUARANTINED_HOST_CLOSE_RETRIES,
                "quarantined cleanup admission recovery",
              ),
            );
          }
        }
        const replacementOwners = [...cleanupOwners].filter(
          (owner) => !observedOwners.has(owner),
        );
        if (replacementOwners.length === 0) break;
        replacementOwners.forEach((owner) => observedOwners.add(owner));
        if (
          !(await settlesWithin(
            Promise.all(
              replacementOwners.map((owner) => owner.catch(() => undefined)),
            ),
            QUARANTINED_HOST_ADMISSION_GRACE_MS,
          ))
        ) {
          throw new Error(
            "Codex ACPX cannot open a new session because quarantined host cleanup exceeded the admission grace",
          );
        }
      }
    } finally {
      // Admission accelerates autonomous timers, but it must never strand a
      // different quarantined host if observing any owner exhausts the grace.
      for (const cleanup of this.#quarantinedHostCleanups) {
        this.#scheduleQuarantinedHostCleanup(cleanup);
      }
    }
    if (
      this.#cleanupOwners.size > 0 ||
      this.#quarantinedHostCleanups.size > 0
    ) {
      throw new Error(
        "Codex ACPX cannot open a new session while quarantined host cleanup remains incomplete",
      );
    }
  }
}

class CodexAcpxSession implements HarnessSession {
  readonly #host: CodexAcpxHost;
  readonly #agent: QualifiedAcpxAgent;
  readonly #input: OpenHarnessSessionInput;
  readonly #dynamicToolHandler?: CodexAcpxDriverOptions["dynamicToolHandler"];
  readonly #now: () => Date;
  readonly #closeSettlementTimeoutMs: number;
  readonly #maxBufferedEvents: number;
  readonly #terminalEventReserve: number;
  readonly #events: AsyncQueue<PrpEvent>;
  readonly #retainCleanup: (cleanup: Promise<void>) => void;
  readonly #quarantineCleanup: (host: CodexAcpxHost, reason: string) => void;
  readonly #transcript: Array<{ event: PrpEvent; bytes: number }> = [];
  readonly #terminalTurns = new Map<string, string>();
  readonly #pendingRuntimeRequests = new Map<
    string,
    PendingAcpxRuntimeRequest
  >();
  readonly #sourceInstanceId: string;
  readonly #providerRecoveryPolicy: NonNullable<
    PersistedHarnessSession["providerRecoveryPolicy"]
  >;
  #sourceSequence = 0;
  #activeTurnId: string | null = null;
  #semanticResult: PrpStructuredRunResult | null = null;
  #semanticFingerprint: string | null = null;
  #semanticCallId: string | null = null;
  #semanticTurnId: string | null = null;
  #pendingSemanticTransfer: {
    result: PrpStructuredRunResult;
    fingerprint: string;
    callId: string;
    turnId: string;
  } | null = null;
  #usage: Record<string, unknown> | null = null;
  #assistantText = "";
  #closed = false;
  #closingStarted = false;
  #eventStreamClosed = false;
  #activePump: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #hostClosePromise: Promise<void> | null = null;
  #hostCloseRecoveryPromise: Promise<void> | null = null;
  #hostClosed = false;
  #transcriptBytes = 0;
  #transcriptEventCount = 0;
  #transcriptOmitted = false;
  #eventStreamOmitted = false;
  #pendingTerminal: {
    turnId: string;
    fingerprint: string;
    eventType: "turn.completed" | "turn.failed" | "turn.interrupted";
    payload: Record<string, unknown>;
  } | null = null;
  #runtimeRequestSequence = 0;

  constructor(input: {
    host: CodexAcpxHost;
    agent: QualifiedAcpxAgent;
    input: OpenHarnessSessionInput;
    dynamicToolHandler?: CodexAcpxDriverOptions["dynamicToolHandler"];
    now: () => Date;
    closeSettlementTimeoutMs: number;
    maxBufferedEvents: number;
    terminalEventReserve: number;
    retainCleanup: (cleanup: Promise<void>) => void;
    quarantineCleanup: (host: CodexAcpxHost, reason: string) => void;
    snapshot: PersistedHarnessSession | null;
  }) {
    const identity = input.host.identity();
    if (identity.normalizedSessionId !== input.input.normalizedSessionId) {
      throw new Error("Codex ACPX host returned a different session identity");
    }
    this.#host = input.host;
    this.#agent = input.agent;
    this.#input = structuredClone(input.input);
    this.#dynamicToolHandler = input.dynamicToolHandler;
    this.#now = input.now;
    this.#closeSettlementTimeoutMs = input.closeSettlementTimeoutMs;
    this.#maxBufferedEvents = input.maxBufferedEvents;
    this.#terminalEventReserve = input.terminalEventReserve;
    this.#retainCleanup = input.retainCleanup;
    this.#quarantineCleanup = input.quarantineCleanup;
    this.#events = new AsyncQueue<PrpEvent>(input.maxBufferedEvents);
    this.#sourceInstanceId = stableId(
      "paperclip-acpx",
      input.input.normalizedSessionId,
    );
    this.#sourceSequence = input.snapshot?.lastSourceSequence ?? 0;
    this.#activeTurnId = input.snapshot?.activeTurnId ?? null;
    this.#providerRecoveryPolicy =
      input.snapshot?.providerRecoveryPolicy ?? "same_session_only";
    const semantic = input.snapshot?.semanticResult;
    if (semantic) {
      this.#semanticResult = structuredClone(semantic.result);
      this.#semanticFingerprint = semantic.fingerprint;
      this.#semanticCallId = semantic.callId ?? null;
      this.#semanticTurnId = semantic.turnId;
    }
    for (const terminal of input.snapshot?.terminalTurns ?? []) {
      this.#terminalTurns.set(terminal.turnId, terminal.fingerprint);
    }
    if (this.#activeTurnId && this.#terminalTurns.has(this.#activeTurnId)) {
      this.#activeTurnId = null;
    }
  }

  ids() {
    const identity = this.#host.identity();
    return {
      driverSessionId: identity.acpxRecordId,
      providerSessionId: identity.agentSessionId,
      displayId: identity.agentSessionId,
    };
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#events;
  }

  async startTurn(input: {
    message: NativeUserMessage;
  }): Promise<{ turnId: string }> {
    this.#assertOpen();
    if (this.#activeTurnId) {
      throw new Error("Codex ACPX session already has an active turn");
    }
    if (
      !this.#events.hasCapacity(
        this.#terminalEventReserve + TURN_START_EVENT_COUNT,
      )
    ) {
      throw new HarnessCapabilityUnavailableError(
        "turn.start",
        "the event consumer must drain the previous turn before another turn can start",
      );
    }
    if (this.#terminalTurns.size >= this.#maxBufferedEvents) {
      throw new HarnessCapabilityUnavailableError(
        "turn.start",
        "the bounded session turn limit was reached; open a new session",
      );
    }
    const turnId = `turn-${randomBytes(12).toString("hex")}`;
    this.#activeTurnId = turnId;
    this.#assistantText = "";
    this.#emit("turn.submitted", { text: input.message.text }, { turnId });
    this.#emit("turn.accepted", { turnId }, { turnId });
    this.#emit("turn.started", { status: "inProgress" }, { turnId });
    let turn: AcpxRuntimeTurn;
    try {
      turn = this.#host.startTurn({
        text: input.message.text,
        requestId: `${safeId(this.#input.runId, "run")}:${turnId}`,
        onElicitation: (request, context) =>
          this.#handleElicitation(turnId, request, context),
      });
    } catch (error) {
      this.#publishTerminal(
        turnId,
        canonicalJson({ status: "failed" }),
        "turn.failed",
        { status: "failed", error: { message: safeMessage(error) } },
      );
      throw error;
    }
    const pump = this.#pumpTurn(turnId, turn);
    this.#activePump = pump;
    void pump
      .finally(() => {
        if (this.#activePump === pump) this.#activePump = null;
      })
      .catch(() => undefined);
    return { turnId };
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    this.#assertOpen();
    if (input.turnId && input.turnId !== this.#activeTurnId) {
      throw new HarnessStaleTurnError(input.turnId);
    }
    if (this.#pendingTerminal) {
      throw new HarnessCapabilityUnavailableError(
        "interruption",
        "the active turn is awaiting canonical terminal-event retention",
      );
    }
    if (!this.#activeTurnId) {
      throw new HarnessCapabilityUnavailableError(
        "interruption",
        "there is no active Codex ACPX turn",
      );
    }
    await this.#host.interruptActiveTurn(input.reason ?? "interrupted");
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return [...this.#pendingRuntimeRequests.values()].map(({ request }) =>
      structuredClone(request),
    );
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    this.#assertOpen();
    const pending = this.#pendingRuntimeRequests.get(input.requestId);
    if (!pending) {
      throw new HarnessCapabilityUnavailableError(
        "runtime request resolution",
        `request ${input.requestId} is no longer pending`,
      );
    }
    if (
      pending.request.turnId !== input.turnId ||
      this.#activeTurnId !== input.turnId
    ) {
      throw new HarnessStaleTurnError(input.turnId);
    }
    if (pending.settling) {
      throw new HarnessCapabilityUnavailableError(
        "runtime request resolution",
        `request ${input.requestId} is already settling`,
      );
    }
    pending.settling = true;
    try {
      const resolution = parseHarnessRuntimeRequestResolution(
        pending.request.requestKind,
        input.resolution,
        pending.request.input,
      );
      const providerResponse = acpElicitationResponse(
        pending.normalized,
        resolution,
      );
      if (!this.#pendingRuntimeRequests.delete(input.requestId)) return;
      pending.cleanup();
      this.#emit(
        "runtime_request.resolved",
        harnessRuntimeRequestOutcome(pending.request, {
          action: resolution.action,
          ...(resolution.action === "submit" && "response" in resolution
            ? { response: resolution.response }
            : {}),
        }),
        { turnId: input.turnId, itemId: pending.request.itemId },
      );
      pending.settle(providerResponse);
    } catch (error) {
      pending.settling = false;
      throw error;
    }
  }

  handoffRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
    signal: AbortSignal;
  }): HarnessRuntimeRequestHandoff {
    if (input.signal.aborted) {
      return { result: "already_settled", cleanup: Promise.resolve() };
    }
    this.#assertOpen();
    const pending = this.#pendingRuntimeRequests.get(input.requestId);
    if (
      !pending ||
      pending.request.turnId !== input.turnId ||
      this.#activeTurnId !== input.turnId ||
      pending.settling
    ) {
      return { result: "already_settled", cleanup: Promise.resolve() };
    }
    if (
      !this.#emit(
        "runtime_request.expired",
        harnessRuntimeInputExpiredOutcome(pending.request, input.reason),
        { turnId: input.turnId, itemId: pending.request.itemId },
      )
    ) {
      throw new HarnessCapabilityUnavailableError(
        "runtime request handoff",
        "the event consumer must drain provider events before the durable handoff can be retained",
      );
    }
    if (!this.#pendingRuntimeRequests.delete(input.requestId)) {
      throw new Error(
        `ACPX runtime request ${input.requestId} changed during its synchronous handoff`,
      );
    }
    pending.cleanup();
    pending.settle({ action: "cancel" });
    const cleanup = Promise.resolve()
      .then(() =>
        this.#host.interruptActiveTurn(
          "Paperclip parked the ACPX input on a durable wait.",
        ),
      )
      .catch((error: unknown) => {
        if (
          this.#activeTurnId === input.turnId &&
          !this.#terminalTurns.has(input.turnId)
        ) {
          throw error;
        }
      });
    return { result: "handed_off", cleanup };
  }

  async dispatchTool(call: RunnerToolCall): Promise<unknown> {
    this.#assertOpen();
    if (this.#pendingTerminal) {
      throw new HarnessCapabilityUnavailableError(
        "tool.dispatch",
        "the active turn is awaiting canonical terminal-event retention",
      );
    }
    const turnId = this.#activeTurnId;
    if (!turnId) {
      throw new Error("Codex ACPX tool call is not bound to an active turn");
    }
    const tool = canonicalRunnerToolName(call.tool);
    if (tool === PRP_COMPLETION_TOOL_NAME || tool === PRP_BLOCK_TOOL_NAME) {
      const validation = validatePrpStructuredRunResult(call.arguments);
      if (!validation.ok) throw new Error("Invalid semantic run result");
      const blocked = validation.result.reportedWorkDisposition === "blocked";
      if (
        (tool === PRP_BLOCK_TOOL_NAME && !blocked) ||
        (tool === PRP_COMPLETION_TOOL_NAME && blocked)
      ) {
        throw new Error(
          "Semantic result disposition does not match the terminal tool",
        );
      }
      const fingerprint = canonicalJson(validation.result);
      if (
        this.#semanticFingerprint !== null &&
        this.#semanticFingerprint !== fingerprint
      ) {
        throw new Error("A different semantic result is already committed");
      }
      const claimsLaterTurn =
        this.#semanticFingerprint === fingerprint &&
        this.#semanticTurnId !== turnId;
      const repeatsPendingTransfer =
        claimsLaterTurn &&
        this.#pendingSemanticTransfer?.fingerprint === fingerprint &&
        this.#pendingSemanticTransfer.turnId === turnId;
      if (
        this.#semanticFingerprint === null ||
        (claimsLaterTurn && !repeatsPendingTransfer)
      ) {
        if (
          !this.#emit("run.result.proposed", validation.result, {
            turnId,
            itemId: call.callId,
          })
        ) {
          throw new HarnessCapabilityUnavailableError(
            "run.result.proposed",
            "the event consumer must drain provider events before a semantic result can be accepted",
          );
        }
        if (claimsLaterTurn) {
          // A reaffirming retry does not own the durable result until its
          // provider turn completes successfully. A failed or interrupted
          // retry must leave the last completed owner recoverable.
          this.#pendingSemanticTransfer = {
            result: structuredClone(validation.result),
            fingerprint,
            callId: call.callId,
            turnId,
          };
        } else {
          this.#semanticResult = structuredClone(validation.result);
          this.#semanticFingerprint = fingerprint;
          this.#semanticCallId = call.callId;
          this.#semanticTurnId = turnId;
        }
      }
      return { accepted: true };
    }
    if (!this.#dynamicToolHandler) {
      throw new Error(`Unsupported Paperclip operation ${tool}`);
    }
    return await this.#dynamicToolHandler({
      tool,
      callId: call.callId,
      providerSessionId: this.#host.identity().agentSessionId,
      turnId,
      arguments: structuredClone(call.arguments),
      signal: call.signal,
    });
  }

  async read(): Promise<Record<string, unknown>> {
    return {
      identity: this.#host.identity(),
      binding: this.#host.binding(),
      status: await this.#host.status(),
    };
  }

  async reconcile(): Promise<Record<string, unknown>> {
    const identity = this.#host.identity();
    const status = await this.#host.status();
    if (
      status.agentSessionId &&
      status.agentSessionId !== identity.agentSessionId
    ) {
      throw new Error("ACPX reconciliation changed the provider session");
    }
    return { identity, status };
  }

  async usage(): Promise<Record<string, unknown> | null> {
    return this.#usage === null ? null : structuredClone(this.#usage);
  }

  async transcript(): Promise<HarnessTranscriptSnapshot> {
    return {
      schema: "paperclip-runner/harness-transcript/v1",
      complete: !this.#transcriptOmitted,
      eventCount: this.#transcriptEventCount,
      events: structuredClone(this.#transcript.map(({ event }) => event)),
      omissionReason: this.#transcriptOmitted ? "retention_limit" : null,
    };
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    const identity = this.#host.identity();
    return {
      driverKind: "acpx_runtime",
      driverSessionId: identity.acpxRecordId,
      providerSessionId: identity.agentSessionId,
      providerRecoveryPolicy: this.#providerRecoveryPolicy,
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      lastSourceSequence: this.#sourceSequence,
      providerIdentity: {
        kind: "acpx",
        normalizedSessionId: identity.normalizedSessionId,
        acpxRecordId: identity.acpxRecordId,
        backendSessionId: identity.backendSessionId,
        agentSessionId: identity.agentSessionId,
        profileDigest: identity.profileDigest,
        workspaceDigest: identity.workspaceDigest,
        requestedModel: identity.requestedModel,
        effectiveModel: identity.effectiveModel,
        permissionMode: identity.permissionMode,
        providerLifetimeFenceCandidates:
          identity.providerLifetimeFenceCandidates,
      },
      semanticResult:
        this.#semanticResult &&
        this.#semanticFingerprint &&
        this.#semanticTurnId
          ? {
              result: structuredClone(this.#semanticResult),
              fingerprint: this.#semanticFingerprint,
              callId: this.#semanticCallId,
              turnId: this.#semanticTurnId,
            }
          : null,
      terminalTurns: [...this.#terminalTurns].map(
        ([terminalTurnId, fingerprint]) => ({
          turnId: terminalTurnId,
          fingerprint,
        }),
      ),
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
    };
  }

  async close(input: { reason: string }): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    if (this.#closed) return;
    this.#closingStarted = true;
    const closePromise = this.#finishClose(input.reason);
    this.#closePromise = closePromise;
    try {
      await closePromise;
      this.#closed = true;
    } catch (error) {
      this.#scheduleHostCloseRecovery(input.reason);
      throw error;
    } finally {
      if (this.#closePromise === closePromise) this.#closePromise = null;
    }
  }

  async #finishClose(reason: string): Promise<void> {
    const closingTurnId = this.#activeTurnId;
    const pump = this.#activePump;
    this.#cancelPendingRuntimeRequests(reason);
    const hostClose =
      this.#hostClosePromise ?? this.#startHostClose({ reason });
    let hostCloseError: unknown = null;
    try {
      await settleWithin(hostClose, this.#closeSettlementTimeoutMs);
    } catch (error) {
      hostCloseError = error;
    }
    if (pump) {
      await settleWithin(
        pump.catch(() => undefined),
        this.#closeSettlementTimeoutMs,
      ).catch(() => undefined);
    }
    if (closingTurnId && !this.#terminalTurns.has(closingTurnId)) {
      const pendingTerminal = this.#pendingTerminal;
      if (pendingTerminal?.turnId === closingTurnId) {
        this.#publishTerminal(
          pendingTerminal.turnId,
          pendingTerminal.fingerprint,
          pendingTerminal.eventType,
          pendingTerminal.payload,
        );
      } else {
        const reaffirmedSemanticResult =
          this.#pendingSemanticTransfer?.turnId === closingTurnId
            ? this.#pendingSemanticTransfer.fingerprint
            : null;
        this.#publishTerminal(
          closingTurnId,
          canonicalJson({
            status: "interrupted",
            ...(reaffirmedSemanticResult === null
              ? {}
              : { reaffirmedSemanticResult }),
          }),
          "turn.interrupted",
          { status: "interrupted", stopReason: "session_closed" },
        );
      }
    }
    if (hostCloseError) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "acpx_host_cleanup_deferred",
          message:
            "ACPX host cleanup exceeded its caller wait bound; the driver retains the exact cleanup until it settles.",
        },
        closingTurnId ? { turnId: closingTurnId } : {},
        0,
      );
    }
    this.#eventStreamClosed = true;
    this.#events.close();
    if (hostCloseError) {
      throw hostCloseError;
    }
  }

  #startHostClose(input: { reason: string }): Promise<void> {
    const closePromise = this.#host.close(input).then(() => {
      this.#hostClosed = true;
    });
    this.#hostClosePromise = closePromise;
    this.#retainCleanup(closePromise);
    return closePromise;
  }

  #scheduleHostCloseRecovery(reason: string): void {
    if (this.#hostClosed || this.#hostCloseRecoveryPromise) return;
    const failedOrPendingClose = this.#hostClosePromise;
    if (!failedOrPendingClose) return;
    // Never overlap the exact cleanup that exceeded the caller's wait bound.
    // Once an attempt rejects, keep one delay-bounded recovery owner alive for
    // a finite retry budget. A permanently pending attempt remains the sole
    // owner while the runtime adapter independently terminates its children;
    // repeated terminal failures settle instead of creating an immortal loop.
    // Host cleanup does not logically close the harness session: #finishClose
    // still owns terminal publication and event-stream closure after recovery.
    const recovery = (async () => {
      let attempt = failedOrPendingClose;
      let retryCount = 0;
      while (!this.#hostClosed) {
        try {
          await attempt;
          return;
        } catch (error) {
          if (retryCount >= MAX_AUTONOMOUS_HOST_CLOSE_RETRIES) {
            this.#quarantineCleanup(this.#host, reason);
            throw error;
          }
          retryCount += 1;
        }
        await waitForCleanupRetry(
          Math.max(1, Math.min(1_000, this.#closeSettlementTimeoutMs)),
        );
        if (this.#hostClosed) {
          return;
        }
        if (this.#hostClosePromise === attempt) {
          this.#hostClosePromise = null;
        }
        attempt = this.#startHostClose({
          reason: `${reason} (automatic cleanup recovery ${retryCount})`,
        });
      }
    })();
    this.#hostCloseRecoveryPromise = recovery;
    this.#retainCleanup(recovery);
    void recovery
      .finally(() => {
        if (this.#hostCloseRecoveryPromise === recovery) {
          this.#hostCloseRecoveryPromise = null;
        }
      })
      .catch(() => undefined);
  }

  async #pumpTurn(turnId: string, turn: AcpxRuntimeTurn): Promise<void> {
    try {
      let index = 0;
      const normalizeToolEvent =
        createAcpxToolEventNormalizer<AcpRuntimeEvent>();
      for await (const event of turn.events) {
        this.#mapRuntimeEvent(normalizeToolEvent(event), turnId, ++index);
      }
      const result = await turn.result;
      this.#cancelPendingRuntimeRequests("provider turn settled", turnId);
      if (this.#terminalTurns.has(turnId)) return;
      if (result.status === "completed") {
        const completedSemanticFingerprint =
          this.#pendingSemanticTransfer?.turnId === turnId
            ? this.#pendingSemanticTransfer.fingerprint
            : this.#semanticTurnId === turnId
              ? this.#semanticFingerprint
              : null;
        const finalText = this.#assistantText.trim();
        if (finalText) {
          this.#emit(
            "item.completed",
            { kind: "agentMessage", channel: "final", text: finalText },
            { turnId, itemId: `${turnId}:assistant-message` },
          );
        }
        this.#publishTerminal(
          turnId,
          canonicalJson({
            status: "completed",
            semanticResult: completedSemanticFingerprint,
          }),
          "turn.completed",
          { status: "completed", stopReason: result.stopReason ?? null },
        );
      } else if (result.status === "cancelled") {
        const reaffirmedSemanticResult =
          this.#pendingSemanticTransfer?.turnId === turnId
            ? this.#pendingSemanticTransfer.fingerprint
            : null;
        this.#publishTerminal(
          turnId,
          canonicalJson({
            status: "interrupted",
            ...(reaffirmedSemanticResult === null
              ? {}
              : { reaffirmedSemanticResult }),
          }),
          "turn.interrupted",
          {
            status: "interrupted",
            stopReason: result.stopReason ?? "cancelled",
          },
        );
      } else {
        const reaffirmedSemanticResult =
          this.#pendingSemanticTransfer?.turnId === turnId
            ? this.#pendingSemanticTransfer.fingerprint
            : null;
        this.#emit(
          "provider.notice.recorded",
          {
            schema: "paperclip.provider.notice.v1",
            noticeId: `${turnId}:failure`,
            severity: "error",
            category: "acpx_turn_failed",
            scope: "turn",
            recoverable: result.error.retryable ?? false,
            userActionable: true,
            summary: safeMessage(result.error.message),
          },
          { turnId, itemId: `${turnId}:failure` },
        );
        this.#publishTerminal(
          turnId,
          canonicalJson({
            status: "failed",
            ...(reaffirmedSemanticResult === null
              ? {}
              : { reaffirmedSemanticResult }),
          }),
          "turn.failed",
          {
            status: "failed",
            error: {
              code: result.error.code ?? null,
              message: safeMessage(result.error.message),
            },
          },
        );
      }
    } catch (error) {
      if (this.#terminalTurns.has(turnId)) return;
      if (error instanceof TerminalEventCapacityError) throw error;
      this.#cancelPendingRuntimeRequests("provider turn failed", turnId);
      if (this.#closed || this.#closingStarted) {
        const reaffirmedSemanticResult =
          this.#pendingSemanticTransfer?.turnId === turnId
            ? this.#pendingSemanticTransfer.fingerprint
            : null;
        this.#publishTerminal(
          turnId,
          canonicalJson({
            status: "interrupted",
            ...(reaffirmedSemanticResult === null
              ? {}
              : { reaffirmedSemanticResult }),
          }),
          "turn.interrupted",
          { status: "interrupted", stopReason: "session_closed" },
        );
      } else {
        const reaffirmedSemanticResult =
          this.#pendingSemanticTransfer?.turnId === turnId
            ? this.#pendingSemanticTransfer.fingerprint
            : null;
        this.#publishTerminal(
          turnId,
          canonicalJson({
            status: "failed",
            ...(reaffirmedSemanticResult === null
              ? {}
              : { reaffirmedSemanticResult }),
          }),
          "turn.failed",
          { status: "failed", error: { message: safeMessage(error) } },
        );
      }
    }
  }

  #publishTerminal(
    turnId: string,
    fingerprint: string,
    eventType: "turn.completed" | "turn.failed" | "turn.interrupted",
    payload: Record<string, unknown>,
  ): void {
    if (this.#terminalTurns.has(turnId)) return;
    const pendingTerminal = this.#pendingTerminal;
    if (
      pendingTerminal !== null &&
      (pendingTerminal.turnId !== turnId ||
        pendingTerminal.fingerprint !== fingerprint ||
        pendingTerminal.eventType !== eventType ||
        canonicalJson(pendingTerminal.payload) !== canonicalJson(payload))
    ) {
      throw new Error(
        `Codex ACPX terminal disposition changed while ${pendingTerminal.turnId} awaited stream capacity`,
      );
    }
    const terminal = pendingTerminal ?? {
      turnId,
      fingerprint,
      eventType,
      payload: structuredClone(payload),
    };
    this.#pendingTerminal = terminal;
    if (!this.#emit(terminal.eventType, terminal.payload, { turnId })) {
      // The persisted terminal index is the driver's settlement authority.
      // Never advance it unless the matching canonical event is already in
      // the bounded stream. A caller may drain and retry close, but it cannot
      // observe a settled turn whose terminal fact was omitted.
      throw new TerminalEventCapacityError(turnId, eventType);
    }
    this.#terminalTurns.set(turnId, fingerprint);
    this.#pendingTerminal = null;
    if (this.#pendingSemanticTransfer?.turnId === turnId) {
      if (eventType === "turn.completed") {
        this.#semanticResult = structuredClone(
          this.#pendingSemanticTransfer.result,
        );
        this.#semanticFingerprint = this.#pendingSemanticTransfer.fingerprint;
        this.#semanticCallId = this.#pendingSemanticTransfer.callId;
        this.#semanticTurnId = turnId;
      }
      this.#pendingSemanticTransfer = null;
    }
    if (this.#activeTurnId === turnId) this.#activeTurnId = null;
  }

  #mapRuntimeEvent(
    event: AcpRuntimeEvent,
    turnId: string,
    index: number,
  ): void {
    const fallbackItemId = `${turnId}:acp:${index}`;
    if (event.type === "text_delta") {
      const output = boundedText(event.text, 64 * 1024);
      const isReasoning =
        event.stream === "thought" || event.tag === "agent_thought_chunk";
      if (!isReasoning) {
        this.#assistantText = boundedText(
          `${this.#assistantText}${output}`,
          256 * 1024,
        );
      }
      this.#emit(
        "item.delta",
        {
          kind: isReasoning ? "reasoning" : "agentMessage",
          channel: isReasoning ? "summary" : "unknown",
          text: output,
        },
        {
          turnId,
          itemId: isReasoning
            ? `${turnId}:reasoning`
            : `${turnId}:assistant-message`,
        },
      );
    }
    if (event.type === "status" && event.tag === "usage_update") {
      this.#usage = boundedRecord({
        cumulative: event.breakdown,
        cost: event.cost,
      });
    }
    for (const canonical of canonicalProviderEventsFromAcpxRuntimeEvent(
      event,
      fallbackItemId,
      turnId,
    )) {
      this.#emit(canonical.eventType, canonical.payload, {
        turnId,
        itemId: canonical.itemId,
      });
    }
  }

  async #handleElicitation(
    turnId: string,
    request: AcpElicitationRequest,
    context: AcpElicitationContext,
  ): Promise<AcpElicitationResponse> {
    if (
      this.#closed ||
      this.#activeTurnId !== turnId ||
      context.signal.aborted
    ) {
      return { action: "cancel" };
    }
    if (this.#pendingRuntimeRequests.size >= MAX_PENDING_RUNTIME_REQUESTS) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "runtime_input_limit_reached",
          adapter: "acpx-runtime",
          reason: "The active ACPX turn has too many pending input requests.",
        },
        { turnId },
      );
      return { action: "cancel" };
    }
    let normalized: NormalizedAcpForm | null;
    try {
      normalized = normalizeAcpFormElicitation(request);
    } catch (error) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "runtime_input_rejected",
          adapter: "acpx-runtime",
          reason: safeMessage(error),
        },
        { turnId },
      );
      return { action: "cancel" };
    }
    if (!normalized) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "runtime_input_unsupported",
          adapter: "acpx-runtime",
          reason: "The ACPX provider requested an unsupported input mode.",
        },
        { turnId },
      );
      return { action: "cancel" };
    }
    if (
      normalized.questionSet.questions.some(
        (question) => question.textValidation?.pattern !== undefined,
      )
    ) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "runtime_input_pattern_unsupported",
          adapter: "acpx-runtime",
          reason:
            "ACPX form patterns require a bounded regular expression dialect.",
        },
        { turnId },
      );
      return { action: "cancel" };
    }
    const requestId = stableId(
      "acpx-request",
      `${turnId}:${++this.#runtimeRequestSequence}:${typeof context.requestId}:${String(context.requestId)}`,
    );
    const runtimeRequest: HarnessRuntimeRequest = {
      requestId,
      requestKind: "elicitation",
      method: "elicitation/create",
      turnId,
      itemId: requestId,
      status: "pending",
      prompt: boundedText(
        normalized.questionSet.title ??
          normalized.questionSet.description ??
          "Additional information is required.",
        1_000,
      ),
      details: { mode: "form" },
      input: structuredClone(normalized.questionSet),
      origin: {
        adapter: "acpx-runtime",
        provider: this.#agent,
        method: "elicitation/create",
      },
    };
    if (
      !this.#emit(
        "runtime_request.created",
        { request: runtimeInputProtocolPayload(runtimeRequest) },
        { turnId, itemId: requestId },
      )
    ) {
      return { action: "cancel" };
    }
    return await new Promise<AcpElicitationResponse>((settle) => {
      const cancel = () => {
        const pending = this.#pendingRuntimeRequests.get(requestId);
        if (!pending || pending.settling) return;
        if (!this.#pendingRuntimeRequests.delete(requestId)) return;
        pending.cleanup();
        this.#emit(
          "runtime_request.cancelled",
          harnessRuntimeRequestOutcome(runtimeRequest, {
            action: "cancel",
            reason: "provider request aborted",
          }),
          { turnId, itemId: requestId },
        );
        settle({ action: "cancel" });
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      this.#pendingRuntimeRequests.set(requestId, {
        request: runtimeRequest,
        normalized,
        settle,
        cleanup: () => context.signal.removeEventListener("abort", cancel),
        settling: false,
      });
      if (context.signal.aborted) cancel();
    });
  }

  #cancelPendingRuntimeRequests(reason: string, turnId?: string): void {
    for (const [requestId, pending] of this.#pendingRuntimeRequests) {
      if (turnId && pending.request.turnId !== turnId) continue;
      if (!this.#pendingRuntimeRequests.delete(requestId)) continue;
      pending.cleanup();
      this.#emit(
        "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(pending.request, {
          action: "cancel",
          reason: boundedText(safeMessage(reason), 1_000),
        }),
        {
          turnId: pending.request.turnId,
          itemId: pending.request.itemId,
        },
      );
      pending.settle({ action: "cancel" });
    }
  }

  #emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
    reservedAfter = isTerminalEvent(eventType)
      ? 0
      : eventType === "run.result.proposed"
        ? Math.max(0, this.#terminalEventReserve - 1)
        : this.#terminalEventReserve,
  ): boolean {
    if (this.#eventStreamClosed) return false;
    if (this.#eventStreamOmitted && isTerminalEvent(eventType)) {
      this.#eventStreamOmitted = false;
      const recordedOmission = this.#emit(
        "harness.diagnostic",
        {
          code: "event_stream_retention_limit",
          message:
            "Earlier provider events were omitted because the consumer exceeded the bounded event buffer.",
        },
        refs,
        1,
      );
      if (!recordedOmission) this.#eventStreamOmitted = true;
    }
    const sourceSeq = this.#sourceSequence + 1;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#sourceInstanceId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#sourceInstanceId,
      sourceKind: "runner",
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload: structuredClone(payload),
    };
    if (!this.#events.push(event, reservedAfter)) {
      this.#eventStreamOmitted = true;
      this.#transcriptEventCount += 1;
      this.#transcriptOmitted = true;
      return false;
    }
    this.#sourceSequence = sourceSeq;
    this.#retainTranscriptEvent(event);
    return true;
  }

  #retainTranscriptEvent(event: PrpEvent): void {
    this.#transcriptEventCount += 1;
    const retained = structuredClone(event);
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(retained));
    } catch {
      this.#transcriptOmitted = true;
      return;
    }
    if (bytes > MAX_TRANSCRIPT_BYTES) {
      this.#transcriptOmitted = true;
      return;
    }
    this.#transcript.push({ event: retained, bytes });
    this.#transcriptBytes += bytes;
    while (
      this.#transcript.length > MAX_TRANSCRIPT_EVENTS ||
      this.#transcriptBytes > MAX_TRANSCRIPT_BYTES
    ) {
      const omitted = this.#transcript.shift();
      if (omitted) this.#transcriptBytes -= omitted.bytes;
      this.#transcriptOmitted = true;
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#closingStarted) {
      throw new Error("Codex ACPX session is closing or closed");
    }
  }
}

function waitForCleanupRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function acpElicitationResponse(
  normalized: NormalizedAcpForm,
  resolution: HarnessRuntimeRequestResolution,
): AcpElicitationResponse {
  if (resolution.action === "submit") {
    if (!("response" in resolution)) {
      throw new HarnessRuntimeRequestResolutionError(
        "elicitation",
        "ACPX form submissions require a canonical question response",
      );
    }
    return normalized.accept(resolution.response);
  }
  if (resolution.action === "accept_for_session") {
    throw new HarnessRuntimeRequestResolutionError(
      "elicitation",
      "ACPX form input does not support session acceptance",
    );
  }
  return { action: resolution.action };
}

function runtimeInputProtocolPayload(
  request: HarnessRuntimeRequest,
): Record<string, unknown> {
  if (!request.input) {
    throw new Error("ACPX runtime input request omitted its question set");
  }
  return {
    schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
    requestKind: "runtime",
    requestId: request.requestId,
    type: "input",
    status: request.status,
    prompt: request.prompt,
    input: structuredClone(request.input),
    origin: structuredClone(request.origin),
    turnId: request.turnId,
    itemId: request.itemId,
  };
}

function validateRecoverySnapshot(snapshot: PersistedHarnessSession): void {
  if (
    snapshot.driverKind !== "acpx_runtime" ||
    !snapshot.runId?.trim() ||
    !snapshot.normalizedSessionId?.trim() ||
    snapshot.providerIdentity?.kind !== "acpx"
  ) {
    throw new Error("persisted Codex ACPX session identity is incomplete");
  }
  const identity = snapshot.providerIdentity;
  if (
    !boundedIdentity(snapshot.runId) ||
    !boundedIdentity(snapshot.normalizedSessionId) ||
    identity.normalizedSessionId !== snapshot.normalizedSessionId ||
    identity.acpxRecordId !== snapshot.driverSessionId ||
    identity.agentSessionId !== snapshot.providerSessionId ||
    ![
      identity.normalizedSessionId,
      identity.acpxRecordId,
      identity.backendSessionId,
      identity.agentSessionId,
      identity.requestedModel,
      identity.effectiveModel,
    ].every(boundedIdentity) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.profileDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(identity.workspaceDigest) ||
    (identity.permissionMode !== undefined &&
      !["approve-all", "approve-reads", "deny-all"].includes(
        identity.permissionMode,
      )) ||
    !validProviderLifetimeFenceCandidates(
      identity.providerLifetimeFenceCandidates,
    )
  ) {
    throw new Error("persisted Codex ACPX session identity is inconsistent");
  }
  if (
    snapshot.providerRecoveryPolicy !== undefined &&
    snapshot.providerRecoveryPolicy !== "same_session_only"
  ) {
    throw new Error("persisted Codex ACPX recovery policy is unsupported");
  }
  if (
    (snapshot.pendingRuntimeRequests?.length ?? 0) > 0 ||
    (snapshot.lineage?.length ?? 0) > 0 ||
    snapshot.goal != null
  ) {
    throw new Error("persisted Codex ACPX snapshot has unsupported state");
  }
  if (
    snapshot.lastSourceSequence !== undefined &&
    (!Number.isSafeInteger(snapshot.lastSourceSequence) ||
      snapshot.lastSourceSequence < 0)
  ) {
    throw new Error("persisted Codex ACPX source sequence is invalid");
  }
  if (
    snapshot.terminalTurns !== undefined &&
    !Array.isArray(snapshot.terminalTurns)
  ) {
    throw new Error("persisted Codex ACPX terminal history is invalid");
  }
  const terminalTurns = snapshot.terminalTurns ?? [];
  if (terminalTurns.length > MAX_RECOVERY_TERMINAL_TURNS) {
    throw new Error("persisted Codex ACPX terminal history exceeds its limit");
  }
  const terminalTurnIds = new Set<string>();
  let terminalBytes = 0;
  for (const terminal of terminalTurns) {
    terminalBytes +=
      Buffer.byteLength(terminal.turnId ?? "") +
      Buffer.byteLength(terminal.fingerprint ?? "");
    if (
      !boundedIdentity(terminal.turnId) ||
      !terminal.fingerprint ||
      Buffer.byteLength(terminal.fingerprint) > 256 * 1024 ||
      terminalBytes > MAX_RECOVERY_TERMINAL_BYTES ||
      terminalTurnIds.has(terminal.turnId)
    ) {
      throw new Error("persisted Codex ACPX terminal turn is invalid");
    }
    terminalTurnIds.add(terminal.turnId);
  }
  if (
    snapshot.activeTurnId !== undefined &&
    snapshot.activeTurnId !== null &&
    !boundedIdentity(snapshot.activeTurnId)
  ) {
    throw new Error("persisted Codex ACPX active turn is invalid");
  }
  const semantic = snapshot.semanticResult;
  if (semantic) {
    const validation = validatePrpStructuredRunResult(semantic.result);
    if (
      !validation.ok ||
      semantic.fingerprint !== canonicalJson(validation.result) ||
      !boundedIdentity(semantic.turnId) ||
      (semantic.callId !== undefined &&
        semantic.callId !== null &&
        !boundedIdentity(semantic.callId))
    ) {
      throw new Error("persisted Codex ACPX semantic result is invalid");
    }
    const semanticTerminalIndex = terminalTurns.findIndex(
      (terminal) => terminal.turnId === semantic.turnId,
    );
    const semanticTerminal = terminalTurns[semanticTerminalIndex];
    if (
      !semanticTerminal ||
      !isCompletedSemanticTerminal(
        semanticTerminal.fingerprint,
        semantic.fingerprint,
      )
    ) {
      throw new Error(
        "persisted Codex ACPX semantic result has no completed terminal turn",
      );
    }
    if (semanticTerminalIndex !== terminalTurns.length - 1) {
      // A later failed or interrupted turn may have reaffirmed the same result,
      // but it still supersedes the earlier settlement as the latest durable
      // provider fact. Recovery must not finalize an earlier success after a
      // newer attempt failed to complete.
      throw new Error(
        "persisted Codex ACPX semantic result is not the latest terminal settlement",
      );
    }
    if (snapshot.activeTurnId !== undefined && snapshot.activeTurnId !== null) {
      const activeTerminal = terminalTurns.find(
        (terminal) => terminal.turnId === snapshot.activeTurnId,
      );
      if (
        snapshot.activeTurnId !== semantic.turnId ||
        !activeTerminal ||
        !isCompletedSemanticTerminal(
          activeTerminal.fingerprint,
          semantic.fingerprint,
        )
      ) {
        throw new Error(
          "persisted Codex ACPX active turn is not the completed semantic settlement",
        );
      }
    }
  } else if (terminalTurns.length > 0) {
    const latestTerminalTurnId = terminalTurns.at(-1)!.turnId;
    const settlementTurnId = snapshot.activeTurnId ?? latestTerminalTurnId;
    const settlement = terminalTurns.find(
      (terminal) => terminal.turnId === settlementTurnId,
    );
    if (
      settlementTurnId !== latestTerminalTurnId ||
      !settlement ||
      !isCompletedTerminal(settlement.fingerprint)
    ) {
      throw new Error(
        "persisted Codex ACPX resultless recovery requires a completed terminal turn",
      );
    }
  }
}

function validProviderLifetimeFenceCandidates(
  value: unknown,
): value is readonly [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (port) => Number.isSafeInteger(port) && port >= 49_152 && port <= 65_535,
    ) &&
    new Set(value).size === 3
  );
}

function isCompletedTerminal(terminalFingerprint: string): boolean {
  try {
    const value: unknown = JSON.parse(terminalFingerprint);
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).status === "completed"
    );
  } catch {
    return false;
  }
}

function isCompletedSemanticTerminal(
  terminalFingerprint: string,
  semanticFingerprint: string,
): boolean {
  try {
    const value: unknown = JSON.parse(terminalFingerprint);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const terminal = value as Record<string, unknown>;
    return (
      terminal.status === "completed" &&
      terminal.semanticResult === semanticFingerprint
    );
  } catch {
    return false;
  }
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function boundedRecord(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 64 * 1024) {
    return { omitted: true, reason: "payload_limit" };
  }
  const parsed: unknown = JSON.parse(serialized);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes
    ? value
    : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function safeId(value: string, fallback: string): string {
  const candidate = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 160);
  return /^[A-Za-z0-9]/.test(candidate) ? candidate : fallback;
}

function stableId(prefix: string, value: string): string {
  const readable = safeId(value, "session").slice(0, 80);
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${prefix}-${readable}-${suffix}`;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(\bauthorization\s*[:=]\s*)(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|[^\r\n,}\]]*)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:key|token|secret|password)\s*[:=]\s*)(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|[^\s,}\]]+)/gi,
      "$1[REDACTED]",
    )
    .slice(0, 4_000);
}

function reportRetainedAcpxCleanupFailure(
  input: AcpxRetainedCleanupFailure,
): void {
  const errorName = input.error instanceof Error ? input.error.name : "Error";
  process.emitWarning(
    JSON.stringify({
      schema: "paperclip.runner.retained_cleanup_failure.v1",
      resource: input.resource,
      attempt: input.attempt,
      errorName,
    }),
    {
      code: "PAPERCLIP_ACPX_RETAINED_CLEANUP_FAILURE",
      type: "PaperclipRunnerCleanupWarning",
    },
  );
}

function isTerminalEvent(eventType: PrpEvent["eventType"]): boolean {
  return (
    eventType === "turn.completed" ||
    eventType === "turn.failed" ||
    eventType === "turn.interrupted"
  );
}

class TerminalEventCapacityError extends Error {
  constructor(turnId: string, eventType: PrpEvent["eventType"]) {
    super(
      `Codex ACPX cannot settle ${turnId} before its ${eventType} event is retained`,
    );
    this.name = "TerminalEventCapacityError";
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  readonly #maxItems: number;
  #closed = false;

  constructor(maxItems: number) {
    this.#maxItems = maxItems;
  }

  hasCapacity(requiredItems: number): boolean {
    return (
      requiredItems <=
      this.#waiters.length + this.#maxItems - this.#items.length
    );
  }

  push(item: T, reservedAfter = 0): boolean {
    if (this.#closed) return false;
    // Admission and insertion are one synchronous operation so every regular
    // event leaves the terminal lane intact. In particular, a lagging
    // consumer cannot occupy terminal capacity between a check and a push.
    if (!this.hasCapacity(1 + reservedAfter)) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: item });
      return true;
    }
    if (this.#items.length >= this.#maxItems) return false;
    this.#items.push(item);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) {
          return Promise.resolve({ done: false, value: item });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

async function settleWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("ACPX host cleanup exceeded its shutdown timeout"));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runAbortableDriverAdmission<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal === undefined) return await operation();
  signal.throwIfAborted();
  return await raceDriverAdmissionWithAbort(
    Promise.resolve().then(operation),
    signal,
  );
}

function raceDriverAdmissionWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = (): void => settle(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void pending.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
