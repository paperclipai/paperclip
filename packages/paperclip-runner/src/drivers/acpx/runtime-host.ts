import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "acpx/runtime";

import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import {
  startRunnerToolBridge,
  type RunnerToolBridge,
  type RunnerToolBridgeOptions,
} from "../runner-tool-bridge.js";
import {
  stageManagedCodexCredential,
  type ManagedCodexCredentialLease,
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

const TURN_CANCELLATION_TIMEOUT_MS = 2_000;

export interface AcpxRuntimePortIdentity {
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
}

export interface AcpxRuntimeTurnInput {
  text: string;
  requestId: string;
  signal?: AbortSignal;
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
  systemInstructions: string;
  /** Abort provider admission and clean any runtime that resolves too late. */
  signal?: AbortSignal;
  mcpServers: readonly AcpxMcpServerBinding[];
}

export interface AcpxRetainedCleanupFailure {
  resource: "credential" | "command" | "runtime" | "tool_bridge";
  attempt: number;
  error: unknown;
}

export interface AcpxMcpServerBinding {
  name: string;
  url: string;
  bearerToken: string;
  runnerOwned: boolean;
}

export type AcpxSemanticToolSession = Omit<RunnerToolBridgeOptions, "secret">;

export interface AcpxRuntimeHostDependencies {
  verifyInstallation?: (
    profile: QualifiedAcpxProfile,
  ) => Promise<VerifiedAcpxInstallation>;
  /** Internal test seam for aborting credential acquisition. */
  stageCredential?: typeof stageManagedCodexCredential;
  openRuntime(options: AcpxRuntimePortOpenOptions): Promise<AcpxRuntimePort>;
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
  /** Abort admission without admitting resources that resolve afterward. */
  signal?: AbortSignal;
  semanticTools?: AcpxSemanticToolSession;
}

const activeRuntimeHostCleanupOwners = new Set<Promise<unknown>>();
const RETAINED_CLEANUP_RETRY_INITIAL_DELAY_MS = 10;
const RETAINED_CLEANUP_RETRY_MAX_DELAY_MS = 1_000;

export class AcpxRuntimeHost {
  readonly #runtime: AcpxRuntimePort;
  readonly #binding: AcpxRecoveryBinding;
  readonly #identity: AcpxIdentityRecord;
  readonly #sandbox: AcpxRuntimeSandbox;
  readonly #credential: ManagedCodexCredentialLease | null;
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
    credential: ManagedCodexCredentialLease | null;
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
    const profile = resolveQualifiedAcpxProfile(options.agent, options.model);
    const binding = await runAbortableAdmissionStage(options.signal, () =>
      createAcpxRecoveryBinding({
        runtimeDirectory: options.runtimeDirectory,
        normalizedSessionId: options.normalizedSessionId,
        workingDirectory: options.workingDirectory,
        profile,
        requestedModel: options.model,
        permissionMode: options.permissionMode,
      }),
    );
    if (options.expectedIdentity) {
      verifyExpectedAcpxIdentity(options.expectedIdentity, binding, null);
    }
    if (
      options.agent !== "codex" &&
      options.managedCodexCredentialSourcePath !== undefined
    ) {
      throw new Error(
        "Managed Codex credentials require the Codex ACPX profile",
      );
    }

    const installation = await runAbortableAdmissionStage(options.signal, () =>
      (dependencies.verifyInstallation ?? verifyQualifiedAcpxInstallation)(
        profile,
      ),
    );
    if (installation.commandDigest !== profile.commandDigest) {
      throw new Error("Verified ACPX installation does not match its profile");
    }
    let command: VerifiedAcpxCommandLease | null = null;
    let credential: ManagedCodexCredentialLease | null = null;
    let toolBridge: RunnerToolBridge | null = null;
    let runtime: AcpxRuntimePort | null = null;
    try {
      const sandbox = await runAbortableAdmissionStage(options.signal, () =>
        prepareAcpxRuntimeSandbox({
          binding,
          agent: options.agent,
          environment: options.environment,
        }),
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
      runtime = await acquireAbortableAdmissionResource({
        signal: options.signal,
        acquire: () =>
          dependencies.openRuntime({
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
            systemInstructions: boundedInstructions(options.systemInstructions),
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
          }),
        resource: "runtime",
        releaseLate: (lateRuntime) =>
          lateRuntime.close({
            reason: "ACPX runtime admission aborted",
          }),
        reportFailure: (failure) =>
          dependencies.reportRetainedCleanupFailure(failure),
      });
      await runAbortableAdmissionStage(options.signal, () =>
        requireVerifiedAcpxModel(runtime!, profile),
      );
      const runtimeIdentity = await runAbortableAdmissionStage(
        options.signal,
        () => runtime!.identity(),
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
      const cleanupError = await cleanupRuntimeResources(
        runtime,
        toolBridge,
        credential,
        command,
        "ACPX runtime initialization failed",
      );
      if (cleanupError) {
        throw new AggregateError(
          [error, ...cleanupError.errors],
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

  async close(input: { reason: string }): Promise<void> {
    if (this.#closed) return;
    if (this.#closePromise) return await this.#closePromise;
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
    if (!cleanupError) {
      if (this.#activeTurn === activeTurn) this.#activeTurn = null;
      this.#closed = true;
    }
    if (cleanupError) errors.push(...cleanupError.errors);
    if (errors.length > 0) {
      throw new AggregateError(errors, "ACPX runtime cleanup failed");
    }
  }
}

async function runAbortableAdmissionStage<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal === undefined) return await operation();
  signal.throwIfAborted();
  const pending = Promise.resolve().then(operation);
  return await raceAdmissionWithAbort(pending, signal);
}

async function acquireAbortableAdmissionResource<T>(input: {
  signal: AbortSignal | undefined;
  acquire: () => Promise<T>;
  resource: AcpxRetainedCleanupFailure["resource"];
  releaseLate: (resource: T) => Promise<void>;
  reportFailure: (failure: AcpxRetainedCleanupFailure) => void;
}): Promise<T> {
  if (input.signal === undefined) return await input.acquire();
  input.signal.throwIfAborted();
  const pending = Promise.resolve().then(input.acquire);
  try {
    return await raceAdmissionWithAbort(pending, input.signal);
  } catch (error) {
    if (input.signal.aborted) {
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
  void cleanup
    .finally(() => activeRuntimeHostCleanupOwners.delete(cleanup))
    .catch(() => undefined);
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
        TURN_CANCELLATION_TIMEOUT_MS,
      );
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome.error;
}

async function cleanupRuntimeResources(
  runtime: AcpxRuntimePort | null,
  toolBridge: RunnerToolBridge | null,
  credential: ManagedCodexCredentialLease | null,
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
