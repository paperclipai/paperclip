import type { ChildProcess } from "node:child_process";

import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  encodeAcpxRuntimeHandleState,
  type AcpAgentRegistry,
  type AcpRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpSessionRecord,
  type AcpSessionStore,
} from "acpx/runtime";

import type {
  AcpxRuntimePort,
  AcpxRuntimePortIdentity,
  AcpxRuntimePortOpenOptions,
  AcpxRuntimeTurn,
} from "./runtime-host.js";
import {
  assertVerifiedAcpxProviderPlatform,
  awaitVerifiedAcpxProviderExit,
  awaitVerifiedAcpxProviderOwnership,
} from "./installation-integrity.js";
import type { AcpxModelStatus } from "./model-verification.js";
import { decideAcpxPermission } from "./permission-policy.js";

const VERIFIED_COMMAND_SENTINEL = "paperclip-verified-acpx-command";
const DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS = 2_000;
const MAX_ADMISSION_CLEANUP_RETRY_ATTEMPTS = 3;
const MAX_ADMISSION_CLEANUP_ATTEMPTS = 1 + MAX_ADMISSION_CLEANUP_RETRY_ATTEMPTS;
const RETAINED_ADMISSION_CLEANUP_RETRY_MIN_MS = 10;
const RETAINED_ADMISSION_CLEANUP_RETRY_MAX_MS = 100;
const PROVIDER_TERM_EXIT_TIMEOUT_MS = 2_000;
const PROVIDER_KILL_EXIT_TIMEOUT_MS = 2_000;
const PROVIDER_SHUTDOWN_SCHEDULING_MARGIN_MS = 1_000;
const MAX_LATE_RUNTIME_CLEANUP_RECONCILIATION_ATTEMPTS = 3;
// Production shutdown waits for the protocol close bound before beginning the
// sequential TERM/KILL verification windows plus a finite scheduling margin.
// Keep this exported package-local bound aligned with the complete
// implementation.
export const DEFAULT_CODEX_ACPX_RUNTIME_SHUTDOWN_BOUND_MS =
  DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS +
  PROVIDER_TERM_EXIT_TIMEOUT_MS +
  PROVIDER_KILL_EXIT_TIMEOUT_MS +
  PROVIDER_SHUTDOWN_SCHEDULING_MARGIN_MS;
// A close may outlive its caller-facing wait bound. Keep every exact attempt
// owned until it settles. A handle never starts a second protocol close while
// the first remains unresolved; late failure can start bounded reconciliation
// only after the exact attempt reaches a terminal outcome.
const activeRuntimeCleanupOwners = new Set<Promise<unknown>>();
const activeCodexRuntimeCleanupOwners = new Set<Promise<unknown>>();
// Provider initialization may include a cold native app-server start on a
// minimally provisioned runner. Keep admission finite while allowing the
// qualified runtime enough time to complete that local handshake.
const SESSION_HANDSHAKE_TIMEOUT_MS = 30_000;

class AcpxRuntimeCloseTimeoutError extends Error {
  constructor() {
    super("ACPX runtime close timed out");
    this.name = "AcpxRuntimeCloseTimeoutError";
  }
}

class AcpxRuntimeCloseFinalTimeoutError extends Error {
  constructor() {
    super("ACPX runtime close remained pending after its final cleanup watch");
    this.name = "AcpxRuntimeCloseFinalTimeoutError";
  }
}

class AcpxSessionHandshakeTimeoutError extends Error {
  readonly code = "ACPX_SESSION_HANDSHAKE_TIMEOUT";

  constructor() {
    super("ACPX session handshake exceeded its admission deadline");
    this.name = "AcpxSessionHandshakeTimeoutError";
  }
}

export interface QualifiedAcpxRuntimeDependencies {
  createRuntime?: (options: AcpRuntimeOptions) => AcpRuntime;
  createRegistry?: (input: {
    overrides: Record<string, string | string[]>;
  }) => AcpAgentRegistry;
  createStore?: (input: { stateDir: string }) => AcpSessionStore;
  runtimeCloseTimeoutMs?: number;
  /** Internal test seam for the provider-session admission deadline. */
  sessionHandshakeTimeoutMs?: number;
  /** Internal test seam for verified guardian ownership transfer. */
  awaitProviderOwnership?: (child: ChildProcess) => Promise<void>;
  /** Internal test seam for independent provider-exit proof. */
  awaitProviderExit?: (child: ChildProcess) => Promise<void>;
  /** Retains autonomous cleanup ownership across the sidecar lifecycle. */
  retainCleanup?: (cleanup: Promise<void>) => void;
  /** Internal test seam for the fail-closed platform admission boundary. */
  platform?: NodeJS.Platform;
}

/** @deprecated Use QualifiedAcpxRuntimeDependencies for provider-neutral ACPX runtimes. */
export type CodexAcpxRuntimeDependencies = QualifiedAcpxRuntimeDependencies;

/**
 * Adapt the pinned ACPX library to Paperclip's admitted runtime port. The
 * executable, launch environment, and spawn cwd stay host-owned and are never
 * persisted in ACPX's session options.
 */
export async function openQualifiedAcpxRuntime(
  options: AcpxRuntimePortOpenOptions,
  dependencies: QualifiedAcpxRuntimeDependencies = {},
): Promise<AcpxRuntimePort> {
  if (options.signal?.aborted) {
    // The host may have already transferred its staged credential to this
    // pending admission before this microtask begins. No adapter resources
    // exist yet, so publish an already-complete cleanup proof before preserving
    // the caller's exact abort reason.
    options.retainFailedAdmissionCleanup(Promise.resolve());
    throw options.signal.reason;
  }
  // Verified ACPX command admission already fails closed on Windows because
  // Node cannot atomically open the provider executable with O_NOFOLLOW there.
  // Reject at the adapter boundary too: allowing a fabricated command lease to
  // start a provider would create a cleanup state that cannot guarantee both a
  // bounded sidecar exit and retained ownership of an unresponsive process
  // tree when Node cannot safely signal a verified provider process group.
  assertVerifiedAcpxProviderPlatform(dependencies.platform ?? process.platform);
  options.signal?.throwIfAborted();
  const credentialFenceFds = options.credentialFenceFds;
  if (
    !Array.isArray(credentialFenceFds) ||
    credentialFenceFds.length !== 2 ||
    credentialFenceFds.some(
      (fd) => !Number.isSafeInteger(fd) || (fd as number) < 0,
    ) ||
    credentialFenceFds[0] === credentialFenceFds[1] ||
    typeof options.activateCredentialFenceOwner !== "function"
  ) {
    throw new Error(
      "The production ACPX runtime requires an inherited provider-lifetime fence",
    );
  }

  const createRegistry = dependencies.createRegistry ?? createAgentRegistry;
  const createStore = dependencies.createStore ?? createRuntimeStore;
  const createRuntime = dependencies.createRuntime ?? createAcpRuntime;
  const runtimeCloseTimeoutMs =
    dependencies.runtimeCloseTimeoutMs ?? DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS;
  const retainedCleanupOwners = new WeakSet<Promise<void>>();
  const retainCleanup = (cleanup: Promise<void>): void => {
    if (retainedCleanupOwners.has(cleanup)) {
      return;
    }
    retainedCleanupOwners.add(cleanup);
    dependencies.retainCleanup?.(cleanup);
    retainCodexRuntimeCleanup(cleanup);
  };
  const children = new SpawnedChildSet(
    retainCleanup,
    dependencies.awaitProviderOwnership,
    dependencies.awaitProviderExit,
  );
  const baseStore = createStore({ stateDir: options.stateDirectory });
  let failedHandshakeHandle: AcpRuntimeHandle | null = null;
  let admissionCleanup: RuntimeAdmissionCleanup | null = null;
  const rememberHandshakeHandle = (record: AcpSessionRecord): void => {
    const runtimeSessionName = record.name?.trim();
    if (
      typeof record.acpxRecordId !== "string" ||
      record.acpxRecordId.length === 0 ||
      !runtimeSessionName ||
      record.cwd !== options.cwd
    ) {
      return;
    }
    const rememberedHandle: AcpRuntimeHandle = {
      sessionKey: options.providerSessionKey,
      backend: "acpx",
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        name: runtimeSessionName,
        agent: options.profile.agent,
        cwd: record.cwd,
        mode: "persistent",
        acpxRecordId: record.acpxRecordId,
        backendSessionId: record.acpSessionId,
        agentSessionId: record.agentSessionId,
      }),
      cwd: record.cwd,
      acpxRecordId: record.acpxRecordId,
      backendSessionId: record.acpSessionId,
      ...(record.agentSessionId
        ? { agentSessionId: record.agentSessionId }
        : {}),
    };
    failedHandshakeHandle = rememberedHandle;
    if (options.signal?.aborted && admissionCleanup !== null) {
      retainCleanup(
        admissionCleanup.runRetained(
          rememberedHandle,
          "ACPX runtime admission aborted",
        ),
      );
    }
  };
  const sessionStore: AcpSessionStore = {
    async load(sessionId) {
      const record = await baseStore.load(sessionId);
      if (record !== undefined) rememberHandshakeHandle(record);
      return record;
    },
    async save(record) {
      // ACPX has already created this runtime-owned identity before it asks
      // the store to persist it. Capture cleanup authority first so a storage
      // rejection cannot orphan the live session created by the handshake.
      rememberHandshakeHandle(record);
      await baseStore.save(record);
    },
  };
  const runnerOwnedMcpServerNames = new Set(
    options.mcpServers
      .filter((server) => server.runnerOwned)
      .map((server) => server.name),
  );
  const runtime = createRuntime({
    cwd: options.cwd,
    sessionStore,
    agentRegistry: createRegistry({
      overrides: { [options.profile.agent]: [VERIFIED_COMMAND_SENTINEL] },
    }),
    permissionMode: options.permissionMode,
    elicitationModes: ["form"],
    nonInteractivePermissions: "fail",
    permissionPolicy: {
      ...options.permissionPolicy,
      autoApprove: options.permissionPolicy.autoApprove
        ? [...options.permissionPolicy.autoApprove]
        : undefined,
      escalate: options.permissionPolicy.escalate
        ? [...options.permissionPolicy.escalate]
        : undefined,
    },
    mcpServers: options.mcpServers.map((server) => ({
      type: "http" as const,
      name: server.name,
      url: server.url,
      headers: [
        { name: "Authorization", value: `Bearer ${server.bearerToken}` },
      ],
    })),
    onPermissionRequest: async (request) => {
      const disposition = decideAcpxPermission(
        options.profile.agent,
        options.permissionMode,
        request,
        {
          runnerOwnedMcpServerNames,
          allConfiguredMcpServersAreRunnerOwned:
            options.mcpServers.length > 0 &&
            options.mcpServers.every((server) => server.runnerOwned),
        },
      );
      return disposition === "delegate" ? undefined : { outcome: disposition };
    },
    spawnEnvironment: () => ({
      ...definedEnvironment(options.launchEnvironment),
      ...(options.profile.agent === "claude"
        ? { PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1" }
        : {}),
    }),
    spawnCwd: options.cwd,
    spawnAgent: (input) => {
      // ACPX can invoke this callback after its handshake caller has already
      // been cancelled. Check at the last host-owned boundary so a late
      // handshake cannot create a provider process after authority is gone.
      options.signal?.throwIfAborted();
      options.assertWorkspaceHeld?.();
      return children.add(
        options.command.spawn(input.args, input.options, {
          credentialFenceFds,
          activateCredentialFenceOwner: options.activateCredentialFenceOwner!,
        }) as ChildProcess,
      );
    },
  });
  admissionCleanup = new RuntimeAdmissionCleanup(
    runtime,
    children,
    runtimeCloseTimeoutMs,
  );

  const handshake = Promise.resolve()
    .then(() =>
      runtime.ensureSession({
        sessionKey: options.providerSessionKey,
        agent: options.profile.agent,
        mode: "persistent",
        cwd: options.cwd,
        sessionOptions: {
          // ACP session construction receives the provider-native selector.
          // The caller-facing canonical model was already pinned when the
          // qualified profile was resolved and is restored at the status
          // boundary after the provider reports this selector.
          model: options.profile.reportedModelId,
          ...(options.systemInstructions
            ? { systemPrompt: { append: options.systemInstructions } }
            : {}),
        },
      }),
    )
    .catch((error: unknown) => {
      throw classifySessionEnsureFailure(error);
    });
  let handle: AcpRuntimeHandle | null = null;
  let lateCleanup: Promise<void> | null = null;
  try {
    const boundedHandshake = boundedSessionHandshake(
      handshake,
      dependencies.sessionHandshakeTimeoutMs ?? SESSION_HANDSHAKE_TIMEOUT_MS,
    );
    handle = options.signal
      ? await raceRuntimeHandshakeWithAbort(boundedHandshake, options.signal)
      : await boundedHandshake;
    // A provider can answer only after the verified sentinel is armed, but do
    // not admit the session until the owner has observed that exact handoff.
    await children.verifyLifetimeOwnership();
    // The handshake or lifetime-ownership observation can settle in the same
    // turn as cancellation. Never admit that newly acquired authority.
    options.signal?.throwIfAborted();
  } catch (error) {
    const aborted = options.signal?.aborted === true;
    if (aborted || error instanceof AcpxSessionHandshakeTimeoutError) {
      lateCleanup = lateHandshakeCleanup(
        handshake,
        admissionCleanup,
        aborted
          ? "ACPX runtime admission aborted"
          : "ACPX session handshake completed after its admission deadline",
      );
      retainCleanup(lateCleanup);
    }
    const cleanupHandle = handle ?? failedHandshakeHandle;
    const cleanupReason = aborted
      ? "ACPX runtime admission aborted"
      : "ACPX session handshake failed";
    const cleanupErrors = await admissionCleanup.run(
      cleanupHandle,
      cleanupReason,
    );
    const retainedCleanup =
      cleanupErrors.length === 0
        ? Promise.resolve()
        : admissionCleanup.runRetained(cleanupHandle, cleanupReason);
    const cleanupProof =
      lateCleanup === null
        ? retainedCleanup
        : Promise.all([retainedCleanup, lateCleanup]).then(() => undefined);
    options.retainFailedAdmissionCleanup(cleanupProof);
    retainCleanup(cleanupProof);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "ACPX session handshake and runtime cleanup failed",
      );
    }
    throw error;
  }

  // Assigned by the successful handshake above. Keeping this assertion at the
  // boundary makes it impossible to construct a port from a cancelled or
  // otherwise absent ACPX session.
  if (handle === null)
    throw new Error("ACPX runtime omitted its session handle");
  try {
    return runtimePort(
      runtime,
      handle,
      requireIdentity(handle),
      baseStore,
      children,
      runtimeCloseTimeoutMs,
    );
  } catch (error) {
    const cleanupReason = "ACPX runtime identity validation failed";
    const cleanupErrors = await admissionCleanup.run(handle, cleanupReason);
    const cleanupProof =
      cleanupErrors.length === 0
        ? Promise.resolve()
        : admissionCleanup.runRetained(handle, cleanupReason);
    options.retainFailedAdmissionCleanup(cleanupProof);
    retainCleanup(cleanupProof);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "ACPX runtime identity validation and cleanup failed",
      );
    }
    throw error;
  }
}

/** Backward-compatible name retained for existing Codex-only consumers. */
export const openCodexAcpxRuntime = openQualifiedAcpxRuntime;

function classifySessionEnsureFailure(error: unknown): Error {
  if (error instanceof Error) {
    const details = error as Error & Record<string, unknown>;
    if (typeof details.code !== "string" || details.code.length === 0) {
      details.code =
        error instanceof TypeError
          ? "ACPX_SESSION_ENSURE_TYPE_ERROR"
          : "ACPX_SESSION_ENSURE_FAILED";
    }
    return error;
  }
  return Object.assign(new Error("ACPX session ensure rejected a non-error"), {
    code: "ACPX_SESSION_ENSURE_NON_ERROR",
  });
}

function raceRuntimeHandshakeWithAbort<T>(
  handshake: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
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
    void handshake.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function retainCodexRuntimeCleanup(cleanup: Promise<unknown>): void {
  activeCodexRuntimeCleanupOwners.add(cleanup);
  void cleanup
    .finally(() => activeCodexRuntimeCleanupOwners.delete(cleanup))
    .catch(() => undefined);
}

type RuntimeAdmissionCleanupTarget = {
  handle: AcpRuntimeHandle | null;
  reason: string;
  cleanup: Promise<void> | null;
};

class RuntimeAdmissionCleanup {
  readonly #closedHandles = new Set<string>();
  readonly #activeHandleAttempts = new Map<
    string,
    Promise<unknown | undefined>
  >();
  readonly #handleAttemptCounts = new Map<string, number>();
  readonly #registeredTargets = new Map<
    string,
    RuntimeAdmissionCleanupTarget
  >();
  readonly #targetAliases = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: AcpRuntime,
    private readonly children: SpawnedChildSet,
    private readonly runtimeCloseTimeoutMs: number,
  ) {}

  run(handle: AcpRuntimeHandle | null, reason: string): Promise<unknown[]> {
    const targetKey = this.#resolveTargetKey(
      runtimeAdmissionCleanupTargetKey(handle),
      handle,
    );
    return this.#runAttempt(targetKey, handle, reason).then(
      ({ errors }) => errors,
    );
  }

  runRetained(handle: AcpRuntimeHandle | null, reason: string): Promise<void> {
    const rawTargetKey = runtimeAdmissionCleanupTargetKey(handle);
    const targetKey = this.#resolveTargetKey(rawTargetKey, handle);
    const existing = this.#registeredTargets.get(targetKey);
    if (existing !== undefined) {
      if (existing.handle === null) existing.handle = handle;
      else if (handle !== null) {
        existing.handle = preferRuntimeAdmissionCleanupHandle(
          existing.handle,
          handle,
        );
      }
      this.#targetAliases.set(rawTargetKey, targetKey);
      return existing.cleanup!;
    }
    const target: RuntimeAdmissionCleanupTarget = {
      handle,
      reason,
      cleanup: null,
    };
    this.#registeredTargets.set(targetKey, target);
    this.#targetAliases.set(rawTargetKey, targetKey);
    const cleanup = this.#retryRetained(targetKey, target);
    target.cleanup = cleanup;
    return cleanup;
  }

  #resolveTargetKey(
    rawTargetKey: string,
    handle: AcpRuntimeHandle | null,
  ): string {
    const aliasedTargetKey = this.#targetAliases.get(rawTargetKey);
    if (aliasedTargetKey !== undefined) return aliasedTargetKey;
    if (handle === null) return rawTargetKey;
    const recordId = nonEmptyRuntimeIdentity(handle.acpxRecordId);
    const sessionTargetKey = runtimeAdmissionCleanupSessionTargetKey(handle);
    if (recordId !== undefined) {
      const fallbackTargetKey =
        this.#targetAliases.get(sessionTargetKey) ?? sessionTargetKey;
      const fallbackHandle =
        this.#registeredTargets.get(fallbackTargetKey)?.handle;
      if (
        fallbackHandle != null &&
        nonEmptyRuntimeIdentity(fallbackHandle.acpxRecordId) === undefined &&
        sameRuntimeAdmissionCleanupOwner(fallbackHandle, handle)
      ) {
        this.#targetAliases.set(rawTargetKey, fallbackTargetKey);
        return fallbackTargetKey;
      }
      return rawTargetKey;
    }
    const compatibleRecordTargets = [
      ...this.#registeredTargets.entries(),
    ].filter(
      ([, target]) =>
        target.handle !== null &&
        nonEmptyRuntimeIdentity(target.handle.acpxRecordId) !== undefined &&
        sameRuntimeAdmissionCleanupOwner(target.handle, handle),
    );
    return compatibleRecordTargets.length === 1
      ? compatibleRecordTargets[0]![0]
      : rawTargetKey;
  }

  async #retryRetained(
    targetKey: string,
    target: RuntimeAdmissionCleanupTarget,
  ): Promise<void> {
    let runtimeTerminalError: unknown | null = null;
    let processErrors: unknown[] = [];
    let retryDelayMs = RETAINED_ADMISSION_CLEANUP_RETRY_MIN_MS;
    for (;;) {
      const attempt = await this.#runAttempt(
        targetKey,
        runtimeTerminalError === null ? target.handle : null,
        target.reason,
      );
      let runtimeError = attempt.runtimeError;
      processErrors = attempt.processErrors;
      if (attempt.pendingRuntimeClose !== undefined) {
        // The configured timeout bounds the caller-facing pass, not the exact
        // close promise. Give that exact promise one final bounded watch. A
        // late rejection can then admit the next actual close attempt, while
        // a second timeout terminalizes protocol cleanup without overlap.
        const lateOutcome = await closeOutcomeWithin(
          attempt.pendingRuntimeClose,
          this.runtimeCloseTimeoutMs,
        );
        if (lateOutcome instanceof AcpxRuntimeCloseTimeoutError) {
          runtimeTerminalError = new AcpxRuntimeCloseFinalTimeoutError();
          runtimeError = runtimeTerminalError;
        } else {
          runtimeError = lateOutcome;
        }
      }
      if (
        runtimeTerminalError === null &&
        runtimeError !== undefined &&
        (this.#handleAttemptCounts.get(targetKey) ?? 0) >=
          MAX_ADMISSION_CLEANUP_ATTEMPTS
      ) {
        runtimeTerminalError = new AggregateError(
          [runtimeError],
          `ACPX failed-admission cleanup exhausted ${MAX_ADMISSION_CLEANUP_RETRY_ATTEMPTS} retry attempts`,
        );
      }
      const runtimeNeedsRetry =
        runtimeTerminalError === null &&
        runtimeError !== undefined &&
        !this.#closedHandles.has(targetKey);
      const processNeedsRetry = processErrors.length > 0;
      if (!runtimeNeedsRetry && !processNeedsRetry) {
        if (runtimeTerminalError === null) return;
        throw runtimeTerminalError;
      }
      // Runtime close retries are bounded above, but a live provider cannot
      // be abandoned merely because its first termination passes failed.
      // Keep this retained owner active with bounded backoff until process
      // exit is observed. Once the process is gone, any terminal protocol
      // cleanup error is still reported to the owner below.
      await delay(retryDelayMs);
      retryDelayMs = Math.min(
        retryDelayMs * 2,
        RETAINED_ADMISSION_CLEANUP_RETRY_MAX_MS,
      );
    }
  }

  #runAttempt(
    targetKey: string,
    handle: AcpRuntimeHandle | null,
    reason: string,
  ): Promise<{
    errors: unknown[];
    runtimeError: unknown | undefined;
    processErrors: unknown[];
    pendingRuntimeClose?: Promise<unknown | undefined>;
  }> {
    const cleanup = this.#tail.then(async () => {
      const errors: unknown[] = [];
      let runtimeError: unknown | undefined;
      let pendingRuntimeClose: Promise<unknown | undefined> | undefined;
      if (handle !== null && !this.#closedHandles.has(targetKey)) {
        const runtimeOutcome = await this.#closeHandleWithin(
          targetKey,
          handle,
          reason,
        );
        runtimeError = runtimeOutcome.error;
        if (runtimeError !== undefined) errors.push(runtimeError);
        pendingRuntimeClose = runtimeOutcome.pendingAttempt;
      }
      const processErrors = await this.children.terminate();
      errors.push(...processErrors);
      return {
        errors,
        runtimeError,
        processErrors,
        ...(pendingRuntimeClose === undefined ? {} : { pendingRuntimeClose }),
      };
    });
    this.#tail = cleanup.then(
      () => undefined,
      () => undefined,
    );
    return cleanup;
  }

  async #closeHandleWithin(
    targetKey: string,
    handle: AcpRuntimeHandle,
    reason: string,
  ): Promise<{
    error: unknown | undefined;
    pendingAttempt?: Promise<unknown | undefined>;
  }> {
    let attempt = this.#activeHandleAttempts.get(targetKey);
    if (attempt === undefined) {
      const attemptCount = this.#handleAttemptCounts.get(targetKey) ?? 0;
      if (attemptCount >= MAX_ADMISSION_CLEANUP_ATTEMPTS) {
        return {
          error: new Error(
            `ACPX failed-admission cleanup exhausted ${MAX_ADMISSION_CLEANUP_RETRY_ATTEMPTS} retry attempts`,
          ),
        };
      }
      this.#handleAttemptCounts.set(targetKey, attemptCount + 1);
      attempt = runtimeCloseOutcome(this.runtime, {
        handle,
        reason,
        discardPersistentState: false,
      });
      this.#activeHandleAttempts.set(targetKey, attempt);
      void attempt.then((error) => {
        if (this.#activeHandleAttempts.get(targetKey) === attempt) {
          this.#activeHandleAttempts.delete(targetKey);
        }
        if (error === undefined) this.#closedHandles.add(targetKey);
      });
    }
    const error = await closeOutcomeWithin(attempt, this.runtimeCloseTimeoutMs);
    return error instanceof AcpxRuntimeCloseTimeoutError
      ? { error, pendingAttempt: attempt }
      : { error };
  }
}

function runtimeAdmissionCleanupTargetKey(
  handle: AcpRuntimeHandle | null,
): string {
  if (handle === null) return JSON.stringify(["children"]);
  const recordId = nonEmptyRuntimeIdentity(handle.acpxRecordId);
  return recordId === undefined
    ? runtimeAdmissionCleanupSessionTargetKey(handle)
    : JSON.stringify(["record", recordId]);
}

function runtimeAdmissionCleanupSessionTargetKey(
  handle: AcpRuntimeHandle,
): string {
  return JSON.stringify(["session", handle.sessionKey]);
}

function preferRuntimeAdmissionCleanupHandle(
  current: AcpRuntimeHandle,
  incoming: AcpRuntimeHandle,
): AcpRuntimeHandle {
  const currentRecordId = nonEmptyRuntimeIdentity(current.acpxRecordId);
  const incomingRecordId = nonEmptyRuntimeIdentity(incoming.acpxRecordId);
  if (
    !sameRuntimeAdmissionCleanupOwner(current, incoming) ||
    (currentRecordId !== undefined && incomingRecordId !== currentRecordId)
  ) {
    return current;
  }
  const currentAgentSessionId = nonEmptyRuntimeIdentity(current.agentSessionId);
  const incomingAgentSessionId = nonEmptyRuntimeIdentity(
    incoming.agentSessionId,
  );
  if (
    currentAgentSessionId !== undefined &&
    incomingAgentSessionId !== undefined &&
    incomingAgentSessionId !== currentAgentSessionId
  ) {
    return current;
  }
  const backendSessionId =
    nonEmptyRuntimeIdentity(incoming.backendSessionId) ??
    nonEmptyRuntimeIdentity(current.backendSessionId);
  const agentSessionId = incomingAgentSessionId ?? currentAgentSessionId;
  return {
    ...current,
    ...incoming,
    ...((incomingRecordId ?? currentRecordId) === undefined
      ? {}
      : { acpxRecordId: incomingRecordId ?? currentRecordId }),
    ...(backendSessionId === undefined ? {} : { backendSessionId }),
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
  };
}

function sameRuntimeAdmissionCleanupOwner(
  current: AcpRuntimeHandle,
  incoming: AcpRuntimeHandle,
): boolean {
  return (
    current.sessionKey === incoming.sessionKey &&
    current.backend === incoming.backend &&
    current.cwd === incoming.cwd
  );
}

function nonEmptyRuntimeIdentity(
  value: string | undefined,
): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function boundedSessionHandshake(
  handshake: Promise<AcpRuntimeHandle>,
  timeoutMs: number,
): Promise<AcpRuntimeHandle> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handshake,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpxSessionHandshakeTimeoutError()),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lateHandshakeCleanup(
  handshake: Promise<AcpRuntimeHandle>,
  cleanup: RuntimeAdmissionCleanup,
  reason: string,
): Promise<void> {
  return handshake.then(
    (lateHandle) => cleanup.runRetained(lateHandle, reason),
    () => undefined,
  );
}

function runtimePort(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  identity: AcpxRuntimePortIdentity,
  sessionStore: AcpSessionStore,
  children: SpawnedChildSet,
  runtimeCloseTimeoutMs: number,
): AcpxRuntimePort {
  type RuntimeCloseAttempt = {
    readonly outcome: Promise<unknown | null>;
    readonly reconciliationGeneration: number;
    readonly origin:
      | { readonly kind: "external" }
      | {
          readonly kind: "reconciliation";
          readonly generation: number;
          readonly attemptNumber: number;
        };
    pendingExternalIntent: boolean;
  };
  let runtimeClosed = false;
  let runtimeCloseAttempt: RuntimeCloseAttempt | undefined;
  let lateReconciliationOwner: Promise<void> | undefined;
  // Each independently observed late failure receives a bounded reconciliation
  // budget. Exhausting retries for an older generation must not prevent a newer
  // late failure from acquiring its own recovery owner.
  let lateReconciliationAttemptGeneration = 0;
  let lateReconciliationAttempts = 0;
  let lateFailureGeneration = 0;
  let reconciledLateFailureGeneration = 0;
  const watchedReleasedAttempts = new Set<RuntimeCloseAttempt>();

  const hasUnreconciledLateFailure = (): boolean =>
    reconciledLateFailureGeneration < lateFailureGeneration;

  const consumePendingExternalIntent = (
    attempt: RuntimeCloseAttempt,
    failed: boolean,
  ): boolean => {
    const pending = attempt.pendingExternalIntent;
    attempt.pendingExternalIntent = false;
    return (
      pending &&
      failed &&
      attempt.origin.kind === "reconciliation" &&
      attempt.origin.attemptNumber >=
        MAX_LATE_RUNTIME_CLEANUP_RECONCILIATION_ATTEMPTS
    );
  };

  const scheduleLateFailureReconciliation = (): void => {
    if (
      runtimeCloseAttempt ||
      lateReconciliationOwner ||
      !hasUnreconciledLateFailure()
    ) {
      return;
    }
    if (lateReconciliationAttemptGeneration !== lateFailureGeneration) {
      lateReconciliationAttemptGeneration = lateFailureGeneration;
      lateReconciliationAttempts = 0;
    }
    if (
      lateReconciliationAttempts >=
      MAX_LATE_RUNTIME_CLEANUP_RECONCILIATION_ATTEMPTS
    ) {
      return;
    }
    const attemptGeneration = lateFailureGeneration;
    const attemptNumber = lateReconciliationAttempts + 1;
    lateReconciliationAttempts = attemptNumber;
    let retry = false;
    const reconciliation = closeRuntime({
      reason: `ACPX late protocol cleanup reconciliation ${attemptNumber}`,
      reconciliation: {
        generation: attemptGeneration,
        attemptNumber,
      },
    }).then(
      () => {
        if (hasUnreconciledLateFailure()) {
          retry =
            lateFailureGeneration === attemptGeneration &&
            attemptNumber < MAX_LATE_RUNTIME_CLEANUP_RECONCILIATION_ATTEMPTS;
        }
      },
      () => {
        retry =
          lateFailureGeneration === attemptGeneration &&
          attemptNumber < MAX_LATE_RUNTIME_CLEANUP_RECONCILIATION_ATTEMPTS;
      },
    );
    const owner = reconciliation.finally(() => {
      if (lateReconciliationOwner === owner)
        lateReconciliationOwner = undefined;
      if (retry || hasUnreconciledLateFailure()) {
        queueMicrotask(scheduleLateFailureReconciliation);
      }
    });
    lateReconciliationOwner = owner;
    retainRuntimeCleanupOwner(owner);
  };

  const watchPendingAttempt = (
    attempt: RuntimeCloseAttempt,
    processCleanupSucceeded: boolean,
  ): void => {
    if (watchedReleasedAttempts.has(attempt)) return;
    watchedReleasedAttempts.add(attempt);
    void attempt.outcome.then((error) => {
      watchedReleasedAttempts.delete(attempt);
      if (runtimeCloseAttempt === attempt) runtimeCloseAttempt = undefined;
      const renewForExternalIntent = consumePendingExternalIntent(
        attempt,
        error !== null || !processCleanupSucceeded,
      );
      if (renewForExternalIntent) lateFailureGeneration += 1;
      if (error === null) {
        if (processCleanupSucceeded) {
          reconciledLateFailureGeneration = Math.max(
            reconciledLateFailureGeneration,
            attempt.reconciliationGeneration,
          );
          runtimeClosed = !hasUnreconciledLateFailure();
        }
        scheduleLateFailureReconciliation();
        return;
      }
      // A newer successful close cannot erase an older outcome that had not
      // settled yet. Re-open cleanup state and autonomously create a bounded
      // reconciliation generation so the late failure is not suppression-only.
      // An autonomous failure remains charged to the budget of the generation
      // that created it. If external callers coalesced onto the exhausted final
      // attempt, their single batched intent creates exactly one new generation;
      // joins on earlier attempts are satisfied by the remaining same-generation
      // retries.
      if (attempt.origin.kind === "external") {
        lateFailureGeneration += 1;
      }
      runtimeClosed = false;
      scheduleLateFailureReconciliation();
    });
  };

  async function closeRuntime(input: {
    reason: string;
    reconciliation?: {
      generation: number;
      attemptNumber: number;
    };
  }): Promise<void> {
    if (runtimeClosed) return;
    if (
      runtimeCloseAttempt?.origin.kind === "reconciliation" &&
      input.reconciliation === undefined
    ) {
      // Preserve the attempt's autonomous origin while remembering that one or
      // more external callers requested a fresh cleanup observation. The exact
      // outcome consumes this bit, so coalesced callers cannot mint generations
      // independently.
      runtimeCloseAttempt.pendingExternalIntent = true;
    }
    if (!runtimeCloseAttempt) {
      // A close can reconcile only failures already known when its protocol
      // attempt begins. A released older attempt may reject while this one is
      // in flight; that later generation must trigger a subsequent close.
      runtimeCloseAttempt = {
        outcome: ownedRuntimeCloseOutcome(runtime, handle, input.reason),
        reconciliationGeneration:
          input.reconciliation?.generation ?? lateFailureGeneration,
        origin:
          input.reconciliation === undefined
            ? { kind: "external" }
            : {
                kind: "reconciliation",
                generation: input.reconciliation.generation,
                attemptNumber: input.reconciliation.attemptNumber,
              },
        pendingExternalIntent: false,
      };
    }
    const observedAttempt = runtimeCloseAttempt;
    const processCleanup = terminateChildrenAfterCloseBound(
      observedAttempt.outcome,
      children,
      runtimeCloseTimeoutMs,
    );
    // The caller may stop waiting, but the exact ACPX protocol cleanup stays
    // owned and remains this handle's sole close attempt until it settles.
    // Provider termination still proceeds at the deadline.
    const [closeError, processErrors] = await Promise.all([
      boundedCloseOutcome(observedAttempt.outcome, runtimeCloseTimeoutMs),
      processCleanup,
    ]);
    if (closeError instanceof AcpxRuntimeCloseTimeoutError) {
      watchPendingAttempt(observedAttempt, processErrors.length === 0);
    } else {
      if (
        consumePendingExternalIntent(
          observedAttempt,
          closeError !== null || processErrors.length > 0,
        )
      ) {
        lateFailureGeneration += 1;
      }
      if (runtimeCloseAttempt === observedAttempt) {
        runtimeCloseAttempt = undefined;
      }
    }
    if (processErrors.length === 0 && closeError === null) {
      reconciledLateFailureGeneration = Math.max(
        reconciledLateFailureGeneration,
        observedAttempt.reconciliationGeneration,
      );
      runtimeClosed = !hasUnreconciledLateFailure();
    } else {
      runtimeClosed = false;
    }
    scheduleLateFailureReconciliation();
    if (closeError !== null || processErrors.length > 0) {
      const errors = [closeError, ...processErrors].filter(
        (error): error is unknown => error !== null,
      );
      throw new AggregateError(
        errors,
        "ACPX runtime and provider cleanup failed",
      );
    }
  }

  const port: AcpxRuntimePort = {
    async identity() {
      return structuredClone(identity);
    },
    async getStatus() {
      return await persistedRuntimeStatus(sessionStore, handle, identity);
    },
    ...(runtime.setConfigOption
      ? {
          async setModel(model: string) {
            await runtime.setConfigOption?.({
              handle,
              key: "model",
              value: model,
            });
          },
        }
      : {}),
    startTurn(input) {
      const finishOwnershipAdmission =
        children.beginLifetimeOwnershipAdmission();
      let turn: AcpxRuntimeTurn;
      try {
        turn = runtime.startTurn({
          handle,
          text: input.text,
          mode: "prompt",
          requestId: input.requestId,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onElicitation
            ? { onElicitation: input.onElicitation }
            : {}),
        });
      } catch (error) {
        void finishOwnershipAdmission().catch(() => undefined);
        throw error;
      }
      return turnWithVerifiedLifetimeOwnership(turn, finishOwnershipAdmission);
    },
    close: closeRuntime,
  };
  return port;
}

function turnWithVerifiedLifetimeOwnership(
  turn: AcpxRuntimeTurn,
  finishOwnershipAdmission: () => Promise<void>,
): AcpxRuntimeTurn {
  // A persisted ACPX session can be loaded without starting an agent process.
  // Keep the narrowly scoped turn admission open until either the provider has
  // accepted the prompt or the turn has already terminalized. The synchronous
  // stable-empty seal in SpawnedChildSet then rejects every later spawn.
  const reachedAdmissionBoundary = Promise.race([
    turn.promptStarted.then(
      () => undefined,
      () => undefined,
    ),
    turn.result.then(
      () => undefined,
      () => undefined,
    ),
  ]);
  const ownershipVerified = reachedAdmissionBoundary.then(() =>
    finishOwnershipAdmission(),
  );
  void ownershipVerified.catch(() => undefined);
  return {
    requestId: turn.requestId,
    promptStarted: ownershipVerified.then(() => turn.promptStarted),
    events: eventsAfterLifetimeOwnership(turn.events, ownershipVerified),
    result: ownershipVerified.then(() => turn.result),
    cancel: (input) => turn.cancel(input),
    closeStream: (input) => turn.closeStream(input),
  };
}

async function* eventsAfterLifetimeOwnership<T>(
  events: AsyncIterable<T>,
  ownershipVerified: Promise<void>,
): AsyncIterable<T> {
  await ownershipVerified;
  yield* events;
}

async function persistedRuntimeStatus(
  sessionStore: AcpSessionStore,
  handle: AcpRuntimeHandle,
  identity: AcpxRuntimePortIdentity,
): Promise<AcpxModelStatus> {
  const recordId = handle.acpxRecordId ?? handle.sessionKey;
  const record = await sessionStore.load(recordId);
  if (!record) {
    throw Object.assign(
      new Error("The pinned ACPX runtime omitted its persisted session record"),
      { code: "ACPX_PERSISTED_SESSION_MISSING" },
    );
  }
  const persistedAgentSessionId =
    nonEmptyRuntimeIdentity(record.agentSessionId) ?? record.acpSessionId;
  if (
    record.acpxRecordId !== identity.acpxRecordId ||
    record.acpSessionId !== identity.backendSessionId ||
    persistedAgentSessionId !== identity.agentSessionId
  ) {
    throw Object.assign(
      new Error("The persisted ACPX session identity changed after admission"),
      { code: "ACPX_PERSISTED_SESSION_IDENTITY_MISMATCH" },
    );
  }
  const currentModelId = record.acpx?.current_model_id;
  const availableModelIds = record.acpx?.available_models;
  return {
    summary: [
      `session=${record.acpxRecordId}`,
      `backendSessionId=${record.acpSessionId}`,
      `agentSessionId=${persistedAgentSessionId}`,
      record.closed === true ? "closed" : "open",
    ].join(" "),
    acpxRecordId: record.acpxRecordId,
    backendSessionId: record.acpSessionId,
    agentSessionId: persistedAgentSessionId,
    ...(currentModelId === undefined && !availableModelIds?.length
      ? {}
      : {
          models: {
            ...(currentModelId === undefined ? {} : { currentModelId }),
            availableModelIds: availableModelIds ? [...availableModelIds] : [],
          },
        }),
  };
}

function runtimeCloseOutcome(
  runtime: AcpRuntime,
  input: Parameters<AcpRuntime["close"]>[0],
): Promise<unknown | undefined> {
  return Promise.resolve()
    .then(() => runtime.close(input))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
}

async function closeOutcomeWithin(
  closeOutcome: Promise<unknown | undefined>,
  timeoutMs: number,
): Promise<unknown | undefined> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutOutcome = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () => resolve(new AcpxRuntimeCloseTimeoutError()),
      boundedTimeoutMs,
    );
  });
  const outcome = await Promise.race([closeOutcome, timeoutOutcome]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

function ownedRuntimeCloseOutcome(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  reason: string,
): Promise<unknown | null> {
  const cleanup = Promise.resolve()
    .then(() =>
      runtime.close({ handle, reason, discardPersistentState: false }),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  return retainRuntimeCleanupOwner(cleanup);
}

function retainRuntimeCleanupOwner<T>(cleanup: Promise<T>): Promise<T> {
  activeRuntimeCleanupOwners.add(cleanup);
  void cleanup
    .finally(() => activeRuntimeCleanupOwners.delete(cleanup))
    .catch(() => undefined);
  return cleanup;
}

async function terminateChildrenAfterCloseBound(
  closeOutcome: Promise<unknown | null>,
  children: SpawnedChildSet,
  timeoutMs: number,
): Promise<unknown[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closeOutcome.then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(1, Math.floor(timeoutMs)));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return await children.terminate();
}

async function boundedCloseOutcome(
  closeOutcome: Promise<unknown | null>,
  timeoutMs: number,
): Promise<unknown | null> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    closeOutcome.then((error) => ({ error })),
    new Promise<{ error: unknown }>((resolve) => {
      timer = setTimeout(
        () => resolve({ error: new AcpxRuntimeCloseTimeoutError() }),
        boundedTimeoutMs,
      );
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome.error;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

type ProviderExitOutcome = { exited: true } | { exited: false; error: unknown };

class ProviderExitObservation {
  #outcome: ProviderExitOutcome | null = null;
  readonly #observers = new Set<(outcome: ProviderExitOutcome) => void>();

  constructor(providerExit: Promise<void>) {
    void providerExit.then(
      () => this.#settle({ exited: true }),
      (error: unknown) => this.#settle({ exited: false, error }),
    );
  }

  observe(observer: (outcome: ProviderExitOutcome) => void): void {
    if (this.#outcome) observer(this.#outcome);
    else this.#observers.add(observer);
  }

  async waitWithin(
    timeoutMs: number,
  ): Promise<{ exited: boolean; error?: unknown }> {
    if (this.#outcome) return this.#outcome;
    return await new Promise((resolve) => {
      const finish = (outcome: ProviderExitOutcome | { exited: false }) => {
        clearTimeout(timer);
        this.#observers.delete(finish);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ exited: false }), timeoutMs);
      timer.unref();
      this.#observers.add(finish);
      if (this.#outcome) finish(this.#outcome);
    });
  }

  #settle(outcome: ProviderExitOutcome): void {
    if (this.#outcome) return;
    this.#outcome = outcome;
    for (const observer of this.#observers) observer(outcome);
    this.#observers.clear();
  }
}

class SpawnedChildSet {
  readonly #children = new Set<ChildProcess>();
  readonly #errors = new Set<unknown>();
  readonly #providerExits = new Map<ChildProcess, ProviderExitObservation>();
  readonly #terminations = new Map<ChildProcess, Promise<unknown[]>>();
  readonly #lifetimeOwnership: Promise<void>[] = [];
  #lifetimeOwnershipSealed = false;
  #sealed = false;

  constructor(
    private readonly retainCleanup?: (cleanup: Promise<void>) => void,
    private readonly awaitProviderOwnership: (
      child: ChildProcess,
    ) => Promise<void> = awaitVerifiedAcpxProviderOwnership,
    private readonly awaitProviderExit: (
      child: ChildProcess,
    ) => Promise<void> = awaitVerifiedAcpxProviderExit,
  ) {}

  add(child: ChildProcess): ChildProcess {
    let exitProof: Promise<void>;
    try {
      exitProof = this.awaitProviderExit(child);
    } catch (error) {
      exitProof = Promise.reject(error);
    }
    const providerExit = new ProviderExitObservation(exitProof);
    this.#providerExits.set(child, providerExit);
    this.#track(child, providerExit);
    const ownership = this.awaitProviderOwnership(child);
    void ownership.catch(() => undefined);
    this.#lifetimeOwnership.push(ownership);
    if (this.#sealed || this.#lifetimeOwnershipSealed) {
      // Once the stable-empty cleanup point is sealed, ACPX no longer has
      // authority to create provider work. Retain an immediate-kill attempt
      // through exit verification before rejecting the spawn itself.
      const termination = this.#startTermination(child, true);
      const cleanup = termination.then((errors) => {
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            "ACPX post-seal provider cleanup failed",
          );
        }
      });
      this.retainCleanup?.(cleanup);
      void cleanup.catch(() => undefined);
      throw new Error(
        this.#sealed
          ? "ACPX provider spawned after cleanup was sealed"
          : "ACPX provider spawned after ownership admission was sealed",
      );
    }
    return child;
  }

  async verifyLifetimeOwnership(): Promise<void> {
    try {
      for (;;) {
        const ownership = this.#lifetimeOwnership.splice(0);
        if (ownership.length === 0) {
          // This check and seal are synchronous. Any spawn added while an
          // earlier batch was pending is observed by the next loop iteration;
          // no later provider can race admission after the stable-empty point.
          this.#lifetimeOwnershipSealed = true;
          return;
        }
        await Promise.all(ownership);
      }
    } catch (error) {
      this.#lifetimeOwnershipSealed = true;
      throw error;
    }
  }

  beginLifetimeOwnershipAdmission(): () => Promise<void> {
    if (this.#sealed) {
      throw new Error("ACPX provider ownership admission is closed");
    }
    if (!this.#lifetimeOwnershipSealed) {
      throw new Error("ACPX provider ownership admission is already active");
    }
    this.#lifetimeOwnershipSealed = false;
    let finished = false;
    return async () => {
      if (finished) return;
      finished = true;
      await this.verifyLifetimeOwnership();
    };
  }

  #track(child: ChildProcess, providerExit: ProviderExitObservation): void {
    this.#children.add(child);
    const onError = (error: unknown) => this.#errors.add(error);
    let guardianExited = !running(child);
    let providerExited = false;
    const forgetIfReleased = () => {
      if (!guardianExited || !providerExited) return;
      this.#children.delete(child);
      this.#providerExits.delete(child);
      child.off("error", onError);
      child.off("exit", onGuardianExit);
      child.off("close", onGuardianExit);
    };
    const onGuardianExit = () => {
      guardianExited = true;
      forgetIfReleased();
    };
    // ChildProcess reports some spawn and signal-delivery failures through an
    // asynchronous `error` event. Observe those for the child's whole tracked
    // lifetime so cleanup can report them instead of crashing runnerd.
    child.on("error", onError);
    child.once("exit", onGuardianExit);
    child.once("close", onGuardianExit);
    providerExit.observe((outcome) => {
      if (outcome.exited) {
        providerExited = true;
        forgetIfReleased();
      } else {
        this.#errors.add(outcome.error);
      }
    });
  }

  async terminate(): Promise<unknown[]> {
    // Revoke spawn authority synchronously before the first await. Children
    // already owned here receive the normal TERM/KILL sequence; every later
    // spawn is rejected and its independently retained post-seal cleanup
    // cannot extend this caller-facing shutdown without bound.
    this.#sealed = true;
    for (const child of this.#children) this.#startTermination(child);
    const ownedTerminations = [...this.#terminations.values()];
    const errors = (await Promise.all(ownedTerminations)).flat();
    // A failed spawn or signal can emit `error` and then `close` before this
    // method snapshots the live children. Keep those errors independently of
    // child membership and report each object once after all owned attempts.
    for (const error of this.#errors) pushUnique(errors, error);
    this.#errors.clear();
    return errors;
  }

  #startTermination(
    child: ChildProcess,
    immediateKill = false,
  ): Promise<unknown[]> {
    const existing = this.#terminations.get(child);
    if (existing) return existing;
    const providerExit =
      this.#providerExits.get(child) ??
      new ProviderExitObservation(
        Promise.reject(new Error("ACPX provider exit proof is unavailable")),
      );
    const termination = (
      immediateKill
        ? terminatePostSealChild(child, providerExit)
        : terminateChild(child, providerExit)
    ).catch((error: unknown) => [error]);
    this.#terminations.set(child, termination);
    termination.then(() => {
      if (this.#terminations.get(child) === termination) {
        this.#terminations.delete(child);
      }
    });
    return termination;
  }
}

async function terminatePostSealChild(
  child: ChildProcess,
  providerExit: ProviderExitObservation,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  // Verified production children override ChildProcess.kill so this SIGKILL
  // request revokes the owner pipe and wakes the live guardian, which retains
  // authority to reap the whole group. Never copy the numeric PGID into a
  // later signal owner.
  const killOutcome = await signalAndWaitForVerifiedProviderExit(
    child,
    "SIGKILL",
    PROVIDER_KILL_EXIT_TIMEOUT_MS,
    providerExit,
  );
  for (const error of killOutcome.errors) pushUnique(errors, error);
  if (!killOutcome.exited) {
    errors.push(
      new Error("ACPX post-seal provider did not exit after SIGKILL"),
    );
  }
  return errors;
}

async function terminateChild(
  child: ChildProcess,
  providerExit: ProviderExitObservation,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const terminateOutcome = await signalAndWaitForVerifiedProviderExit(
    child,
    "SIGTERM",
    PROVIDER_TERM_EXIT_TIMEOUT_MS,
    providerExit,
  );
  for (const error of terminateOutcome.errors) pushUnique(errors, error);
  if (!terminateOutcome.exited) {
    errors.push(new Error("ACPX provider did not exit after SIGTERM"));
    // A live verified guardian still pins the PGID. Its protected `kill`
    // override revokes the owner pipe and wakes it to reap the group. If the
    // guardian already exited, do not signal a saved identifier; retain local
    // cleanup while waiting for the provider-only descriptor to reach EOF.
    const killOutcome = await signalAndWaitForVerifiedProviderExit(
      child,
      "SIGKILL",
      PROVIDER_KILL_EXIT_TIMEOUT_MS,
      providerExit,
    );
    for (const error of killOutcome.errors) pushUnique(errors, error);
    if (!killOutcome.exited) {
      errors.push(new Error("ACPX provider did not exit after SIGKILL"));
    }
  }
  // Never unref a child whose guardian exit and provider-only EOF were not
  // both observed. Local cleanup retains it instead of transferring a reusable
  // PGID or releasing credential ownership early.
  return errors;
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function signalAndWaitForVerifiedProviderExit(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
  providerExit: ProviderExitObservation,
): Promise<{ exited: boolean; errors: unknown[] }> {
  const [guardian, provider] = await Promise.all([
    signalAndWaitForExit(child, signal, timeoutMs),
    providerExit.waitWithin(timeoutMs),
  ]);
  const errors: unknown[] = [];
  if (guardian.error !== undefined) pushUnique(errors, guardian.error);
  if (provider.error !== undefined) pushUnique(errors, provider.error);
  return {
    exited: guardian.exited && provider.exited,
    errors,
  };
}

async function signalAndWaitForExit(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<{ exited: boolean; error?: unknown }> {
  if (!running(child)) return { exited: true };
  return await new Promise<{ exited: boolean; error?: unknown }>((resolve) => {
    let settled = false;
    const finish = (outcome: { exited: boolean; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      child.off("error", onError);
      resolve(outcome);
    };
    const onExit = () => finish({ exited: true });
    const onError = (error: unknown) => finish({ exited: false, error });
    const timer = setTimeout(() => finish({ exited: false }), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    child.once("close", onExit);
    child.once("error", onError);
    if (!running(child)) {
      finish({ exited: true });
      return;
    }
    try {
      child.kill(signal);
      if (!running(child)) finish({ exited: true });
    } catch (error) {
      finish({ exited: false, error });
    }
  });
}

function pushUnique(errors: unknown[], error: unknown): void {
  if (!errors.includes(error)) errors.push(error);
}

function requireIdentity(handle: AcpRuntimeHandle): AcpxRuntimePortIdentity {
  const acpxRecordId = nonEmptyRuntimeIdentity(handle.acpxRecordId);
  if (!acpxRecordId) throw new Error("ACPX runtime omitted acpxRecordId");
  const backendSessionId = nonEmptyRuntimeIdentity(handle.backendSessionId);
  if (!backendSessionId) {
    throw new Error("ACPX runtime omitted backendSessionId");
  }
  return {
    acpxRecordId,
    backendSessionId,
    // ACPX agents do not all advertise a distinct native thread identity.
    // In that case the backend ID is the real ACP protocol session, so retain
    // it explicitly rather than inventing a Paperclip-owned identifier.
    agentSessionId:
      nonEmptyRuntimeIdentity(handle.agentSessionId) ?? backendSessionId,
  };
}

function definedEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
