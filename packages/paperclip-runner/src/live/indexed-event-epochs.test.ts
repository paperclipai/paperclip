import { resolveRunnerCargoTestBinary, resolveRunnerCargoTestBinaryOrDefault } from "../../test/cargo-test-binary.js";
import { advanceSourceCursor, type SourceCursor } from "../control-plane/event-epochs.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { SqliteAuthorityStore } from "../control-plane/sqlite-authority-store.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver-impl.js";
import { createCapabilityRunnerdCodexTransport, defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
const runnerTestBinary = () => resolveRunnerCargoTestBinaryOrDefault(
  resolve(import.meta.dirname, "../../runner"),
  "debug",
  "paperclip-runnerd",
  qualifiedCapabilityRunnerdBinary,
);


it.each([undefined, 4])("crosses raw event epochs with normalized limit %s while preserving output and provider ownership", async (normalizedEventEpochLimit) => {
  const root = await mkdtemp(join(tmpdir(), "indexed-event-epochs-"));
  const callsPath = join(root, "calls.log");
  const identity = { runnerInstanceId: "epoch-runner", environmentLeaseId: "epoch-lease", normalizedSessionId: "epoch-session",
    runId: "epoch-run", turnId: "epoch-turn", itemId: "epoch-item" };
  let authority: SqliteAuthorityStore | undefined, core: DurablePrpControlPlane | undefined;
  const open = DurablePrpControlPlane.open.bind(DurablePrpControlPlane);
  const spy = vi.spyOn(DurablePrpControlPlane, "open").mockImplementation(async options => core = await open({ ...options, eventEpochLimit: 8, commandEpochLimit: 8, secureChannelFrameLimit: 64, normalizedEventEpochLimit }));
  const bundle = createCapabilityRunnerdCodexTransport({ runnerBinary: runnerTestBinary(),
    codexCommand: resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "fake-codex-app-server"),
    codexArgs: ["--state-file", join(root, "fake.json"), "--durable-turn-ids", "--hold-turn", "--soak-output-on-steer", "--record-process-start", "--call-log", callsPath, "--require-lightweight-history"],
    stateDirectory: root, prpIdentity: identity,
    authorityStoreFactory: async (_identity, directory) => authority ??= await SqliteAuthorityStore.open({path:join(directory,"authority.sqlite"),binding:"event-epochs",create:true}),
  });
  const driver = new CodexAppServerDriver({ taskEnvelope: {schema:"paperclip.skillless_task.v1",objective:"Keep producing output across event epochs.",
    completionContract:{revision:"event-epochs-v1",criteria:[{id:"output",requirement:"Deliver every output body exactly."}]},constraints:[],expectedResultSchema:"paperclip.run_result.v1"},
    runnerInstanceId:identity.runnerInstanceId,approvalPolicy:"never",includeCollaborationModeInstructions:false,
    environment:{PATH:process.env.PATH ?? "/usr/bin:/bin",HOME:"/isolated/home",CODEX_HOME:"/isolated/codex-home",LANG:"C.UTF-8"},transportFactory:()=>bundle.transport,requireProviderSessionIdentity:true });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined, consumer: Promise<void> | undefined, failure: unknown;
  const epochs = new Set<string | undefined>(), outputs = new Map<string, string>(), ids = new Set<string>();
  let completed = 0;
  let cursor: SourceCursor = { sourceSeq: 0 };
  const normalizedEpochs = new Set<string | undefined>();
  try {
    session = await driver.openSession({runId:identity.runId,normalizedSessionId:identity.normalizedSessionId,workingDirectory:root});
    consumer = (async () => { for await (const event of session!.events()) {
      expect(ids.has(event.sourceEventId)).toBe(false); ids.add(event.sourceEventId);
      cursor = advanceSourceCursor(cursor, event);
      normalizedEpochs.add(event.sourceEpoch);
      if (event.eventType === "output.body.chunk") {
        const id = String((event.payload.body as Record<string, unknown>).bodyId);
        outputs.set(id, (outputs.get(id) ?? "") + String(event.payload.text));
      }
      if (event.eventType === "item.completed" && event.itemId?.startsWith("soak-output-")) {
        const body = event.payload.outputBody as Record<string, unknown>;
        expect(outputs.get(String(body.bodyId))).toBe(`${event.itemId}: ${"s".repeat(8192)}`);
        completed++;
      }
      await session!.acknowledgeEvent!(event);
    } })().catch(error => {failure=error;});
    const turn = await session.startTurn({message:{text:"Hold this turn across namespace changes."}});
    const owner = bundle.evidence();
    for (let index=1;index<=16;index++) {
      await session.steer!({turnId:turn.turnId,message:{text:`Output ${index}`},correlationId:`epoch-steer-${index}`});
      await vi.waitFor(() => { if(failure) throw failure; expect(completed).toBe(index); },{timeout:20_000,interval:10});
      epochs.add(core!.store.state.indexedState?.sourceEpoch);
      expect(bundle.evidence()).toMatchObject({runnerPid:owner.runnerPid,providerPid:owner.providerPid,runnerExited:false});
      if(index%3===0) core!.disconnectActiveRunner();
    }
    expect(epochs.size).toBeGreaterThanOrEqual(5);
    if (normalizedEventEpochLimit === undefined) expect(normalizedEpochs.size).toBe(1);
    else expect(normalizedEpochs.size).toBeGreaterThan(10);
    expect(core!.store.state.identity).toEqual(identity);
    const calls=(await readFile(callsPath,"utf8")).trim().split(/\r?\n/);
    expect(calls.filter(call=>call==="process-start")).toHaveLength(1);
    expect(calls.filter(call=>call==="thread/start")).toHaveLength(1);
    expect(calls.filter(call=>call==="turn/start")).toHaveLength(1);
    expect(calls).not.toContain("turn/interrupt"); expect(calls).not.toContain("thread/resume");
    await session.close({reason:"event epoch qualification complete"}); await consumer; session=undefined;
    if(failure) throw failure;
  } finally { await session?.close({reason:"event epoch cleanup"}); await consumer; await bundle.transport.close(); await authority?.close(); spy.mockRestore(); await rm(root,{recursive:true,force:true}); }
},90_000);

it("keeps indexed replay and renewed event namespaces through warm run attachment", async () => {
  const root=await mkdtemp(join(tmpdir(),"indexed-event-warm-"));
  let authority:SqliteAuthorityStore|undefined, core:DurablePrpControlPlane|undefined, consumer:Promise<void>|undefined, failure:unknown;
  const open=DurablePrpControlPlane.open.bind(DurablePrpControlPlane);
  const spy=vi.spyOn(DurablePrpControlPlane,"open").mockImplementation(async options=>core=await open({...options,eventEpochLimit:4,commandEpochLimit:8}));
  const bundle=createCapabilityRunnerdCodexTransport({runnerBinary:runnerTestBinary(),
    codexCommand:resolveRunnerCargoTestBinary(resolve(import.meta.dirname, "../../runner"), "debug", "fake-codex-app-server"),codexArgs:["--state-file",join(root,"fake.json"),"--durable-turn-ids"],
    stateDirectory:root,lifecyclePolicy:{mode:"warm",idleTimeoutMs:60_000},
    authorityStoreFactory:async (_identity,directory)=>authority??=await SqliteAuthorityStore.open({path:join(directory,"authority.sqlite"),binding:"event-epochs-warm",create:true}),
  });
  bundle.transport.setServerRequestHandler(async()=>({success:true,contentItems:[]}));
  let completed=0;
  try {
    await bundle.transport.request("thread/start",{cwd:root,dynamicTools:[{name:"get_task_context",description:"Read the active task.",inputSchema:{type:"object",properties:{},additionalProperties:false}}],completionContract:{revision:"epoch-warm-v1",criterionIds:["objective"]}});
    const owner=bundle.evidence();
    consumer=(async()=>{for await(const notification of bundle.transport.notifications()) {
      const port=bundle.transport.normalizedDelivery!()!;
      if(notification.paperclipDelivery) await port.commit({expectedRevision:port.load()?.revision??0,raw:notification.paperclipDelivery,driver:{},events:[]});
      if(notification.method==="turn/completed") completed++;
    }})().catch(error=>{failure=error;});
    for(let round=1;round<=3;round++) {
      await bundle.transport.request("turn/start",{input:[{type:"text",text:`Run ${round}`}]});
      await vi.waitFor(()=>{if(failure) throw failure;expect(completed).toBe(round);expect(core!.store.state.indexedState?.sourceEpoch).toBeTruthy();},{timeout:20_000,interval:10});
      expect(bundle.evidence()).toMatchObject({runnerPid:owner.runnerPid,providerPid:owner.providerPid,runnerExited:false});
      if(round<3) await bundle.transport.attachRun!({runId:`warm-run-${round}`,turnId:`warm-turn-${round}`,itemId:`warm-item-${round}`});
    }
    if(failure) throw failure;
  } finally {await bundle.transport.close();await consumer;await authority?.close();spy.mockRestore();await rm(root,{recursive:true,force:true});}
},90_000);
