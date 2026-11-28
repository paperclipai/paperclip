// Backlog-suspension & real OpenCode proxy boundary tests split out of
// runnerd-codex-transport.test.ts so Vitest schedules them in parallel with the
// core transport suite instead of serializing them on one worker.
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { configuredEnvironmentProjection } from "../configured-environment.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createCodexTaskEnvelope } from "../contracts/codex.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import {
  createCapabilityRunnerdCodexTransport,
  readRunnerdArtifactBinding,
} from "./runnerd-codex-transport.js";
import {
  defaultCapabilityRunnerdBinary,
  fakeCodex,
  fakeCodexArgs,
} from "../../test/support/runnerd-transport.js";

it("continues rehydrating events after the committed-event window slides", async () => {
  const stateDirectory = await mkdtemp(
    join(tmpdir(), "runnerd-sliding-event-window-"),
  );
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory, "--split-event-burst"),
    stateDirectory,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
  });
  bundle.transport.setServerRequestHandler(async () => ({
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ ok: true, result: { task: { id: "task-1" } } }),
      },
    ],
  }));
  try {
    await bundle.transport.request("initialize", {});
    await bundle.transport.request("thread/start", {
      cwd: tmpdir(),
      dynamicTools: [
        {
          name: "get_task_context",
          description: "Read the active task.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    await bundle.transport.request("turn/start", {
      input: [{ type: "text", text: "Emit a split event burst." }],
    });
    const notifications = bundle.transport
      .notifications()
      [Symbol.asyncIterator]();
    const methods: string[] = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        notifications.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("sliding event window notification timeout")),
            10_000,
          ),
        ),
      ]);
      if (!next.value) break;
      methods.push(next.value.method);
      if (next.value.method === "turn/completed") break;
    }
    expect(
      methods.filter((method) => method === "item/agentMessage/delta"),
    ).toHaveLength(144);
    expect(methods).toContain("turn/completed");
  } finally {
    await bundle.transport.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it.each([
  { suffixCount: 48, suffixLifecycle: null },
  { suffixCount: 1024, suffixLifecycle: "settled-before-output" },
  { suffixCount: 1024, suffixLifecycle: "active-after-output" },
] as const)(
  "proves local suspension after an event backlog before rebinding the next run ($suffixCount suffix deltas; $suffixLifecycle)",
  async ({ suffixCount, suffixLifecycle }) => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "runnerd-local-close-backlog-"),
    );
    let closePhase = "before-first-close";
    let closeStartedAt = 0;
    let preserveFailedState = false;
    const readClosedState = async (relativePath: string) => {
      try {
        const value: unknown = JSON.parse(
          await readFile(join(stateDirectory, relativePath), "utf8"),
        );
        return value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    };
    const readCloseDiagnostic = async () => {
      const runner = await readClosedState("runner/runner-state.json");
      const provider = await readClosedState(
        "runner/codex-provider-state.json",
      );
      const control = await readClosedState(
        "control-plane/control-plane-state.json",
      );
      const commands: Record<string, unknown>[] = Array.isArray(
        control.commands,
      )
        ? control.commands.filter(
            (command): command is Record<string, unknown> =>
              command !== null &&
              typeof command === "object" &&
              !Array.isArray(command),
          )
        : [];
      const closedNumber = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) ? value : null;
      const closedValue = (value: unknown, allowed: string[]) =>
        typeof value === "string" && allowed.includes(value)
          ? value
          : "unknown";
      return {
        runnerLifecycle: closedValue(runner.lifecycle, [
          "ready",
          "suspended",
          "closed",
          "recoverable_failure",
        ]),
        runnerAckedSourceSeq: closedNumber(runner.ackedSourceSeq),
        runnerNextSourceSeq: closedNumber(runner.nextSourceSeq),
        runnerOutboxCount: Array.isArray(runner.outbox)
          ? runner.outbox.length
          : null,
        providerLifecycle: closedValue(provider.lifecycle, [
          "prepared",
          "session_open",
          "turn_active",
          "closed",
          "provider_exited",
        ]),
        providerHasActiveTurn:
          typeof provider.activeProviderTurnId === "string",
        providerPendingCount: Array.isArray(provider.pendingEvents)
          ? provider.pendingEvents.length
          : null,
        providerQueuedCount: Array.isArray(provider.queuedEvents)
          ? provider.queuedEvents.length
          : null,
        committedEventCount: Array.isArray(control.committedEvents)
          ? control.committedEvents.length
          : null,
        commandsShape: Array.isArray(control.commands)
          ? "array"
          : "unavailable",
        commandCount: commands.length,
        closeCommands: commands
          .filter(
            (command) =>
              typeof command.type === "string" &&
              ["turn.stop", "runner.drain", "runner.suspend"].includes(
                command.type,
              ),
          )
          .slice(-12)
          .map((command) => ({
            type: closedValue(command.type, [
              "turn.stop",
              "runner.drain",
              "runner.suspend",
            ]),
            status: closedValue(command.status, [
              "pending",
              "completed",
              "failed",
              "rejected",
              "indeterminate",
            ]),
          })),
      };
    };
    let firstCloseCompletedState: Awaited<
      ReturnType<typeof readCloseDiagnostic>
    > | null = null;
    const identity = {
      runnerInstanceId: "runner-close-backlog",
      environmentLeaseId: "lease-close-backlog",
      runId: "run-close-first",
      normalizedSessionId: "session-close-backlog",
      turnId: "turn-close-first",
      itemId: "item-close-first",
    };
    const readRunnerState = vi.fn(
      async () =>
        JSON.parse(
          await readFile(
            join(stateDirectory, "runner", "runner-state.json"),
            "utf8",
          ),
        ) as Record<string, unknown>,
    );
    const options = {
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(
        stateDirectory,
        "--split-event-burst",
        "--split-event-suffix-count",
        String(suffixCount),
        "--durable-turn-ids",
        "--call-log",
        join(stateDirectory, "calls.log"),
        "--record-process-start",
        ...(suffixLifecycle === null
          ? []
          : ["--split-event-suffix-lifecycle", suffixLifecycle]),
      ),
      stateDirectory,
      lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
      readRunnerState,
    };
    const first = createCapabilityRunnerdCodexTransport({
      ...options,
      prpIdentity: identity,
    });
    const semanticResult = vi.fn(async () => ({
      success: true,
      contentItems: [],
    }));
    first.transport.setServerRequestHandler(semanticResult);
    let second:
      ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    try {
      const opened = await first.transport.request("thread/start", {
        cwd: tmpdir(),
        dynamicTools: [
          {
            name: "get_task_context",
            description: "Read the current task.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      const firstTurn = await first.transport.request("turn/start", {
        input: [
          {
            type: "text",
            text: "Emit a split event burst before the queued follow-up.",
          },
        ],
      });
      let deltas = 0;
      for await (const event of first.transport.notifications()) {
        if (event.method === "item/agentMessage/delta") deltas += 1;
        // Match production: semantic result is already returned, but a long
        // provider suffix remains. Close must service stop/suspend alongside
        // cumulative ACKs, not wait for the entire suffix in this consumer.
        if (suffixCount > 48 && deltas === 97) break;
        if (event.method === "turn/completed") break;
      }
      expect(deltas).toBe(suffixCount > 48 ? 97 : 144);
      expect(semanticResult).toHaveBeenCalledTimes(1);
      if (suffixCount > 48) {
        // Both cases stop with unread output. One provider has already
        // persisted completion; the adversarial one still owns active work.
        // Physical exit alone must not turn the latter into a safe resume.
        const fakeBeforeStop = JSON.parse(
          await readFile(join(stateDirectory, "fake-codex-state.json"), "utf8"),
        );
        expect(fakeBeforeStop.nextTurn).toBe(1);
        expect(fakeBeforeStop.activeTurnId).toBe(
          suffixLifecycle === "active-after-output"
            ? (firstTurn.turn as Record<string, unknown>).id
            : null,
        );
        const beforeClose = await readRunnerState();
        const unacknowledgedDeltas = (
          beforeClose.outbox as { eventType: string }[]
        ).filter((event) => event.eventType === "item.delta");
        expect(unacknowledgedDeltas.length).toBeLessThanOrEqual(128);
      }
      closePhase = "first-close";
      closeStartedAt = Date.now();
      await first.transport.close();
      closePhase = "after-first-close";
      firstCloseCompletedState = await readCloseDiagnostic().catch(() => null);
      // Local transports have no remote checkpoint callback. They must still
      // verify suspension rather than treating process termination as proof.
      expect(readRunnerState).toHaveBeenCalled();
      expect(await readRunnerState()).toMatchObject({
        ...identity,
        lifecycle: "suspended",
      });
      const control = JSON.parse(
        await readFile(
          join(stateDirectory, "control-plane", "control-plane-state.json"),
          "utf8",
        ),
      );
      expect(control.commands).toContainEqual(
        expect.objectContaining({
          type: "runner.suspend",
          status: "completed",
        }),
      );
      const durableDeltas = control.committedEvents.filter(
        (event: { eventType: string }) => event.eventType === "item.delta",
      );
      // Explicit stop may cancel provider output not yet ingested. Every
      // admitted delta is retained exactly once, without asserting that future
      // unread output must survive cancellation.
      if (suffixCount === 48) expect(durableDeltas).toHaveLength(144);
      else expect(durableDeltas.length).toBeGreaterThanOrEqual(deltas);
      expect(
        new Set(
          durableDeltas.map(
            (event: { sourceEventId: string }) => event.sourceEventId,
          ),
        ).size,
      ).toBe(durableDeltas.length);
      const provider = JSON.parse(
        await readFile(
          join(stateDirectory, "runner", "codex-provider-state.json"),
          "utf8",
        ),
      );
      expect(provider.pendingEvents).toEqual([]);
      expect(provider.queuedEvents).toEqual([]);
      expect(provider.activeProviderTurnId).toBeNull();
      const firstStoppedJournal = await readRunnerState();
      closePhase = "successor-attach";
      second = createCapabilityRunnerdCodexTransport({
        ...options,
        readRunnerState: undefined,
        prpIdentity: {
          ...identity,
          runId: "run-close-second",
          turnId: "turn-close-second",
          itemId: "item-close-second",
        },
      });
      const secondSemanticResult = vi.fn(async () => ({
        success: true,
        contentItems: [],
      }));
      second.transport.setServerRequestHandler(secondSemanticResult);
      if (suffixLifecycle === "active-after-output") {
        await expect(
          second.transport.request("thread/read", {}),
        ).rejects.toThrow(
          "prepared provider checkpoint resumed unexpected active work",
        );
        expect(secondSemanticResult).not.toHaveBeenCalled();
        const refusedProvider = JSON.parse(
          await readFile(
            join(stateDirectory, "runner/codex-provider-state.json"),
            "utf8",
          ),
        );
        expect(refusedProvider).toMatchObject({
          lifecycle: "closed",
          activeProviderTurnId: null,
          completedTurnAuthoritative: false,
          startupAttempt: {
            schema: "paperclip.provider_startup.v1",
            phase: "initialization_failed",
            failedStage: "admission",
            requestedThreadId: (opened.thread as Record<string, unknown>).id,
            authenticatedThreadId: null,
            directChildExitObserved: true,
            processTreeRetired: false,
            origin: {
              runnerInstanceId: identity.runnerInstanceId,
              normalizedSessionId: identity.normalizedSessionId,
              runId: "run-close-second",
              turnId: "turn-close-second",
              itemId: "item-close-second",
            },
            command: { commandType: "run.attach" },
          },
        });
        expect(refusedProvider.startupAttempt.attemptedProcessGeneration).toBe(
          provider.providerProcessGeneration + 1,
        );
        expect(refusedProvider.startupAttempt.processId).toBeGreaterThan(0);
        expect(refusedProvider.startupAttempt.processGroupId).toBe(
          refusedProvider.startupAttempt.processId,
        );
        for (const pid of [
          refusedProvider.startupAttempt.processId,
          -refusedProvider.startupAttempt.processGroupId,
        ]) {
          expect(() => process.kill(pid, 0)).toThrow(
            expect.objectContaining({ code: "ESRCH" }),
          );
        }
        const refusedControl = JSON.parse(
          await readFile(
            join(stateDirectory, "control-plane/control-plane-state.json"),
            "utf8",
          ),
        );
        expect(refusedControl.commands).toContainEqual(
          expect.objectContaining({
            type: "run.attach",
            status: "failed",
          }),
        );
        expect(
          refusedControl.committedEvents.some((event: { eventType: string }) =>
            [
              "session.started",
              "session.resumed",
              "turn.started",
              "run.attached",
            ].includes(event.eventType),
          ),
        ).toBe(false);
        expect(
          refusedControl.committedEvents
            .filter(
              (event: { eventType: string; envelope: { payload: PrpEvent } }) =>
                event.eventType === "harness.diagnostic" &&
                event.envelope.payload.payload.code ===
                  "provider_startup_ownership",
            )
            .map(
              (event: { envelope: { payload: PrpEvent } }) =>
                (
                  event.envelope.payload.payload.startup as Record<
                    string,
                    unknown
                  >
                ).phase,
            ),
        ).toEqual(["intent", "spawned", "initialization_failed"]);
        const calls = (
          await readFile(join(stateDirectory, "calls.log"), "utf8")
        )
          .trim()
          .split(/\r?\n/);
        expect(calls.filter((call) => call === "process-start")).toHaveLength(
          2,
        );
        expect(calls.filter((call) => call === "thread/start")).toHaveLength(1);
        expect(calls.filter((call) => call === "thread/resume")).toHaveLength(
          1,
        );
        expect(calls.filter((call) => call === "turn/start")).toHaveLength(1);
        const stillActive = JSON.parse(
          await readFile(join(stateDirectory, "fake-codex-state.json"), "utf8"),
        );
        expect(stillActive.activeTurnId).toBe(
          (firstTurn.turn as Record<string, unknown>).id,
        );
        expect(stillActive.nextTurn).toBe(1);
        const epochs = await readdir(join(stateDirectory, "authority-epochs"));
        expect(epochs).toHaveLength(1);
        const archivedStop = JSON.parse(
          await readFile(
            join(
              stateDirectory,
              "authority-epochs",
              epochs[0]!,
              "runner-state.json",
            ),
            "utf8",
          ),
        );
        expect(archivedStop).toEqual(firstStoppedJournal);
        expect(control.commands).toContainEqual(
          expect.objectContaining({
            type: "turn.stop",
            status: "completed",
            result: expect.objectContaining({
              result: expect.objectContaining({
                providerTurnId: (firstTurn.turn as Record<string, unknown>).id,
                status: "stopped",
                providerExitConfirmed: true,
                interruptAccepted: false,
              }),
            }),
          }),
        );
        return;
      }
      const resumed = await second.transport.request("thread/read", {});
      expect(resumed.thread).toMatchObject({
        id: (opened.thread as Record<string, unknown>).id,
      });
      expect(second.evidence().diagnostics).toContain(
        "runnerd attached the durable provider session to a fresh PRP run authority",
      );
      if (suffixCount > 48) {
        closePhase = "successor-start";
        const secondTurn = await second.transport.request("turn/start", {
          input: [
            {
              type: "text",
              text: "Run the queued follow-up under its own authority.",
            },
          ],
        });
        expect((secondTurn.turn as Record<string, unknown>).id).not.toBe(
          (firstTurn.turn as Record<string, unknown>).id,
        );
        let secondDeltas = 0;
        for await (const event of second.transport.notifications()) {
          if (event.method === "item/agentMessage/delta") secondDeltas += 1;
          if (secondDeltas === 97 || event.method === "turn/completed") break;
        }
        expect(secondDeltas).toBe(97);
        expect(secondSemanticResult).toHaveBeenCalledTimes(1);
        closePhase = "second-close";
        closeStartedAt = Date.now();
        await second.transport.close();
        closePhase = "after-second-close";
        expect(await readRunnerState()).toMatchObject({
          lifecycle: "suspended",
          runId: "run-close-second",
          turnId: "turn-close-second",
        });
      }
    } catch (error) {
      preserveFailedState = true;
      try {
        console.error(
          "[backlog-close-state]",
          JSON.stringify({
            suffixCount,
            stateDirectory,
            closePhase,
            closeElapsedMs:
              closeStartedAt === 0 ? null : Date.now() - closeStartedAt,
            firstCloseCompletedState,
            failureState: await readCloseDiagnostic(),
          }),
        );
      } catch {
        // Diagnostics must never replace the original transport failure.
      }
      throw error;
    } finally {
      await Promise.allSettled([
        first.transport.close(),
        second?.transport.close(),
      ]);
      if (!preserveFailedState)
        await rm(stateDirectory, { recursive: true, force: true });
    }
  },
  60_000,
);

async function withPreparedOpenCodeCleanup(input: {
  run: () => Promise<void>;
  closeSession: () => Promise<void>;
  closeTransport: () => Promise<void>;
  removeRoot: () => Promise<void>;
  evidence: () => Pick<
    ReturnType<ReturnType<typeof createCapabilityRunnerdCodexTransport>["evidence"]>,
    "runnerPid" | "runnerExited" | "runnerExitCode" | "runnerSignal" | "diagnostics"
  >;
}): Promise<void> {
  const failures: { stage: string; error: unknown }[] = [];
  for (const [stage, operation] of [
    ["run", input.run],
    ["session.close", input.closeSession],
    ["transport.close", input.closeTransport],
    ["removeRoot", input.removeRoot],
  ] as const) {
    try {
      await operation();
    } catch (error) {
      failures.push({ stage, error });
    }
  }
  if (failures.length === 0) return;
  const evidence = input.evidence();
  // Never dump stderr, environment values, prompts, paths, or arbitrary
  // diagnostic text. Keep only bounded process/settlement facts alongside
  // the original errors, so a finally failure cannot hide the primary one.
  const summary = {
    failedStages: failures.map(({ stage }) => stage),
    runnerStarted: evidence.runnerPid !== null,
    runnerExited: evidence.runnerExited,
    runnerExitCode: evidence.runnerExitCode,
    runnerSignalled: evidence.runnerSignal !== null,
    diagnosticCount: evidence.diagnostics.length,
    suspensionRejected: evidence.diagnostics.includes(
      "runner did not prove durable suspension before checkpoint",
    ),
  };
  throw new AggregateError(
    failures.map(({ error }) => error),
    `Prepared OpenCode fixture failed: ${JSON.stringify(summary)}`,
    { cause: failures[0]!.error },
  );
}

it.each([true, false])("preserves prepared OpenCode cleanup errors (primary failure: %s)", async (failRun) => {
  const primary = new Error("prepared input assertion failed");
  const cleanup = new NativeSessionCloseUnrecoverableError();
  const calls: string[] = [];
  const evidence = {
    runnerPid: 123,
    runnerExited: true,
    runnerExitCode: 1,
    runnerSignal: null,
    diagnostics: ["Bearer fixture-secret", "runner did not prove durable suspension before checkpoint"],
  };
  const failure = await withPreparedOpenCodeCleanup({
    run: async () => { calls.push("run"); if (failRun) throw primary; },
    closeSession: async () => { calls.push("session.close"); throw cleanup; },
    closeTransport: async () => { calls.push("transport.close"); },
    removeRoot: async () => { calls.push("removeRoot"); },
    evidence: () => evidence,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual(failRun ? [primary, cleanup] : [cleanup]);
  expect((failure as AggregateError).cause).toBe(failRun ? primary : cleanup);
  expect(calls).toEqual(["run", "session.close", "transport.close", "removeRoot"]);
  expect((failure as Error).message).toContain('"suspensionRejected":true');
  expect((failure as Error).message).not.toContain("fixture-secret");
});

it.each([
  { model: "openrouter/deepseek/deepseek-v4-flash-0731", supportsReasoning: true, adoptAfterTurn: false },
  { model: "openrouter/deepseek/deepseek-v4-flash-0731", supportsReasoning: true, adoptAfterTurn: true },
  { model: "anthropic/claude-sonnet-4", supportsReasoning: false, adoptAfterTurn: false },
])("preserves prepared input and completion feedback through runnerd and the real OpenCode proxy boundary ($model, live adoption: $adoptAfterTurn)", async ({ model, supportsReasoning, adoptAfterTurn }) => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-prepared-opencode-"));
  // GitHub-hosted Linux toolcache Node can be group-writable, unlike the AWS
  // fleet. Qualify an owned copy with strict permissions, never chmod the host
  // runtime or weaken the launch boundary. Keep macOS's native runtime path
  // because its signing and dylib lookup can depend on that location.
  const providerNode = process.platform === "linux" ? join(root, "node") : process.execPath;
  if (process.platform === "linux") {
    await cp(process.execPath, providerNode, { dereference: true });
    await chmod(providerNode, 0o500);
  }
  // The qualified launch boundary unlinks its executable after exec. Use a
  // native wrapper, like the real OpenCode binary; a shebang script would need
  // to reopen the now-unlinked path in its interpreter.
  const executable = join(root, "fake-opencode");
  const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
  execFileSync("cc", ["-x", "c", "-o", executable, "-"], {
    input: `#include <unistd.h>\n#include <stdlib.h>\nint main(int argc, char **argv) { char **args = calloc(argc + 2, sizeof(char *)); args[0] = ${JSON.stringify(providerNode)}; args[1] = ${JSON.stringify(fixture)}; for (int i = 1; i < argc; i++) args[i + 1] = argv[i]; execv(args[0], args); return 127; }`,
  });
  // CI may use umask 0002; qualified executables cannot be group-writable.
  await chmod(executable, 0o755);
  // Use the production bundler without depending on (or mutating) shared dist
  // artifacts. The Vitest CI lane builds Rust but does not build TypeScript.
  const proxy = join(root, "opencode-app-server-proxy.cjs");
  const proxyBytes = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { bundleVerifiedProviderEntrypoints } from "./scripts/build-verified-provider-entrypoints.mjs";
    const entries = await bundleVerifiedProviderEntrypoints({ write: false });
    const proxy = entries.find(({ entrypoint }) => entrypoint.name === "opencode-app-server-proxy");
    process.stdout.write(proxy.verifiedResult.outputFiles[0].contents);
  `], { maxBuffer: 16 * 1024 * 1024 });
  await writeFile(proxy, proxyBytes, { mode: 0o755 });
  const digest = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  const runtime = join(root, "opencode");
  const server = createServer();
  let authority: DurablePrpControlPlane | null = null;
  server.on("upgrade", (request, socket, head) => {
    if (authority) authority.handleUpgrade(request, socket, "/runner", head);
    else socket.destroy();
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected OpenCode adoption listener");
  const registration = async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      release: async () => { if (authority === next) authority = null; },
    };
  };
  const identity = {
    runnerInstanceId: "runner-opencode-adopt", environmentLeaseId: "lease-opencode-adopt",
    runId: "prepared-opencode", normalizedSessionId: "prepared-opencode",
    turnId: "turn-opencode-adopt", itemId: "item-opencode-adopt",
  };
  const bundle = createCapabilityRunnerdCodexTransport({
    prpIdentity: identity,
    controlPlaneRegistration: registration,
    provider: "opencode",
    runnerBinary: defaultCapabilityRunnerdBinary(),
    stateDirectory: join(root, "runner-state"),
    opencodeRuntimeDirectory: runtime,
    opencodeCommand: executable,
    opencodeCommandSha256: digest(executable),
    opencodeProxyPath: proxy,
    opencodeProxySha256: digest(proxy),
    providerNodeCommand: providerNode,
    providerNodeCommandSha256: digest(providerNode),
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key",
      ...(supportsReasoning ? configuredEnvironmentProjection({ PAPERCLIP_OPENCODE_PERFORMANCE_DIAGNOSTICS: "1" }) : {}),
    },
  });
  const task = createCodexTaskEnvelope({
    objective: "Preserve the prepared task.", contractRevision: "prepared-v1",
    criteria: [{ id: "objective", requirement: "Keep this request unchanged." }],
  });
  let completionCalls = 0;
  const feedback = "Include [Saved document](/PAP/issues/PAP-1#document-plan) in your final response.";
  const driver = new CodexAppServerDriver({
    taskEnvelope: task,
    conversationMode: "prepared",
    model,
    transportFactory: () => bundle.transport,
    workingDirectoryAuthority: "remote_runner",
    environment: { PAPERCLIP_WORKSPACE_CWD: root },
    completionFeedback: async () => {
      completionCalls += 1;
      if (completionCalls === 1) throw new Error("Keep the task's required document link in the final response.");
      return feedback;
    },
  });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  let survivingPid: number | null = null;
  const prepared = JSON.stringify({
    schema: "paperclip.native-model-envelope.v3",
    task: { prompt: "Keep this completion-feedback request unchanged." },
    completionContract: { revision: "prepared-v1", criteria: task.completionContract.criteria },
  });
  await withPreparedOpenCodeCleanup({
    run: async () => {
      session = await driver.openSession({ runId: "prepared-opencode", normalizedSessionId: "prepared-opencode", workingDirectory: root });
      expect(bundle.transport.supportsTurnReasoning?.()).toBe(supportsReasoning);
      const firstTurn = { message: { role: "user" as const, text: prepared } };
      if (!supportsReasoning) {
        await expect(session.startTurn({ ...firstTurn, reasoningMode: "disabled" }))
          .rejects.toThrow("Per-turn reasoning is not supported");
        await expect(bundle.transport.request("turn/start", { input: [{ type: "text", text: prepared }], reasoningMode: "disabled" }))
          .rejects.toThrow("requires an OpenCode/OpenRouter model");
      }
      await session.startTurn({ ...firstTurn, ...(supportsReasoning ? { reasoningMode: "disabled" as const } : {}) });
      const events: PrpEvent[] = [];
      for await (const event of session.events()) {
        events.push(event);
        if (event.eventType === "turn.completed") break;
      }
      expect(events.find(event => event.eventType === "session.started")?.payload.context).toMatchObject({ model });
      expect(completionCalls).toBe(2);
      expect(events.filter(event => event.eventType === "run.result.proposed")).toHaveLength(1);
      const performance = events.filter(event => event.eventType === "harness.diagnostic" && event.payload.code === "provider_performance_spans");
      expect(performance).toHaveLength(supportsReasoning ? 1 : 0);
      if (supportsReasoning) {
        expect(performance[0].payload.spans).toEqual([{
          name: "provider.model.stream", startedAtMs: expect.any(Number), endedAtMs: expect.any(Number), outcome: "ok",
        }]);
        expect(JSON.stringify(performance)).not.toContain("private-performance-sentinel");
      }
      const sessionRoots = (await readdir(runtime, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      expect(sessionRoots).toHaveLength(1);
      const requests = (await readFile(join(runtime, sessionRoots[0]!.name, "data/fake-prompt-requests.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(requests.map((request) => request.parts)).toEqual([[{ type: "text", text: prepared }]]);
      expect(requests[0].variant).toBe(supportsReasoning ? "paperclip-no-reasoning" : undefined);
      const outcomes = JSON.parse(await readFile(join(runtime, sessionRoots[0]!.name, "data/fake-completion-feedback.json"), "utf8"));
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0].result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("required document link") }] });
      expect(outcomes[1].result).toMatchObject({ content: [{ text: expect.stringContaining(feedback) }] });
      if (adoptAfterTurn) {
        const snapshot = await session.snapshot();
        const runnerStartedAt = bundle.transport.processInfo!().startedAt;
        survivingPid = bundle.evidence().runnerPid;
        expect(survivingPid).toEqual(expect.any(Number));
        const artifact = readRunnerdArtifactBinding(defaultCapabilityRunnerdBinary());
        await bundle.detachControllerForRestart();
        // These controller launch assets are gone. The original native proxy
        // and harness remain alive; only authenticated adoption is allowed.
        await rm(proxy);
        await rm(executable);
        const duplicateLauncher = vi.fn(() => { throw new Error("duplicate OpenCode runner launch"); });
        adopted = createCapabilityRunnerdCodexTransport({
          provider: "opencode",
          stateDirectory: join(root, "runner-state"),
          runnerFilesystemRoot: join(root, "retired-controller"),
          runnerBinary: join(root, "retired-controller", "runnerd"),
          runnerArtifact: artifact,
          prpIdentity: identity,
          controlPlaneRegistration: registration,
          resumeProviderSession: {
            driverSessionId: snapshot.driverSessionId,
            providerSessionId: snapshot.providerSessionId,
            providerIdentity: snapshot.providerIdentity,
          },
          runnerProcessLauncher: duplicateLauncher,
          adoptExistingRunner: {
            pid: survivingPid!, processGroupId: survivingPid, startedAt: runnerStartedAt,
            signal: () => true,
            isAlive: () => { try { process.kill(survivingPid!, 0); return true; } catch { return false; } },
          },
        });
        const recoveryDriver = new CodexAppServerDriver({
          taskEnvelope: task, conversationMode: "prepared", model,
          transportFactory: () => adopted!.transport,
          workingDirectoryAuthority: "remote_runner",
          environment: { PAPERCLIP_WORKSPACE_CWD: root },
          completionFeedback: async () => feedback,
        });
        const recovery = await recoveryDriver.recoverSession(snapshot);
        if (!recovery.recovered) throw new Error(`OpenCode live adoption failed: ${recovery.reason}`);
        expect(recovery.session).toBeDefined();
        session = recovery.session!;
        expect(adopted.evidence().runnerPid).toBe(survivingPid);
        expect(adopted.transport.processInfo!().startedAt).toBe(runnerStartedAt);
        expect((await session.snapshot()).providerSessionId).toBe(snapshot.providerSessionId);
        expect(duplicateLauncher).not.toHaveBeenCalled();
      }
      await session.startTurn({ message: { role: "user", text: "Reply Hi." } });
      for await (const event of session.events()) if (event.eventType === "turn.completed") break;
      const allRequests = (await readFile(join(runtime, sessionRoots[0]!.name, "data/fake-prompt-requests.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(allRequests.map(request => request.variant)).toEqual(supportsReasoning
        ? ["paperclip-no-reasoning", "paperclip-default"] : [undefined, undefined]);
    },
    closeSession: async () => { await session?.close({ reason: "test complete" }); },
    closeTransport: async () => {
      try { await adopted?.transport.close(); }
      finally {
        await bundle.transport.close();
        if (survivingPid !== null) { try { process.kill(survivingPid, "SIGKILL"); } catch {} }
      }
    },
    removeRoot: async () => {
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      await rm(root, { recursive: true, force: true });
    },
    evidence: () => adopted?.evidence() ?? bundle.evidence(),
  });
}, 30_000);
