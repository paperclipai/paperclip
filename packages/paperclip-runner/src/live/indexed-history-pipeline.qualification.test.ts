import { resolveRunnerCargoTestBinary, resolveRunnerCargoTestBinaryOrDefault } from "../../test/cargo-test-binary.js";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver-impl.js";
import { SqliteAuthorityStore } from "../control-plane/sqlite-authority-store.js";
import { readIndexedLocalState } from "../control-plane/indexed-local-state-reader.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
const runnerTestBinary = () => resolveRunnerCargoTestBinaryOrDefault(
  resolve(import.meta.dirname, "../../runner"),
  "debug",
  "paperclip-runnerd",
  qualifiedCapabilityRunnerdBinary,
);


const mib = Number(process.env.PAPERCLIP_HISTORY_PIPELINE_MIB ?? 0);
it.skipIf(![64, 10240].includes(mib))("ingests large ordinary provider output through runner, controller, normalizer and durable event sink", async () => {
  const root = await mkdtemp(join(tmpdir(), "indexed-history-pipeline-"));
  let authority: SqliteAuthorityStore | undefined;
  const sink = await SqliteAuthorityStore.open({ path: join(root, "normalized.sqlite"), binding: "pipeline-sink", create: true });
  const identity = { runnerInstanceId: "pipeline-runner", environmentLeaseId: "pipeline-lease", normalizedSessionId: "pipeline-session", runId: "pipeline-run", turnId: "pipeline-turn", itemId: "pipeline-item" };
  const bundle = createCapabilityRunnerdCodexTransport({ runnerBinary: runnerTestBinary(),
    codexCommand: resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake.json"), "--durable-turn-ids", "--history-growth-mib", String(mib)],
    stateDirectory: root, prpIdentity: identity,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    authorityStoreFactory: async (_identity, directory) => authority ??= await SqliteAuthorityStore.open({ path: join(directory, "authority.sqlite"), binding: "history-pipeline", create: true }),
  });
  const driver = new CodexAppServerDriver({ taskEnvelope: { schema: "paperclip.skillless_task.v1", objective: "Generate ordinary output to qualify durable history.",
    completionContract: { revision: "pipeline-v1", criteria: [{ id: "history", requirement: "Deliver all output." }] }, constraints: [], expectedResultSchema: "paperclip.run_result.v1" },
    runnerInstanceId: identity.runnerInstanceId, approvalPolicy: "never", includeCollaborationModeInstructions: false,
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/isolated/home", CODEX_HOME: "/isolated/codex-home", LANG: "C.UTF-8" },
    transportFactory: () => bundle.transport, requireProviderSessionIdentity: true });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  let generation = "0", events = 0, normalizedBytes = 0, peakCurrentBytes = 0, historyItems = 0, bodyBytes = 0;
  let body: { id: string; offset: number; hash: ReturnType<typeof createHash> } | null = null;
  const hash = createHash("sha256"), started = Date.now();
  const report = async (status: string, extra = {}) => {
    if (process.env.PAPERCLIP_HISTORY_REPORT) await writeFile(process.env.PAPERCLIP_HISTORY_REPORT, JSON.stringify({ schema: "paperclip.indexed-history-pipeline.v1", status, provider: "credential-free fake Codex", mib, events, historyItems, bodyBytes, normalizedBytes, peakCurrentBytes, elapsedMs: Date.now() - started, ...extra }, null, 2), { mode: 0o600 });
  };
  try {
    session = await driver.openSession({ runId: identity.runId, normalizedSessionId: identity.normalizedSessionId, workingDirectory: root });
    const commit = async (event: import("../protocol/replay-contract.js").PrpEvent) => {
      generation = await sink.commit({ expectedGeneration: generation, state: { lastSourceSeq: event.sourceSeq }, records: [{ epoch: event.runId, kind: "event", id: event.sourceEventId, sequence: String(event.sourceSeq), body: event as unknown as Record<string, unknown> }] });
    };
    session.setEventCommitter!(commit);
    const consumeUntilTerminal = async () => {
      for await (const event of session!.events()) {
        const bytes = JSON.stringify(event); hash.update(bytes); normalizedBytes += Buffer.byteLength(bytes); events++;
        await commit(event);
        await session!.acknowledgeEvent!(event);
        if (event.eventType === "output.body.chunk") {
          const reference = event.payload.body as Record<string, unknown>;
          const chunk = String(event.payload.text), offset = Number(event.payload.offset);
          if (offset === 0) { expect(body).toBeNull(); body = { id: String(reference.bodyId), offset: 0, hash: createHash("sha256") }; }
          expect(body?.id).toBe(reference.bodyId);
          expect(body?.offset).toBe(offset);
          expect(createHash("sha256").update(chunk).digest("hex")).toBe(event.payload.sha256);
          body!.hash.update(chunk); body!.offset += Buffer.byteLength(chunk); bodyBytes += Buffer.byteLength(chunk);
        }
        const outputId = event.eventType === "tool.execution.completed" ? event.payload.executionId : event.itemId;
        if (["item.completed", "tool.execution.completed"].includes(event.eventType) && typeof outputId === "string" && outputId.startsWith("history-")) {
          const reference = event.payload.outputBody as Record<string, unknown>;
          expect(body?.offset).toBe(256 * 1024);
          expect(body!.hash.digest("hex")).toBe(reference.sha256);
          expect(body?.id).toBe(reference.bodyId);
          body = null; historyItems++;
        }
        if (events % 128 === 0) {
          peakCurrentBytes = Math.max(peakCurrentBytes, Buffer.byteLength(JSON.stringify((await authority!.load())!.state)));
          expect(peakCurrentBytes).toBeLessThan(8 * 1024 * 1024);
          await report("running");
        }
        if (["session.failed", "turn.failed"].includes(event.eventType)) throw new Error(`pipeline failed: ${JSON.stringify(event.payload)}`);
        if (event.eventType === "turn.completed") return;
      }
      throw new Error("history stream ended before completion");
    };
    const consume = consumeUntilTerminal();
    // Keep any asynchronous consumer failure observed while turn admission runs.
    void consume.catch(() => {});
    await session.startTurn({ message: { text: "Generate the qualification output." } });
    await consume;
    expect(historyItems).toBe(mib * 4);
    expect(bodyBytes).toBe(mib * 1024 * 1024);
    await session.flushEventDelivery!();
    const beforeContinuation = bundle.evidence();
    const continuationStarted = performance.now();
    await session.attachRun!({ runId: "pipeline-continuation" });
    const resumed = consumeUntilTerminal(); void resumed.catch(() => {});
    await session.startTurn({ message: { text: "Continue after the retained output history." } });
    await resumed;
    const continuationMs = performance.now() - continuationStarted;
    expect(bundle.evidence().providerPid).toBe(beforeContinuation.providerPid);
    expect(bundle.evidence().runnerPid).toBe(beforeContinuation.runnerPid);
    await session.flushEventDelivery!();
    const before = performance.now();
    const snapshots = await Promise.all([authority!.load(), readIndexedLocalState(join(root, "runner/runner-state.json")), readIndexedLocalState(join(root, "runner/codex-provider-state.json"))]);
    const resumeReadMs = performance.now() - before;
    const currentBytes = snapshots.map(snapshot => Buffer.byteLength(JSON.stringify(snapshot!.state)));
    expect(currentBytes.every(bytes => bytes < 8 * 1024 * 1024)).toBe(true);
    let physicalBytes = 0, files = 0;
    async function inventory(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inventory(path);
        else if (entry.isFile()) {
          // SQLite may unlink a transient WAL/SHM after readdir during a
          // checkpoint. Persistent files disappearing are still an error.
          const metadata = await stat(path).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" && /\.sqlite-(wal|shm)$/.test(path)) return null;
            throw error;
          });
          if (metadata) { physicalBytes += metadata.size; files++; }
        }
      }
    }
    await inventory(root);
    expect(physicalBytes).toBeGreaterThan(mib * 1024 * 1024);
    const evidence = bundle.evidence();
    await session.close({ reason: "qualification complete" }); session = undefined;
    await bundle.transport.close(); await authority!.close(); authority = undefined;
    await sink.close(); await rm(root, { recursive: true, force: true });
    await report("passed", { physicalBytes, files, currentBytes, resumeReadMs, continuationMs, normalizedSha256: hash.digest("hex"), runner: evidence });
  } catch (error) { await report("failed", { error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally { await session?.close({ reason: "history qualification complete" }); await bundle.transport.close(); await authority?.close(); await sink.close(); await rm(root, { recursive: true, force: true }); }
}, 12 * 60 * 60_000);
