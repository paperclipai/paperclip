import { resolveRunnerCargoTestBinary, resolveRunnerCargoTestBinaryOrDefault } from "../../test/cargo-test-binary.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { SqliteAuthorityStore } from "../control-plane/sqlite-authority-store.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
const runnerTestBinary = () => resolveRunnerCargoTestBinaryOrDefault(
  resolve(import.meta.dirname, "../../runner"),
  "debug",
  "paperclip-runnerd",
  qualifiedCapabilityRunnerdBinary,
);


// Explicit protocol scale qualification, with real runner/fake-provider
// processes and real storage. This does not stand in for Product E2E or a soak.
it.skipIf(process.env.PAPERCLIP_HISTORY_CONTINUATIONS !== "1000")("continues one provider through 1,000 indexed run epochs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "indexed-continuations-"));
  let authority: SqliteAuthorityStore | undefined;
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: runnerTestBinary(),
    codexCommand: resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "fake-codex-app-server"),
    codexArgs: ["--state-file", join(directory, "fake-state.json"), "--durable-turn-ids"],
    stateDirectory: directory,
    prpIdentity: { runnerInstanceId: "history-runner", environmentLeaseId: "history-lease", normalizedSessionId: "history-session", runId: "history-run-0", turnId: "history-turn-0", itemId: "history-item-0" },
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    authorityStoreFactory: async (_identity, root) => authority ??= await SqliteAuthorityStore.open({ path: join(root, "authority.sqlite"), binding: "history-continuations", create: true }),
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  let completed: (() => void) | null = null;
  let consumerFailure: unknown;
  let consumer: Promise<void> | undefined;
  const started = Date.now();
  const durations: number[] = [];
  try {
    await bundle.transport.request("initialize", {});
    const opened = await bundle.transport.request("thread/start", {
      cwd: directory,
      dynamicTools: [{ name: "get_task_context", description: "Read the task.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      completionContract: { revision: "history-contract", criterionIds: ["objective"] },
    });
    const owner = bundle.evidence();
    consumer = (async () => {
      for await (const notification of bundle.transport.notifications()) {
        const port = bundle.transport.normalizedDelivery!()!;
        if (notification.paperclipDelivery) await port.commit({
          expectedRevision: port.load()?.revision ?? 0,
          raw: notification.paperclipDelivery,
          driver: { schema: "paperclip.qualification.raw-consumer.v1" }, events: [],
        });
        if (notification.method === "turn/completed") completed?.();
      }
    })().catch((error) => { consumerFailure = error; completed?.(); });
    bundle.transport.setBeforeRunRotation!(async () => { if (consumerFailure) throw consumerFailure; });
    for (let index = 0; index < 1000; index++) {
      const before = Date.now();
      if (index) await bundle.transport.attachRun!({ runId: `history-run-${index}`, turnId: `history-turn-${index}`, itemId: `history-item-${index}` });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const terminal = new Promise<void>((resolve, reject) => { completed = resolve; timer = setTimeout(() => reject(new Error(`turn ${index} timed out`)), 20_000); });
      try {
        await bundle.transport.request("turn/start", { input: [{ type: "text", text: `Continue the same task: ${index}` }] });
        await terminal;
        if (consumerFailure) throw consumerFailure;
      } finally { clearTimeout(timer); }
      expect(bundle.evidence()).toMatchObject({ runnerPid: owner.runnerPid, codexPid: owner.codexPid, runnerExited: false });
      const current = await authority!.load();
      expect(Buffer.byteLength(JSON.stringify(current!.state))).toBeLessThan(256 * 1024);
      durations.push(Date.now() - before);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const report = { schema: "paperclip.indexed-continuations-qualification.v1", turns: durations.length, elapsedMs: Date.now() - started, turnP95Ms: sorted[949], first100MeanMs: durations.slice(0,100).reduce((a,b)=>a+b)/100, last100MeanMs: durations.slice(-100).reduce((a,b)=>a+b)/100, sameRunnerAndProvider: true, provider: "credential-free fake Codex process", opened };
    if (process.env.PAPERCLIP_HISTORY_REPORT) await writeFile(process.env.PAPERCLIP_HISTORY_REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
  } finally {
    await bundle.transport.close();
    await consumer;
    await authority?.close();
    expect(bundle.evidence()).toMatchObject({ runnerExited: true, runnerExitCode: 0 });
    await rm(directory, { recursive: true, force: true });
  }
}, 30 * 60_000);
