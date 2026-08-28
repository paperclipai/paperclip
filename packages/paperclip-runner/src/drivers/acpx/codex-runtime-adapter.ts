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
import { decideAcpxPermission } from "./permission-policy.js";

const VERIFIED_COMMAND_SENTINEL = "paperclip-verified-acpx-command";
const DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS = 2_000;
const RETAINED_ADMISSION_CLEANUP_RETRY_MIN_MS = 10;
const RETAINED_ADMISSION_CLEANUP_RETRY_MAX_MS = 30_000;
const activeCodexRuntimeCleanupOwners = new Set<Promise<unknown>>();

class AcpxRuntimeCloseTimeoutError extends Error {
  constructor() {
    super("ACPX runtime close timed out");
    this.name = "AcpxRuntimeCloseTimeoutError";
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
  // The verified-command boundary already refuses to mint a Windows command
  // lease, because Node cannot pin its executable there. Repeat the platform
  // gate at this lower boundary so alternate host wiring cannot launch a
  // credential-bearing provider without a killable tree. `child.kill()` only
  // terminates the direct Windows process, and taskkill cannot reliably find
  // descendants after their original parent has exited; Windows support must
  // therefore wait for an owned Job Object or equivalent containment.
  if (process.platform === "win32") {
    throw new Error(
      "The production ACPX runtime requires provider process-tree containment unavailable on Windows",
    );
  }

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
  const runnerOwnedMcpServerNames = new Set(
    options.mcpServers
      .filter((server) => server.runnerOwned)
      .map((server) => server.name),
  );
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
    spawnEnvironment: () => definedEnvironment(options.launchEnvironment),
    spawnCwd: options.cwd,
    spawnAgent: (input) => {
      // ACPX can invoke this callback after its handshake caller has already
      // been cancelled. Check at the last host-owned boundary so a late
      // handshake cannot create a provider process after authority is gone.
      options.signal?.throwIfAborted();
      // A verified provider can create descendants that inherit its launch
      // credential. Give the provider a dedicated POSIX process group so
      // cleanup authority covers that complete credential-bearing tree.
      return children.add(
        options.command.spawn(input.args, {
          ...input.options,
          detached: true,
        }) as ChildProcess,
        true,
      );
    },
  });
  admissionCleanup = new RuntimeAdmissionCleanup(
    runtime,
    children,
    runtimeCloseTimeoutMs,
    retainCleanup,
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
      admissionCleanup,
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
    private readonly retainCleanup: (cleanup: Promise<void>) => void,
  ) {}

  run(handle: AcpRuntimeHandle | null, reason: string): Promise<unknown[]> {
    const targetKey = this.#resolveTargetKey(
      runtimeAdmissionCleanupTargetKey(handle),
      handle,
    );
    return this.#runAttempt(targetKey, handle, reason).then(({ errors }) => {
      if (errors.length > 0) {
        this.retainCleanup(this.runRetained(handle, reason));
      }
      return errors;
    });
  }

  runRetained(handle: AcpRuntimeHandle | null, reason: string): Promise<void> {
    const rawTargetKey = runtimeAdmissionCleanupTargetKey(handle);
    const targetKey = this.#resolveTargetKey(rawTargetKey, handle);
    const existing = this.#registeredTargets.get(targetKey);
    if (existing !== undefined) {
      if (handle !== null) {
        existing.handle =
          existing.handle === null
            ? handle
            : preferRuntimeAdmissionCleanupHandle(existing.handle, handle);
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
        fallbackHandle !== undefined &&
        fallbackHandle !== null &&
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
    let retryDelayMs = RETAINED_ADMISSION_CLEANUP_RETRY_MIN_MS;
    // Retained cleanup is the continuing owner. Keep one runtime-close attempt
    // in flight at a time and retry process-tree termination until both are
    // confirmed complete; a finite budget would recreate an orphan boundary.
    for (;;) {
      const attempt = await this.#runAttempt(
        targetKey,
        target.handle,
        target.reason,
      );
      const runtimeNeedsRetry =
        target.handle !== null &&
        attempt.runtimeError !== undefined &&
        !this.#closedHandles.has(targetKey);
      const processNeedsRetry = attempt.processErrors.length > 0;
      if (!runtimeNeedsRetry && !processNeedsRetry) {
        return;
      }
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
  }> {
    const cleanup = this.#tail.then(async () => {
      const errors: unknown[] = [];
      let runtimeError: unknown | undefined;
      if (handle !== null && !this.#closedHandles.has(targetKey)) {
        runtimeError = await this.#closeHandleWithin(targetKey, handle, reason);
        if (runtimeError !== undefined) errors.push(runtimeError);
      }
      const processErrors = await this.children.terminate();
      errors.push(...processErrors);
      return {
        errors,
        runtimeError,
        processErrors,
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
  ): Promise<unknown | undefined> {
    let attempt = this.#activeHandleAttempts.get(targetKey);
    if (attempt === undefined) {
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
    return await closeOutcomeWithin(attempt, this.runtimeCloseTimeoutMs);
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
  admissionCleanup: RuntimeAdmissionCleanup,
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
    startTurn(input) {
      return runtime.startTurn({
        handle,
        text: input.text,
        mode: "prompt",
        requestId: input.requestId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
    async close(input) {
      const errors = await admissionCleanup.run(handle, input.reason);
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "ACPX runtime and provider cleanup failed",
        );
      }
    },
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

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
}

class SpawnedChildSet {
  readonly #children = new Map<ChildProcess, SpawnedProviderProcess>();
  readonly #errors = new Set<unknown>();

  add(child: ChildProcess, processGroup: boolean): ChildProcess {
    const onError = (error: unknown) => this.#errors.add(error);
    const tracked: SpawnedProviderProcess = {
      child,
      processGroupId: processGroup ? (child.pid ?? null) : null,
      onError,
    };
    this.#children.set(child, tracked);
    const forgetExitedTree = () => {
      if (!providerTreeRunning(tracked)) this.#forget(tracked);
    };
    // ChildProcess reports some spawn and signal-delivery failures through an
    // asynchronous `error` event. Observe those for the child's whole tracked
    // lifetime so cleanup can report them instead of crashing runnerd.
    child.on("error", onError);
    child.once("exit", forgetExitedTree);
    child.once("close", forgetExitedTree);
    return child;
  }

  async terminate(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const children = [...this.#children.values()];
    await Promise.all(
      children.map(async (tracked) => {
        if (providerTreeRunning(tracked)) {
          const terminateOutcome = await signalAndWaitForExit(
            tracked,
            "SIGTERM",
            2_000,
          );
          if (terminateOutcome.error !== undefined) {
            pushUnique(errors, terminateOutcome.error);
          }
          if (!terminateOutcome.exited && providerTreeRunning(tracked)) {
            const killOutcome = await signalAndWaitForExit(
              tracked,
              "SIGKILL",
              2_000,
            );
            if (killOutcome.error !== undefined) {
              pushUnique(errors, killOutcome.error);
            }
            if (!killOutcome.exited && providerTreeRunning(tracked)) {
              errors.push(
                new Error("ACPX provider did not exit after SIGKILL"),
              );
            }
          }
        }
        if (!providerTreeRunning(tracked)) this.#forget(tracked);
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

  #forget(tracked: SpawnedProviderProcess): void {
    if (this.#children.get(tracked.child) !== tracked) return;
    this.#children.delete(tracked.child);
    tracked.child.off("error", tracked.onError);
  }
}

interface SpawnedProviderProcess {
  child: ChildProcess;
  processGroupId: number | null;
  onError: (error: unknown) => void;
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function providerTreeRunning(tracked: SpawnedProviderProcess): boolean {
  if (tracked.processGroupId === null) return running(tracked.child);
  try {
    process.kill(-tracked.processGroupId, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function signalAndWaitForExit(
  tracked: SpawnedProviderProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<{ exited: boolean; error?: unknown }> {
  if (!providerTreeRunning(tracked)) return { exited: true };
  const { child } = tracked;
  return await new Promise<{ exited: boolean; error?: unknown }>((resolve) => {
    let settled = false;
    const finish = (outcome: { exited: boolean; error?: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      child.off("exit", onExit);
      child.off("close", onExit);
      child.off("error", onError);
      resolve(outcome);
    };
    const onExit = () => {
      if (!providerTreeRunning(tracked)) finish({ exited: true });
    };
    const onError = (error: unknown) => finish({ exited: false, error });
    const timer = setTimeout(
      () => finish({ exited: !providerTreeRunning(tracked) }),
      timeoutMs,
    );
    timer.unref();
    const poll =
      tracked.processGroupId === null
        ? undefined
        : setInterval(() => {
            if (!providerTreeRunning(tracked)) finish({ exited: true });
          }, 25);
    poll?.unref();
    child.once("exit", onExit);
    child.once("close", onExit);
    child.once("error", onError);
    if (!providerTreeRunning(tracked)) {
      finish({ exited: true });
      return;
    }
    try {
      if (tracked.processGroupId === null) {
        if (!child.kill(signal) && providerTreeRunning(tracked)) {
          finish({
            exited: false,
            error: new Error(`ACPX provider rejected ${signal}`),
          });
          return;
        }
      } else {
        process.kill(-tracked.processGroupId, signal);
      }
      if (!providerTreeRunning(tracked)) finish({ exited: true });
    } catch (error) {
      if (errorCode(error) === "ESRCH" && !providerTreeRunning(tracked)) {
        finish({ exited: true });
      } else {
        finish({ exited: false, error });
      }
    }
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
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
