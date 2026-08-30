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
} from "./runtime-host.js";

const VERIFIED_COMMAND_SENTINEL = "paperclip-verified-acpx-command";
const DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS = 2_000;
const MAX_ADMISSION_CLEANUP_RETRY_ATTEMPTS = 3;
const MAX_ADMISSION_CLEANUP_ATTEMPTS = 1 + MAX_ADMISSION_CLEANUP_RETRY_ATTEMPTS;
const RETAINED_ADMISSION_CLEANUP_RETRY_MIN_MS = 10;
const RETAINED_ADMISSION_CLEANUP_RETRY_MAX_MS = 100;
const activeCodexRuntimeCleanupOwners = new Set<Promise<unknown>>();

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

export interface CodexAcpxRuntimeDependencies {
  createRuntime?: (options: AcpRuntimeOptions) => AcpRuntime;
  createRegistry?: (input: {
    overrides: Record<string, string | string[]>;
  }) => AcpAgentRegistry;
  createStore?: (input: { stateDir: string }) => AcpSessionStore;
  runtimeCloseTimeoutMs?: number;
  /** Internal test seam for autonomous failed-admission cleanup ownership. */
  retainCleanup?: (cleanup: Promise<void>) => void;
}

/**
 * Adapt the pinned ACPX library to Paperclip's admitted runtime port. The
 * executable, launch environment, and spawn cwd stay host-owned and are never
 * persisted in ACPX's session options.
 */
export async function openCodexAcpxRuntime(
  options: AcpxRuntimePortOpenOptions,
  dependencies: CodexAcpxRuntimeDependencies = {},
): Promise<AcpxRuntimePort> {
  if (options.profile.agent !== "codex") {
    throw new Error(
      "The production ACPX runtime currently supports Codex only",
    );
  }
  options.signal?.throwIfAborted();

  const createRegistry = dependencies.createRegistry ?? createAgentRegistry;
  const createStore = dependencies.createStore ?? createRuntimeStore;
  const createRuntime = dependencies.createRuntime ?? createAcpRuntime;
  const runtimeCloseTimeoutMs =
    dependencies.runtimeCloseTimeoutMs ?? DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS;
  const children = new SpawnedChildSet();
  const baseStore = createStore({ stateDir: options.stateDirectory });
  let failedHandshakeHandle: AcpRuntimeHandle | null = null;
  let admissionCleanup: RuntimeAdmissionCleanup | null = null;
  const retainedCleanupOwners = new WeakSet<Promise<void>>();
  const retainCleanup = (cleanup: Promise<void>): void => {
    if (retainedCleanupOwners.has(cleanup)) {
      return;
    }
    retainedCleanupOwners.add(cleanup);
    dependencies.retainCleanup?.(cleanup);
    retainCodexRuntimeCleanup(cleanup);
  };
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
        agent: "codex",
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
  const runtime = createRuntime({
    cwd: options.cwd,
    sessionStore,
    agentRegistry: createRegistry({
      overrides: { codex: [VERIFIED_COMMAND_SENTINEL] },
    }),
    permissionMode: options.permissionMode,
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
    spawnEnvironment: () => definedEnvironment(options.launchEnvironment),
    spawnCwd: options.cwd,
    spawnAgent: (input) => {
      // ACPX can invoke this callback after its handshake caller has already
      // been cancelled. Check at the last host-owned boundary so a late
      // handshake cannot create a provider process after authority is gone.
      options.signal?.throwIfAborted();
      return children.add(
        options.command.spawn(input.args, input.options) as ChildProcess,
      );
    },
  });
  admissionCleanup = new RuntimeAdmissionCleanup(
    runtime,
    children,
    runtimeCloseTimeoutMs,
  );

  let handle: AcpRuntimeHandle | null = null;
  try {
    const handshake = Promise.resolve().then(() =>
      runtime.ensureSession({
        sessionKey: options.providerSessionKey,
        agent: "codex",
        mode: "persistent",
        cwd: options.cwd,
        sessionOptions: {
          model: options.profile.qualificationModel,
          ...(options.systemInstructions
            ? { systemPrompt: { append: options.systemInstructions } }
            : {}),
        },
      }),
    );
    if (options.signal === undefined) {
      handle = await handshake;
    } else {
      try {
        handle = await raceRuntimeHandshakeWithAbort(handshake, options.signal);
      } catch (error) {
        if (options.signal.aborted) {
          retainCleanup(
            handshake.then((lateHandle) =>
              admissionCleanup!.runRetained(
                lateHandle,
                "ACPX runtime admission aborted",
              ),
            ),
          );
        }
        throw error;
      }
      // The promise and abort notification can settle in the same turn. Do
      // not admit a handle if cancellation won immediately afterward.
      options.signal.throwIfAborted();
    }
  } catch (error) {
    const cleanupErrors = await admissionCleanup.run(
      handle ?? failedHandshakeHandle,
      options.signal?.aborted
        ? "ACPX runtime admission aborted"
        : "ACPX session handshake failed",
    );
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
      children,
      runtimeCloseTimeoutMs,
    );
  } catch (error) {
    const cleanupErrors = await admissionCleanup.run(
      handle,
      "ACPX runtime identity validation failed",
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "ACPX runtime identity validation and cleanup failed",
      );
    }
    throw error;
  }
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
  handle: AcpRuntimeHandle;
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

  runRetained(handle: AcpRuntimeHandle, reason: string): Promise<void> {
    const rawTargetKey = runtimeAdmissionCleanupTargetKey(handle);
    const targetKey = this.#resolveTargetKey(rawTargetKey, handle);
    const existing = this.#registeredTargets.get(targetKey);
    if (existing !== undefined) {
      existing.handle = preferRuntimeAdmissionCleanupHandle(
        existing.handle,
        handle,
      );
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
        fallbackHandle !== undefined &&
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
    let processAttemptNumber = 0;
    let retryDelayMs = RETAINED_ADMISSION_CLEANUP_RETRY_MIN_MS;
    while (processAttemptNumber < MAX_ADMISSION_CLEANUP_ATTEMPTS) {
      processAttemptNumber += 1;
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
      if (processAttemptNumber >= MAX_ADMISSION_CLEANUP_ATTEMPTS) break;
      await delay(retryDelayMs);
      retryDelayMs = Math.min(
        retryDelayMs * 2,
        RETAINED_ADMISSION_CLEANUP_RETRY_MAX_MS,
      );
    }
    const errors = [
      ...(runtimeTerminalError === null ? [] : [runtimeTerminalError]),
      ...processErrors,
    ];
    throw new AggregateError(
      errors,
      `ACPX failed-admission cleanup exhausted ${MAX_ADMISSION_CLEANUP_RETRY_ATTEMPTS} retry attempts`,
    );
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

function runtimePort(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  identity: AcpxRuntimePortIdentity,
  children: SpawnedChildSet,
  runtimeCloseTimeoutMs: number,
): AcpxRuntimePort {
  return {
    async identity() {
      return structuredClone(identity);
    },
    async getStatus() {
      if (!runtime.getStatus) {
        throw new Error("The pinned ACPX runtime cannot report session status");
      }
      return structuredClone(await runtime.getStatus({ handle }));
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
    async close(input) {
      const closeError = await closeRuntimeWithin(runtime, {
        input: {
          handle,
          reason: input.reason,
          discardPersistentState: false,
        },
        timeoutMs: runtimeCloseTimeoutMs,
      });
      const processErrors = await children.terminate();
      if (closeError !== undefined || processErrors.length > 0) {
        const errors = [...processErrors];
        if (closeError !== undefined) errors.unshift(closeError);
        throw new AggregateError(
          errors,
          "ACPX runtime and provider cleanup failed",
        );
      }
    },
  };
}

async function closeRuntimeWithin(
  runtime: AcpRuntime,
  options: {
    input: Parameters<AcpRuntime["close"]>[0];
    timeoutMs: number;
  },
): Promise<unknown | undefined> {
  return await closeOutcomeWithin(
    runtimeCloseOutcome(runtime, options.input),
    options.timeoutMs,
  );
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

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

class SpawnedChildSet {
  readonly #children = new Set<ChildProcess>();
  readonly #errors = new Set<unknown>();

  add(child: ChildProcess): ChildProcess {
    this.#children.add(child);
    const onError = (error: unknown) => this.#errors.add(error);
    const forget = () => this.#children.delete(child);
    const forgetAndDetach = () => {
      forget();
      child.off("error", onError);
    };
    // ChildProcess reports some spawn and signal-delivery failures through an
    // asynchronous `error` event. Observe those for the child's whole tracked
    // lifetime so cleanup can report them instead of crashing runnerd.
    child.on("error", onError);
    child.once("exit", forget);
    child.once("close", forgetAndDetach);
    return child;
  }

  async terminate(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const children = [...this.#children];
    await Promise.all(
      children.map(async (child) => {
        if (running(child)) {
          const terminateOutcome = await signalAndWaitForExit(
            child,
            "SIGTERM",
            2_000,
          );
          if (terminateOutcome.error !== undefined) {
            pushUnique(errors, terminateOutcome.error);
          }
          if (!terminateOutcome.exited && running(child)) {
            const killOutcome = await signalAndWaitForExit(
              child,
              "SIGKILL",
              2_000,
            );
            if (killOutcome.error !== undefined) {
              pushUnique(errors, killOutcome.error);
            }
            if (!killOutcome.exited && running(child)) {
              errors.push(
                new Error("ACPX provider did not exit after SIGKILL"),
              );
            }
          }
        }
      }),
    );
    // A failed spawn or signal can emit `error` and then `close` before this
    // method snapshots the live children. Keep those errors independently of
    // child membership, report each object once, and drain them only after all
    // in-flight termination attempts have had a chance to emit.
    for (const error of this.#errors) pushUnique(errors, error);
    this.#errors.clear();
    return errors;
  }
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
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
  const identity = {
    acpxRecordId: handle.acpxRecordId,
    backendSessionId: handle.backendSessionId,
    agentSessionId: handle.agentSessionId,
  };
  for (const [name, value] of Object.entries(identity)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`ACPX runtime omitted ${name}`);
    }
  }
  return identity as AcpxRuntimePortIdentity;
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
