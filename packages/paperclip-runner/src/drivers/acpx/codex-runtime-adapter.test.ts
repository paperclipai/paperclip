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
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
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
    const retainFailedAdmissionCleanup = vi.fn();

    await expect(
      openCodexAcpxRuntime(
        {
          ...openOptions(command),
          signal: controller.signal,
          retainFailedAdmissionCleanup,
        },
        { createRuntime },
      ),
    ).rejects.toBe(cancellation);

    expect(retainFailedAdmissionCleanup).toHaveBeenCalledOnce();
    await expect(
      retainFailedAdmissionCleanup.mock.calls[0]?.[0],
    ).resolves.toBeUndefined();
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
    expect(runtimeOptions?.elicitationModes).toEqual(["form"]);
    expect(await port.identity()).toEqual({
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
    });
  });

  it.each([["claude" as const, "claude-sonnet-5", "sonnet"]])(
    "opens the qualified %s session through the verified lease",
    async (agent, model, providerModel) => {
      const runtime = fakeRuntime();
      const command = fakeCommand();
      const options = openOptions(command);
      let runtimeOptions: AcpRuntimeOptions | undefined;
      options.profile = resolveQualifiedAcpxProfile(agent, model);
      options.launchEnvironment = { PATH: "/verified/bin" };

      await openCodexAcpxRuntime(options, {
        createRegistry: ({ overrides }) => {
          expect(overrides).toEqual({
            [agent]: ["paperclip-verified-acpx-command"],
          });
          return registry();
        },
        createStore: () => store(),
        createRuntime: (createdOptions) => {
          runtimeOptions = createdOptions;
          return runtime;
        },
      });

      expect(runtimeOptions?.spawnEnvironment?.()).toEqual({
        PATH: "/verified/bin",
        PAPERCLIP_ACPX_ISOLATED_CONTEXT: "1",
      });
      expect(runtime.ensureSession).toHaveBeenCalledWith(
        expect.objectContaining({
          agent,
          sessionOptions: expect.objectContaining({ model: providerModel }),
        }),
      );
    },
  );

  it("launches only through the verified command lease", async () => {
    const runtime = fakeRuntime();
    const command = fakeCommand();
    const child = fakeChild();
    vi.mocked(command.spawn).mockReturnValue(child);
    const spawnOptions = { cwd: "/runtime/spawn" };
    await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      awaitProviderOwnership: providerOwnershipEstablished,
      awaitProviderExit: providerOwnershipEstablished,
      createRuntime: (options) => {
        vi.mocked(runtime.ensureSession).mockImplementation(async () => {
          expect(
            options.spawnAgent?.({
              command: "/attacker/replacement",
              args: ["--stdio"],
              options: spawnOptions,
            }),
          ).toBe(child);
          return HANDLE;
        });
        return runtime;
      },
    });
    expect(command.spawn).toHaveBeenCalledWith(["--stdio"], spawnOptions, {
      credentialFenceFds: [42, 43],
      activateCredentialFenceOwner: expect.any(Function),
    });
  });

  it("revalidates a recovered workspace immediately before provider spawn", async () => {
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const command = fakeCommand();
    const workspaceSubstituted = new Error("recovered workspace substituted");
    const assertWorkspaceHeld = vi.fn(() => {
      throw workspaceSubstituted;
    });
    await openCodexAcpxRuntime(
      { ...openOptions(command), assertWorkspaceHeld },
      {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      },
    );

    expect(() =>
      runtimeOptions?.spawnAgent?.({
        command: "/attacker/replacement",
        args: ["--stdio"],
        options: {},
      }),
    ).toThrow(workspaceSubstituted);
    expect(assertWorkspaceHeld).toHaveBeenCalledOnce();
    expect(command.spawn).not.toHaveBeenCalled();
  });
  it("reads verified status from durable state without draining live updates", async () => {
    const runtime = fakeRuntime();
    vi.mocked(runtime.getStatus!).mockReturnValue(new Promise(() => {}));
    const durableRecord = {
      acpxRecordId: "record-1",
      acpSessionId: "backend-1",
      agentSessionId: "agent-1",
      acpx: {
        current_model_id: "gpt-5.6-sol",
        available_models: ["gpt-5.6-sol"],
      },
    } as never;
    const durableStore: AcpSessionStore = {
      load: vi.fn(async () => structuredClone(durableRecord)),
      save: vi.fn(),
    };
    const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
      createRegistry: () => registry(),
      createStore: () => durableStore,
      createRuntime: () => runtime,
    });

    expect(await port.getStatus()).toMatchObject({
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    });
    expect(durableStore.load).toHaveBeenCalledWith("record-1");
    expect(runtime.getStatus).not.toHaveBeenCalled();
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

  it("never overlaps a retained protocol close that has not settled", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const runtimeClose = new Promise<void>(() => {});
      vi.mocked(runtime.close)
        .mockReturnValueOnce(runtimeClose)
        .mockResolvedValueOnce(undefined);
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          return runtimeWithProvider(runtime, options);
        },
      });

      const firstClose = expect(
        port.close({ reason: "runtime close stalled" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      expect(runtime.close).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await firstClose;

      // Repeated callers inherit the same bounded observation. A permanently
      // pending exact close remains the sole protocol attempt for this handle.
      expect(runtime.close).toHaveBeenCalledOnce();
      const secondClose = expect(
        port.close({ reason: "idempotent terminal close" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await vi.advanceTimersByTimeAsync(2_000);
      await secondClose;
      expect(runtime.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a fresh close after a retained attempt rejects late", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectRuntimeClose!: (error: unknown) => void;
      const runtimeClose = new Promise<void>((_resolve, reject) => {
        rejectRuntimeClose = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(runtimeClose)
        .mockResolvedValueOnce(undefined);
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          return runtimeWithProvider(runtime, options);
        },
      });

      const firstClose = expect(
        port.close({ reason: "runtime close stalled" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await firstClose;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      const protocolFailure = new Error("late protocol close failure");
      rejectRuntimeClose(protocolFailure);
      // The late-settlement observer schedules reconciliation asynchronously.
      // Wait for that fresh attempt instead of racing another caller against
      // the already-settled retained failure.
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
      await expect(
        port.close({ reason: "retry after retained failure" }),
      ).resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "ACPX late protocol cleanup reconciliation 1",
        discardPersistentState: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a retained close only after its late failure settles", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectFirstClose!: (error: unknown) => void;
      const firstRuntimeClose = new Promise<void>((_resolve, reject) => {
        rejectFirstClose = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(firstRuntimeClose)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          return runtimeWithProvider(runtime, options);
        },
      });

      const firstClose = expect(
        port.close({ reason: "first protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await firstClose;

      const inheritedClose = expect(
        port.close({ reason: "observe pending protocol close" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await vi.advanceTimersByTimeAsync(2_000);
      await inheritedClose;
      expect(runtime.close).toHaveBeenCalledOnce();

      rejectFirstClose(new Error("older protocol close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "ACPX late protocol cleanup reconciliation 1",
        discardPersistentState: false,
      });
      await expect(
        port.close({ reason: "observe reconciled cleanup" }),
      ).resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares a pending close across concurrent callers before reconciliation", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectFirstClose!: (error: unknown) => void;
      const firstRuntimeClose = new Promise<void>((_resolve, reject) => {
        rejectFirstClose = reject;
      });
      let resolveFreshClose!: () => void;
      const freshRuntimeClose = new Promise<void>((resolve) => {
        resolveFreshClose = resolve;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(firstRuntimeClose)
        .mockReturnValueOnce(freshRuntimeClose)
        .mockResolvedValueOnce(undefined);
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          return runtimeWithProvider(runtime, options);
        },
      });

      const firstClose = expect(
        port.close({ reason: "first protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await firstClose;

      const inheritedClose = expect(
        port.close({ reason: "observe pending protocol close" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      expect(runtime.close).toHaveBeenCalledOnce();
      rejectFirstClose(new Error("retained protocol close failed"));
      await inheritedClose;
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));

      resolveFreshClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.close).toHaveBeenCalledTimes(2);
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "ACPX late protocol cleanup reconciliation 1",
        discardPersistentState: false,
      });
      await expect(
        port.close({ reason: "observe reconciled cleanup" }),
      ).resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let late settlements bypass the reconciliation retry bound", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectInitialClose!: (error: unknown) => void;
      const initialClose = new Promise<void>((_resolve, reject) => {
        rejectInitialClose = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(initialClose)
        .mockRejectedValueOnce(new Error("reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 2 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 3 failed"));
      const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
      });

      const firstClose = expect(
        port.close({ reason: "first protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
      await firstClose;
      rejectInitialClose(new Error("initial protocol close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(4));
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.close).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timed-out reconciliation failures in their originating budget", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectInitialClose!: (error: unknown) => void;
      const initialClose = new Promise<void>((_resolve, reject) => {
        rejectInitialClose = reject;
      });
      const reconciliationRejectors: Array<(error: unknown) => void> = [];
      const reconciliationAttempts = Array.from(
        { length: 3 },
        () =>
          new Promise<void>((_resolve, reject) => {
            reconciliationRejectors.push(reject);
          }),
      );
      vi.mocked(runtime.close)
        .mockReturnValueOnce(initialClose)
        .mockReturnValueOnce(reconciliationAttempts[0]!)
        .mockReturnValueOnce(reconciliationAttempts[1]!)
        .mockReturnValueOnce(reconciliationAttempts[2]!)
        .mockResolvedValueOnce(undefined);
      const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        runtimeCloseTimeoutMs: 1,
      });

      const firstClose = expect(
        port.close({ reason: "external protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await firstClose;
      rejectInitialClose(new Error("external close failed late"));

      for (let index = 0; index < reconciliationRejectors.length; index += 1) {
        await vi.waitFor(() =>
          expect(runtime.close).toHaveBeenCalledTimes(index + 2),
        );
        expect(runtime.close).toHaveBeenLastCalledWith({
          handle: HANDLE,
          reason: `ACPX late protocol cleanup reconciliation ${index + 1}`,
          discardPersistentState: false,
        });
        const overlappingExternalClose =
          index === 0
            ? expect(
                port.close({
                  reason: "external observer of reconciliation",
                }),
              ).rejects.toThrow("ACPX runtime and provider cleanup failed")
            : null;
        // The external observer coalesces onto reconciliation attempt one. It
        // must not relabel that immutable attempt as an external generation.
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        if (overlappingExternalClose) await overlappingExternalClose;
        reconciliationRejectors[index]!(
          new Error(`reconciliation ${index + 1} failed late`),
        );
      }

      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(runtime.close).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews one budget when an external close joins the final reconciliation", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectInitialClose!: (error: unknown) => void;
      const initialClose = new Promise<void>((_resolve, reject) => {
        rejectInitialClose = reject;
      });
      let rejectFinalReconciliation!: (error: unknown) => void;
      const finalReconciliation = new Promise<void>((_resolve, reject) => {
        rejectFinalReconciliation = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(initialClose)
        .mockRejectedValueOnce(new Error("reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 2 failed"))
        .mockReturnValueOnce(finalReconciliation)
        .mockResolvedValueOnce(undefined);
      const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        runtimeCloseTimeoutMs: 1,
      });

      const initialObserver = expect(
        port.close({ reason: "external protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await initialObserver;
      rejectInitialClose(new Error("external close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(4));

      const finalObserver = expect(
        port.close({ reason: "external observer of final reconciliation" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await finalObserver;
      expect(runtime.close).toHaveBeenCalledTimes(4);

      rejectFinalReconciliation(new Error("final reconciliation failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(5));
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "ACPX late protocol cleanup reconciliation 1",
        discardPersistentState: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.close).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches coalesced external closes when the final reconciliation fails", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectInitialClose!: (error: unknown) => void;
      const initialClose = new Promise<void>((_resolve, reject) => {
        rejectInitialClose = reject;
      });
      let rejectFinalReconciliation!: (error: unknown) => void;
      const finalReconciliation = new Promise<void>((_resolve, reject) => {
        rejectFinalReconciliation = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(initialClose)
        .mockRejectedValueOnce(new Error("reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 2 failed"))
        .mockReturnValueOnce(finalReconciliation)
        .mockRejectedValueOnce(new Error("renewed reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("renewed reconciliation 2 failed"))
        .mockRejectedValueOnce(new Error("renewed reconciliation 3 failed"));
      const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        runtimeCloseTimeoutMs: 1,
      });

      const initialObserver = expect(
        port.close({ reason: "external protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await initialObserver;
      rejectInitialClose(new Error("external close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(4));

      const coalescedObservers = ["first", "second", "third"].map((label) =>
        expect(
          port.close({ reason: `${label} external observer` }),
        ).rejects.toThrow("ACPX runtime and provider cleanup failed"),
      );
      rejectFinalReconciliation(
        new Error("final reconciliation failed with joined observers"),
      );
      expect(runtime.close).toHaveBeenCalledTimes(4);
      await Promise.all(coalescedObservers);
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(7));
      expect(
        vi
          .mocked(runtime.close)
          .mock.calls.slice(4)
          .map(([input]) => input.reason),
      ).toEqual([
        "ACPX late protocol cleanup reconciliation 1",
        "ACPX late protocol cleanup reconciliation 2",
        "ACPX late protocol cleanup reconciliation 3",
      ]);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(runtime.close).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes an external intent when a timed-out final reconciliation succeeds late", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectInitialClose!: (error: unknown) => void;
      const initialClose = new Promise<void>((_resolve, reject) => {
        rejectInitialClose = reject;
      });
      let resolveFinalReconciliation!: () => void;
      const finalReconciliation = new Promise<void>((resolve) => {
        resolveFinalReconciliation = resolve;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(initialClose)
        .mockRejectedValueOnce(new Error("reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 2 failed"))
        .mockReturnValueOnce(finalReconciliation);
      const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        runtimeCloseTimeoutMs: 1,
      });

      const initialObserver = expect(
        port.close({ reason: "external protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await initialObserver;
      rejectInitialClose(new Error("external close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(4));

      const finalObserver = expect(
        port.close({
          reason: "external observer of successful reconciliation",
        }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await finalObserver;
      expect(runtime.close).toHaveBeenCalledTimes(4);

      resolveFinalReconciliation();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(runtime.close).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews an external intent when bounded protocol success cannot terminate the provider", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectInitialClose!: (error: unknown) => void;
      const initialClose = new Promise<void>((_resolve, reject) => {
        rejectInitialClose = reject;
      });
      let resolveFinalReconciliation!: () => void;
      const finalReconciliation = new Promise<void>((resolve) => {
        resolveFinalReconciliation = resolve;
      });
      let resolveFinalReconciliationStarted!: () => void;
      const finalReconciliationStarted = new Promise<void>((resolve) => {
        resolveFinalReconciliationStarted = resolve;
      });
      let resolveRenewedReconciliation!: () => void;
      const renewedReconciliation = new Promise<void>((resolve) => {
        resolveRenewedReconciliation = resolve;
      });
      let resolveRenewedReconciliationStarted!: () => void;
      const renewedReconciliationStarted = new Promise<void>((resolve) => {
        resolveRenewedReconciliationStarted = resolve;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(initialClose)
        .mockRejectedValueOnce(new Error("reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 2 failed"))
        .mockImplementationOnce(() => {
          resolveFinalReconciliationStarted();
          return finalReconciliation;
        })
        .mockImplementationOnce(() => {
          resolveRenewedReconciliationStarted();
          return renewedReconciliation;
        });
      const child = failingSignalChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child.child);
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          return runtimeWithProvider(runtime, options);
        },
        runtimeCloseTimeoutMs: 1,
      });

      const initialObserver = expect(
        port.close({ reason: "external protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await initialObserver;
      rejectInitialClose(new Error("external close failed late"));
      await finalReconciliationStarted;
      expect(runtime.close).toHaveBeenCalledTimes(4);

      const finalObserver = expect(
        port.close({ reason: "external observer of failed process cleanup" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      resolveFinalReconciliation();
      await finalObserver;
      await renewedReconciliationStarted;
      expect(runtime.close).toHaveBeenCalledTimes(5);
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "ACPX late protocol cleanup reconciliation 1",
        discardPersistentState: false,
      });
      child.child.signalCode = "SIGKILL";
      child.child.emit("exit", null, "SIGKILL");
      resolveRenewedReconciliation();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(runtime.close).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews an external intent when late protocol success follows process cleanup failure", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectInitialClose!: (error: unknown) => void;
      const initialClose = new Promise<void>((_resolve, reject) => {
        rejectInitialClose = reject;
      });
      let resolveFinalReconciliation!: () => void;
      const finalReconciliation = new Promise<void>((resolve) => {
        resolveFinalReconciliation = resolve;
      });
      let resolveFinalReconciliationStarted!: () => void;
      const finalReconciliationStarted = new Promise<void>((resolve) => {
        resolveFinalReconciliationStarted = resolve;
      });
      let resolveRenewedReconciliationStarted!: () => void;
      const renewedReconciliationStarted = new Promise<void>((resolve) => {
        resolveRenewedReconciliationStarted = resolve;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(initialClose)
        .mockRejectedValueOnce(new Error("reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 2 failed"))
        .mockImplementationOnce(() => {
          resolveFinalReconciliationStarted();
          return finalReconciliation;
        })
        .mockImplementationOnce(() => {
          resolveRenewedReconciliationStarted();
          return Promise.resolve();
        });
      const child = failingSignalChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child.child);
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          return runtimeWithProvider(runtime, options);
        },
        runtimeCloseTimeoutMs: 1,
      });

      const initialObserver = expect(
        port.close({ reason: "external protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await initialObserver;
      rejectInitialClose(new Error("external close failed late"));
      await finalReconciliationStarted;
      expect(runtime.close).toHaveBeenCalledTimes(4);

      const finalObserver = expect(
        port.close({ reason: "external observer of failed process cleanup" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(4_000);
      await finalObserver;
      expect(runtime.close).toHaveBeenCalledTimes(4);

      child.child.signalCode = "SIGKILL";
      child.child.emit("exit", null, "SIGKILL");
      resolveFinalReconciliation();
      await renewedReconciliationStarted;
      expect(runtime.close).toHaveBeenCalledTimes(5);
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "ACPX late protocol cleanup reconciliation 1",
        discardPersistentState: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.close).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one reconciliation budget across repeated bounded observers", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectRetainedClose!: (error: unknown) => void;
      const retainedClose = new Promise<void>((_resolve, reject) => {
        rejectRetainedClose = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(retainedClose)
        .mockRejectedValueOnce(new Error("reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 2 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 3 failed"));
      const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        runtimeCloseTimeoutMs: 1,
      });

      for (const reason of [
        "first observer",
        "second observer",
        "third observer",
      ]) {
        const close = expect(port.close({ reason })).rejects.toThrow(
          "ACPX runtime and provider cleanup failed",
        );
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        await close;
      }
      expect(runtime.close).toHaveBeenCalledOnce();
      rejectRetainedClose(new Error("retained close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(4));
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.close).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each late failure generation a bounded reconciliation budget", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let rejectInitialClose!: (error: unknown) => void;
      const initialClose = new Promise<void>((_resolve, reject) => {
        rejectInitialClose = reject;
      });
      let rejectNewerClose!: (error: unknown) => void;
      const newerClose = new Promise<void>((_resolve, reject) => {
        rejectNewerClose = reject;
      });
      vi.mocked(runtime.close)
        .mockReturnValueOnce(initialClose)
        .mockRejectedValueOnce(new Error("reconciliation 1 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 2 failed"))
        .mockRejectedValueOnce(new Error("reconciliation 3 failed"))
        .mockReturnValueOnce(newerClose)
        .mockResolvedValueOnce(undefined);
      const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        runtimeCloseTimeoutMs: 1,
      });

      const firstClose = expect(
        port.close({ reason: "first protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await firstClose;
      rejectInitialClose(new Error("initial close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(4));
      await vi.advanceTimersByTimeAsync(0);

      const secondClose = expect(
        port.close({ reason: "newer protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await secondClose;
      expect(runtime.close).toHaveBeenCalledTimes(5);

      rejectNewerClose(new Error("newer close failed late"));
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(6));
      expect(runtime.close).toHaveBeenLastCalledWith({
        handle: HANDLE,
        reason: "ACPX late protocol cleanup reconciliation 1",
        discardPersistentState: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a retained protocol close terminal when it succeeds late", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      let resolveRetainedClose!: () => void;
      const retainedClose = new Promise<void>((resolve) => {
        resolveRetainedClose = resolve;
      });
      vi.mocked(runtime.close).mockReturnValueOnce(retainedClose);
      const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: () => runtime,
        runtimeCloseTimeoutMs: 1,
      });

      const close = expect(
        port.close({ reason: "protocol close stalls" }),
      ).rejects.toThrow("ACPX runtime and provider cleanup failed");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      await close;
      expect(runtime.close).toHaveBeenCalledOnce();

      resolveRetainedClose();
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        port.close({ reason: "observe late success" }),
      ).resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains cleanup after guardian exit until provider exit is proven", async () => {
    const runtime = fakeRuntime();
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    let proveProviderExit!: () => void;
    const providerExit = new Promise<void>((resolve) => {
      proveProviderExit = resolve;
    });
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      awaitProviderOwnership: providerOwnershipEstablished,
      awaitProviderExit: async () => await providerExit,
      createRuntime: (options) => runtimeWithProvider(runtime, options),
    });

    let settled = false;
    const closing = port.close({ reason: "guardian exited first" });
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    await Promise.resolve();

    expect(child.signalCode).toBe("SIGTERM");
    expect(settled).toBe(false);

    proveProviderExit();
    await expect(closing).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("kills a TERM-resistant provider through its live guardian", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const child = childThatExitsOnKill();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          return runtimeWithProvider(runtime, options);
        },
      });

      const closing = expect(
        port.close({ reason: "provider ignored shutdown" }),
      ).rejects.toMatchObject({
        errors: [
          expect.objectContaining({
            message: "ACPX provider did not exit after SIGTERM",
          }),
        ],
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await closing;

      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(child.signalCode).toBe("SIGKILL");
      // Cleanup never transfers a copied numeric PGID or releases local
      // ownership before the verified guardian's exit is observed.
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains local ownership when guardian group exit cannot be confirmed", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const child = stubbornChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          return runtimeWithProvider(runtime, options);
        },
      });

      const closing = expect(
        port.close({ reason: "provider group exit unconfirmed" }),
      ).rejects.toMatchObject({
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: "ACPX provider did not exit after SIGKILL",
          }),
        ]),
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await closing;

      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Windows before runtime construction or provider spawn", async () => {
    const command = fakeCommand();
    const createRuntime = vi.fn(() => fakeRuntime());

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        platform: "win32",
        createRuntime,
      }),
    ).rejects.toThrow(
      "The production ACPX runtime is unavailable on Windows because verified provider launch requires atomic no-follow file opening",
    );

    expect(createRuntime).not.toHaveBeenCalled();
    expect(command.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["one fence", [42]],
    ["duplicate fences", [42, 42]],
    ["an invalid fence", [42, -1]],
  ])("rejects %s before runtime construction", async (_label, fences) => {
    const command = fakeCommand();
    const createRuntime = vi.fn(() => fakeRuntime());

    await expect(
      openCodexAcpxRuntime(
        {
          ...openOptions(command),
          credentialFenceFds: fences as unknown as readonly [number, number],
        },
        { createRuntime },
      ),
    ).rejects.toThrow(
      "The production ACPX runtime requires an inherited provider-lifetime fence",
    );

    expect(createRuntime).not.toHaveBeenCalled();
    expect(command.spawn).not.toHaveBeenCalled();
  });

  it("rejects a missing credential owner activation callback", async () => {
    const command = fakeCommand();
    const createRuntime = vi.fn(() => fakeRuntime());

    await expect(
      openCodexAcpxRuntime(
        {
          ...openOptions(command),
          activateCredentialFenceOwner: null,
        },
        { createRuntime },
      ),
    ).rejects.toThrow(
      "The production ACPX runtime requires an inherited provider-lifetime fence",
    );

    expect(createRuntime).not.toHaveBeenCalled();
    expect(command.spawn).not.toHaveBeenCalled();
  });

  it("rejects and independently cleans providers spawned during termination", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const firstChild = childThatExitsOnKill();
      const lateChild = childThatExitsOnKill();
      const command = fakeCommand();
      vi.mocked(command.spawn)
        .mockReturnValueOnce(firstChild)
        .mockReturnValueOnce(lateChild);
      const retainedCleanups: Promise<void>[] = [];
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const port = await openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderOwnership: providerOwnershipEstablished,
        awaitProviderExit: providerOwnershipEstablished,
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtimeWithProvider(runtime, options);
        },
      });

      let settled = false;
      const closing = port.close({ reason: "join late provider" }).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(() =>
        runtimeOptions?.spawnAgent?.({
          command: "ignored",
          args: ["--stdio"],
          options: {},
        }),
      ).toThrow("provider spawned after cleanup was sealed");
      expect(lateChild.kill).toHaveBeenCalledWith("SIGKILL");
      expect(retainedCleanups).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");
      await closing;
      await retainedCleanups[0];
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
    const onElicitation = vi.fn();

    const admittedTurn = port.startTurn({
      text: "Complete the task.",
      requestId: "turn-1",
      signal,
      onElicitation,
    });
    expect(admittedTurn.requestId).toBe(turn.requestId);
    await expect(admittedTurn.promptStarted).resolves.toBeUndefined();
    await expect(admittedTurn.result).resolves.toEqual({ status: "completed" });
    expect(runtime.startTurn).toHaveBeenCalledWith({
      handle: HANDLE,
      text: "Complete the task.",
      mode: "prompt",
      requestId: "turn-1",
      signal,
      onElicitation,
    });
  });

  it("admits a verified provider that starts with the first recovered turn", async () => {
    const runtime = fakeRuntime();
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    let runtimeOptions: AcpRuntimeOptions | undefined;
    let resolvePromptStarted: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      resolvePromptStarted = resolve;
    });
    const rawTurn = {
      requestId: "turn-recovered",
      promptStarted,
      events: { async *[Symbol.asyncIterator]() {} },
      result: new Promise<never>(() => undefined),
      cancel: vi.fn(),
      closeStream: vi.fn(),
    };
    vi.mocked(runtime.startTurn).mockImplementation(() => {
      queueMicrotask(() => {
        runtimeOptions?.spawnAgent?.({
          command: "ignored",
          args: ["--stdio"],
          options: {},
        });
        resolvePromptStarted?.();
      });
      return rawTurn;
    });
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      awaitProviderOwnership: providerOwnershipEstablished,
      awaitProviderExit: providerOwnershipEstablished,
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });

    const turn = port.startTurn({
      text: "Resume the task.",
      requestId: "turn-recovered",
    });
    await expect(turn.promptStarted).resolves.toBeUndefined();
    expect(command.spawn).toHaveBeenCalledTimes(1);
    expect(() =>
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      }),
    ).toThrow("provider spawned after ownership admission was sealed");
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

  it.each([
    ["codex", "gpt-5.6-sol", "approve-all", { outcome: "allow_once" }],
    ["codex", "gpt-5.6-sol", "approve-reads", undefined],
    ["codex", "gpt-5.6-sol", "deny-all", { outcome: "reject_once" }],
    ["claude", "claude-sonnet-5", "approve-all", { outcome: "allow_once" }],
    ["claude", "claude-sonnet-5", "approve-reads", undefined],
    ["claude", "claude-sonnet-5", "deny-all", { outcome: "reject_once" }],
  ] as const)(
    "applies the %s/%s ACPX profile's %s mode without an implicit prompt bridge",
    async (agent, model, permissionMode, expected) => {
      const runtime = fakeRuntime();
      let runtimeOptions: AcpRuntimeOptions | undefined;
      const options = openOptions(fakeCommand());
      options.profile = resolveQualifiedAcpxProfile(agent, model);
      options.permissionMode = permissionMode;
      const port = await openCodexAcpxRuntime(options, {
        createRegistry: () => registry(),
        createStore: () => store(),
        createRuntime: (createdOptions) => {
          runtimeOptions = createdOptions;
          return runtime;
        },
      });

      expect(runtimeOptions?.nonInteractivePermissions).toBe("fail");
      await expect(
        runtimeOptions?.onPermissionRequest?.(
          {
            sessionId: "session-1",
            inferredKind: "write",
            raw: {},
          },
          { signal: new AbortController().signal },
        ),
      ).resolves.toEqual(expected);
      await port.close({ reason: "permission policy verified" });
    },
  );

  it("uses the real ACP session when no second agent identity is advertised", async () => {
    const runtime = fakeRuntime({ ...HANDLE, agentSessionId: undefined });
    const durableStore: AcpSessionStore = {
      load: vi.fn(async () =>
        structuredClone({
          acpxRecordId: "record-1",
          acpSessionId: "backend-1",
          acpx: { current_model_id: "gpt-5.6-sol" },
        } as never),
      ),
      save: vi.fn(),
    };
    const port = await openCodexAcpxRuntime(openOptions(fakeCommand()), {
      createRegistry: () => registry(),
      createStore: () => durableStore,
      createRuntime: () => runtime,
    });

    await expect(port.identity()).resolves.toEqual({
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "backend-1",
    });
    await expect(port.getStatus()).resolves.toMatchObject({
      backendSessionId: "backend-1",
      agentSessionId: "backend-1",
      models: { currentModelId: "gpt-5.6-sol" },
    });
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("bounds invalid-identity cleanup before terminating the provider", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime({
        ...HANDLE,
        backendSessionId: undefined,
        agentSessionId: undefined,
      });
      vi.mocked(runtime.close).mockImplementation(
        () => new Promise<void>(() => undefined),
      );
      const child = fakeChild();
      const command = fakeCommand();
      vi.mocked(command.spawn).mockReturnValue(child);
      const opening = openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => ({
          ...runtime,
          ensureSession: vi.fn(async () => {
            options.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            return {
              ...HANDLE,
              backendSessionId: undefined,
              agentSessionId: undefined,
            };
          }),
        }),
      });
      const rejected = expect(opening).rejects.toThrow(
        "identity validation and cleanup failed",
      );

      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
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
        awaitProviderExit: providerOwnershipEstablished,
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
        awaitProviderExit: providerOwnershipEstablished,
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
    const retainedAdmissionCleanups: Promise<void>[] = [];

    const opening = openCodexAcpxRuntime(
      {
        ...openOptions(fakeCommand()),
        signal: controller.signal,
        retainFailedAdmissionCleanup: (cleanup) =>
          retainedAdmissionCleanups.push(cleanup),
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
    expect(retainedAdmissionCleanups).toHaveLength(1);
    resolveHandshake?.(HANDLE);

    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
    await expect(retainedAdmissionCleanups[0]).resolves.toBeUndefined();
    expect(vi.mocked(runtime.close).mock.calls[0]?.[0]).toEqual({
      handle: HANDLE,
      reason: "ACPX runtime admission aborted",
      discardPersistentState: false,
    });
    expect(vi.mocked(runtime.close).mock.calls[1]?.[0]).toEqual(
      vi.mocked(runtime.close).mock.calls[0]?.[0],
    );
  });

  it("terminalizes a never-settling late close without overlapping it", async () => {
    let resolveHandshake: ((handle: AcpRuntimeHandle) => void) | undefined;
    const blockedHandshake = new Promise<AcpRuntimeHandle>((resolve) => {
      resolveHandshake = resolve;
    });
    const runtime = fakeRuntime();
    vi.mocked(runtime.ensureSession).mockReturnValue(blockedHandshake);
    vi.mocked(runtime.close).mockImplementation(
      () => new Promise<void>(() => undefined),
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
    // The exact late-handshake owner and the host-facing aggregate proof are
    // distinct retained promises over the same cleanup obligation.
    expect(retainedCleanups).toHaveLength(2);
    resolveHandshake?.(HANDLE);

    await expect(retainedCleanups[0]).rejects.toMatchObject({
      name: "AcpxRuntimeCloseFinalTimeoutError",
    });
    expect(runtime.close).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));
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

  it("exhausts the full retained admission close retry budget", async () => {
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
    vi.mocked(runtime.close).mockRejectedValue(closeFailure);
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
    expect(retainedCleanups).toHaveLength(3);
    const recoveryOutcome = retainedCleanups[0]!.catch(
      (error: unknown) => error,
    );
    const compositeOutcome = retainedCleanups[2]!.catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(4));
    await expect(recoveryOutcome).resolves.toMatchObject({
      message: "ACPX failed-admission cleanup exhausted 3 retry attempts",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.close).toHaveBeenCalledTimes(4);

    rejectHandshake?.(new Error("test handshake stopped"));
    await expect(retainedCleanups[1]).resolves.toBeUndefined();
    await expect(compositeOutcome).resolves.toMatchObject({
      message: "ACPX failed-admission cleanup exhausted 3 retry attempts",
    });
  });

  it("aggregates asynchronous provider signal errors after a failed handshake", async () => {
    const child = failingSignalChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child.child);
    const handshakeError = new Error("ACP handshake rejected");
    const runtime = fakeRuntime();
    const retainedCleanups: Promise<void>[] = [];

    const result = openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      awaitProviderExit: providerOwnershipEstablished,
      retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
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
        child.errors[0],
        expect.objectContaining({
          message: "ACPX provider did not exit after SIGTERM",
        }),
        child.errors[1],
        expect.objectContaining({
          message: "ACPX provider did not exit after SIGKILL",
        }),
      ],
    });
    expect(child.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(retainedCleanups).toHaveLength(1);
    child.child.signalCode = "SIGKILL";
    child.child.emit("exit", null, "SIGKILL");
    await expect(retainedCleanups[0]).resolves.toBeUndefined();
  });

  it("retains failed-admission cleanup until the provider exits", async () => {
    const child = childThatExitsAfterSignalCalls(12);
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const handshakeError = new Error("ACP handshake rejected");
    const runtime = fakeRuntime();
    const retainedCleanups: Promise<void>[] = [];

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        awaitProviderExit: providerOwnershipEstablished,
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
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
      }),
    ).rejects.toThrow("session handshake and runtime cleanup failed");

    expect(retainedCleanups).toHaveLength(1);
    await expect(retainedCleanups[0]).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(12);
    expect(child.signalCode).toBe("SIGKILL");
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
    expect(failure).toMatchObject({ code: "ACPX_SESSION_ENSURE_FAILED" });
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
        awaitProviderExit: providerOwnershipEstablished,
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

  it("waits for a timed-out admission close before retrying it sequentially", async () => {
    let rejectFirstClose!: (error: Error) => void;
    const firstClose = new Promise<void>((_resolve, reject) => {
      rejectFirstClose = reject;
    });
    const runtime = fakeRuntime();
    vi.mocked(runtime.close)
      .mockImplementationOnce(() => firstClose)
      .mockResolvedValueOnce(undefined);
    const retainedCleanups: Promise<void>[] = [];

    await expect(
      openCodexAcpxRuntime(openOptions(fakeCommand()), {
        createRegistry: () => registry(),
        createStore: () => store(),
        runtimeCloseTimeoutMs: 1,
        retainCleanup: (cleanup) => retainedCleanups.push(cleanup),
        createRuntime: (runtimeOptions) => {
          vi.mocked(runtime.ensureSession).mockImplementation(async () => {
            await runtimeOptions.sessionStore.save({
              acpxRecordId: "retry-record",
              acpSessionId: "retry-backend-session",
              agentSessionId: "retry-agent-session",
              name: "retry-runtime-name",
              cwd: "/workspace",
            } as never);
            throw new Error("handshake failed before cleanup retry");
          });
          return runtime;
        },
      }),
    ).rejects.toThrow("session handshake and runtime cleanup failed");

    expect(runtime.close).toHaveBeenCalledOnce();
    expect(retainedCleanups).toHaveLength(1);
    let recoverySettled = false;
    void retainedCleanups[0]!.then(() => {
      recoverySettled = true;
    });
    await Promise.resolve();
    expect(recoverySettled).toBe(false);

    rejectFirstClose(new Error("late first close failure"));
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(2));
    await expect(retainedCleanups[0]).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(runtime.close).toHaveBeenCalledTimes(2);
    expect(runtime.close).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        reason: "ACPX session handshake failed",
        discardPersistentState: false,
      }),
    );
  });

  it("rejects close with asynchronous provider signal errors", async () => {
    const runtime = fakeRuntime();
    const command = fakeCommand();
    const child = failingSignalChild();
    vi.mocked(command.spawn).mockReturnValue(child.child);
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      awaitProviderOwnership: providerOwnershipEstablished,
      awaitProviderExit: providerOwnershipEstablished,
      createRuntime: (options) => {
        return runtimeWithProvider(runtime, options);
      },
    });

    await expect(port.close({ reason: "test complete" })).rejects.toMatchObject(
      {
        errors: [
          child.errors[0],
          expect.objectContaining({
            message: "ACPX provider did not exit after SIGTERM",
          }),
          child.errors[1],
          expect.objectContaining({
            message: "ACPX provider did not exit after SIGKILL",
          }),
        ],
      },
    );
    expect(child.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.child.kill).toHaveBeenCalledTimes(2);
    child.child.signalCode = "SIGKILL";
    child.child.emit("exit", null, "SIGKILL");
  });

  it("retains a provider error after close removes the child", async () => {
    const runtime = fakeRuntime();
    const command = fakeCommand();
    const child = fakeChild();
    const providerError = new Error("provider spawn failed");
    vi.mocked(command.spawn).mockReturnValue(child);
    const port = await openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      awaitProviderOwnership: providerOwnershipEstablished,
      awaitProviderExit: providerOwnershipEstablished,
      createRuntime: (options) => {
        return runtimeWithProvider(runtime, options);
      },
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

  it("propagates ownership failure from a provider spawned during verification", async () => {
    const firstChild = fakeChild();
    const racingChild = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn)
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(racingChild);
    let resolveFirstOwnership!: () => void;
    const firstOwnership = new Promise<void>((resolve) => {
      resolveFirstOwnership = resolve;
    });
    const racingOwnershipFailure = new Error(
      "racing guardian ownership failed",
    );
    const runtime = fakeRuntime();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const awaitProviderOwnership = vi.fn((child: ChildProcess) => {
      if (child !== firstChild) return Promise.reject(racingOwnershipFailure);
      return firstOwnership.then(() => {
        // This callback runs while verification still awaits its initial
        // ownership batch, reproducing the exact append-after-splice race.
        runtimeOptions?.spawnAgent?.({
          command: "ignored",
          args: ["--stdio"],
          options: {},
        });
      });
    });
    vi.mocked(runtime.ensureSession).mockImplementation(async () => {
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      });
      return HANDLE;
    });

    const opening = openCodexAcpxRuntime(openOptions(command), {
      createRegistry: () => registry(),
      createStore: () => store(),
      awaitProviderOwnership,
      awaitProviderExit: providerOwnershipEstablished,
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime;
      },
    });
    await vi.waitFor(() =>
      expect(awaitProviderOwnership).toHaveBeenCalledOnce(),
    );
    resolveFirstOwnership();

    await expect(opening).rejects.toBe(racingOwnershipFailure);
    expect(awaitProviderOwnership).toHaveBeenCalledTimes(2);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(racingChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds a stalled session handshake and terminates its provider", async () => {
    const child = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn).mockReturnValue(child);
    const runtime = fakeRuntime();

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        sessionHandshakeTimeoutMs: 1,
        awaitProviderExit: providerOwnershipEstablished,
        createRuntime: (options) => {
          vi.mocked(runtime.ensureSession).mockImplementation(() => {
            options.spawnAgent?.({
              command: "ignored",
              args: ["--stdio"],
              options: {},
            });
            return new Promise<AcpRuntimeHandle>(() => undefined);
          });
          return runtime;
        },
      }),
    ).rejects.toThrow("session handshake exceeded its admission deadline");
    expect(runtime.close).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects provider children created after handshake cleanup is sealed", async () => {
    const child = fakeChild();
    const postCleanupChild = fakeChild();
    const command = fakeCommand();
    vi.mocked(command.spawn)
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(postCleanupChild);
    const runtime = fakeRuntime();
    const retainCleanup = vi.fn<(cleanup: Promise<void>) => void>();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    let resolveHandshake: ((handle: AcpRuntimeHandle) => void) | undefined;
    vi.mocked(runtime.ensureSession).mockImplementation(
      () =>
        new Promise<AcpRuntimeHandle>((resolve) => {
          resolveHandshake = resolve;
        }),
    );

    await expect(
      openCodexAcpxRuntime(openOptions(command), {
        createRegistry: () => registry(),
        createStore: () => store(),
        sessionHandshakeTimeoutMs: 1,
        awaitProviderExit: providerOwnershipEstablished,
        retainCleanup,
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime;
        },
      }),
    ).rejects.toThrow("session handshake exceeded its admission deadline");

    expect(retainCleanup).toHaveBeenCalledTimes(2);
    const lateHandshakeCleanup = retainCleanup.mock.calls[0]?.[0];
    const cleanupProof = retainCleanup.mock.calls[1]?.[0];
    expect(lateHandshakeCleanup).toBeDefined();
    expect(cleanupProof).toBeDefined();

    expect(() =>
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      }),
    ).toThrow("provider spawned after cleanup was sealed");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(retainCleanup).toHaveBeenCalledTimes(3);
    await retainCleanup.mock.calls[2]?.[0];
    resolveHandshake?.(HANDLE);

    await lateHandshakeCleanup;
    await cleanupProof;
    expect(runtime.close).toHaveBeenCalledWith({
      handle: HANDLE,
      reason: "ACPX session handshake completed after its admission deadline",
      discardPersistentState: false,
    });
    expect(() =>
      runtimeOptions?.spawnAgent?.({
        command: "ignored",
        args: ["--stdio"],
        options: {},
      }),
    ).toThrow("provider spawned after cleanup was sealed");
    expect(postCleanupChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(retainCleanup).toHaveBeenCalledTimes(4);
    await retainCleanup.mock.calls[3]?.[0];
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
    // Fake command leases do not inherit these descriptors; production host
    // supplies both live credential-quorum listener descriptors.
    credentialFenceFds: [42, 43] as const,
    activateCredentialFenceOwner: async () => undefined,
    systemInstructions: "Use Paperclip tools.",
    mcpServers: [],
    retainFailedAdmissionCleanup: vi.fn(),
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

function runtimeWithProvider(
  runtime: AcpRuntime,
  options: AcpRuntimeOptions,
): AcpRuntime {
  vi.mocked(runtime.ensureSession).mockImplementationOnce(async () => {
    options.spawnAgent?.({
      command: "ignored",
      args: ["--stdio"],
      options: {},
    });
    return HANDLE;
  });
  return runtime;
}

async function providerOwnershipEstablished(): Promise<void> {}

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
  child.unref = vi.fn(() => child);
  return { child, errors };
}

function childThatExitsAfterSignalCalls(exitAfter: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    const calls = vi.mocked(child.kill).mock.calls.length;
    if (calls >= exitAfter) {
      child.signalCode = signal as NodeJS.Signals;
      queueMicrotask(() => child.emit("exit", null, signal));
    } else {
      queueMicrotask(() =>
        child.emit("error", new Error(`signal attempt ${calls} failed`)),
      );
    }
    return true;
  });
  child.unref = vi.fn(() => child);
  return child;
}

function stubbornChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    pid: { value: 71_001 },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
    stdin: { value: { destroy: vi.fn() } },
    stdout: { value: { destroy: vi.fn() } },
    stderr: { value: { destroy: vi.fn() } },
  });
  child.kill = vi.fn(() => true);
  child.unref = vi.fn(() => child);
  return child;
}

function childThatExitsOnKill(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    pid: { value: 71_002 },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") {
      child.signalCode = "SIGKILL";
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    }
    return true;
  });
  child.unref = vi.fn(() => child);
  return child;
}

function registry(): AcpAgentRegistry {
  return { resolve: vi.fn(), list: vi.fn() };
}

function store(): AcpSessionStore {
  return { load: vi.fn(), save: vi.fn() };
}
