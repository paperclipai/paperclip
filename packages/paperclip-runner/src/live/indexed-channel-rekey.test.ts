import { resolveRunnerCargoTestBinary, resolveRunnerCargoTestBinaryOrDefault } from "../../test/cargo-test-binary.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { SqliteAuthorityStore } from "../control-plane/sqlite-authority-store.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
const runnerTestBinary = () => resolveRunnerCargoTestBinaryOrDefault(
  resolve(import.meta.dirname, "../../runner"),
  "debug",
  "paperclip-runnerd",
  qualifiedCapabilityRunnerdBinary,
);


// Real native transport/process/storage; the provider is credential-free.
// The small connection limit exercises the normal production re-auth path.
it.each([false, true])("rekeys repeatedly during one active provider turn (command epochs: %s)", async (commandEpochs) => {
  const root = await mkdtemp(join(tmpdir(), "indexed-channel-rekey-"));
  const callsPath = join(root, "calls.log");
  let authority: SqliteAuthorityStore | undefined;
  const cores: DurablePrpControlPlane[] = [];
  const open = DurablePrpControlPlane.open.bind(DurablePrpControlPlane);
  const spy = vi.spyOn(DurablePrpControlPlane, "open").mockImplementation(async options => {
    const core = await open({ ...options, secureChannelFrameLimit: 16, ...(commandEpochs ? { commandEpochLimit: 8 } : {}) });
    cores.push(core); return core;
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: runnerTestBinary(),
    codexCommand: resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake.json"), "--durable-turn-ids", "--hold-turn", "--record-process-start", "--call-log", callsPath, "--require-lightweight-history"],
    stateDirectory: root, runnerReconnectGraceMs: 10_000,
    authorityStoreFactory: async (_identity, directory) => authority ??= await SqliteAuthorityStore.open({ path: join(directory, "authority.sqlite"), binding: "channel-rekey", create: true }),
  });
  let consumer: Promise<void> | undefined, failure: unknown;
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: root, dynamicTools: [] });
    consumer = (async () => {
      for await (const notification of bundle.transport.notifications()) {
        const port = bundle.transport.normalizedDelivery!()!;
        if (notification.paperclipDelivery) await port.commit({ expectedRevision: port.load()?.revision ?? 0, raw: notification.paperclipDelivery,
          driver: { schema: "paperclip.qualification.raw-consumer.v1" }, events: [] });
      }
    })().catch(error => { failure = error; });
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Keep the same turn active across encrypted connections." }] });
    const owner = bundle.evidence(), core = cores[0]!, identity = structuredClone(core.store.state.identity);
    const firstCommand = structuredClone(core.store.state.commands[0]!);
    const epochs = new Set<string | undefined>();
    const threadId = (opened.thread as { id: string }).id;
    for (let index = 0; index < 64; index++) {
      await bundle.transport.request("thread/read", { threadId, includeTurns: false });
      if (failure) throw failure;
      epochs.add(core.store.state.indexedState?.controllerEpoch);
      expect(bundle.evidence()).toMatchObject({ runnerPid: owner.runnerPid, codexPid: owner.codexPid, runnerExited: false });
    }
    if (commandEpochs) {
      expect(epochs.size).toBeGreaterThanOrEqual(7);
      expect(await core.queueCommand(firstCommand.type, firstCommand.payload, firstCommand.commandId)).toMatchObject({ commandId: firstCommand.commandId, status: firstCommand.status });
    }
    expect(core.store.state.connectionCount).toBeGreaterThanOrEqual(4);
    expect(core.store.state.identity).toEqual(identity);
    expect(core.store.state.malformedFrames).toBe(0);
    const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
    expect(calls.filter(call => call === "process-start")).toHaveLength(1);
    expect(calls.filter(call => call === "thread/start")).toHaveLength(1);
    expect(calls.filter(call => call === "turn/start")).toHaveLength(1);
    expect(calls).not.toContain("turn/interrupt");
    expect(calls).not.toContain("thread/resume");
    const first = (await authority!.readEvents(identity.runId, "0", 1, 1024 * 1024)).records[0]!;
    expect(await authority!.getRecord(identity.runId, "event", first.id)).toEqual(first);
  } finally {
    await bundle.transport.close(); await consumer; await authority?.close(); spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
