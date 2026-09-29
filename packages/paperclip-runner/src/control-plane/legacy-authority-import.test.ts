import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DurablePrpControlPlane, stageLegacyControlPlaneAuthority, type StoredCoreState } from "./durable-prp-control-plane.js";
import { SqliteAuthorityStore } from "./sqlite-authority-store.js";
import type { DurableRecoveryCoreCommand, DurableRecoveryIdentity } from "./prp-transport-types.js";
const identity: DurableRecoveryIdentity = { runnerInstanceId: "migration-runner", environmentLeaseId: "migration-environment", normalizedSessionId: "migration-session", runId: "migration-run", turnId: "migration-turn", itemId: "migration-item" };
const command = (seq: number): DurableRecoveryCoreCommand => ({ schema: "paperclip.prp.command.v1",commandId:`command-${seq}`,controllerSeq:seq,type:"run.prepare",issuedAt:"2026-09-28T00:00:00.000Z",payload:{},status:"completed",result:{status:"completed",commandId:`command-${seq}`,controllerSeq:seq,commandType:"run.prepare"} });
const coreOptions = (directory: string) => ({ stateDirectory: directory, identity, expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
function event(seq: number, eventType: string, payload: Record<string, unknown>) {
  return { sourceSeq:seq,sourceEventId:`event-${seq}`,eventType,priority:1,deliveryCount:1,logicalEffectCount:1,envelope:{protocol:"paperclip.runner",version:1,kind:"event",...identity,payload:{schema:"paperclip.prp.event.v1",schemaVersion:1,...identity,sourceSeq:seq,sourceEventId:`event-${seq}`,sourceInstanceId:identity.runnerInstanceId,sourceKind:"runner",eventType,priority:1,emittedAt:"2026-09-28T00:00:00.000Z",payload}} };
}
it("stages a >192 MiB controller journal with bounded current state, exact old receipts, and restartable checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-authority-"));
  const sourcePath = join(directory, "control-plane-state.json");
  const storage = { path: join(directory, "authority.sqlite"), binding: "legacy-import-test", create: true };
  let authority = await SqliteAuthorityStore.open(storage);
  try {
    const legacy = await DurablePrpControlPlane.open(coreOptions(directory));
    await legacy.stop();
    const initial = JSON.parse(await readFile(sourcePath, "utf8"));
    const fd = await open(sourcePath, "w", 0o600);
    await fd.write('{"committedEvents":['); // history precedes commands deliberately
    const payload = { code: "history", text: "x".repeat(100 * 1024) };
    for (let seq = 1; seq <= 2000; seq++) await fd.write(`${seq > 1 ? "," : ""}${JSON.stringify(event(seq,"harness.diagnostic",payload))}`);
    const tail = { ...initial, commands:[command(1),command(2)],ackedSourceSeq:2000,commandDeliveryCounts:{"command-1":1,"command-2":3} };
    delete tail.committedEvents;
    await fd.write(`],${JSON.stringify(tail).slice(1)}`);
    await fd.close();
    let checkpoints=0;
    const input={sourcePath,identity,authority,fenceId:"exclusive-migration-1",assertExclusiveFence:async()=>{}};
    await expect(stageLegacyControlPlaneAuthority({...input,onCheckpoint:async()=>{if(++checkpoints===3)throw new Error("simulated controller death");}})).rejects.toThrow("simulated controller death");
    const interrupted=await authority.load();
    expect((interrupted!.state.cursor as {offset:number}).offset).toBeGreaterThan(16*1024*1024);
    await authority.close();
    authority=await SqliteAuthorityStore.open({...storage,create:false});
    const prepared=await stageLegacyControlPlaneAuthority({...input,authority});
    expect(prepared.state.phase).toBe("prepared");
    expect((prepared.state.cursor as {offset:number}).offset).toBeGreaterThan(192*1024*1024);
    expect(JSON.stringify(prepared.state).length).toBeLessThan(16*1024);
    const current=prepared.state.projection as unknown as StoredCoreState;
    expect(current.commands.map(command=>command.commandId)).toEqual(["command-2"]);
    expect(current.commandDeliveryCounts).toEqual({"command-2":3});
    expect(current.indexedState!.nextControllerSeq).toBe(3);
    expect((await authority.getRecord(identity.runId,"command","command-1"))!.body).toEqual(command(1));
    expect((await authority.getRecord(identity.runId,"event","event-1"))!.body).toEqual(event(1,"harness.diagnostic",payload));
    // Preparation must not replace the legacy locator or activate staging.
    const beginning=await open(sourcePath,"r");
    const bytes=Buffer.alloc(24);await beginning.read(bytes,0,bytes.length,0);await beginning.close();
    expect(bytes.toString()).toContain('"committedEvents"');
    await expect(DurablePrpControlPlane.open({...coreOptions(directory),authorityStore:authority})).rejects.toThrow();
    await expect(stageLegacyControlPlaneAuthority({...input,authority,fenceId:"wrong-owner"})).rejects.toThrow("different authority or fence");
  } finally {await authority.close();await rm(directory,{recursive:true,force:true});}
},180_000);

it("reconciles semantic inputs after all commands and refuses a lost ownership fence",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"legacy-semantic-import-"));
  const sourcePath=join(directory,"control-plane-state.json");
  const authority=await SqliteAuthorityStore.open({path:join(directory,"authority.sqlite"),binding:"semantic-import",create:true});
  try{
    const legacy=await DurablePrpControlPlane.open(coreOptions(directory));await legacy.stop();
    const initial=JSON.parse(await readFile(sourcePath,"utf8"));
    const correlation={runId:identity.runId,normalizedSessionId:identity.normalizedSessionId,turnId:identity.turnId,itemId:identity.itemId};
    const semantic=(callId:string)=>({semantic_tool:{callId,operationId:"get_task_context",correlation,input:{}}});
    const commandId=`command_tool_${createHash("sha256").update(`${identity.runId}\0settled-call`).digest("hex").slice(0,32)}`;
    const settled={...command(1),commandId,type:"semantic_tool.result",payload:{callId:"settled-call",operationId:"get_task_context",sourceEventId:"event-1",sourceEventType:"semantic_tool.input",correlation,input:{}},result:{commandId,controllerSeq:1,commandType:"semantic_tool.result",status:"completed"}};
    const {committedEvents:_events,commands:_commands,...fields}=initial;
    await writeFile(sourcePath,JSON.stringify({committedEvents:[event(1,"semantic_tool.input",semantic("settled-call")),event(2,"semantic_tool.input",semantic("pending-call"))],...fields,commands:[settled],ackedSourceSeq:2}),{mode:0o600});
    const input={sourcePath,identity,authority,fenceId:"semantic-fence",assertExclusiveFence:async()=>{}};
    await expect(stageLegacyControlPlaneAuthority({...input,assertExclusiveFence:async()=>{throw new Error("lease lost");}})).rejects.toThrow("lease lost");
    expect(await authority.load()).toBeNull();
    const prepared=await stageLegacyControlPlaneAuthority(input);
    const current=prepared.state.projection as unknown as StoredCoreState;
    expect(current.indexedState!.pendingSemanticInputIds).toEqual(["event-2"]);
    expect(current.committedEvents.map(event=>event.sourceEventId)).toEqual(["event-2"]);
    await writeFile(sourcePath,'{"changed":true}',{mode:0o600});
    await expect(stageLegacyControlPlaneAuthority(input)).rejects.toThrow("source changed");
  }finally{await authority.close();await rm(directory,{recursive:true,force:true});}
});

it("does not invent execution authority from missing legacy fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-import-missing-"));
  const sourcePath = join(directory, "control-plane-state.json");
  const authority = await SqliteAuthorityStore.open({ path: join(directory, "authority.sqlite"), binding: "missing-fields", create: true });
  try {
    await writeFile(sourcePath, JSON.stringify({ identity }), { mode: 0o600 });
    await expect(stageLegacyControlPlaneAuthority({ sourcePath, identity, authority, fenceId: "missing-fence", assertExclusiveFence: async () => {} })).rejects.toThrow("missing required source fields");
    expect(await authority.load()).toBeNull();
  } finally { await authority.close(); await rm(directory, { recursive: true, force: true }); }
});
