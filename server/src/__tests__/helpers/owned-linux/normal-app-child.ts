// PRIVATE UNRUN physical child. Same entry for FIRST and SECOND generations.
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { beginOwnedPrivateCA } from "./private-ca-scope.js";
import { installDotChildPorts } from "./child-observation.js";
const file=process.env.PAPERCLIP_DOT_CHILD_INPUT;assert(file&&path.isAbsolute(file));
const absolute=z.string().refine(value=>path.isAbsolute(value));
const loopback=z.url().refine(value=>{const url=new URL(value);return url.protocol==="http:"&&url.hostname==="127.0.0.1"&&!url.username&&!url.password&&!url.search&&!url.hash;});
const input=z.object({stackId:z.string().min(1),databaseUrl:z.url(),home:absolute,origin:z.url(),userId:z.string().min(1),companyId:z.uuid(),generation:z.number().int().min(1).max(2),
  resource:z.url(),cloudOrigin:z.url(),cloudLoopback:loopback,callbackPublicOrigin:z.url(),callbackLoopback:loopback,
  linuxInput:z.object({catalogRoot:absolute,prebuiltPackageRoot:absolute,expectedBundleDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),providerRoot:absolute,remoteBinary:absolute,caBundle:absolute,caSHA256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
}).strict().parse(JSON.parse(await readFile(file,"utf8")));
const database=new URL(input.databaseUrl);assert(database.hostname==="127.0.0.1"&&database.port==="55448"&&database.pathname.endsWith("_test"));
assert.equal(process.versions.node,"24.22.2");assert(process.send&&process.connected);
let health:"ready"|"unavailable"|"wake-once-then-unavailable"="ready";
let stage:"first-select"|"retry-select"|undefined;
const send=(event:Record<string,unknown>)=>{if(!process.connected)throw new Error("owned_child_ipc_disconnected");process.send!(event);};
const restoreCA=beginOwnedPrivateCA({pem:await readFile(input.linuxInput.caBundle,"utf8"),SHA256:input.linuxInput.caSHA256});
let ports:Awaited<ReturnType<typeof installDotChildPorts>>;
try{ports=await installDotChildPorts({...input,deviceStage:()=>stage,emit:send,probeWitnessRoot:input.linuxInput.providerRoot});}
catch(primary){try{restoreCA();}catch(cleanup){throw new AggregateError([primary,cleanup],"owned_dot_child_port_setup_failed");}throw primary;}
let owner:Awaited<ReturnType<typeof import("./normal-app-generation.js")["startNormalDotAppGeneration"]>>|undefined;
let shutting:Promise<void>|undefined;
const shutdown=()=>shutting??=(async()=>{
  try{await owner?.stop();const snapshot=ports.snapshot();assert.equal(snapshot.connections,0);assert.equal(snapshot.dedicated,0);assert.equal(snapshot.listeners,0);
    assert.equal(snapshot.observerPending,0);assert.equal(snapshot.observerFailures,0);assert.equal(snapshot.overflow,0);
    send({kind:"stopped",pid:process.pid,owner:owner?.snapshot(),snapshot});
  }finally{try{ports.restore();}finally{restoreCA();}}
})();
try{
  const {startNormalDotAppGeneration}=await import("./normal-app-generation.js");
  owner=await startNormalDotAppGeneration({...input,health:()=>health,consumedWakeHealth:()=>{health="unavailable";}});
  const port=Number(new URL(owner.origin).port);send({kind:"ready",pid:process.pid,port,bootId:randomUUID()});
  process.on("message",async(raw:unknown)=>{
    try{
      const message=z.discriminatedUnion("command",[
        z.object({command:z.literal("snapshot"),id:z.number().int()}).strict(),
        z.object({command:z.literal("health"),id:z.number().int(),value:z.enum(["ready","unavailable","wake-once-then-unavailable"])}).strict(),
        z.object({command:z.literal("device-stage"),id:z.number().int(),value:z.enum(["first-select","retry-select","none"])}).strict(),
        z.object({command:z.literal("drain-run"),id:z.number().int(),runId:z.uuid()}).strict(),
        z.object({command:z.literal("stop-checkpointed"),id:z.number().int(),runId:z.uuid(),environmentId:z.uuid()}).strict(),
        z.object({command:z.literal("inspect"),id:z.number().int()}).strict(),
        z.object({command:z.literal("shutdown")}).strict(),
      ]).parse(raw);
      if(message.command==="shutdown"){await shutdown();process.disconnect();return;}
      if(message.command==="health")health=message.value;
      if(message.command==="device-stage")stage=message.value==="none"?undefined:message.value;
      let result:unknown;
      if(message.command==="drain-run")await owner!.heartbeat.waitForRunExecutionDrain(message.runId,{timeoutMs:15000});
      if(message.command==="stop-checkpointed"){
        const {stopCheckpointedOwnedRun}=await import("./checkpointed-fault.js");
        result=await stopCheckpointedOwnedRun({db:owner!.db,workerManager:owner!.workerManager,runId:message.runId,
          companyId:input.companyId,environmentId:message.environmentId,providerRoot:input.linuxInput.providerRoot});
      }
      if(message.command==="inspect"){
        const {readIdleMcpSleepProof}=await import("../../../services/public-mcp/idle-sleep-proof.js");
        result=await readIdleMcpSleepProof(owner!.db,owner!.db,{stackId:input.stackId,ownerId:randomUUID(),
          capabilityGeneration:"a".repeat(64),challenge:"b".repeat(64),now:Date.now(),budget:{beforeRead:async()=>{},check:()=>{}}});
      }
      send({kind:"snapshot",id:message.id,result,owner:owner!.snapshot(),database:ports.snapshot()});
    }catch{send({kind:"failed",code:"owned_child_command_failed"});process.exitCode=1;}
  });
  process.once("disconnect",()=>{void shutdown().catch(()=>{process.exitCode=1;});});
}catch(primary){try{await shutdown();}catch(cleanup){throw new AggregateError([primary,cleanup],"owned_dot_child_failed_retained");}throw primary;}
