import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import {
  createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
} from "./runnerd-codex-transport.js";

// Opt in explicitly; never build/stage runnerd or invoke a real provider here.
// Run from packages/paperclip-runner:
// PAPERCLIP_FINAL_BURST_BENCHMARK=1 pnpm exec vitest run src/live/runnerd-final-output-burst.benchmark.test.ts
// PAPERCLIP_FINAL_BURST_BINARY optionally selects an isolated comparison build;
// the selected binary is still copied privately and verified unchanged.
// This is an opt-in local filesystem benchmark, not a CPU-isolated performance
// assertion. Repetitions share the host's background load and filesystem caches.
const enabled = process.env.PAPERCLIP_FINAL_BURST_BENCHMARK === "1";
const repetitions = Number(
  process.env.PAPERCLIP_FINAL_BURST_REPETITIONS ?? "1",
);
if (
  enabled &&
  (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5)
) {
  throw new Error("final_burst_repetitions_must_be_between_1_and_5");
}
const fixture = resolve(
  import.meta.dirname,
  "../../test/fixtures/fake-final-burst-codex-app-server.mjs",
);
const cases = [16, 128, 512].flatMap((deltaCount) =>
  Array.from({ length: enabled ? repetitions : 1 }, (_, repeat) => ({
    deltaCount,
    repeat: repeat + 1,
  })),
);
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

it.skipIf(!enabled).each(cases)(
  "measures $deltaCount final deltas, repetition $repeat, without relaxing durable handoff",
  async ({ deltaCount, repeat }) => {
    const root = await mkdtemp(
      join(tmpdir(), "paperclip-final-burst-benchmark-"),
    );
    try {
      const stateDirectory = join(root, "session");
      const sourceCodexHome = join(root, "empty-codex-home");
      const providerState = join(root, "fixture-state.json");
      await mkdir(sourceCodexHome);
      const staged = process.env.PAPERCLIP_FINAL_BURST_BINARY
        ? resolve(process.env.PAPERCLIP_FINAL_BURST_BINARY)
        : defaultCapabilityRunnerdBinary();
      const runnerBinary = join(root, "paperclip-runnerd");
      const binarySha256 = digest(await readFile(staged));
      await copyFile(staged, runnerBinary);
      await chmod(runnerBinary, 0o700);
      expect(digest(await readFile(runnerBinary))).toBe(binarySha256);
      expect(digest(await readFile(staged))).toBe(binarySha256);

      const identity = {
        runnerInstanceId: "runner-final-burst",
        environmentLeaseId: "lease-final-burst",
        runId: "run-final-burst-first",
        normalizedSessionId: "session-final-burst",
        turnId: "turn-final-burst-first",
        itemId: "item-final-burst-first",
      };
      let authority: DurablePrpControlPlane | null = null;
      let saves = 0;
      let saveMs = 0;
      let cursorCommits = 0;
      let lastCursor = 0;
      let terminalCommittedAtMs: number | null = null;
      let terminalEmittedAtMs: number | null = null;
      const commandReceipts = new Map<
        string,
        { type: string; issuedAtMs: number; completedAtMs: number }
      >();
      const options = {
        runnerBinary,
        codexCommand: process.execPath,
        codexArgs: [fixture, providerState, String(deltaCount)],
        sourceCodexHome,
        environment: {},
        stateDirectory,
        lifecyclePolicy: { mode: "per_turn" as const, idleTimeoutMs: null },
      };
      const first = createCapabilityRunnerdCodexTransport({
        ...options,
        prpIdentity: identity,
        controlPlaneRegistration: async (core) => {
          authority = core;
          // Test-only observation of the existing durable save boundary. This
          // delegates every save unchanged and never edits a cursor or receipt.
          const store = core.store as typeof core.store & { save(): void };
          const original = store.save.bind(store);
          store.save = () => {
            const started = performance.now();
            original();
            saveMs += performance.now() - started;
            saves += 1;
            const now = Date.now();
            if (store.state.ackedSourceSeq > lastCursor) {
              cursorCommits += 1;
              lastCursor = store.state.ackedSourceSeq;
            }
            const lastEvent = store.state.committedEvents.at(-1);
            if (
              lastEvent?.eventType === "run.terminal" &&
              terminalCommittedAtMs === null
            ) {
              terminalCommittedAtMs = now;
              const event = lastEvent.envelope.payload as Record<
                string,
                unknown
              >;
              terminalEmittedAtMs = Date.parse(String(event.emittedAt));
            }
            for (const command of store.state.commands) {
              if (
                command.status === "completed" &&
                !commandReceipts.has(command.commandId)
              ) {
                commandReceipts.set(command.commandId, {
                  type: command.type,
                  issuedAtMs: Date.parse(command.issuedAt),
                  completedAtMs: now,
                });
              }
            }
          };
          await core.start();
          return { connectUrl: core.connectUrl, release: () => undefined };
        },
      });
      let semanticCalls = 0;
      first.transport.setServerRequestHandler(async () => {
        semanticCalls += 1;
        return {
          success: true,
          contentItems: [{ type: "inputText", text: '{"ok":true}' }],
        };
      });
      let replay:
        ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
      let successor:
        ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let consumed: Promise<void> | undefined;
      try {
        const startedAtMs = Date.now();
        const opened = await first.transport.request("thread/start", {
          cwd: root,
          model: "fixture-no-model",
          dynamicTools: [...codexSemanticToolSpecs()],
          completionContract: { revision: "burst-v1", criterionIds: ["burst"] },
        });
        await first.transport.request("turn/start", {
          input: [
            {
              type: "text",
              text: "Emit the fixed synthetic final-output burst.",
            },
          ],
        });
        const deltas: string[] = [];
        consumed = (async () => {
          for await (const event of first.transport.notifications()) {
            if (event.method === "item/agentMessage/delta")
              deltas.push(String(event.params.text));
            if (event.method === "turn/completed") return;
          }
          throw new Error("final_burst_stream_ended_without_terminal");
        })();
        await Promise.race([
          consumed,
          new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(
              () => reject(new Error("final_burst_terminal_deadline")),
              45_000,
            );
          }),
        ]);
        clearTimeout(deadlineTimer);
        expect(deltas).toEqual(
          Array.from(
            { length: deltaCount },
            (_, index) => `${index.toString().padStart(4, "0")} `,
          ),
        );
        expect(semanticCalls).toBe(1);
        const terminalObservedAtMs = Date.now();
        const closeStartedAtMs = Date.now();
        await first.transport.close();
        const closeFinishedAtMs = Date.now();
        const durable = await json(
          join(stateDirectory, "runner", "runner-state.json"),
        );
        expect(durable).toMatchObject({
          ...identity,
          schema: "paperclip.runner.durable.state.v1",
          lifecycle: "suspended",
        });
        const control = await json(
          join(stateDirectory, "control-plane", "control-plane-state.json"),
        );
        expect(control.identity).toEqual(identity);
        expect(control.commands).toContainEqual(
          expect.objectContaining({
            type: "runner.suspend",
            status: "completed",
          }),
        );
        expect(
          control.committedEvents.map(
            (event: { sourceSeq: number }) => event.sourceSeq,
          ),
        ).toEqual(
          Array.from(
            { length: control.ackedSourceSeq },
            (_, index) => index + 1,
          ),
        );
        expect(
          control.committedEvents.every(
            (event: { logicalEffectCount: number }) =>
              event.logicalEffectCount === 1,
          ),
        ).toBe(true);
        expect(durable.ackedSourceSeq).toBe(control.ackedSourceSeq);
        expect(terminalCommittedAtMs).not.toBeNull();
        expect(Number.isFinite(terminalEmittedAtMs)).toBe(true);
        const fixtureState = await json(providerState);
        const turn = fixtureState.turns["final-burst-turn-1"];
        expect(turn).toMatchObject({ status: "completed", deltaCount });

        // Exercise saved same-run replay, then the production six-field
        // authority-rotation guard. The latter only reopens/reads the existing
        // provider thread; it does not execute a second provider turn. Neither
        // path may run the fixture tool again.
        replay = createCapabilityRunnerdCodexTransport({
          ...options,
          prpIdentity: identity,
        });
        let replayedSemanticCalls = 0;
        replay.transport.setServerRequestHandler(async () => {
          replayedSemanticCalls += 1;
          throw new Error("final_burst_semantic_reexecution");
        });
        const replayed = await replay.transport.request("thread/read", {});
        expect(replayed.thread).toMatchObject({
          id: (opened.thread as Record<string, unknown>).id,
        });
        await replay.transport.close();
        expect(replayedSemanticCalls).toBe(0);
        const replayState = await json(
          join(stateDirectory, "control-plane", "control-plane-state.json"),
        );
        expect(
          replayState.committedEvents.every(
            (event: { logicalEffectCount: number }) =>
              event.logicalEffectCount === 1,
          ),
        ).toBe(true);
        const successorIdentity = {
          ...identity,
          runId: "run-final-burst-second",
          turnId: "turn-final-burst-second",
          itemId: "item-final-burst-second",
        };
        successor = createCapabilityRunnerdCodexTransport({
          ...options,
          prpIdentity: successorIdentity,
        });
        const resumed = await successor.transport.request("thread/read", {});
        expect(resumed.thread).toMatchObject({
          id: (opened.thread as Record<string, unknown>).id,
        });
        await successor.transport.close();
        expect(
          await json(join(stateDirectory, "runner", "runner-state.json")),
        ).toMatchObject({ ...successorIdentity, lifecycle: "suspended" });
        expect((await json(providerState)).nextTurn).toBe(1);
        expect(digest(await readFile(staged))).toBe(binarySha256);
        const timing = (at: number | null) =>
          at === null ? null : at - turn.providerCompletedAtMs;
        process.stdout.write(
          `FINAL_BURST_BENCHMARK ${JSON.stringify({
            schema: "paperclip.final_output_burst_benchmark.v1",
            deltaCount,
            repeat,
            binarySha256,
            providerEmissionMs:
              turn.providerCompletedAtMs - turn.burstStartedAtMs,
            startupToProviderCompleteMs:
              turn.providerCompletedAtMs - startedAtMs,
            providerCompleteToRunnerTerminalMs: timing(terminalEmittedAtMs),
            providerCompleteToControllerTerminalMs: timing(
              terminalCommittedAtMs,
            ),
            providerCompleteToVisibleTerminalMs:
              terminalObservedAtMs - turn.providerCompletedAtMs,
            closeMs: closeFinishedAtMs - closeStartedAtMs,
            controllerSaves: saves,
            controllerSaveMs: Math.round(saveMs * 100) / 100,
            controllerCursorCommits: cursorCommits,
            committedEvents: control.committedEvents.length,
            controlCloseCommands: [...commandReceipts.values()]
              .filter((command) =>
                ["turn.stop", "runner.drain", "runner.suspend"].includes(
                  command.type,
                ),
              )
              .map((command) => ({
                type: command.type,
                receiptMs: command.completedAtMs - command.issuedAtMs,
              })),
            exactDeltas: true,
            exactSuspension: true,
            sameRunReplay: true,
            sameProviderAuthorityReopen: true,
            successorTurnExecuted: false,
            rustSaveCount: null,
            wireAckCount: null,
          })}\n`,
        );
        expect(authority).not.toBeNull();
      } finally {
        clearTimeout(deadlineTimer);
        await Promise.allSettled([
          first.transport.close(),
          replay?.transport.close(),
          successor?.transport.close(),
        ]);
        await Promise.allSettled([consumed]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
