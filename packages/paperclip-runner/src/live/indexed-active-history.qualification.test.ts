import { resolveRunnerCargoTestBinary, resolveRunnerCargoTestBinaryOrDefault } from "../../test/cargo-test-binary.js";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver-impl.js";
import { SqliteAuthorityStore } from "../control-plane/sqlite-authority-store.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
const runnerTestBinary = () => resolveRunnerCargoTestBinaryOrDefault(
  resolve(import.meta.dirname, "../../runner"),
  "debug",
  "paperclip-runnerd",
  qualifiedCapabilityRunnerdBinary,
);


const seconds = Number(process.env.PAPERCLIP_ACTIVE_HISTORY_SOAK_SECONDS ?? 0);
// The short lane checks the fixture; only 259200 seconds is a 72-hour result.
it.skipIf(![60, 259200].includes(seconds))("keeps generating and durably consuming output during one active turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "indexed-active-history-"));
  const identity = { runnerInstanceId: "active-history-runner", environmentLeaseId: "active-history-lease", normalizedSessionId: "active-history-session",
    runId: "active-history-run", turnId: "active-history-turn", itemId: "active-history-item" };
  let authority: SqliteAuthorityStore | undefined;
  const sink = await SqliteAuthorityStore.open({ path: join(root, "normalized.sqlite"), binding: "active-history-sink", create: true });
  const bundle = createCapabilityRunnerdCodexTransport({ runnerBinary: runnerTestBinary(),
    codexCommand: resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake.json"), "--durable-turn-ids", "--hold-turn", "--soak-output-on-steer", "--require-lightweight-history"],
    stateDirectory: root, prpIdentity: identity, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    authorityStoreFactory: async (_identity, directory) => authority ??= await SqliteAuthorityStore.open({ path: join(directory, "authority.sqlite"), binding: "active-history", create: true }),
  });
  const driver = new CodexAppServerDriver({ taskEnvelope: { schema: "paperclip.skillless_task.v1", objective: "Qualify a long active turn with growing output.",
    completionContract: { revision: "active-history-v1", criteria: [{ id: "history", requirement: "Durably deliver ordinary output." }] }, constraints: [], expectedResultSchema: "paperclip.run_result.v1" },
    runnerInstanceId: identity.runnerInstanceId, approvalPolicy: "never", includeCollaborationModeInstructions: false,
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/isolated/home", CODEX_HOME: "/isolated/codex-home", LANG: "C.UTF-8" },
    transportFactory: () => bundle.transport, requireProviderSessionIdentity: true });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  let generation = "0", events = 0, items = 0, bytes = 0, peakCurrentBytes = 0, probes = 0, maxProbeMs = 0;
  let body: { id: string; offset: number; digest: ReturnType<typeof createHash> } | null = null;
  let consumer: Promise<void> | undefined, failure: unknown, closing = false;
  let started = performance.now(), startedAt = new Date().toISOString();
  const report = async (status: string, error?: unknown) => {
    const target = process.env.PAPERCLIP_HISTORY_REPORT;
    if (!target) return;
    await writeFile(`${target}.tmp`, JSON.stringify({ schema: "paperclip.indexed-active-history.v1", status,
      provider: "credential-free fake Codex; actual driver and durable event sink", seconds, startedAt,
      updatedAt: new Date().toISOString(), elapsedMs: performance.now() - started, events, items, bytes, probes,
      peakCurrentBytes, maxProbeMs, runnerPid: bundle.evidence().runnerPid, providerPid: bundle.evidence().providerPid,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) }, null, 2), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  };
  try {
    session = await driver.openSession({ runId: identity.runId, normalizedSessionId: identity.normalizedSessionId, workingDirectory: root });
    const commit = async (event: import("../protocol/replay-contract.js").PrpEvent) => {
      generation = await sink.commit({ expectedGeneration: generation, state: { lastSourceSeq: event.sourceSeq },
        records: [{ epoch: event.runId, kind: "event", id: event.sourceEventId, sequence: String(event.sourceSeq), body: event as unknown as Record<string, unknown> }] });
    };
    session.setEventCommitter!(commit);
    consumer = (async () => {
      for await (const event of session!.events()) {
        await commit(event); await session!.acknowledgeEvent!(event); events++;
        if (event.eventType === "output.body.chunk") {
          const ref = event.payload.body as Record<string, unknown>, text = String(event.payload.text), offset = Number(event.payload.offset);
          if (offset === 0) { expect(body).toBeNull(); body = { id: String(ref.bodyId), offset: 0, digest: createHash("sha256") }; }
          expect(body?.id).toBe(ref.bodyId); expect(body?.offset).toBe(offset);
          expect(createHash("sha256").update(text).digest("hex")).toBe(event.payload.sha256);
          body!.digest.update(text); body!.offset += Buffer.byteLength(text); bytes += Buffer.byteLength(text);
        }
        if (event.eventType === "item.completed" && event.itemId?.startsWith("soak-output-")) {
          const ref = event.payload.outputBody as Record<string, unknown>;
          expect(body?.id).toBe(ref.bodyId); expect(String(body!.offset)).toBe(ref.byteLength);
          expect(body!.digest.digest("hex")).toBe(ref.sha256);
          body = null; items++;
        }
        if (!closing && ["turn.completed", "turn.failed", "session.failed"].includes(event.eventType)) throw new Error(`active soak ended early: ${event.eventType}`);
      }
      if (!closing) throw new Error("active soak event stream closed early");
    })().catch(error => { failure = error; });
    const turn = await session.startTurn({ message: { text: "Keep this turn active while generating qualification output." } });
    const owner = bundle.evidence();
    started = performance.now(); startedAt = new Date().toISOString();
    await report("running");
    while (performance.now() - started < seconds * 1000) {
      if (failure) throw failure;
      const before = performance.now(), previous = items;
      await session.steer!({ turnId: turn.turnId, message: { text: `Produce qualification output ${probes + 1}.` }, correlationId: `soak-steer-${probes + 1}` });
      await bundle.transport.request("thread/read", { threadId: session.ids().driverSessionId, includeTurns: false });
      const deadline = performance.now() + 30_000;
      while (items === previous && !failure && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (failure) throw failure;
      expect(items).toBeGreaterThan(previous);
      maxProbeMs = Math.max(maxProbeMs, performance.now() - before); probes++;
      expect(bundle.evidence()).toMatchObject({ runnerPid: owner.runnerPid, providerPid: owner.providerPid, runnerExited: false });
      peakCurrentBytes = Math.max(peakCurrentBytes, Buffer.byteLength(JSON.stringify((await authority!.load())!.state)));
      expect(peakCurrentBytes).toBeLessThan(8 * 1024 * 1024);
      await report("running");
      await new Promise(resolve => setTimeout(resolve, Math.min(seconds === 60 ? 1000 : 30_000, Math.max(0, seconds * 1000 - (performance.now() - started)))));
    }
    closing = true; await report("settling");
    await session.close({ reason: "active history qualification complete" }); await consumer; session = undefined;
    if (failure) throw failure;
    await bundle.transport.close(); await authority!.close(); authority = undefined; await sink.close();
    expect(bundle.evidence()).toMatchObject({ runnerExited: true, runnerExitCode: 0 });
    await rm(root, { recursive: true, force: true });
    await report("passed");
  } catch (error) { await report("failed", error); throw error; }
  finally { closing = true; await session?.close({ reason: "active history qualification cleanup" }); await consumer;
    await bundle.transport.close(); await authority?.close(); await sink.close(); await rm(root, { recursive: true, force: true }); }
}, (seconds + 3600) * 1000);
