import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessDriverBackend } from "../../backends/harness-driver-backend.js";
import { createCodexTaskEnvelope } from "../../contracts/codex.js";
import type { ControlPlanePort } from "../../contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "../../contracts/native-execution.js";
import { NativeSessionProtocolIntegrityError } from "../../contracts/native-session-backend.js";
import {
  DurablePrpControlPlane,
  durableRecoveryInternals,
  type DurableRecoveryIdentity,
} from "../../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdCodexTransport } from "../../live/runnerd-codex-transport.js";
import { executeNativeSession } from "../../native-session-runtime.js";
import { CodexAppServerDriver } from "./codex-app-server-driver.js";
import { CodexSessionState } from "./codex-session-state.js";
import {
  FakeCodexTransport,
  TestQueue,
  WORKSPACE,
  describe,
  expect,
  it,
  makeDriver,
  result,
  vi,
  type PrpEvent,
} from "./codex-app-server-driver.test-support.js";

// Synthetic runner process boundary; authentication and the encrypted wire are
// real. Keep this client local to this test rather than exporting test protocol
// machinery from the production controller.
async function authenticatedRunner(
  core: DurablePrpControlPlane,
  identity: DurableRecoveryIdentity,
) {
  const framed = (domain: string, parts: Buffer[]) => {
    const values = [Buffer.from(domain), Buffer.from([0])];
    for (const part of parts) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(part.length));
      values.push(length, part);
    }
    return Buffer.concat(values);
  };
  const digest = (domain: string, parts: Buffer[]) =>
    createHash("sha256").update(framed(domain, parts)).digest();
  const credential = Buffer.from(core.issueBootstrapTicket());
  const authKey = digest("paperclip-runner-auth-key-v1", [credential]);
  const mac = (domain: string, parts: Buffer[]) =>
    createHmac("sha256", authKey).update(framed(domain, parts)).digest();
  const credentialId = `sha256:${digest("paperclip-runner-credential-id-v1", [credential]).toString("hex")}`;
  const socket = new WebSocket(core.connectUrl);
  const frames = new TestQueue<Record<string, unknown>>();
  const reader = frames[Symbol.asyncIterator]();
  socket.addEventListener("message", (event) =>
    frames.push(JSON.parse(String(event.data))),
  );
  socket.addEventListener("close", () => frames.close());
  socket.addEventListener("error", () =>
    frames.fail(new Error("Synthetic runner socket failed")),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      protocol: "paperclip.runner",
      version: 1,
      kind: "auth_hello",
      payload: {
        credentialId,
        clientNonce: "composed-integrity-client",
        protocolMin: 1,
        protocolMax: 1,
        ...identity,
        runnerVersion: "0.3.0",
        runnerDigest: `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`,
      },
    }),
  );
  const challenge = (await reader.next()).value!.payload as Record<
    string,
    unknown
  >;
  const { serverProof, ...challengeFields } = challenge;
  const canonical = Buffer.from(
    durableRecoveryInternals.canonicalJson(challengeFields),
  );
  expect(serverProof).toBe(
    mac("paperclip-runner-server-proof-v1", [canonical]).toString("hex"),
  );
  const clientProof = mac("paperclip-runner-client-proof-v1", [
    canonical,
    Buffer.from(String(serverProof)),
  ]).toString("hex");
  socket.send(
    JSON.stringify({
      protocol: "paperclip.runner",
      version: 1,
      kind: "auth_response",
      payload: {
        credentialId,
        clientNonce: challenge.clientNonce,
        serverNonce: challenge.serverNonce,
        clientProof,
      },
    }),
  );
  const binding = digest("paperclip-runner-session-binding-v1", [
    canonical,
    Buffer.from(String(serverProof)),
    Buffer.from(clientProof),
  ]);
  const sessionId = `sha256:${binding.toString("hex")}`;
  const nonce = (prefix: string, counter: number) => {
    const value = Buffer.alloc(12);
    value.write(prefix, 0, "ascii");
    value.writeBigUInt64BE(BigInt(counter), 4);
    return value;
  };
  const aad = (direction: string, counter: number) =>
    Buffer.from(
      `paperclip.runner.secure-frame.v1\0${sessionId}\0${direction}\0${counter}`,
    );
  const welcome = (await reader.next()).value!;
  expect(welcome.counter).toBe(0);
  const sealed = Buffer.from(String(welcome.ciphertext), "hex");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    mac("paperclip-runner-core-to-client-key-v1", [binding]),
    nonce("P3S1", 0),
  );
  decipher.setAAD(aad("core_to_client", 0));
  decipher.setAuthTag(sealed.subarray(-16));
  const opened = JSON.parse(
    Buffer.concat([
      decipher.update(sealed.subarray(0, -16)),
      decipher.final(),
    ]).toString("utf8"),
  );
  expect(opened.kind).toBe("welcome");
  let counter = 0;
  return {
    socket,
    send(value: Record<string, unknown>) {
      const cipher = createCipheriv(
        "aes-256-gcm",
        mac("paperclip-runner-client-to-core-key-v1", [binding]),
        nonce("P3C1", counter),
      );
      cipher.setAAD(aad("client_to_core", counter));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      socket.send(
        JSON.stringify({
          schema: "paperclip.runner.secure-frame.v1",
          counter: counter++,
          ciphertext: ciphertext.toString("hex"),
        }),
      );
    },
  };
}

describe("Codex protocol integrity propagation", () => {
  it("blocks goal operations after an integrity fault without blocking cleanup", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-goal-integrity", normalizedSessionId: "session-goal-integrity", workingDirectory: WORKSPACE,
    });
    if (!(session instanceof CodexSessionState)) throw new Error("Expected Codex state");
    const fault = new NativeSessionProtocolIntegrityError("semantic_input_digest_mismatch");
    session.failProtocolIntegrity(fault);
    const before = transport.calls.length;
    for (const action of ["get", "clear", "resume"] as const) {
      await expect(session.goal!({ action })).rejects.toBe(fault);
    }
    expect(transport.calls).toHaveLength(before);
    await session.close({ reason: "integrity cleanup" });
  });

  it("preserves a fault that arrives while a goal read is in flight", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-goal-race", normalizedSessionId: "session-goal-race", workingDirectory: WORKSPACE,
    });
    if (!(session instanceof CodexSessionState)) throw new Error("Expected Codex state");
    let release!: (value: Record<string, unknown>) => void;
    const held = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
    const request = transport.request.bind(transport);
    const spy = vi.spyOn(transport, "request").mockImplementation((method, params) =>
      method === "thread/goal/get" ? held : request(method, params),
    );
    const pending = session.goal!({ action: "get" });
    const fault = new NativeSessionProtocolIntegrityError("semantic_input_digest_mismatch");
    session.failProtocolIntegrity(fault);
    release({ goal: null });
    await expect(pending).rejects.toBe(fault);
    spy.mockRestore();
    await session.close({ reason: "integrity cleanup" });
  });

  it.each(["matching", "foreign"] as const)(
    "defers an early %s semantic call until turn admission, then enforces its binding",
    async (binding) => {
      const transport = new FakeCodexTransport();
      let releaseStart!: (response: Record<string, unknown>) => void;
      transport.turnStartResponse = new Promise((resolve) => {
        releaseStart = resolve;
      });
      const session = await makeDriver([transport]).openSession({
        runId: `run-early-semantic-${binding}`,
        normalizedSessionId: `session-early-semantic-${binding}`,
        workingDirectory: WORKSPACE,
      });
      if (!(session instanceof CodexSessionState))
        throw new Error("Expected Codex state");
      const events: PrpEvent[] = [];
      const consumed = (async () => {
        for await (const event of session.events()) events.push(event);
      })();
      const started = session.startTurn({
        message: { role: "user", text: "Complete the task." },
      });
      // Keep cleanup safe even when the negative assertion below fails.
      void started.catch(() => {});
      let semantic: Promise<Record<string, unknown>> | undefined;
      try {
        await vi.waitFor(() => expect(session.turnStartPending).toBe(true));
        expect(session.activeTurnId).toBeNull();
        let semanticSettled = false;
        semantic = transport.invoke({
          id: "early-finish",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: binding === "matching" ? "turn-1" : "foreign-turn",
            callId: "early-finish",
            tool: "paperclip_finish",
            arguments: result,
          },
        });
        void semantic.then(
          () => {
            semanticSettled = true;
          },
          () => {
            semanticSettled = true;
          },
        );
        // The provider callback can beat both the turn/start response and
        // normalized turn/started notification. Its valid identity must not
        // be judged against the not-yet-admitted null active turn.
        await Promise.resolve();
        await Promise.resolve();
        if (binding === "matching") {
          expect(session.protocolFailed).toBe(false);
          expect(semanticSettled).toBe(false);
          expect(
            events.some((event) => event.eventType === "run.result.proposed"),
          ).toBe(false);
        }
        releaseStart({
          turn: { id: "turn-1", status: "inProgress", items: [] },
        });
        await started;
        transport.push("turn/started", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        });
        const response = await semantic;
        if (binding === "matching") {
          expect(response.success).toBe(true);
          expect(session.protocolFailed).toBe(false);
          await vi.waitFor(() =>
            expect(
              events.some((event) => event.eventType === "run.result.proposed"),
            ).toBe(true),
          );
          const accepted = events.findIndex(
            (event) => event.eventType === "turn.accepted",
          );
          const proposed = events.findIndex(
            (event) => event.eventType === "run.result.proposed",
          );
          expect(accepted).toBeGreaterThanOrEqual(0);
          expect(proposed).toBeGreaterThan(accepted);
        } else {
          expect(response.success).toBe(false);
          expect(session.protocolFailed).toBe(true);
          await vi.waitFor(() =>
            expect(
              events.find((event) => event.eventType === "session.failed")
                ?.payload.code,
            ).toBe("tool_binding_mismatch"),
          );
          expect(
            events.some((event) => event.eventType === "run.result.proposed"),
          ).toBe(false);
        }
      } finally {
        releaseStart({
          turn: { id: "turn-1", status: "inProgress", items: [] },
        });
        await started.catch(() => {});
        await session.close({ reason: "test cleanup" });
        await semantic;
        await consumed;
      }
    },
  );

  it.each([
    "start-rejected",
    "invalid-start-response",
    "integrity-fault",
  ] as const)(
    "does not admit a queued semantic result after %s while turn admission is pending",
    async (failure) => {
      const transport = new FakeCodexTransport();
      let rejectStart!: (error: Error) => void;
      let resolveStart!: (response: Record<string, unknown>) => void;
      transport.turnStartResponse = new Promise((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
      });
      const session = await makeDriver([transport]).openSession({
        runId: `run-early-${failure}`,
        normalizedSessionId: `session-early-${failure}`,
        workingDirectory: WORKSPACE,
      });
      if (!(session instanceof CodexSessionState))
        throw new Error("Expected Codex state");
      const events: PrpEvent[] = [];
      const consumed = (async () => {
        for await (const event of session.events()) events.push(event);
      })().catch((error: unknown) => error);
      const started = session
        .startTurn({ message: { role: "user", text: "Complete the task." } })
        .catch((error: unknown) => error);
      const fault =
        failure === "integrity-fault"
          ? new NativeSessionProtocolIntegrityError(
              "semantic_input_digest_mismatch",
            )
          : new Error("Provider rejected turn start");
      let semantic: Promise<unknown> | undefined;
      try {
        await vi.waitFor(() => expect(session.turnStartPending).toBe(true));
        transport.push("turn/started", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "inProgress", items: [] },
        });
        await vi.waitFor(() => expect(session.activeTurnId).toBe("turn-1"));
        semantic = transport
          .invoke({
            id: "early-rejected-finish",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "early-rejected-finish",
              tool: "paperclip_finish",
              arguments: result,
            },
          })
          .catch((error: unknown) => error);
        await Promise.resolve();
        expect(session.result).toBeNull();
        if (failure === "integrity-fault") {
          transport.queue.fail(fault);
          await vi.waitFor(() => expect(session.protocolFailed).toBe(true));
        }
        if (failure === "invalid-start-response") {
          resolveStart({ turn: { status: "inProgress", items: [] } });
          expect(await started).toMatchObject({
            message: "Codex turn response omitted turn.id",
          });
        } else {
          rejectStart(fault);
          expect(await started).toBe(fault);
        }
        if (failure === "integrity-fault") expect(await semantic).toBe(fault);
        else expect(await semantic).toMatchObject({ success: false });
        expect(
          events.some((event) =>
            ["turn.accepted", "run.result.proposed", "turn.completed"].includes(
              event.eventType,
            ),
          ),
        ).toBe(false);
      } finally {
        rejectStart(fault);
        await started;
        await session.close({ reason: "test cleanup" });
        await semantic;
        await consumed;
      }
    },
  );

  it.each([
    "integrity-fault",
    "early-semantic",
    "early-start-rejected",
    "early-foreign-turn",
    "early-new-epoch",
    "early-integrity-fault",
    "early-close",
    "early-detach",
  ] as const)(
    "composes authenticated controller, transport, driver, backend, and runtime for %s",
    async (scenario) => {
      const directory = mkdtempSync(
        join(tmpdir(), "paperclip-composed-integrity-"),
      );
      const identity: DurableRecoveryIdentity = {
        runnerInstanceId: `composed-runner-${scenario}`,
        environmentLeaseId: `composed-lease-${scenario}`,
        runId: `composed-run-${scenario}`,
        normalizedSessionId: `composed-session-${scenario}`,
        turnId: `composed-turn-${scenario}`,
        itemId: `composed-item-${scenario}`,
      };
      const contract = {
        revision: "1",
        objective: "Validate the authenticated failure boundary",
        criteria: [
          {
            id: "objective",
            requirement: "Do not accept corrupt provider input",
          },
        ],
      };
      const input: NativeExecutionInputV1 = {
        schema: "paperclip.native-execution-input.v1",
        binding: {
          companyId: `composed-company-${scenario}`,
          issueId: `composed-issue-${scenario}`,
          agentId: `composed-agent-${scenario}`,
          runId: identity.runId,
          executionWorkspaceId: "composed-workspace",
        },
        task: {
          identifier: "TEST-1",
          title: contract.objective,
          description: null,
          prompt: contract.objective,
          workMode: "standard",
        },
        workspace: {
          cwd: directory,
          repoUrl: null,
          repoRef: null,
          branchName: null,
        },
        session: {
          normalizedSessionId: identity.normalizedSessionId,
          driverKind: "codex_app_server",
          protocolVersion: 1,
        },
        provider: { kind: "codex", model: null },
        completionContract: {
          id: "composed-contract",
          sha256: "composed-contract-sha",
          schemaVersion: "paperclip.completion-contract.v1",
          contract,
        },
        interactionResponses: [],
        credentialBindings: [],
      };
      const events: PrpEvent[] = [];
      const controlPlane: ControlPlanePort = {
        openRun: vi.fn(async () => undefined),
        checkpointSession: vi.fn(async () => undefined),
        appendEvent: vi.fn(async (event) => {
          events.push(event as PrpEvent);
          return {
            cursor: events.length,
            highestContiguousSourceSeq: events.length,
            disposition: "committed" as const,
          };
        }),
        replayEvents: vi.fn(async () => ({
          events: [],
          highestContiguousSourceSeq: 0,
        })),
        completeRun: vi.fn(async () => undefined),
      };
      let authority: DurablePrpControlPlane | undefined;
      let finishProcess!: (result: {
        code: number;
        signal: null;
        stdout: string;
        stderr: string;
      }) => void;
      const completion = new Promise<{
        code: number;
        signal: null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        finishProcess = resolve;
      });
      const kill = vi.fn(() => {
        finishProcess({ code: 0, signal: null, stdout: "", stderr: "" });
        return true;
      });
      const launch = vi.fn(() => ({
        child: { exitCode: null, kill },
        completion,
      }));
      const bundle = createCapabilityRunnerdCodexTransport({
        stateDirectory: directory,
        prpIdentity: identity,
        runnerBinary: process.execPath,
        codexCommand: process.execPath,
        codexArgs: [],
        sourceCodexHome: null,
        environment: {},
        runnerReconnectGraceMs: 900_000,
        closeGraceMs: scenario === "early-semantic" ? 1_000 : 50,
        readRunnerState: async () => ({
          schema: "paperclip.runner.durable.state.v1",
          ...identity,
          lifecycle: authority?.store.state.commands.some(
            (command) =>
              command.type === "runner.suspend" &&
              command.status === "completed",
          )
            ? "suspended"
            : "running",
        }),
        runnerProcessLauncher: launch,
        controlPlaneRegistration: async (core) => {
          authority = core;
          await core.start();
          return { connectUrl: core.connectUrl, release: () => core.stop() };
        },
      });
      const driver = new CodexAppServerDriver({
        taskEnvelope: createCodexTaskEnvelope({
          objective: contract.objective,
        }),
        environment: { PAPERCLIP_WORKSPACE_CWD: directory },
        approvalPolicy: "never",
        transportFactory: () => bundle.transport,
      });
      const backend = new HarnessDriverBackend(driver);
      const admitted = vi.fn();
      const execution = executeNativeSession({
        input,
        backend,
        controlPlane,
        runnerInstanceId: identity.runnerInstanceId,
        controlPlaneInstanceId: "composed-core",
        timeoutMs: 900_000,
        requireSessionCloseBeforeReturn: true,
        onSession: admitted,
      }).catch((error: unknown) => error);
      let client: Awaited<ReturnType<typeof authenticatedRunner>> | undefined;
      try {
        await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
        const core = authority!;
        client = await authenticatedRunner(core, identity);
        const commandResult = async (
          type: string,
          result: Record<string, unknown> = {},
        ) => {
          await vi.waitFor(() =>
            expect(
              core.store.state.commands.some(
                (command) => command.type === type,
              ),
            ).toBe(true),
          );
          const command = core.store.state.commands.find(
            (candidate) => candidate.type === type,
          )!;
          client!.send({
            protocol: "paperclip.runner",
            version: 1,
            kind: "command_result",
            payload: {
              commandId: command.commandId,
              commandType: command.type,
              controllerSeq: command.controllerSeq,
              status: "completed",
              result,
            },
          });
          await vi.waitFor(() =>
            expect(core.getCommand(command.commandId)?.status).toBe("completed"),
          );
        };
        const event = (
          sourceSeq: number,
          eventType: PrpEvent["eventType"],
          payload: Record<string, unknown>,
        ) => ({
          protocol: "paperclip.runner",
          version: 1,
          kind: "event",
          ...identity,
          payload: {
            schema: "paperclip.prp.event.v1",
            schemaVersion: 1,
            sourceEventId: `composed-event-${sourceSeq}`,
            sourceSeq,
            sourceInstanceId: identity.runnerInstanceId,
            sourceKind: "runner",
            runId: identity.runId,
            normalizedSessionId: identity.normalizedSessionId,
            turnId: identity.turnId,
            itemId: identity.itemId,
            eventType,
            priority: 0,
            emittedAt: "2026-09-08T00:00:00.000Z",
            payload,
          },
        });
        await commandResult("run.prepare");
        await commandResult("session.open");
        client.send(
          event(1, "session.started", {
            threadId: "composed-provider-thread",
            sessionId: "composed-provider-session",
            runtimeIdentity: { processId: process.pid },
          }),
        );
        await commandResult("session.goal.get", { goal: null });
        if (scenario !== "integrity-fault") {
          await vi.waitFor(() =>
            expect(
              core.store.state.commands.some(
                (command) => command.type === "turn.start",
              ),
            ).toBe(true),
          );
          const start = core.store.state.commands.find(
            (command) => command.type === "turn.start",
          )!;
          // Commit the exact provider start and semantic call while the durable
          // command response is still withheld. No polling/scheduling luck can
          // make this cross-channel order disappear.
          client.send(
            event(2, "turn.started", {
              providerTurnId:
                scenario === "early-foreign-turn"
                  ? "foreign-provider-turn"
                  : "composed-provider-turn",
              status: "inProgress",
            }),
          );
          const earlyResult = {
            ...result,
            summary: "Composed completion.",
            completionClaim: {
              ...result.completionClaim,
              contractRevision: contract.revision,
              criteria: [
                {
                  criterionId: "objective",
                  status: "satisfied",
                  evidenceRefs: ["hello.txt"],
                },
              ],
            },
          };
          client.send(
            event(3, "semantic_tool.input", {
              semantic_tool: {
                schema: "paperclip.prp.semantic_tool.v1",
                schemaVersion: 1,
                phase: "input",
                callId: "early-composed-finish",
                operationId: "paperclip_finish",
                correlation: {
                  runId: identity.runId,
                  normalizedSessionId: identity.normalizedSessionId,
                  turnId: identity.turnId,
                  itemId: identity.itemId,
                },
                idempotencyKey: null,
                content: {
                  digest: `sha256:${createHash("sha256").update(durableRecoveryInternals.canonicalJson(earlyResult)).digest("hex")}`,
                  redactionDisposition: "digest_only",
                  references: [],
                },
                input: earlyResult,
              },
            }),
          );
          await vi.waitFor(() =>
            expect(core.store.state.ackedSourceSeq).toBe(3),
          );
          expect(start.status).toBe("pending");
          expect(
            core.store.state.commands.some(
              (command) => command.type === "semantic_tool.result",
            ),
          ).toBe(false);
          expect(
            events.some((entry) => entry.eventType === "run.result.proposed"),
          ).toBe(false);
          if (scenario === "early-detach") {
            await bundle.detachControllerForRestart();
            kill();
          } else if (scenario === "early-integrity-fault") {
            const transportFailure = bundle.transport
              .request("thread/read", { threadId: "composed-provider-thread" })
              .catch((error: unknown) => error);
            client.send(
              event(4, "semantic_tool.input", {
                semantic_tool: {
                  schema: "paperclip.prp.semantic_tool.v1",
                  schemaVersion: 1,
                  phase: "input",
                  callId: "corrupt-while-admission-pending",
                  operationId: "paperclip_finish",
                  correlation: {
                    runId: identity.runId,
                    normalizedSessionId: identity.normalizedSessionId,
                    turnId: identity.turnId,
                    itemId: identity.itemId,
                  },
                  idempotencyKey: null,
                  content: {
                    digest: `sha256:${"0".repeat(64)}`,
                    redactionDisposition: "digest_only",
                    references: [],
                  },
                  input: earlyResult,
                },
              }),
            );
            const primary = await transportFailure;
            expect(primary).toBeInstanceOf(NativeSessionProtocolIntegrityError);
            expect(await execution).toBe(primary);
            expect(core.store.state.ackedSourceSeq).toBe(3);
          } else if (scenario === "early-new-epoch") {
            // A replaced start fence must reject this parked call, never
            // reinterpret it under the second request's mutable turn id.
            const nextStart = bundle.transport
              .request("turn/start", { input: [{ text: "Next turn" }] })
              .catch((error: unknown) => error);
            await vi.waitFor(() =>
              expect(
                core.store.state.commands.filter(
                  (command) => command.type === "turn.start",
                ),
              ).toHaveLength(2),
            );
            await vi.waitFor(() =>
              expect(
                core.store.state.commands.find(
                  (command) => command.type === "semantic_tool.result",
                )?.payload.isError,
              ).toBe(true),
            );
            for (const command of core.store.state.commands.filter(
              (command) => command.type === "turn.start",
            )) {
              client.send({
                protocol: "paperclip.runner",
                version: 1,
                kind: "command_result",
                payload: {
                  commandId: command.commandId,
                  commandType: command.type,
                  controllerSeq: command.controllerSeq,
                  status: "failed",
                  result: { message: "Provider rejected turn start" },
                },
              });
            }
            expect(await nextStart).toBeInstanceOf(Error);
          } else if (
            scenario === "early-start-rejected" ||
            scenario === "early-close"
          ) {
            if (scenario === "early-close")
              void bundle.transport
                .close("Close during pending admission")
                .catch(() => undefined);
            client.send({
              protocol: "paperclip.runner",
              version: 1,
              kind: "command_result",
              payload: {
                commandId: start.commandId,
                commandType: start.type,
                controllerSeq: start.controllerSeq,
                status: "failed",
                result: { message: "Provider rejected turn start" },
              },
            });
          } else {
            await commandResult("turn.start", {
              providerTurnId: "composed-provider-turn",
            });
          }
          if (scenario === "early-semantic") {
            await vi.waitFor(() =>
              expect(
                core.store.state.commands.find(
                  (command) => command.type === "semantic_tool.result",
                )?.payload.isError,
              ).toBe(false),
            );
            await vi.waitFor(() =>
              expect(
                events.some(
                  (entry) => entry.eventType === "run.result.proposed",
                ),
              ).toBe(true),
            );
            const accepted = events.findIndex(
              (entry) => entry.eventType === "turn.accepted",
            );
            expect(accepted).toBeGreaterThanOrEqual(0);
            expect(
              events.findIndex(
                (entry) => entry.eventType === "run.result.proposed",
              ),
            ).toBeGreaterThan(accepted);
            // Proposal admission is not the runner's durable result receipt.
            // Complete that exact command before asking close to certify reuse.
            await commandResult("semantic_tool.result");
            expect(core.semanticToolResultsSettled()).toBe(true);
            // This fixture replaces only the runner process. Model the new
            // durable close contract explicitly instead of accepting an
            // unreadable provider suffix as a reusable checkpoint.
            mkdirSync(join(directory, "runner"), { recursive: true });
            writeFileSync(
              join(directory, "runner", "codex-provider-state.json"),
              JSON.stringify({ pendingEvents: [], activeProviderTurnId: null }),
            );
            client.send(
              event(4, "turn.completed", {
                providerTurnId: "composed-provider-turn",
                status: "completed",
              }),
            );
            await commandResult("runner.drain", { retainedEventsDrained: true });
            await commandResult("runner.suspend");
            kill();
            expect(await execution).toMatchObject({
              result: { summary: "Composed completion." },
            });
            expect(controlPlane.completeRun).toHaveBeenCalledTimes(1);
          } else {
            expect(await execution).toBeInstanceOf(Error);
            expect(
              events.some((entry) => entry.eventType === "run.result.proposed"),
            ).toBe(false);
            expect(
              core.store.state.commands
                .filter((command) => command.type === "semantic_tool.result")
                .every((command) => command.payload.isError === true),
            ).toBe(true);
            expect(controlPlane.completeRun).not.toHaveBeenCalled();
          }
          expect(launch).toHaveBeenCalledTimes(1);
          return;
        }
        await commandResult("turn.start", {
          providerTurnId: "composed-provider-turn",
        });
        client.send(
          event(2, "turn.started", {
            providerTurnId: "composed-provider-turn",
            status: "inProgress",
          }),
        );
        await vi.waitFor(() =>
          expect(
            events.some((entry) => entry.eventType === "turn.started"),
          ).toBe(true),
        );
        expect(controlPlane.openRun).toHaveBeenCalledTimes(1);
        expect(admitted).toHaveBeenCalledWith(expect.anything());
        // Capture the actual transport fault, not a newly constructed lookalike.
        // A pending read also proves that request and notification consumers see
        // the very same object before the runtime closes its transport.
        const transportFailure = bundle.transport
          .request("thread/read", { threadId: "composed-provider-thread" })
          .catch((error: unknown) => error);
        await vi.waitFor(() =>
          expect(
            core.store.state.commands.some(
              (command) => command.type === "session.snapshot",
            ),
          ).toBe(true),
        );
        const faultAt = Date.now();
        client.send(
          event(3, "semantic_tool.input", {
            semantic_tool: {
              schema: "paperclip.prp.semantic_tool.v1",
              schemaVersion: 1,
              phase: "input",
              callId: "composed-call",
              operationId: "get_task_context",
              correlation: {
                runId: identity.runId,
                normalizedSessionId: identity.normalizedSessionId,
                turnId: identity.turnId,
                itemId: identity.itemId,
              },
              idempotencyKey: null,
              content: {
                digest: `sha256:${"0".repeat(64)}`,
                redactionDisposition: "digest_only",
                references: [],
              },
              input: { summary: "DO-NOT-LEAK-composed-test" },
            },
          }),
        );
        const primary = await transportFailure;
        expect(primary).toBeInstanceOf(NativeSessionProtocolIntegrityError);
        expect(primary).toMatchObject({
          code: "native_event_replay_conflict",
          reason: "semantic_input_digest_mismatch",
          recovery: "operator_required",
        });
        expect(await execution).toBe(primary);
        expect(Date.now() - faultAt).toBeLessThan(5_000);
        expect(core.store.state.ackedSourceSeq).toBe(2);
        expect(
          core.store.state.committedEvents.map((entry) => entry.eventType),
        ).toEqual(["session.started", "turn.started"]);
        expect(controlPlane.completeRun).not.toHaveBeenCalled();
        expect(
          events.some((entry) => entry.eventType === "run.result.proposed"),
        ).toBe(false);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(kill).toHaveBeenCalled();
        expect(bundle.evidence().diagnostics.join("\n")).not.toContain(
          "DO-NOT-LEAK",
        );
      } finally {
        client?.socket.close();
        kill();
        await bundle.detachControllerForRestart();
        await authority?.stop();
        await execution;
        rmSync(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each(["pre-start", "pending-input", "buffered-terminal"] as const)(
    "preserves the exact integrity fault through the composed backend at %s",
    async (stage) => {
      const transport = new FakeCodexTransport();
      const driver = makeDriver([transport]);
      const harness = await driver.openSession({
        runId: "run-integrity",
        normalizedSessionId: "session-integrity",
        workingDirectory: WORKSPACE,
      });
      if (!(harness instanceof CodexSessionState))
        throw new Error("Expected Codex state");
      const backend = new HarnessDriverBackend({
        descriptor: () => driver.descriptor(),
        openSession: async () => harness,
      });
      const session = await backend.openSession({
        identity: {
          runId: "run-integrity",
          sessionId: "session-integrity",
          companyId: "company",
          issueId: "issue",
          agentId: "agent",
        },
        workingDirectory: WORKSPACE,
      });
      const fault = new NativeSessionProtocolIntegrityError(
        "semantic_input_digest_mismatch",
      );
      const events: PrpEvent[] = [];
      let pending: Promise<Record<string, unknown>> | undefined;
      let consumed: Promise<unknown> | undefined;
      const consume = async () => {
        try {
          for await (const event of session.events()) events.push(event);
          return null;
        } catch (error) {
          return error;
        }
      };
      try {
        if (stage !== "pre-start") {
          const { turnId } = await session.startTurn({
            message: { role: "user", text: "Work safely." },
          });
          if (stage === "pending-input") {
            consumed = consume();
            pending = transport.invoke({
              id: "input-integrity",
              method: "item/tool/requestUserInput",
              params: {
                threadId: "thread-1",
                turnId,
                itemId: "input-integrity-item",
                questions: [
                  {
                    id: "color",
                    header: "Color",
                    question: "Which color?",
                    options: [{ label: "Amber" }, { label: "Cobalt" }],
                  },
                ],
              },
            });
            await vi.waitFor(() =>
              expect(
                events.some(
                  (event) => event.eventType === "runtime_request.created",
                ),
              ).toBe(true),
            );
          } else {
            transport.queue.push({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: turnId,
                  status: "completed",
                  items: [
                    {
                      id: "final",
                      type: "agentMessage",
                      text: JSON.stringify(result),
                    },
                  ],
                },
              },
            });
            await vi.waitFor(() => expect(harness.terminal).toBe(true));
            expect(harness.result).not.toBeNull();
          }
        }
        transport.queue.fail(fault);
        await vi.waitFor(() => expect(harness.protocolFailed).toBe(true));
        consumed ??= consume();
        expect(await consumed).toBe(fault);
        expect(
          events.filter((event) =>
            [
              "turn.completed",
              "turn.failed",
              "turn.interrupted",
              "run.result.proposed",
              "runtime_request.expired",
            ].includes(event.eventType),
          ),
        ).toEqual([]);
        if (pending) expect(await pending).toEqual({ answers: {} });
        await expect(session.result()).rejects.toBe(fault);
        await expect(session.snapshot()).rejects.toBe(fault);
        await expect(
          session.startTurn({
            message: { role: "user", text: "Do not retry." },
          }),
        ).rejects.toBe(fault);
        await expect(
          session.attachRun!({
            identity: { ...session.identity(), runId: "replacement-run" },
          }),
        ).rejects.toBe(fault);
        expect(
          transport.calls.filter((call) => call.method === "turn/start"),
        ).toHaveLength(stage === "pre-start" ? 0 : 1);
      } finally {
        await session.close({ reason: "test cleanup" });
        await consumed;
        await pending;
      }
    },
  );

  it("preserves a protocol failure received before turn start as a typed terminal", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({ runId: "prestart", normalizedSessionId: "prestart-session", workingDirectory: WORKSPACE });
    transport.queue.push({ method: "turn/completed", params: { threadId: "unrelated", turn: { id: "wrong", status: "completed" } } });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    await expect(session.startTurn({ message: { role: "user", text: "Work" } })).rejects.toMatchObject({ code: "native_provider_terminal_failed", providerCode: "thread_binding_mismatch", recoverable: false });
    await session.close({ reason: "test complete" });
  });
  it("does not promote a message-and-field lookalike transport error", async () => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport]).openSession({
      runId: "run-generic",
      normalizedSessionId: "session-generic",
      workingDirectory: WORKSPACE,
    });
    const fault = Object.assign(new Error("native_event_replay_conflict"), {
      code: "native_event_replay_conflict",
      reason: "semantic_input_digest_mismatch",
    });
    const events: PrpEvent[] = [];
    const consumed = (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    try {
      await session.startTurn({ message: { role: "user", text: "Work." } });
      transport.queue.fail(fault);
      await consumed;
      expect(
        events.find((event) => event.eventType === "session.failed")?.payload
          .code,
      ).toBe("notification_transport_failed");
      expect(events.some((event) => event.eventType === "turn.failed")).toBe(
        true,
      );
      await expect(session.snapshot()).resolves.toBeDefined();
    } finally {
      await session.close({ reason: "test cleanup" });
      await consumed;
    }
  });
});
