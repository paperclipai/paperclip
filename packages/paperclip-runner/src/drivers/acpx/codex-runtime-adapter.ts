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
const activeCodexRuntimeCleanupOwners = new Set<Promise<unknown>>();

export interface CodexAcpxRuntimeDependencies {
  createRuntime?: (options: AcpRuntimeOptions) => AcpRuntime;
  createRegistry?: (input: {
    overrides: Record<string, string | string[]>;
  }) => AcpAgentRegistry;
  createStore?: (input: { stateDir: string }) => AcpSessionStore;
  runtimeCloseTimeoutMs?: number;
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
      retainCodexRuntimeCleanup(
        admissionCleanup.run(
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
          retainCodexRuntimeCleanup(
            handshake.then((lateHandle) =>
              admissionCleanup!.run(
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

class RuntimeAdmissionCleanup {
  readonly #closedHandles = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: AcpRuntime,
    private readonly children: SpawnedChildSet,
    private readonly runtimeCloseTimeoutMs: number,
  ) {}

  run(handle: AcpRuntimeHandle | null, reason: string): Promise<unknown[]> {
    const cleanup = this.#tail.then(async () => {
      const errors: unknown[] = [];
      if (handle !== null) {
        const key = runtimeHandleCleanupKey(handle);
        if (!this.#closedHandles.has(key)) {
          const runtimeError = await closeRuntimeWithin(this.runtime, {
            input: {
              handle,
              reason,
              discardPersistentState: false,
            },
            timeoutMs: this.runtimeCloseTimeoutMs,
          });
          // A rejection or timeout does not prove the runtime released this
          // identity. Leave it eligible for the next serialized cleanup pass.
          if (runtimeError === undefined) {
            this.#closedHandles.add(key);
          } else {
            errors.push(runtimeError);
          }
        }
      }
      errors.push(...(await this.children.terminate()));
      return errors;
    });
    this.#tail = cleanup.then(
      () => undefined,
      () => undefined,
    );
    return cleanup;
  }
}

function runtimeHandleCleanupKey(handle: AcpRuntimeHandle): string {
  return JSON.stringify([
    handle.sessionKey,
    handle.runtimeSessionName,
    handle.acpxRecordId,
    handle.backendSessionId,
    handle.agentSessionId,
  ]);
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
  const timeoutMs = Math.max(1, options.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeOutcome = Promise.resolve()
    .then(() => runtime.close(options.input))
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  const timeoutOutcome = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () => resolve(new Error("ACPX runtime close timed out")),
      timeoutMs,
    );
  });
  const outcome = await Promise.race([closeOutcome, timeoutOutcome]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
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
