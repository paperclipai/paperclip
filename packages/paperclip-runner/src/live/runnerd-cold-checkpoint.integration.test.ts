import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";
import { coldCheckpointStateDigest } from "../control-plane/cold-checkpoint.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

it.each(["same-thread", "receipt-thread-mismatch", "restored-thread-mismatch"])("verifies cold Codex thread continuity after killing a settled Runner: %s", async mode => {
  const root = await mkdtemp(join(tmpdir(), "runner-cold-checkpoint-"));
  const identity = {
    runnerInstanceId: "runner", environmentLeaseId: "lease", normalizedSessionId: "session",
    runId: "run-a", turnId: "turn-a", itemId: "item-a",
  };
  const calls = join(root, "calls");
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root, "--call-log", calls, "--durable-turn-ids"), stateDirectory: root,
  };
  const first = createCapabilityRunnerdCodexTransport({...options, prpIdentity:identity});
  let second: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  const completeTurn = async (bundle: typeof first, text: string) => {
    await bundle.transport.request("turn/start", {input:[{type:"text",text}]});
    for await (const event of bundle.transport.notifications()) {
      if (event.method === "turn/completed") return;
    }
    throw new Error("Turn ended without a completion");
  };
  try {
    const started = await first.transport.request("thread/start", {cwd:root,dynamicTools:[]});
    const thread = started.thread as {id:string;sessionId:string};
    await completeTurn(first, "first turn");
    const source = join(root,"runner","runner-state.json");
    const snapshot = async () => JSON.parse(await readFile(source,"utf8")) as Record<string,unknown>;
    await expect.poll(async () => (await snapshot()).outbox).toEqual([]);
    const state = await snapshot();
    expect(state.lifecycle).toBe("ready");
    const digest = coldCheckpointStateDigest(state);
    const receipt = {schema:"paperclip.runner.cold-checkpoint.v1" as const,sourceId:"host-snapshot",
      sha256:digest,runnerStateSha256:digest,identity,providerSessionId:mode === "receipt-thread-mismatch" ? "another-thread" : thread.id};
    const {runnerPid,providerPid} = first.evidence();
    expect(runnerPid).toBeGreaterThan(0);
    expect(providerPid).toBeGreaterThan(0);
    await first.detachControllerForRestart();
    process.kill(runnerPid!, "SIGKILL");
    try { process.kill(providerPid!, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await expect.poll(() => { try { process.kill(runnerPid!,0); return true; } catch { return false; } }).toBe(false);
    if (mode === "restored-thread-mismatch") {
      const providerStatePath = join(root, "fake-codex-state.json");
      const providerState = JSON.parse(await readFile(providerStatePath, "utf8"));
      await writeFile(providerStatePath, JSON.stringify({ ...providerState, threadId: "another-thread" }));
      const runnerProviderPath = join(root, "runner", "codex-provider-state.json");
      const runnerProviderState = JSON.parse(await readFile(runnerProviderPath, "utf8"));
      expect(runnerProviderState.threadId).toBe(thread.id);
      await writeFile(runnerProviderPath, JSON.stringify({ ...runnerProviderState, threadId: "another-thread" }));
    }

    const external = join(root, "host-owned");
    await rename(join(root,"runner"),external);
    let archived = false;
    second = createCapabilityRunnerdCodexTransport({
      ...options, runnerStateDirectory:external, resumeDynamicTools:[], resumeColdCheckpoint:receipt,
      prpIdentity:{...identity,runId:"run-b",turnId:"turn-b",itemId:"item-b"},
      prepareExternalRunnerState:async () => {},
      readRunnerState:async () => archived ? JSON.parse(await readFile(join(external,"runner-state.json"),"utf8")) : state,
      archiveExternalRunnerState:async ({archiveKey}) => {
        await rename(join(external,"runner-state.json"),join(root,archiveKey));
        archived = true;
        return state;
      },
    });
    const resumed = second.transport.request("thread/read",{});
    if (mode === "same-thread") {
      expect((await resumed).thread).toMatchObject({id:thread.id,sessionId:thread.sessionId});
      await completeTurn(second,"follow-up");
      expect(second.evidence().runnerPid).not.toBe(runnerPid);
    } else {
      await expect(resumed).rejects.toThrow(/identity_mismatch|identity_conflict|restore_conflict/);
      if (mode === "receipt-thread-mismatch") expect(archived).toBe(false);
    }
    const providerCalls = await readFile(calls,"utf8");
    expect(providerCalls.split("\n").filter(line => line === "turn/start")).toHaveLength(mode === "same-thread" ? 2 : 1);
  } finally {
    try {
      try { await second?.transport.close(); } catch (error) {
        if (mode !== "restored-thread-mismatch") throw error;
        expect(String(error)).toContain("provider_transport_failed");
      }
    } finally {
      await first.transport.close();
      await rm(root,{recursive:true,force:true});
    }
  }
}, 30_000);
