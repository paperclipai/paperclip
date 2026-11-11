// PRIVATE UNRUN. Pass-through observation/owned transport only; no grants,
// ACKs, database results, readiness answers or business outcomes are fabricated.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { request } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";

export async function installDotChildPorts(input: {
  resource: string; cloudOrigin: string; cloudLoopback: string;
  callbackPublicOrigin: string; callbackLoopback: string;
  deviceStage: () => "first-select"|"retry-select"|undefined;
  emit: (event: Record<string,unknown>) => void;
  probeWitnessRoot: string;
}) {
  const actual=await import("@paperclipai/db");
  const database={queries:0,clients:0,opened:0,closed:0,dedicated:0,listeners:0};
  const connections=new Set<string>(),observed=new WeakSet<object>();
  const attach=(db:ReturnType<typeof actual.createDb>)=>{
    if(observed.has(db.$client))return db;observed.add(db.$client);const id=++database.clients;
    const debug=db.$client.options.debug,onclose=db.$client.options.onclose;
    db.$client.options.debug=(...args)=>{const key=`${id}:${args[0]}`;
      if(!connections.has(key)){connections.add(key);database.opened++;}database.queries++;
      if(typeof debug==="function")debug(...args);};
    db.$client.options.onclose=connectionId=>{if(connections.delete(`${id}:${connectionId}`))database.closed++;
      if(typeof onclose==="function")onclose(connectionId);};return db;
  };
  const createDb:(...args:Parameters<typeof actual.createDb>)=>ReturnType<typeof actual.createDb>=(...args)=>{
    const db=attach(actual.createDb(...args));attach(actual.livenessDb(db));attach(actual.checkpointDb(db));attach(actual.fileStorageDb(db));return db;};
  mock.module("@paperclipai/db",{namedExports:{...actual,createDb,
    withDedicatedDbConnection:async<T>(db:ReturnType<typeof actual.createDb>,action:(db:ReturnType<typeof actual.createDb>)=>Promise<T>)=>
      actual.withDedicatedDbConnection(db,async dedicated=>{attach(dedicated);database.dedicated++;try{return await action(dedicated);}finally{database.dedicated--;}}),
    createOwnedDatabaseListener:(db:ReturnType<typeof actual.createDb>)=>{const listener=actual.createOwnedDatabaseListener(db);database.listeners++;let closed=false;
      return{listen:listener.listen,async close(){await listener.close();if(!closed){closed=true;database.listeners--;}}};},
  }});
  assert.equal((await import("@paperclipai/db")).createDb,createDb,"Child DB observer did not bind actual module graph");
  // Observe the same normal read-only probe promise. No input, runner,
  // request, timeout, retry, return value or rejection is changed.
  assert(path.isAbsolute(input.probeWitnessRoot));
  const probeModule=await import("../../../services/native-runtime/remote-runner-recovery-probe.js");
  const {readRemoteRunnerRecoveryError}=await import("../../../services/native-runtime/remote-runner-recovery-diagnostics.js");
  const probeCounts={started:0,settled:0,pending:0,rejected:0,overflow:0,witnessWriteFailures:0};
  const probeStages={runner_state:0,identity_marker:0,process_verification:0};
  const readProbe:typeof probeModule.readRemoteRunnerRecoveryProbe=probe=>{
    const startedAt=Date.now(),startedMonotonic=performance.now();
    probeCounts.started++;probeCounts.pending++;probeStages[probe.stage]++;
    const promise=probeModule.readRemoteRunnerRecoveryProbe(probe);
    void promise.then(()=>{probeCounts.settled++;},async error=>{
      probeCounts.settled++;probeCounts.rejected++;
      const diagnostic=readRemoteRunnerRecoveryError(error);
      if(probeCounts.rejected>32){probeCounts.overflow++;return;}
      const fixedMessages=new Set(["owned_resource_retiring","owned_execution_resource_inactive","owned_provider_closing"]);
      const fixedMessage=error instanceof Error&&fixedMessages.has(error.message)?error.message:"unclassified";
      try {
        await writeFile(path.join(input.probeWitnessRoot,"first-native-probe-failure.json"),JSON.stringify({version:1,
          stage:probe.stage,readOnly:probe.readOnly,startedAt,failedAt:Date.now(),elapsedMs:Math.max(0,performance.now()-startedMonotonic),
          reason:diagnostic?.reason??"unclassified",fixedMessage,counts:{...probeCounts},stageCounts:{...probeStages},
          noRawPayload:true,noAdditionalCalls:true,originalPromiseReturned:true})+"\n",{flag:"wx",mode:0o600});
      }catch(witnessError){
        if(!(witnessError instanceof Error&&"code" in witnessError&&witnessError.code==="EEXIST"))probeCounts.witnessWriteFailures++;
      }
    }).catch(()=>{probeCounts.witnessWriteFailures++;}).finally(()=>{probeCounts.pending--;});
    return promise;
  };
  mock.module(new URL("../../../services/native-runtime/remote-runner-recovery-probe.ts",import.meta.url).href,
    {namedExports:{...probeModule,readRemoteRunnerRecoveryProbe:readProbe}});
  assert.equal((await import("../../../services/native-runtime/remote-runner-recovery-probe.js")).readRemoteRunnerRecoveryProbe,readProbe);
  let authorityRequests=0,callbackRequests=0,unexpectedEventRequests=0,eventFactoryOwners=0,deviceRegistrations=0,authenticateCalls=0,observerPending=0,observerFailures=0,overflow=0,events=0;
  const emit=(event:Record<string,unknown>)=>{if(events++>=32){overflow++;return;}input.emit(event);};
  const originalFetch=globalThis.fetch;
  const mapped:typeof fetch=async(value,init)=>{
    const original=new Request(value,init),url=new URL(original.url);
    const target=url.origin===input.cloudOrigin?input.cloudLoopback:url.origin===input.callbackPublicOrigin?input.callbackLoopback:undefined;
    if(!target)return originalFetch(value,init);
    if(url.protocol!=="https:"||url.username||url.password||url.hash)throw new Error("child_owned_transport_denied");
    const base=new URL(target);assert.equal(base.protocol,"http:");assert.equal(base.hostname,"127.0.0.1");
    const body=original.body?Buffer.from(await original.arrayBuffer()):undefined;
    assert((body?.length??0)<=1048576);const headers=Object.fromEntries(original.headers);headers.host=url.host;
    return new Promise<Response>((resolve,reject)=>{
      const sent=request(new URL(url.pathname+url.search,base),{method:original.method,headers,signal:original.signal,agent:false},response=>{
        const chunks:Buffer[]=[];let bytes=0;response.on("data",part=>{bytes+=part.length;if(bytes>1048576){overflow++;response.destroy(new Error("child_response_overflow"));return;}chunks.push(Buffer.from(part));});
        response.once("error",reject);response.once("end",()=>{const status=response.statusCode!;const headers=new Headers();for(const [name,value]of Object.entries(response.headers))if(value!==undefined)for(const part of Array.isArray(value)?value:[value])headers.append(name,part);
          resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));});
      });sent.once("error",reject);sent.end(body);
    });
  };
  globalThis.fetch=mapped;
  const cutover=await import("../../../services/public-mcp/device-cutover.js");
  const {HttpError}=await import("../../../errors.js");
  mock.module(new URL("../../../services/public-mcp/device-cutover.ts",import.meta.url).href,{namedExports:{...cutover,
    assertDotDeviceProfileAck:(...args:Parameters<typeof cutover.assertDotDeviceProfileAck>)=>{
      const phase=input.deviceStage(),promise=cutover.assertDotDeviceProfileAck(...args);
      if(phase){observerPending++;void promise.then(()=>emit({kind:"ack-check",stage:phase,result:"fulfilled"}),error=>emit({kind:"ack-check",stage:phase,
        result:error instanceof HttpError&&error.status===503&&error.message==="The hosted Dot connection is being reconciled."?"current-ack-denial":"other"}))
        .catch(()=>{observerFailures++;}).finally(()=>{observerPending--;});}return promise;
    }}});
  const oauthModule=await import("../../../services/public-mcp/oauth.js");
  mock.module(new URL("../../../services/public-mcp/oauth.ts",import.meta.url).href,{namedExports:{...oauthModule,
    createPublicMcpOAuth:(...args:Parameters<typeof oauthModule.createPublicMcpOAuth>)=>{
      const ownerDb=args[0],owner=oauthModule.createPublicMcpOAuth(...args);if(owner.mode!=="openai_dot_agent")return owner;
      const authenticate=owner.authenticate;owner.authenticate=token=>{authenticateCalls++;return authenticate.call(owner,token);};
      const register=owner.register;owner.register=(...args)=>{const stage=input.deviceStage(),promise=register.apply(owner,args);
        if(stage){deviceRegistrations++;observerPending++;void promise.then(async client=>{
          const [row]=await ownerDb.select({revision:actual.mcpOauthClientChanges.revision}).from(actual.mcpOauthClientChanges).where(eq(actual.mcpOauthClientChanges.clientId,client.client_id));
          if(!row||!Number.isSafeInteger(row.revision))throw new Error("child_dcr_revision_missing");
          emit({kind:"dcr-committed",stage,clientId:client.client_id,revision:row.revision});
        }).catch(()=>{observerFailures++;}).finally(()=>{observerPending--;});}return promise;};
      return owner;
    }}});
  const eventModule=await import("../../../services/public-mcp/events.js");
  const eventFetch:import("../../../services/public-mcp/event-webhooks.js").EventFetch=(url,init)=>{
    const value=new URL(url);assert.equal(init.method,"POST");assert.equal(init.redirect,"error");
    assert(!value.username&&!value.password&&!value.search&&!value.hash);
    if(value.origin===input.cloudOrigin&&value.pathname==="/v1/connector/mcp-dot-subscription-authority")authorityRequests++;
    else if(value.origin===input.callbackPublicOrigin&&value.pathname==="/events")callbackRequests++;
    else{unexpectedEventRequests++;throw new Error("child_event_transport_denied");}
    return mapped(url,init);
  };
  mock.module(new URL("../../../services/public-mcp/events.ts",import.meta.url).href,{namedExports:{...eventModule,
    createPublicMcpEvents:(...args:Parameters<typeof eventModule.createPublicMcpEvents>)=>{
      const [db,oauth,dispatch,options]=args;
      if(options?.enableDotRunner===true&&oauth.mode==="openai_dot_agent"&&oauth.config.resource===input.resource){
        eventFactoryOwners++;return eventModule.createPublicMcpEvents(db,oauth,dispatch,{...options,fetch:eventFetch});}
      return eventModule.createPublicMcpEvents(...args);
    }}});
  return{snapshot:()=>({...database,connections:connections.size,eventFactoryOwners,authorityRequests,callbackRequests,unexpectedEventRequests,deviceRegistrations,authenticateCalls,observerPending,observerFailures,overflow,probeObservation:{...probeCounts,stages:{...probeStages}}}),
    restore(){globalThis.fetch=originalFetch;mock.restoreAll();}};
}
