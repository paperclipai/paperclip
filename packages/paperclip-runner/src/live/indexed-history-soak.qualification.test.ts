import { resolveRunnerCargoTestBinary, resolveRunnerCargoTestBinaryOrDefault } from "../../test/cargo-test-binary.js";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { SqliteAuthorityStore } from "../control-plane/sqlite-authority-store.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
const runnerTestBinary = () => resolveRunnerCargoTestBinaryOrDefault(
  resolve(import.meta.dirname, "../../runner"),
  "debug",
  "paperclip-runnerd",
  qualifiedCapabilityRunnerdBinary,
);


const hours = 72;
// Real elapsed-time qualification. A held fake-provider turn exercises runner
// leases and wall-clock limits without paid inference. This does not qualify
// a hosted provider/sandbox TTL or substitute for crash/resource-failure lanes.
it.skipIf(process.env.PAPERCLIP_HISTORY_SOAK_HOURS !== String(hours))("keeps one indexed active turn alive for 72 real hours", async () => {
  const directory = await mkdtemp(join(tmpdir(), "indexed-history-soak-"));
  let authority: SqliteAuthorityStore | undefined;
  const identity = { runnerInstanceId: "soak-runner", environmentLeaseId: "soak-lease", normalizedSessionId: "soak-session", runId: "soak-run", turnId: "soak-turn", itemId: "soak-item" };
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: runnerTestBinary(),
    codexCommand: resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "fake-codex-app-server"),
    codexArgs: ["--state-file", join(directory, "fake-state.json"), "--durable-turn-ids", "--hold-turn"],
    stateDirectory: directory, prpIdentity: identity,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 600_000 },
    authorityStoreFactory: async (_identity, root) => authority ??= await SqliteAuthorityStore.open({ path: join(root, "authority.sqlite"), binding: "history-soak", create: true }),
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  let consumer: Promise<void> | undefined;
  let consumerFailure: unknown;
  let terminal = false;
  let startedAt = new Date().toISOString(), started = performance.now();
  let qualified = false;
  let probes = 0, peakCurrentBytes = 0, maxProbeMs = 0;
  const report = async (status: string, error?: unknown) => {
    if (!process.env.PAPERCLIP_HISTORY_REPORT) return;
    const path = process.env.PAPERCLIP_HISTORY_REPORT;
    const value = { schema: "paperclip.indexed-active-turn-soak.v1", status, startedAt, updatedAt: new Date().toISOString(), elapsedMs: performance.now()-started, requiredHours: hours, probes, peakCurrentBytes, maxProbeMs, provider: "credential-free fake Codex process", runnerPid: bundle.evidence().runnerPid, providerPid: bundle.evidence().codexPid, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) };
    await writeFile(`${path}.tmp`, JSON.stringify(value,null,2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  try {
    await bundle.transport.request("initialize", {});
    const opened = await bundle.transport.request("thread/start", { cwd: directory, dynamicTools: [{ name: "get_task_context", description: "Read the task.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }], completionContract: { revision: "soak-contract", criterionIds: ["objective"] } }) as { thread: { id: string } };
    const owner = bundle.evidence();
    consumer = (async () => {
      for await (const notification of bundle.transport.notifications()) {
        const port = bundle.transport.normalizedDelivery!()!;
        if (notification.paperclipDelivery) await port.commit({ expectedRevision: port.load()?.revision ?? 0, raw: notification.paperclipDelivery, driver: { schema: "paperclip.qualification.raw-consumer.v1" }, events: [] });
        if (notification.method === "turn/completed") terminal = true;
      }
    })().catch(error => { consumerFailure = error; });
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Keep this turn active until explicitly interrupted." }] });
    startedAt = new Date().toISOString(); started = performance.now();
    await report("running");
    while (performance.now()-started < hours*60*60_000) {
      const before = performance.now();
      await bundle.transport.request("thread/read", { threadId: opened.thread.id, includeTurns: false });
      probes++; maxProbeMs = Math.max(maxProbeMs,performance.now()-before);
      if (consumerFailure) throw consumerFailure;
      expect(terminal).toBe(false);
      expect(bundle.evidence()).toMatchObject({ runnerPid: owner.runnerPid, codexPid: owner.codexPid, runnerExited: false });
      const current = await authority!.load();
      const bytes = Buffer.byteLength(JSON.stringify(current!.state));
      peakCurrentBytes = Math.max(peakCurrentBytes,bytes);
      expect(bytes).toBeLessThan(256*1024);
      await report("running");
      await new Promise(resolve => setTimeout(resolve, Math.min(30_000, Math.max(0,hours*60*60_000-(performance.now()-started)))));
    }
    qualified = true;
    await report("settling");
  } catch (error) { await report("failed",error); throw error; }
  finally {
    try {
      await bundle.transport.close(); await consumer; await authority?.close();
      expect(bundle.evidence()).toMatchObject({ runnerExited: true, runnerExitCode: 0 });
      if (qualified) await report("passed");
    } catch (error) { await report("cleanup_failed",error); throw error; }
    finally { await rm(directory,{recursive:true,force:true}); }
  }
}, (hours+1)*60*60_000);
