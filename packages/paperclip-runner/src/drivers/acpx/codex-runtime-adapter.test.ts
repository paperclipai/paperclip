import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import type {
  AcpAgentRegistry,
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpSessionStore,
} from "acpx/runtime";
import { decodeAcpxRuntimeHandleState } from "acpx/runtime";
import { describe, expect, it, vi } from "vitest";

import type { VerifiedAcpxCommandLease } from "./installation-integrity.js";
import { openCodexAcpxRuntime } from "./codex-runtime-adapter.js";
import type { AcpxRuntimePortOpenOptions } from "./runtime-host.js";

const HANDLE: AcpRuntimeHandle = {
  sessionKey: "session-key",
  backend: "acpx",
  runtimeSessionName: "runtime-name",
  cwd: "/workspace",
  acpxRecordId: "record-1",
  backendSessionId: "backend-1",
  agentSessionId: "agent-1",
};

describe("Codex ACPX runtime adapter", () => {
  it("rejects a pre-aborted admission before constructing or spawning ACPX", async () => {
    const cancellation = new Error("runtime admission cancelled");
    const controller = new AbortController();
    controller.abort(cancellation);
    const command = fakeCommand();
    const createRuntime = vi.fn();

    await expect(
      openCodexAcpxRuntime(
        { ...openOptions(command), signal: controller.signal },
        { createRuntime },
      ),
    ).rejects.toBe(cancellation);

    expect(createRuntime).not.toHaveBeenCalled();
    expect(command.spawn).not.toHaveBeenCalled();
  });

  it("rejects Windows before constructing or spawning ACPX", async () => {
    const command = fakeCommand();
    const createRuntime = vi.fn();
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    if (platformDescriptor === undefined) {
      throw new Error("Node process.platform descriptor is unavailable");
    }
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "win32",
    });
    try {
      await expect(
        openCodexAcpxRuntime(openOptions(command), { createRuntime }),
      ).rejects.toThrow(
        "provider process-tree containment unavailable on Windows",
      );
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }

    expect(createRuntime).not.toHaveBeenCalled();
    expect(command.spawn).not.toHaveBeenCalled();
  });

  it("opens a persistent Codex session without persisting launch secrets", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const command = fakeCommand();
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: ({ overrides }) => {
        expect(overrides).toEqual({
          codex: ["paperclip-verified-acpx-command"],
        });
        return registry();
      },
      createStore: ({ stateDir }) => {
        expect(stateDir).toBe("/runtime/state");
        return store();
      },
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });

    expect(runtime.ensureSession).toHaveBeenCalledWith({
      sessionKey: "provider-key",
      agent: "codex",
      mode: "persistent",
      cwd: "/workspace",
      sessionOptions: {
        model: "gpt-5.6-sol",
        systemPrompt: { append: "Use Paperclip tools." },
      },
    });
    expect(
      JSON.stringify(vi.mocked(runtime.ensureSession).mock.calls[0]?.[0]),
    ).not.toContain("credential-secret");
    expect(runtimeOptions?.spawnEnvironment?.()).toEqual({
      CODEX_HOME: "/runtime/agent-home",
      OPENAI_API_KEY: "credential-secret",
    });
    expect(runtimeOptions?.spawnCwd).toBe("/workspace");
    expect(await port.identity()).toEqual({
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
    });
  });

  it("launches only through the verified command lease", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const command = fakeCommand();
    await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });
    const child = fakeChild();
    vi.mocked(command.spawn).mockReturnValue(child);
    const spawnOptions = { cwd: "/runtime/spawn" };

    expect(
      runtimeOptions?.spawnAgent?.({
        command: "/attacker/replacement",
        args: ["--stdio"],
        options: spawnOptions,
      }),
    ).toBe(child);
    expect(command.spawn).toHaveBeenCalledWith(["--stdio"], {
      ...spawnOptions,
      detached: true,
    });
  });

  it.runIf(process.platform !== "win32")(
    "terminates the provider process group after its leader exits",
    async () => {
      const child = fakeProcessGroupChild(54_321);
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const handshakeFailure = new Error("ACP handshake rejected");
      const runtime = fakeRuntime();
      let groupRunning = true;
      const processKill = vi
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => {
          expect(pid).toBe(-54_321);
          if (signal === 0) {
            if (!groupRunning) {
              throw Object.assign(new Error("process group exited"), {
                code: "ESRCH",
              });
            }
            return true;
          }
          if (signal === "SIGTERM") {
            child.signalCode = "SIGTERM";
            queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
            return true;
          }
          if (signal === "SIGKILL") {
            groupRunning = false;
            return true;
          }
          return true;
        });
      vi.useFakeTimers();
      try {
        const openingError = openCodexAcpxRuntime(openOptions(command), {
          createRegistry: () => registry(),
          createStore: () => store(),
          createRuntime: (runtimeOptions) => {
            vi.mocked(runtime.ensureSession).mockImplementation(async () => {
              runtimeOptions.spawnAgent?.({
                command: "ignored",
                args: ["--stdio"],
                options: {},
              });
              throw handshakeFailure;
            });
            return runtime;
          },
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        expect(command.spawn).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(2_001);
        await expect(openingError).resolves.toBe(handshakeFailure);
        expect(processKill).toHaveBeenCalledWith(-54_321, "SIGTERM");
        expect(processKill).toHaveBeenCalledWith(-54_321, "SIGKILL");
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        processKill.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("maps status, model selection, and state-preserving close", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.getStatus!).mockResolvedValue({
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    });
    const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: () => runtime,
    });

    expect(await port.getStatus()).toEqual({
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    });
    await port.setModel?.("gpt-5.6-sol");
    expect(runtime.setConfigOption).toHaveBeenCalledWith({
      handle: HANDLE,
      key: "model",
      value: "gpt-5.6-sol",
    });
    await port.close({ reason: "test complete" });
    expect(runtime.close).toHaveBeenCalledWith({
      handle: HANDLE,
      reason: "test complete",
      discardPersistentState: false,
    });
  });

  it("maps prompt turns to the admitted ACPX handle", async () => {
    const runtime = fakeRuntime();
    const turn = {
      requestId: "turn-1",
      promptStarted: Promise.resolve(),
      events: { async *[Symbol.asyncIterator]() {} },
      result: Promise.resolve({ status: "completed" as const }),
      cancel: vi.fn(),
      closeStream: vi.fn(),
    };
    vi.mocked(runtime.startTurn).mockReturnValue(turn);
    const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: () => runtime,
    });
    const signal = new AbortController().signal;

    expect(
      port.startTurn({
        text: "Complete the task.",
        requestId: "turn-1",
        signal,
      }),
    ).toBe(turn);
    expect(runtime.startTurn).toHaveBeenCalledWith({
      handle: HANDLE,
      text: "Complete the task.",
      mode: "prompt",
      requestId: "turn-1",
      signal,
    });
  });

  it("projects only ephemeral MCP bindings and applies fail-closed permissions", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const port = await openCodexAcpxRuntime(
      {
        ...openOptions(fakeCommand()),
        permissionMode: "deny-all",
        mcpServers: [
          {
            name: "paperclip",
            url: "http://127.0.0.1:3210/mcp",
            bearerToken: "bridge-secret",
            runnerOwned: true,
          },
        ],
      },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      },
    );

    expect(runtimeOptions?.mcpServers).toEqual([
      {
        type: "http",
        name: "paperclip",
        url: "http://127.0.0.1:3210/mcp",
        headers: [{ name: "Authorization", value: "Bearer bridge-secret" }],
      },
    ]);
    await expect(
      runtimeOptions?.onPermissionRequest?.(
        {
          sessionId: "session-1",
          inferredKind: "execute",
          raw: { _meta: { is_mcp_tool_approval: true } },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ outcome: "reject_once" });
    await expect(
      runtimeOptions?.onPermissionRequest?.(
        {
          sessionId: "session-1",
          inferredKind: "execute",
          raw: {},
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ outcome: "reject_once" });
    expect(
      JSON.stringify(vi.mocked(runtime.ensureSession).mock.calls),
    ).not.toContain("bridge-secret");
    await port.close({ reason: "complete" });
  });

  it("delegates permissions that require an unavailable coordinator", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });

    await expect(
      runtimeOptions?.onPermissionRequest?.(
        {
          sessionId: "session-1",
          inferredKind: "write",
          raw: {},
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    await port.close({ reason: "complete" });
  });

  it("fails closed and closes the session when ACPX omits recovery identity", async () => {
    const runtime = fakeRuntime({ ...HANDLE, agentSessionId: undefined });
    await expect(
      openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
      }),
    ).rejects.toThrow("ACPX runtime omitted agentSessionId");
    expect(runtime.close).toHaveBeenCalledWith({
      handle: { ...HANDLE, agentSessionId: undefined },
      reason: "ACPX runtime identity validation failed",
      discardPersistentState: false,
    });
  });

  it("retains failed ordinary admission cleanup until a retry succeeds", async () => {
    const runtime = fakeRuntime({ ...HANDLE, agentSessionId: undefined });
    const firstCloseFailure = new Error("runtime close failed");
    vi.mocked(runtime.close)
      .mockRejectedValueOnce(firstCloseFailure)
      .mockResolvedValueOnce(undefined);
    const retainedCleanups: Promise<void>[] = [];

    await expect(
      openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
      }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: "ACPX runtime omitted agentSessionId",
        }),
        firstCloseFailure,
      ],
    });

    expect(retainedCleanups).toHaveLength(1);
    await expect(retainedCleanups[0]).resolves.toBeUndefined();
    expect(runtime.close).toHaveBeenCalledTimes(2);
  });

  it("terminates a provider spawned before the session handshake rejects", async () => {
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const failure = new Error("ACP handshake rejected");
    const runtime = fakeRuntime();

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            options.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            throw failure;
          });
          return runtime;
        },
      }),
    ).rejects.toBe(failure);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("aborts a blocked handshake, reaps its provider, and closes a late session", async () => {
    let resolveHandshake: ((handle: AcpRuntimeHandle) => void) | undefined;
    const blockedHandshake = new Promise<AcpRuntimeHandle>((resolve) => {
      resolveHandshake = resolve;
    });
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const runtime = fakeRuntime();
    const controller = new AbortController();
    const cancellation = new Error("runtime admission cancelled");

    const opening = openCodexAcpxRuntime(
      { ...openOptions(command), signal: controller.signal },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            runtimeOptions.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            return await blockedHandshake;
          });
          return runtime;
        },
      },
    );
    await vi.waitFor(() => expect(command.spawn).toHaveBeenCalledOnce());

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    resolveHandshake?.(HANDLE);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(runtime.close).toHaveBeenCalledWith({
      handle: HANDLE,
      reason: "ACPX runtime admission aborted",
      discardPersistentState: false,
    });
  });

  it("retries retained admission cleanup after the first close times out", async () => {
    let rejectHandshake: ((error: Error) => void) | undefined;
    let firstCloseSettled = false;
    let overlappingClose = false;
    const blockedHandshake = new Promise<AcpRuntimeHandle>(
      (_resolve, reject) => {
        rejectHandshake = reject;
      },
    );
    const runtime = fakeRuntime();
    vi.mocked(runtime.ensureSession).mockReturnValue(blockedHandshake);
    vi.mocked(runtime.close)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => {
              firstCloseSettled = true;
              reject(new Error("late close rejected after its timeout"));
            }, 8);
          }),
      )
      .mockImplementationOnce(async () => {
        overlappingClose = !firstCloseSettled;
      });
    const controller = new AbortController();
    const cancellation = new Error("runtime admission cancelled");
    let runtimeOptions: AcpRuntimeOptions | undefined;

    const opening = openCodexAcpxRuntime(
      {
        ...openOptions(fakeCommand()),
        signal: controller.signal,
      },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
        runtimeCloseTimeoutMs: 5,
      },
    );
    await vi.waitFor(() =>
      expect(runtime.ensureSession).toHaveBeenCalledOnce(),
    );

    controller.abort(cancellation);
    const openingFailure = opening.catch((error: unknown) => error);
    await runtimeOptions!.sessionStore.save({
      acpxRecordId: "late-record",
      acpSessionId: "late-backend-session",
      agentSessionId: "late-agent-session",
      name: "late-runtime-name",
      cwd: "/workspace",
    } as never);

    await expect(openingFailure).resolves.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
    expect(firstCloseSettled).toBe(true);
    expect(overlappingClose).toBe(false);
    expect(runtime.close).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runtime.close).mock.calls[1]?.[0]).toEqual(
      vi.mocked(runtime.close).mock.calls[0]?.[0],
    );
    rejectHandshake?.(new Error("test handshake stopped"));
  });

  it("retries a rejected cleanup for a session returned after admission aborts", async () => {
    let resolveHandshake: ((handle: AcpRuntimeHandle) => void) | undefined;
    const blockedHandshake = new Promise<AcpRuntimeHandle>((resolve) => {
      resolveHandshake = resolve;
    });
    const firstCloseFailure = new Error("late runtime close failed");
    const runtime = fakeRuntime();
    vi.mocked(runtime.ensureSession).mockReturnValue(blockedHandshake);
    vi.mocked(runtime.close)
      .mockRejectedValueOnce(firstCloseFailure)
      .mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const cancellation = new Error("runtime admission cancelled");

    const opening = openCodexAcpxRuntime(
      {
        ...openOptions(fakeCommand()),
        signal: controller.signal,
      },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
      },
    );
    await vi.waitFor(() =>
      expect(runtime.ensureSession).toHaveBeenCalledOnce(),
    );

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    resolveHandshake?.(HANDLE);

    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runtime.close).mock.calls[0]?.[0]).toEqual({
      handle: HANDLE,
      reason: "ACPX runtime admission aborted",
      discardPersistentState: false,
    });
    expect(vi.mocked(runtime.close).mock.calls[1]?.[0]).toEqual(
      vi.mocked(runtime.close).mock.calls[0]?.[0],
    );
  });

  it("retains ownership of a late close until its exact attempt settles", async () => {
    let resolveHandshake: ((handle: AcpRuntimeHandle) => void) | undefined;
    const blockedHandshake = new Promise<AcpRuntimeHandle>((resolve) => {
      resolveHandshake = resolve;
    });
    const runtime = fakeRuntime();
    vi.mocked(runtime.ensureSession).mockReturnValue(blockedHandshake);
    let resolveClose: (() => void) | undefined;
    vi.mocked(runtime.close).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    const controller = new AbortController();
    const cancellation = new Error("runtime admission cancelled");
    const retainedCleanups: Promise<void>[] = [];

    const opening = openCodexAcpxRuntime(
      { ...openOptions(fakeCommand()), signal: controller.signal },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        runtimeCloseTimeoutMs: 5,
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
      },
    );
    await vi.waitFor(() =>
      expect(runtime.ensureSession).toHaveBeenCalledOnce(),
    );

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    expect(retainedCleanups).toHaveLength(1);
    resolveHandshake?.(HANDLE);

    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    let cleanupSettled = false;
    void retainedCleanups[0]!.then(
      () => {
        cleanupSettled = true;
      },
      () => {
        cleanupSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cleanupSettled).toBe(false);
    expect(runtime.close).toHaveBeenCalledOnce();

    resolveClose?.();
    await retainedCleanups[0];
    expect(cleanupSettled).toBe(true);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("coalesces store and late-handshake cleanup while a timed-out close is active", async () => {
    let resolveHandshake: ((handle: AcpRuntimeHandle) => void) | undefined;
    let firstCloseSettled = false;
    let overlappingClose = false;
    const blockedHandshake = new Promise<AcpRuntimeHandle>((resolve) => {
      resolveHandshake = resolve;
    });
    const runtime = fakeRuntime();
    vi.mocked(runtime.ensureSession).mockReturnValue(blockedHandshake);
    vi.mocked(runtime.close)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => {
              firstCloseSettled = true;
              reject(new Error("timed-out close eventually rejected"));
            }, 8);
          }),
      )
      .mockImplementationOnce(async () => {
        overlappingClose = !firstCloseSettled;
      });
    const controller = new AbortController();
    const cancellation = new Error("runtime admission cancelled");
    let runtimeOptions: AcpRuntimeOptions | undefined;

    const opening = openCodexAcpxRuntime(
      {
        ...openOptions(fakeCommand()),
        signal: controller.signal,
      },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
        runtimeCloseTimeoutMs: 5,
      },
    );
    await vi.waitFor(() =>
      expect(runtime.ensureSession).toHaveBeenCalledOnce(),
    );

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    await runtimeOptions!.sessionStore.save({
      acpxRecordId: "record-1",
      acpSessionId: "backend-1",
      agentSessionId: "agent-1",
      name: "stored-runtime-name",
      cwd: "/workspace",
    } as never);
    // The returned handle uses a different runtimeSessionName representation,
    // but its durable record identity must join the store-published cleanup.
    resolveHandshake?.(HANDLE);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
    expect(overlappingClose).toBe(false);
  });

  it("promotes a session fallback into the later durable record lifecycle", async () => {
    let resolveHandshake: ((handle: AcpRuntimeHandle) => void) | undefined;
    let firstCloseSettled = false;
    let overlappingClose = false;
    const blockedHandshake = new Promise<AcpRuntimeHandle>((resolve) => {
      resolveHandshake = resolve;
    });
    const runtime = fakeRuntime();
    vi.mocked(runtime.ensureSession).mockReturnValue(blockedHandshake);
    vi.mocked(runtime.close)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => {
              firstCloseSettled = true;
              reject(new Error("fallback close rejected after timeout"));
            }, 15);
          }),
      )
      .mockImplementationOnce(async () => {
        overlappingClose = !firstCloseSettled;
      });
    const controller = new AbortController();
    const cancellation = new Error("runtime admission cancelled");
    const retainedCleanups: Promise<void>[] = [];
    let runtimeOptions: AcpRuntimeOptions | undefined;

    const opening = openCodexAcpxRuntime(
      {
        ...openOptions(fakeCommand()),
        signal: controller.signal,
      },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
        runtimeCloseTimeoutMs: 10,
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
      },
    );
    await vi.waitFor(() =>
      expect(runtime.ensureSession).toHaveBeenCalledOnce(),
    );

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    resolveHandshake?.({
      ...HANDLE,
      sessionKey: "provider-key",
      acpxRecordId: undefined,
      agentSessionId: "fallback-agent-session",
    } as never);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    await runtimeOptions!.sessionStore.save({
      acpxRecordId: "promoted-record",
      acpSessionId: "promoted-backend-session",
      name: "promoted-runtime-name",
      cwd: "/workspace",
    } as never);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
    expect(overlappingClose).toBe(false);
    expect(vi.mocked(runtime.close).mock.calls[1]?.[0].handle).toMatchObject({
      acpxRecordId: "promoted-record",
      backendSessionId: "promoted-backend-session",
      agentSessionId: "fallback-agent-session",
    });
    expect(
      decodeAcpxRuntimeHandleState(
        vi.mocked(runtime.close).mock.calls[1]![0].handle.runtimeSessionName,
      ),
    ).toMatchObject({ name: "promoted-runtime-name" });
    await Promise.all(retainedCleanups);
  });

  it("keeps exact record ids distinct when whitespace differs", async () => {
    let rejectHandshake: ((error: Error) => void) | undefined;
    const blockedHandshake = new Promise<AcpRuntimeHandle>(
      (_resolve, reject) => {
        rejectHandshake = reject;
      },
    );
    const runtime = fakeRuntime();
    vi.mocked(runtime.ensureSession).mockReturnValue(blockedHandshake);
    const controller = new AbortController();
    const cancellation = new Error("runtime admission cancelled");
    let runtimeOptions: AcpRuntimeOptions | undefined;

    const opening = openCodexAcpxRuntime(
      { ...openOptions(fakeCommand()), signal: controller.signal },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      },
    );
    await vi.waitFor(() =>
      expect(runtime.ensureSession).toHaveBeenCalledOnce(),
    );

    controller.abort(cancellation);
    await expect(opening).rejects.toBe(cancellation);
    for (const acpxRecordId of ["record-id", " record-id "]) {
      await runtimeOptions!.sessionStore.save({
        acpxRecordId,
        acpSessionId: `${acpxRecordId}-backend`,
        agentSessionId: `${acpxRecordId}-agent`,
        name: `${acpxRecordId}-runtime`,
        cwd: "/workspace",
      } as never);
    }

    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
    expect(
      vi
        .mocked(runtime.close)
        .mock.calls.map(([input]) => input.handle.acpxRecordId),
    ).toEqual(["record-id", " record-id "]);
    rejectHandshake?.(new Error("test handshake stopped"));
  });

  it("retains cleanup beyond the former admission close retry budget", async () => {
    let rejectHandshake: ((error: Error) => void) | undefined;
    const blockedHandshake = new Promise<AcpRuntimeHandle>(
      (_resolve, reject) => {
        rejectHandshake = reject;
      },
    );
    const runtime = fakeRuntime();
    const closeFailure = new Error("runtime close failed");
    const retainedCleanups: Promise<void>[] = [];
    vi.mocked(runtime.ensureSession).mockReturnValue(blockedHandshake);
    vi.mocked(runtime.close)
      .mockRejectedValueOnce(closeFailure)
      .mockRejectedValueOnce(closeFailure)
      .mockRejectedValueOnce(closeFailure)
      .mockRejectedValueOnce(closeFailure)
      .mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const cancellation = new Error("runtime admission cancelled");
    let runtimeOptions: AcpRuntimeOptions | undefined;

    const opening = openCodexAcpxRuntime(
      {
        ...openOptions(fakeCommand()),
        signal: controller.signal,
      },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
      },
    );
    await vi.waitFor(() =>
      expect(runtime.ensureSession).toHaveBeenCalledOnce(),
    );

    controller.abort(cancellation);
    await runtimeOptions!.sessionStore.save({
      acpxRecordId: "late-record",
      acpSessionId: "late-backend-session",
      agentSessionId: "late-agent-session",
      name: "late-runtime-name",
      cwd: "/workspace",
    } as never);

    await expect(opening).rejects.toBeInstanceOf(Error);
    expect(retainedCleanups).toHaveLength(2);
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(5));
    await expect(retainedCleanups[0]).resolves.toBeUndefined();
    expect(runtime.close).toHaveBeenCalledTimes(5);

    rejectHandshake?.(new Error("test handshake stopped"));
    await expect(retainedCleanups[1]).rejects.toThrow("test handshake stopped");
  });

  it("aggregates asynchronous provider signal errors after a failed handshake", async () => {
    const child = failingSignalChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child.child);
    const handshakeError = new Error("ACP handshake rejected");
    const runtime = fakeRuntime();

    const result = openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        vi.mocked(runtime.ensureSession).mockImplementation(async () => {
          options.spawnAgent?.({
            command: "ignored",
            args: ["--stdio"],
            options: {},
          });
          throw handshakeError;
        });
        return runtime;
      },
    });

    await expect(result).rejects.toMatchObject({
      errors: [
        handshakeError,
        ...child.errors,
        expect.objectContaining({
          message: "ACPX provider did not exit after SIGKILL",
        }),
      ],
    });
    expect(child.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.child.signalCode = "SIGKILL";
    child.child.emit("exit", null, "SIGKILL");
  });

  it("retains provider cleanup beyond the former retry budget", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperties(child, {
      exitCode: { value: null, writable: true },
      signalCode: { value: null, writable: true },
    });
    let killAttempts = 0;
    child.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") {
        killAttempts += 1;
        if (killAttempts === 5) {
          child.signalCode = "SIGKILL";
          queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
          return true;
        }
      }
      queueMicrotask(() =>
        child.emit("error", new Error(`${String(signal)} still pending`)),
      );
      return true;
    });
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const handshakeError = new Error("ACP handshake rejected");
    const runtime = fakeRuntime();
    const retainedCleanups: Promise<void>[] = [];

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            runtimeOptions.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            throw handshakeError;
          });
          return runtime;
        },
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
      }),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(retainedCleanups).toHaveLength(1);
    await expect(retainedCleanups[0]).resolves.toBeUndefined();
    expect(killAttempts).toBe(5);
  });

  it("closes a recovered session when its handshake rejects before another save", async () => {
    const runtime = fakeRuntime();
    const recoveredStore = store();
    vi.mocked(recoveredStore.load).mockResolvedValue({
      acpxRecordId: "recovered-record",
      acpSessionId: "recovered-backend-session",
      agentSessionId: "recovered-agent-session",
      name: "recovered-runtime-name",
      cwd: "/workspace",
    } as never);
    const failure = new Error("recovered ACP handshake rejected");

    await expect(
      openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => recoveredStore,
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            await runtimeOptions.sessionStore.load("provider-key");
            throw failure;
          });
          return runtime;
        },
      }),
    ).rejects.toBe(failure);
    expect(runtime.close).toHaveBeenCalledOnce();
    const recoveredClose = vi.mocked(runtime.close).mock.calls[0]![0];
    expect(recoveredClose).toMatchObject({
      handle: {
        sessionKey: "provider-key",
        backend: "acpx",
        cwd: "/workspace",
        acpxRecordId: "recovered-record",
        backendSessionId: "recovered-backend-session",
        agentSessionId: "recovered-agent-session",
      },
      reason: "ACPX session handshake failed",
      discardPersistentState: false,
    });
    expect(
      decodeAcpxRuntimeHandleState(recoveredClose.handle.runtimeSessionName),
    ).toEqual({
      name: "recovered-runtime-name",
      agent: "codex",
      cwd: "/workspace",
      mode: "persistent",
      acpxRecordId: "recovered-record",
      backendSessionId: "recovered-backend-session",
      agentSessionId: "recovered-agent-session",
    });
    expect(recoveredStore.save).not.toHaveBeenCalled();
  });

  it("closes a newly created session when its record save rejects", async () => {
    const runtime = fakeRuntime();
    const failingStore = store();
    const failure = new Error("session store unavailable");
    vi.mocked(failingStore.save).mockRejectedValue(failure);

    await expect(
      openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => failingStore,
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            await runtimeOptions.sessionStore.save({
              acpxRecordId: "new-record",
              acpSessionId: "new-backend-session",
              agentSessionId: "new-agent-session",
              name: "new-runtime-name",
              cwd: "/workspace",
            } as never);
            return HANDLE;
          });
          return runtime;
        },
      }),
    ).rejects.toBe(failure);
    expect(runtime.close).toHaveBeenCalledOnce();
    const failedSaveClose = vi.mocked(runtime.close).mock.calls[0]![0];
    expect(failedSaveClose).toMatchObject({
      handle: {
        sessionKey: "provider-key",
        backend: "acpx",
        cwd: "/workspace",
        acpxRecordId: "new-record",
        backendSessionId: "new-backend-session",
        agentSessionId: "new-agent-session",
      },
      reason: "ACPX session handshake failed",
      discardPersistentState: false,
    });
    expect(
      decodeAcpxRuntimeHandleState(failedSaveClose.handle.runtimeSessionName),
    ).toMatchObject({ name: "new-runtime-name", agent: "codex" });
  });

  it("bounds a stalled runtime close before terminating a failed-handshake provider", async () => {
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const runtime = fakeRuntime();
    vi.mocked(runtime.close).mockImplementation(
      () => new Promise<void>(() => undefined),
    );

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            await runtimeOptions.sessionStore.save({
              acpxRecordId: "actual-record",
              acpSessionId: "backend-session",
              agentSessionId: "agent-session",
              name: "actual-runtime-name",
              cwd: "/workspace",
            } as never);
            runtimeOptions.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            throw new Error("ACP handshake rejected");
          });
          return runtime;
        },
        runtimeCloseTimeoutMs: 5,
      }),
    ).rejects.toThrow("ACPX session handshake and runtime cleanup failed");
    expect(runtime.close).toHaveBeenCalledOnce();
    const stalledClose = vi.mocked(runtime.close).mock.calls[0]![0];
    expect(stalledClose).toMatchObject({
      handle: {
        sessionKey: "provider-key",
        backend: "acpx",
        cwd: "/workspace",
        acpxRecordId: "actual-record",
        backendSessionId: "backend-session",
        agentSessionId: "agent-session",
      },
      reason: "ACPX session handshake failed",
      discardPersistentState: false,
    });
    expect(
      decodeAcpxRuntimeHandleState(stalledClose.handle.runtimeSessionName),
    ).toMatchObject({ name: "actual-runtime-name", agent: "codex" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects close with asynchronous provider signal errors", async () => {
    const runtime = fakeRuntime();
    const command = fakeCommand();
    const child = failingSignalChild();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    vi.mocked(command.spawn).mockReturnValue(child.child);
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });
    runtimeOptions?.spawnAgent?.({
      command: "ignored",
      args: ["--stdio"],
      options: {},
    });

    await expect(port.close({ reason: "test complete" })).rejects.toMatchObject(
      {
        errors: [
          ...child.errors,
          expect.objectContaining({
            message: "ACPX provider did not exit after SIGKILL",
          }),
        ],
      },
    );
    expect(child.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.child.signalCode = "SIGKILL";
    child.child.emit("exit", null, "SIGKILL");
  });

  it("retains a provider error after close removes the child", async () => {
    const runtime = fakeRuntime();
    const command = fakeCommand();
    const child = fakeChild();
    const providerError = new Error("provider spawn failed");
    let runtimeOptions: AcpRuntimeOptions | undefined;
    vi.mocked(command.spawn).mockReturnValue(child);
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });
    runtimeOptions?.spawnAgent?.({
      command: "ignored",
      args: ["--stdio"],
      options: {},
    });

    child.emit("error", providerError);
    // A real ChildProcess has committed its terminal status before `close`.
    // Model that ordering so the process tracker can prove this child no
    // longer needs a cleanup signal while retaining its earlier error.
    child.exitCode = 1;
    child.emit("close", 1, null);

    await expect(port.close({ reason: "test complete" })).rejects.toMatchObject(
      {
        errors: [providerError],
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects non-Codex profiles before constructing ACPX", async () => {
    const createRuntime = vi.fn();
    await expect(
      openCodexAcpxRuntime(
        {
          ...openOptions(fakeCommand()),
          profile: {
            ...openOptions(fakeCommand()).profile,
            agent: "claude",
          },
        },
        { createRuntime },
      ),
    ).rejects.toThrow("currently supports Codex only");
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

function openOptions(
  command: VerifiedAcpxCommandLease,
): AcpxRuntimePortOpenOptions {
  return {
    command,
    profile: {
      driverKind: "acpx_runtime",
      protocolVersion: 1,
      acpxVersion: "0.13.1",
      agent: "codex",
      agentProfileVersion: 1,
      agentServerPackage: "@agentclientprotocol/codex-acp",
      agentServerVersion: "1.6.2",
      agentRuntimePackage: null,
      agentRuntimeVersion: null,
      commandDigest: "sha256:test",
      qualificationModel: "gpt-5.6-sol",
      reportedModelId: "gpt-5.6-sol",
      permissionPolicy: "interactive",
    },
    cwd: "/workspace",
    stateDirectory: "/runtime/state",
    providerSessionKey: "provider-key",
    permissionMode: "approve-reads",
    permissionPolicy: {
      autoApprove: ["read"],
      escalate: ["write"],
      defaultAction: "escalate",
    },
    launchEnvironment: {
      CODEX_HOME: "/runtime/agent-home",
      OPENAI_API_KEY: "credential-secret",
      OMITTED: undefined,
    },
    systemInstructions: "Use Paperclip tools.",
    mcpServers: [],
  };
}

function fakeRuntime(handle: AcpRuntimeHandle = HANDLE): AcpRuntime {
  return {
    ensureSession: vi.fn().mockResolvedValue(handle),
    startTurn: vi.fn(),
    runTurn: vi.fn(),
    getStatus: vi.fn(),
    setConfigOption: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
  };
}

function fakeCommand(): VerifiedAcpxCommandLease {
  return { spawn: vi.fn(), close: vi.fn() };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn(() => {
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    return true;
  });
  return child;
}

function fakeProcessGroupChild(pid: number): ChildProcess {
  const child = fakeChild();
  Object.defineProperty(child, "pid", { value: pid });
  return child;
}

function failingSignalChild(): {
  child: ChildProcess;
  errors: [Error, Error];
} {
  const child = new EventEmitter() as ChildProcess;
  const errors: [Error, Error] = [
    new Error("SIGTERM delivery failed"),
    new Error("SIGKILL delivery failed"),
  ];
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn((signal) => {
    const error = signal === "SIGTERM" ? errors[0] : errors[1];
    queueMicrotask(() => child.emit("error", error));
    return true;
  });
  return { child, errors };
}

function registry(): AcpAgentRegistry {
  return { resolve: vi.fn(), list: vi.fn() };
}

function store(): AcpSessionStore {
  return { load: vi.fn(), save: vi.fn() };
}
