import type {
  AcpElicitationHandler,
  AcpRuntimeEvent,
  AcpRuntimeTurnResult,
} from "acpx/runtime";

import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import {
  startRunnerToolBridge,
  type RunnerToolBridge,
  type RunnerToolBridgeOptions,
} from "../runner-tool-bridge.js";
import {
  acquireAcpxProviderLifetimeLease,
  stageManagedCodexCredential,
  type AcpxProviderLifetimeLease,
} from "./codex-credentials.js";
import {
  verifyQualifiedAcpxInstallation,
  type VerifiedAcpxCommandLease,
  type VerifiedAcpxInstallation,
} from "./installation-integrity.js";
import {
  requireVerifiedAcpxModel,
  type AcpxModelStatus,
} from "./model-verification.js";
import { acpxRuntimePermissionPolicy } from "./permission-policy.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
  type QualifiedAcpxProfile,
} from "./qualified-profiles.js";
import {
  createAcpxIdentityRecord,
  createAcpxRecoveryBinding,
  verifyExpectedAcpxIdentity,
  type AcpxIdentityRecord,
  type AcpxRecoveryBinding,
} from "./recovery-identity.js";
import {
  prepareAcpxRuntimeSandbox,
  type AcpxRuntimeSandbox,
} from "./runtime-sandbox.js";
import type { AcpxExpectedSessionIdentity } from "./sidecar-protocol.js";

export const ACPX_TURN_CANCELLATION_SHUTDOWN_BOUND_MS = 2_000;
const RUNTIME_ADMISSION_VERIFICATION_TIMEOUT_MS = 8_000;
const activeRuntimeHostCleanupOwners = new Set<Promise<unknown>>();

class AcpxRuntimeAdmissionTimeoutError extends Error {
  constructor() {
    super("ACPX runtime admission verification exceeded its deadline");
    this.name = "AcpxRuntimeAdmissionTimeoutError";
  }
}

const ACPX_ADMISSION_CLEANUP_BATCH_ATTEMPTS = 8;
const ACPX_ADMISSION_CLEANUP_RETRY_DELAY_MS = 10;
const ACPX_ADMISSION_CLEANUP_RESCHEDULE_MS = 1_000;

export interface AcpxRuntimePortIdentity {
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
}

export interface AcpxRuntimeTurnInput {
  text: string;
  requestId: string;
  signal?: AbortSignal;
  onElicitation?: AcpElicitationHandler;
}

export interface AcpxRuntimeTurn {
  readonly requestId: string;
  readonly promptStarted: Promise<void>;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: { reason?: string }): Promise<void>;
  closeStream(input?: { reason?: string }): Promise<void>;
}

/** Minimal third-party ACP runtime surface admitted by the host boundary. */
export interface AcpxRuntimePort {
  identity(): Promise<AcpxRuntimePortIdentity>;
  getStatus(): Promise<AcpxModelStatus>;
  setModel?(model: string): Promise<void>;
  startTurn(input: AcpxRuntimeTurnInput): AcpxRuntimeTurn;
  close(input: { reason: string }): Promise<void>;
}

export interface AcpxRuntimePortOpenOptions {
  command: VerifiedAcpxCommandLease;
  profile: QualifiedAcpxProfile;
  cwd: string;
  stateDirectory: string;
  providerSessionKey: string;
  permissionMode: NativeAcpxPermissionMode;
  permissionPolicy: ReturnType<typeof acpxRuntimePermissionPolicy>;
  launchEnvironment: Readonly<NodeJS.ProcessEnv>;
  /** Kernel credential-home quorum inherited by the provider sentinel. */
  credentialFenceFds: readonly [number, number] | null;
  /** Validate the guardian while the credential-home quorum is held. */
  activateCredentialFenceOwner: ((pid: number) => Promise<void>) | null;
  systemInstructions: string;
  /** Revalidate a pinned recovery workspace at the provider spawn boundary. */
  assertWorkspaceHeld?: () => void;
  /** Abort provider admission and clean any runtime that resolves too late. */
  signal?: AbortSignal;
  mcpServers: readonly AcpxMcpServerBinding[];
  /**
   * Transfer the provider cleanup proof before a failed open settles. The host
   * keeps credentials fenced until this exact cleanup succeeds.
   */
  retainFailedAdmissionCleanup(cleanup: Promise<void>): void;
}

export interface AcpxMcpServerBinding {
  name: string;
  url: string;
  bearerToken: string;
  runnerOwned: boolean;
}

export type AcpxSemanticToolSession = Omit<RunnerToolBridgeOptions, "secret">;

export interface AcpxRetainedCleanupFailure {
  resource:
    | "credential"
    | "provider_lifetime"
    | "command"
    | "runtime"
    | "tool_bridge";
  attempt: number;
  error: unknown;
}

export interface AcpxRuntimeHostDependencies {
  verifyInstallation?: (
    profile: QualifiedAcpxProfile,
  ) => Promise<VerifiedAcpxInstallation>;
  /** Internal test seam for aborting credential acquisition. */
  stageCredential?: typeof stageManagedCodexCredential;
  openRuntime(options: AcpxRuntimePortOpenOptions): Promise<AcpxRuntimePort>;
  /** Internal test seam for deterministic sandbox-admission scheduling. */
  prepareSandbox?: typeof prepareAcpxRuntimeSandbox;
  /** Internal test seam for the post-handshake admission deadline. */
  admissionVerificationTimeoutMs?: number;
  /** Internal test seam for failed-admission cleanup. */
  admissionCleanupTimeoutMs?: number;
  /**
   * Transfers failed-admission cleanup ownership to the embedding lifecycle.
   * The callback receives the exact aggregate cleanup attempt before the
   * bounded admission wait can return.
   */
  retainAdmissionCleanup?: (cleanup: Promise<void>) => void;
  /**
   * Required observability channel for resources acquired after admission was
   * aborted. Implementations must not throw from this callback.
   */
  reportRetainedCleanupFailure(failure: AcpxRetainedCleanupFailure): void;
}

export interface OpenAcpxRuntimeHostOptions {
  runtimeDirectory: string;
  normalizedSessionId: string;
  workingDirectory: string;
  agent: QualifiedAcpxAgent;
  model: string;
  permissionMode: NativeAcpxPermissionMode;
  systemInstructions?: string;
  environment?: NodeJS.ProcessEnv;
  managedCodexCredentialSourcePath?: string;
  expectedIdentity?: AcpxExpectedSessionIdentity;
  /** Revalidate a pinned recovery workspace through provider admission. */
  assertWorkspaceHeld?: () => void;
  /** Abort admission without admitting resources that resolve afterward. */
  signal?: AbortSignal;
  semanticTools?: AcpxSemanticToolSession;
}

const RETAINED_CLEANUP_RETRY_INITIAL_DELAY_MS = 10;
const RETAINED_CLEANUP_RETRY_MAX_DELAY_MS = 1_000;

interface RetainedRejectedRuntimeAdmission {
  readonly credential: AcpxProviderLifetimeLease;
  cleanup: Promise<void>;
}

// A rejected provider open is not itself proof that provider processes are
// gone. Retain the credential with the adapter's exact cleanup proof and scrub
// it only after that proof succeeds. Terminal cleanup failure stays inert and
// fenced instead of exposing the credential to a replacement admission.
const retainedRejectedRuntimeAdmissions =
  new Set<RetainedRejectedRuntimeAdmission>();

interface RetainedAcpxAdmissionCleanup {
  readonly runtime: AcpxRuntimePort | null;
  readonly toolBridge: RunnerToolBridge | null;
  readonly credential: AcpxProviderLifetimeLease | null;
  readonly command: VerifiedAcpxCommandLease | null;
  readonly reason: string;
  recovery: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

// An admission failure has no AcpxRuntimeHost instance for a caller to close.
// Retain those resources here until provider shutdown succeeds and the staged
// credential can consequently be scrubbed. Each recovery batch is finite and
// sequential; an unref'd timer rate-limits later autonomous attempts without
// allowing the failed admission's ownership to become unreachable.
const retainedAcpxAdmissionCleanups = new Set<RetainedAcpxAdmissionCleanup>();

export class AcpxRuntimeHost {
  readonly #runtime: AcpxRuntimePort;
  readonly #binding: AcpxRecoveryBinding;
  readonly #identity: AcpxIdentityRecord;
  readonly #sandbox: AcpxRuntimeSandbox;
  readonly #credential: AcpxProviderLifetimeLease | null;
  readonly #command: VerifiedAcpxCommandLease;
  readonly #toolBridge: RunnerToolBridge | null;
  #activeTurn: AcpxRuntimeTurn | null = null;
  #closingStarted = false;
  #closePromise: Promise<void> | null = null;
  #closed = false;

  private constructor(input: {
    runtime: AcpxRuntimePort;
    binding: AcpxRecoveryBinding;
    identity: AcpxIdentityRecord;
    sandbox: AcpxRuntimeSandbox;
    credential: AcpxProviderLifetimeLease | null;
    command: VerifiedAcpxCommandLease;
    toolBridge: RunnerToolBridge | null;
  }) {
    this.#runtime = input.runtime;
    this.#binding = input.binding;
    this.#identity = input.identity;
    this.#sandbox = input.sandbox;
    this.#credential = input.credential;
    this.#command = input.command;
    this.#toolBridge = input.toolBridge;
  }

  static async open(
    options: OpenAcpxRuntimeHostOptions,
    dependencies: AcpxRuntimeHostDependencies,
  ): Promise<AcpxRuntimeHost> {
    options.signal?.throwIfAborted();
    if (options.agent === "pi") {
      throw new Error(
        "ACPX pi is unavailable until its runtime has descriptor-confined verified launch",
      );
    }
    const profile = resolveQualifiedAcpxProfile(options.agent, options.model);
    const binding = await runAbortableAdmissionStage(
      options.signal,
      () =>
        createAcpxRecoveryBinding({
          runtimeDirectory: options.runtimeDirectory,
          normalizedSessionId: options.normalizedSessionId,
          workingDirectory: options.workingDirectory,
          profile,
          requestedModel: options.model,
          permissionMode: options.permissionMode,
        }),
      dependencies.retainAdmissionCleanup,
    );
    if (options.expectedIdentity) {
      verifyExpectedAcpxIdentity(options.expectedIdentity, binding, null);
    }
    options.assertWorkspaceHeld?.();
    if (
      options.agent !== "codex" &&
      options.managedCodexCredentialSourcePath !== undefined
    ) {
      throw new Error(
        "Managed Codex credentials require the Codex ACPX profile",
      );
    }

    const installation = await runAbortableAdmissionStage(
      options.signal,
      () =>
        (dependencies.verifyInstallation ?? verifyQualifiedAcpxInstallation)(
          profile,
        ),
      dependencies.retainAdmissionCleanup,
    );
    if (installation.commandDigest !== profile.commandDigest) {
      throw new Error("Verified ACPX installation does not match its profile");
    }
    let command: VerifiedAcpxCommandLease | null = null;
    let credential: AcpxProviderLifetimeLease | null = null;
    let toolBridge: RunnerToolBridge | null = null;
    let runtime: AcpxRuntimePort | null = null;
    let pendingRuntimeOwnsCredential = false;
    const admissionVerificationTimeoutMs =
      dependencies.admissionVerificationTimeoutMs ??
      RUNTIME_ADMISSION_VERIFICATION_TIMEOUT_MS;
    const admissionCleanupTimeoutMs =
      dependencies.admissionCleanupTimeoutMs ??
      RUNTIME_ADMISSION_VERIFICATION_TIMEOUT_MS;
    let failedAdmissionCleanupTransferred = false;
    let resolveFailedAdmissionCleanupTransfer!: () => void;
    const failedAdmissionCleanupTransfer = new Promise<void>((resolve) => {
      resolveFailedAdmissionCleanupTransfer = resolve;
    });
    const retainFailedAdmissionCleanup = (cleanup: Promise<void>): void => {
      if (failedAdmissionCleanupTransferred) return;
      failedAdmissionCleanupTransferred = true;
      pendingRuntimeOwnsCredential = credential !== null;
      resolveFailedAdmissionCleanupTransfer();
      if (credential === null) {
        retainRuntimeHostCleanup(cleanup);
        return;
      }
      const retained: RetainedRejectedRuntimeAdmission = {
        credential,
        cleanup: Promise.resolve(),
      };
      const ownedCleanup = cleanup.then(async () => {
        await cleanupAbortedRuntimeAdmission(
          null,
          retained.credential,
          "ACPX rejected runtime admission cleanup confirmed",
        );
        retainedRejectedRuntimeAdmissions.delete(retained);
      });
      retained.cleanup = ownedCleanup;
      retainedRejectedRuntimeAdmissions.add(retained);
      retainRuntimeHostCleanup(ownedCleanup);
    };
    try {
      const sandbox = await runAbortableAdmissionStage(
        options.signal,
        () =>
          (dependencies.prepareSandbox ?? prepareAcpxRuntimeSandbox)({
            binding,
            agent: options.agent,
            environment: options.environment,
          }),
        dependencies.retainAdmissionCleanup,
      );
      if (options.agent === "codex") {
        credential = await acquireAbortableAdmissionResource({
          signal: options.signal,
          acquire: () =>
            (dependencies.stageCredential ?? stageManagedCodexCredential)({
              agentHomeDirectory: sandbox.agentHomeDirectory,
              environment: options.environment,
              sourcePath: options.managedCodexCredentialSourcePath,
            }),
          resource: "credential",
          releaseLate: (lateCredential) => lateCredential.close(),
          reportFailure: (failure) =>
            dependencies.reportRetainedCleanupFailure(failure),
        });
      } else {
        credential = await acquireAbortableAdmissionResource({
          signal: options.signal,
          acquire: () =>
            acquireAcpxProviderLifetimeLease({
              agentHomeDirectory: sandbox.agentHomeDirectory,
            }),
          resource: "provider_lifetime",
          releaseLate: (lateLifetime) => lateLifetime.close(),
          reportFailure: (failure) =>
            dependencies.reportRetainedCleanupFailure(failure),
        });
      }
      command = await acquireAbortableAdmissionResource({
        signal: options.signal,
        acquire: () => installation.openCommand(),
        resource: "command",
        releaseLate: (lateCommand) => lateCommand.close(),
        reportFailure: (failure) =>
          dependencies.reportRetainedCleanupFailure(failure),
      });
      toolBridge = options.semanticTools
        ? await acquireAbortableAdmissionResource({
            signal: options.signal,
            acquire: () => startRunnerToolBridge(options.semanticTools!),
            resource: "tool_bridge",
            releaseLate: (lateToolBridge) => lateToolBridge.close(),
            reportFailure: (failure) =>
              dependencies.reportRetainedCleanupFailure(failure),
          })
        : null;
      const admittedLifetime = credential;
      if (admittedLifetime === null) {
        throw new Error("ACPX provider lifetime lease is unavailable");
      }
      runtime = await acquireAbortableAdmissionResource({
        signal: options.signal,
        acquire: () => {
          options.assertWorkspaceHeld?.();
          return dependencies.openRuntime({
            command: command!,
            profile,
            cwd: binding.workspacePath,
            stateDirectory: sandbox.stateDirectory,
            providerSessionKey: binding.profileSessionKey,
            permissionMode: binding.permissionMode,
            permissionPolicy: acpxRuntimePermissionPolicy(
              binding.permissionMode,
            ),
            launchEnvironment: sandbox.launchEnvironment,
            credentialFenceFds: admittedLifetime.lifetimeFenceFds,
            activateCredentialFenceOwner:
              admittedLifetime.activateLifetimeOwner.bind(admittedLifetime),
            systemInstructions: boundedInstructions(options.systemInstructions),
            ...(options.assertWorkspaceHeld === undefined
              ? {}
              : { assertWorkspaceHeld: options.assertWorkspaceHeld }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            mcpServers: toolBridge
              ? [
                  {
                    name: "paperclip",
                    url: toolBridge.url,
                    bearerToken: toolBridge.secret,
                    runnerOwned: true,
                  },
                ]
              : [],
            retainFailedAdmissionCleanup,
          });
        },
        resource: "runtime",
        releaseLate: (lateRuntime) =>
          lateRuntime.close({
            reason: "ACPX runtime admission aborted",
          }),
        reportFailure: (failure) =>
          dependencies.reportRetainedCleanupFailure(failure),
        onAbortedPending: (pendingRuntime) => {
          // A provider may already be running even though openRuntime has not
          // returned its port. Keep its credential lease with that exact
          // admission while the ordinary catch path revokes tools and releases
          // the consumed command snapshot without delaying cancellation.
          pendingRuntimeOwnsCredential = credential !== null;
          retainAbortedRuntimeAdmissionCleanup({
            pendingRuntime,
            credential,
            reason: "ACPX runtime admission aborted",
            failedAdmissionCleanupTransfer,
          });
        },
      });
      const runtimeIdentity = await runAbortableAdmissionStage(
        options.signal,
        () =>
          boundedRuntimeAdmissionVerification(
            runtime!,
            profile,
            admissionVerificationTimeoutMs,
          ),
        dependencies.retainAdmissionCleanup,
      );
      const observedIdentity: AcpxExpectedSessionIdentity = {
        kind: "acpx",
        normalizedSessionId: binding.normalizedSessionId,
        ...runtimeIdentity,
        profileDigest: binding.profileDigest,
        workspaceDigest: binding.workspaceDigest,
        requestedModel: binding.requestedModel,
        effectiveModel: binding.effectiveModel,
        permissionMode: binding.permissionMode,
      };
      const identity = createAcpxIdentityRecord(observedIdentity, binding);
      if (options.expectedIdentity) {
        verifyExpectedAcpxIdentity(options.expectedIdentity, binding, identity);
      }
      options.signal?.throwIfAborted();
      return new AcpxRuntimeHost({
        runtime,
        binding,
        identity,
        sandbox,
        credential,
        command,
        toolBridge,
      });
    } catch (error) {
      const cleanup = cleanupRuntimeResources(
        runtime,
        toolBridge,
        pendingRuntimeOwnsCredential ? null : credential,
        command,
        "ACPX runtime initialization failed",
      );
      retainRuntimeHostCleanup(cleanup);
      void cleanup.then((cleanupError) => {
        if (!cleanupError) return;
        retainFailedAcpxAdmissionCleanup({
          runtime,
          toolBridge,
          credential: pendingRuntimeOwnsCredential ? null : credential,
          command,
          reason: "ACPX runtime initialization failed",
        });
      });
      dependencies.retainAdmissionCleanup?.(
        cleanup.then((cleanupError) => {
          if (cleanupError) throw cleanupError;
        }),
      );
      const cleanupOutcome = await awaitRuntimeHostCleanupWithin(
        cleanup,
        admissionCleanupTimeoutMs,
      );
      if (cleanupOutcome === "deferred") {
        throw new AggregateError(
          [
            error,
            new Error(
              "ACPX runtime initialization cleanup exceeded its shutdown timeout",
            ),
          ],
          "ACPX runtime initialization and cleanup failed",
        );
      }
      if (cleanupOutcome) {
        throw new AggregateError(
          [error, ...cleanupOutcome.errors],
          "ACPX runtime initialization and cleanup failed",
        );
      }
      throw error;
    }
  }

  identity(): AcpxIdentityRecord {
    return structuredClone(this.#identity);
  }

  binding(): AcpxRecoveryBinding {
    return structuredClone(this.#binding);
  }

  runtimeRoot(): string {
    return this.#sandbox.root;
  }

  persistedEnvironment(): Readonly<NodeJS.ProcessEnv> {
    return Object.freeze({ ...this.#sandbox.persistedEnvironment });
  }

  async status(): Promise<AcpxModelStatus> {
    return structuredClone(await this.#runtime.getStatus());
  }

  startTurn(input: AcpxRuntimeTurnInput): AcpxRuntimeTurn {
    if (this.#closed || this.#closingStarted) {
      throw new Error("ACPX runtime host is closing");
    }
    if (this.#activeTurn) {
      throw new Error("ACPX runtime host already has an active turn");
    }
    const requestId = boundedRequestId(input.requestId);
    const text = boundedTurnText(input.text);
    const turn = this.#runtime.startTurn({
      text,
      requestId,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onElicitation ? { onElicitation: input.onElicitation } : {}),
    });
    this.#activeTurn = turn;
    void turn.result
      .finally(() => {
        // Once shutdown owns this turn, retain its cancellation handle until
        // runtime cleanup succeeds. The result may settle while cleanup is
        // failing, and a later close must still be able to retry cancellation.
        if (this.#activeTurn === turn && !this.#closingStarted) {
          this.#activeTurn = null;
        }
      })
      .catch(() => undefined);
    return turn;
  }

  async interruptActiveTurn(reason: string): Promise<void> {
    const turn = this.#activeTurn;
    if (!turn) throw new Error("ACPX runtime host has no active turn");
    const cancellationError = await boundedCancellation(
      turn.cancel({ reason: boundedReason(reason) }),
    );
    if (cancellationError) throw cancellationError;
  }

  async close(input: { reason: string }): Promise<void> {
    if (this.#closed) return;
    if (this.#closePromise) {
      return await this.#closePromise;
    }
    this.#closingStarted = true;
    const closePromise = this.#close(boundedReason(input.reason));
    this.#closePromise = closePromise;
    try {
      await closePromise;
      this.#closed = true;
    } finally {
      if (this.#closePromise === closePromise) this.#closePromise = null;
    }
  }

  async #close(reason: string): Promise<void> {
    const errors: unknown[] = [];
    const activeTurn = this.#activeTurn;
    if (activeTurn) {
      try {
        const cancellationError = await boundedCancellation(
          activeTurn.cancel({ reason }),
        );
        if (cancellationError !== null) errors.push(cancellationError);
      } catch (error) {
        errors.push(error);
      }
    }
    const cleanupError = await cleanupRuntimeResources(
      this.#runtime,
      this.#toolBridge,
      this.#credential,
      this.#command,
      reason,
    );
    if (cleanupError) errors.push(...cleanupError.errors);
    if (!cleanupError) {
      // Runtime, credential, and command ownership has been relinquished even
      // when the provider never acknowledged turn cancellation. Preserve that
      // cancellation error for this caller, but make later close calls
      // idempotently observe the successfully closed host.
      if (this.#activeTurn === activeTurn) this.#activeTurn = null;
      this.#closed = true;
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "ACPX runtime cleanup failed");
    }
  }
}

async function runAbortableAdmissionStage<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
  retainCleanup: ((cleanup: Promise<void>) => void) | undefined,
): Promise<T> {
  if (signal === undefined) return await operation();
  signal.throwIfAborted();
  const pending = Promise.resolve().then(operation);
  try {
    return await raceAdmissionWithAbort(pending, signal);
  } catch (error) {
    if (signal.aborted) {
      // Abort may win while sandbox preparation or another non-resource stage
      // still owns asynchronous work. Keep that exact operation observed and
      // expose it to the embedding lifecycle so filesystem teardown cannot
      // remove its session root while it is still making durable writes.
      // The aborted opening is already authoritative, and this stage owns no
      // provider resource. Its retained promise represents settlement only;
      // a late stage rejection must not masquerade as failed resource cleanup.
      const cleanup = pending.then(
        () => undefined,
        () => undefined,
      );
      retainRuntimeHostCleanup(cleanup);
      retainCleanup?.(cleanup);
    }
    throw error;
  }
}

async function acquireAbortableAdmissionResource<T>(input: {
  signal: AbortSignal | undefined;
  acquire: () => Promise<T>;
  resource: AcpxRetainedCleanupFailure["resource"];
  releaseLate: (resource: T) => Promise<void>;
  onAbortedPending?: (pending: Promise<T>) => void;
  reportFailure: (failure: AcpxRetainedCleanupFailure) => void;
}): Promise<T> {
  if (input.signal === undefined) return await input.acquire();
  input.signal.throwIfAborted();
  const pending = Promise.resolve().then(input.acquire);
  try {
    return await raceAdmissionWithAbort(pending, input.signal);
  } catch (error) {
    if (input.signal.aborted) {
      if (input.onAbortedPending) {
        input.onAbortedPending(pending);
      } else {
        retainRuntimeHostCleanup(
          pending.then((resource) =>
            releaseRetainedAdmissionResource({
              resource,
              resourceKind: input.resource,
              release: input.releaseLate,
              reportFailure: input.reportFailure,
            }),
          ),
        );
      }
    }
    throw error;
  }
}

function raceAdmissionWithAbort<T>(
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

function retainAbortedRuntimeAdmissionCleanup(input: {
  pendingRuntime: Promise<AcpxRuntimePort>;
  credential: AcpxProviderLifetimeLease | null;
  reason: string;
  failedAdmissionCleanupTransfer: Promise<void>;
}): void {
  const cleanup = input.pendingRuntime.then(
    (runtime) =>
      cleanupAbortedRuntimeAdmission(runtime, input.credential, input.reason),
    () => input.failedAdmissionCleanupTransfer,
  );
  retainRuntimeHostCleanup(cleanup);
}

async function cleanupAbortedRuntimeAdmission(
  runtime: AcpxRuntimePort | null,
  credential: AcpxProviderLifetimeLease | null,
  reason: string,
): Promise<void> {
  const cleanupError = await cleanupRuntimeResources(
    runtime,
    null,
    credential,
    null,
    reason,
  );
  if (!cleanupError) return;
  retainFailedAcpxAdmissionCleanup({
    runtime,
    toolBridge: null,
    credential,
    command: null,
    reason,
  });
}

function retainFailedAcpxAdmissionCleanup(input: {
  runtime: AcpxRuntimePort | null;
  toolBridge: RunnerToolBridge | null;
  credential: AcpxProviderLifetimeLease | null;
  command: VerifiedAcpxCommandLease | null;
  reason: string;
}): void {
  const cleanup: RetainedAcpxAdmissionCleanup = {
    ...input,
    recovery: null,
    timer: null,
  };
  retainedAcpxAdmissionCleanups.add(cleanup);
  startRetainedAcpxAdmissionCleanup(cleanup);
}

function startRetainedAcpxAdmissionCleanup(
  cleanup: RetainedAcpxAdmissionCleanup,
): Promise<void> {
  if (cleanup.recovery) return cleanup.recovery;
  const recovery = (async () => {
    let retryDelayMs = ACPX_ADMISSION_CLEANUP_RETRY_DELAY_MS;
    for (
      let attempt = 1;
      attempt <= ACPX_ADMISSION_CLEANUP_BATCH_ATTEMPTS;
      attempt += 1
    ) {
      const cleanupError = await cleanupRuntimeResources(
        cleanup.runtime,
        cleanup.toolBridge,
        cleanup.credential,
        cleanup.command,
        `${cleanup.reason} (automatic cleanup recovery ${attempt})`,
      );
      if (!cleanupError) {
        retainedAcpxAdmissionCleanups.delete(cleanup);
        if (cleanup.timer) clearTimeout(cleanup.timer);
        cleanup.timer = null;
        return;
      }
      if (attempt < ACPX_ADMISSION_CLEANUP_BATCH_ATTEMPTS) {
        await waitForAdmissionCleanupRetry(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
      }
    }
  })();
  cleanup.recovery = recovery;
  void recovery
    .finally(() => {
      if (cleanup.recovery === recovery) cleanup.recovery = null;
      scheduleRetainedAcpxAdmissionCleanup(cleanup);
    })
    .catch(() => undefined);
  return recovery;
}

function scheduleRetainedAcpxAdmissionCleanup(
  cleanup: RetainedAcpxAdmissionCleanup,
): void {
  if (
    !retainedAcpxAdmissionCleanups.has(cleanup) ||
    cleanup.recovery ||
    cleanup.timer
  ) {
    return;
  }
  cleanup.timer = setTimeout(() => {
    cleanup.timer = null;
    if (!retainedAcpxAdmissionCleanups.has(cleanup)) return;
    startRetainedAcpxAdmissionCleanup(cleanup);
  }, ACPX_ADMISSION_CLEANUP_RESCHEDULE_MS);
  cleanup.timer.unref?.();
}

async function waitForAdmissionCleanupRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function releaseRetainedAdmissionResource<T>(input: {
  resource: T;
  resourceKind: AcpxRetainedCleanupFailure["resource"];
  release: (resource: T) => Promise<void>;
  reportFailure: (failure: AcpxRetainedCleanupFailure) => void;
}): Promise<void> {
  let attempt = 0;
  let retryDelayMs = RETAINED_CLEANUP_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    attempt += 1;
    try {
      await input.release(input.resource);
      return;
    } catch (error) {
      try {
        input.reportFailure({
          resource: input.resourceKind,
          attempt,
          error,
        });
      } catch {
        // The required reporter is observational. A broken reporter must not
        // relinquish ownership of the resource that still needs cleanup.
      }
      await waitForRetainedCleanupRetry(retryDelayMs);
      retryDelayMs = Math.min(
        retryDelayMs * 2,
        RETAINED_CLEANUP_RETRY_MAX_DELAY_MS,
      );
    }
  }
}

async function waitForRetainedCleanupRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function retainRuntimeHostCleanup(cleanup: Promise<unknown>): void {
  activeRuntimeHostCleanupOwners.add(cleanup);
  void cleanup.then(
    () => activeRuntimeHostCleanupOwners.delete(cleanup),
    () => activeRuntimeHostCleanupOwners.delete(cleanup),
  );
}

async function awaitRuntimeHostCleanupWithin(
  cleanup: Promise<AggregateError | null>,
  timeoutMs: number,
): Promise<AggregateError | null | "deferred"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cleanup,
      new Promise<"deferred">((resolve) => {
        timer = setTimeout(
          () => resolve("deferred"),
          Math.max(1, Math.floor(timeoutMs)),
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedRuntimeAdmissionVerification(
  runtime: AcpxRuntimePort,
  profile: QualifiedAcpxProfile,
  timeoutMs: number,
): Promise<AcpxRuntimePortIdentity> {
  const verification = Promise.resolve().then(async () => {
    await requireVerifiedAcpxModel(runtime, profile);
    return await runtime.identity();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      verification,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpxRuntimeAdmissionTimeoutError()),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function boundedCancellation(
  cancellation: Promise<void>,
): Promise<unknown | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    cancellation.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    ),
    new Promise<{ error: unknown }>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            error: new Error(
              "ACPX turn cancellation exceeded its shutdown timeout",
            ),
          }),
        ACPX_TURN_CANCELLATION_SHUTDOWN_BOUND_MS,
      );
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome.error;
}

async function cleanupRuntimeResources(
  runtime: AcpxRuntimePort | null,
  toolBridge: RunnerToolBridge | null,
  credential: AcpxProviderLifetimeLease | null,
  command: VerifiedAcpxCommandLease | null,
  reason: string,
): Promise<AggregateError | null> {
  const settle = async (
    close: () => Promise<void>,
  ): Promise<unknown | null> => {
    try {
      await close();
      return null;
    } catch (error) {
      return error;
    }
  };
  // The command lease owns only the already-consumed verified launch
  // snapshot, so it can be released as shutdown starts. The credential is
  // different: a provider whose exact runtime close is pending or failed may
  // still read or rewrite its home. Retain both the staged bytes and the
  // exclusive home lease until that exact close succeeds.
  const runtimeOutcome = runtime
    ? settle(() => runtime.close({ reason }))
    : Promise.resolve(null);
  const toolBridgeOutcome = (async (): Promise<unknown | null> => {
    // Preserve the semantic-session cleanup order: the bridge is revoked once
    // the runtime close attempt settles, even when that attempt fails.
    await runtimeOutcome;
    return toolBridge === null ? null : await settle(() => toolBridge.close());
  })();
  const commandOutcome = command
    ? settle(() => command.close())
    : Promise.resolve(null);
  const credentialOutcome = (async (): Promise<unknown | null> => {
    const runtimeError = await runtimeOutcome;
    if (runtimeError !== null || credential === null) return null;
    return await settle(() => credential.close());
  })();
  const outcomes = await Promise.all([
    runtimeOutcome,
    toolBridgeOutcome,
    commandOutcome,
    credentialOutcome,
  ]);
  const errors = outcomes.filter((error): error is unknown => error !== null);
  return errors.length > 0
    ? new AggregateError(errors, "ACPX runtime cleanup failed")
    : null;
}

function boundedInstructions(value: string | undefined): string {
  const instructions = value ?? "";
  if (Buffer.byteLength(instructions) > 256 * 1024) {
    throw new Error("ACPX system instructions exceed their bounded size");
  }
  return instructions;
}

function boundedReason(value: string): string {
  const reason = value.trim().slice(0, 1_000);
  return reason || "ACPX runtime closed";
}

function boundedRequestId(value: string): string {
  const requestId = value.trim();
  if (
    requestId.length === 0 ||
    requestId !== value ||
    Buffer.byteLength(requestId) > 1_024
  ) {
    throw new Error("ACPX turn request id is outside its bounded size");
  }
  return requestId;
}

function boundedTurnText(value: string): string {
  if (Buffer.byteLength(value) > 1024 * 1024) {
    throw new Error("ACPX turn text exceeds its bounded size");
  }
  return value;
}
