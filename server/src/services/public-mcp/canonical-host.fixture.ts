import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import {createServer,request,type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import express from "express";
import {eq,sql} from "drizzle-orm";
import {applyPendingMigrations,createDb,closeRegisteredClients,closeLivenessDb,closeCheckpointDb,closeFileStorageDb,companies,authUsers,companyMemberships,issues,mcpOauthGrants,mcpOauthClients,mcpOauthDeviceRequests,mcpOauthClientChanges,mcpOauthClientMirrorState,mcpEventDeliveries,mcpEventSubscriptions,mcpMutationReceipts,activityLog} from "@paperclipai/db";
import {resolveExternalTestDatabaseUrl} from "../../lib/dedicated-test-database-url.js";
import {publicMcpIngressRoutes,publicMcpManagementRoutes} from "../../routes/public-mcp.js";
import {issueRoutes} from "../../routes/issues.js";
import {activityRoutes} from "../../routes/activity.js";
import {errorHandler} from "../../middleware/error-handler.js";
import {createPublicMcpOAuth} from "./oauth.js";
import {createMcpApiDispatch,createPublicMcpExecutor} from "./capabilities.js";
import {createPublicMcpEvents} from "./events.js";
import {startMcpClientMirrorSync} from "./client-mirror-sync.js";
import {readIdleMcpClientMirror} from "./idle-client-mirror.js";
import type {McpClientMirrorRequest} from "./client-mirror-contract.js";
import {startMcpRevocationIndexSync} from "./revocation-index-sync.js";
import {startMcpIngressHandoffExpiry} from "./ingress-handoff-expiry.js";
import {readIdleMcpSleepProof,registerIdleMcpOwners} from "./idle-sleep-proof.js";
import {createDeliveryWorkCoordinator} from "../delivery-work-coordinator.js";
import {createPaperclipCloudConnector,type PaperclipCloudConnectorConfig} from "../paperclip-cloud-connector.js";
import {initializeCloudRuntimeIdentity,applyCloudRuntimeIdentityAssertion} from "../cloud-runtime-identity.js";
import {initializeCloudRuntimeConfig} from "../cloud-runtime-config.js";
import {instanceSettingsService} from "../instance-settings.js";
import {idleWorkSnapshot} from "../task-admission.js";
import {createStorageService} from "../../storage/service.js";
import {createLocalDiskStorageProvider} from "../../storage/local-disk-provider.js";

const databaseUrl=resolveExternalTestDatabaseUrl("PAPERCLIP_MCP_CANONICAL_TEST_DATABASE_URL");
if(!databaseUrl||!process.send)throw new Error("Canonical MCP fixture requires IPC and an explicit dedicated *_test database");
type Input={origin:string;stackId:string;companyId:string;otherCompanyId:string;userId:string;taskId:string;otherTaskId:string;browserSecret:string;cloudOrigin:string;cloudLoopback:string;callbackUrl:string;callbackLoopback:string;runtimeJwks:string;runtimeAssertion:string;connector:PaperclipCloudConnectorConfig};
let db:ReturnType<typeof createDb>|undefined,server:Server|undefined,home:string|undefined,draining=false,queryCount=0,callbackPosts=0,unregister:(()=>void)|undefined;
let delivery:ReturnType<typeof createDeliveryWorkCoordinator>|undefined,events:ReturnType<typeof createPublicMcpEvents>|undefined,configuration:Input|undefined;
const errors:string[]=[];
let registerMirrorClient:((name:string)=>Promise<unknown>)|undefined;
let mirrorExperiment:{mode:"mutation"|"loss-stable"|"loss-advanced"|"loss-repeat"|"loss-partial";completedRevision:number|null;partialRevision:number|null;recoveryBeginDropped:boolean;retryBegin:{revision:number;baseRevision:number|null}|null;nextBegin:{revision:number;baseRevision:number|null}|null;release:(()=>void)|null}|undefined;
async function mirrorExperimentSnapshot(){
  assert.ok(db&&configuration);
  const [row]=await db.select().from(mcpOauthClientMirrorState).where(eq(mcpOauthClientMirrorState.id,"public"));
  const [journal]=await db.select({count:sql<number>`count(*)::int`,maximum:sql<number|null>`max(revision)`}).from(mcpOauthClientChanges);
  const proof=await readIdleMcpClientMirror(db,{budget:{beforeRead:async()=>{},check:()=>{}},enabled:true,origin:configuration.origin,instanceId:configuration.connector.instanceId,managedStackId:configuration.stackId});
  return{sourceRevision:row?.revision,receiptRevision:row?.receipt?.revision??null,cutoverPresent:Boolean(row?.deviceCutoverAt),cutoverAtMs:row?.deviceCutoverAt?.getTime()??null,journalCount:journal.count,journalMaximum:journal.maximum,blocked:proof.blocked,completedRevision:mirrorExperiment?.completedRevision??null,partialRevision:mirrorExperiment?.partialRevision??null,retryBegin:mirrorExperiment?.retryBegin??null,nextBegin:mirrorExperiment?.nextBegin??null,errors:[...errors]};
}

async function mirrorExperimentRecords(){
  assert.ok(db&&mirrorExperiment);
  const clients=await db.select({id:mcpOauthClients.id,name:mcpOauthClients.name,redirectUris:mcpOauthClients.redirectUris,grantTypes:mcpOauthClients.grantTypes}).from(mcpOauthClients).orderBy(sql`${mcpOauthClients.id} COLLATE "C"`).limit(3);
  const devices=await db.select({status:mcpOauthDeviceRequests.status}).from(mcpOauthDeviceRequests).limit(1);
  assert.ok(clients.length<=2,"loss fixture uses only its two normal registered clients");
  assert.equal(devices.length,0,"this client mutation fixture preserves the actual empty device set");
  return{clients,deviceCount:devices.length};
}
async function mirrorExperimentQuiet(){
  assert.ok(events&&delivery&&mirrorExperiment&&mirrorExperiment.mode!=="mutation");
  const expected=mirrorExperiment.mode==="loss-repeat"?["controlled mirror complete response loss","controlled full mirror begin response loss"]:mirrorExperiment.mode==="loss-partial"?["controlled mirror append response loss"]:["controlled mirror complete response loss"];
  await settled();assert.deepEqual(errors,expected,"retain the exact expected controlled response-loss errors");
  assert.equal(delivery.nextWakeAt()===null||delivery.nextWakeAt()!>Date.now()+15_000,true);
  const before={queryCount,callbackPosts,revision:events.reconciliationSnapshot().revision,errorCount:errors.length},started=Date.now();
  await new Promise(resolve=>setTimeout(resolve,15_000));
  assert.equal(queryCount,before.queryCount,"tenant primary SQL remains quiet after response-loss recovery");
  assert.equal(callbackPosts,before.callbackPosts);assert.equal(events.reconciliationSnapshot().revision,before.revision);
  assert.deepEqual(errors,expected,"no unexpected or repeated owner error after response-loss recovery");
  return{started,ended:Date.now(),before,after:{queryCount,callbackPosts,revision:events.reconciliationSnapshot().revision,errorCount:errors.length}};
}

async function mappedFetch(input:Parameters<typeof fetch>[0],init?:RequestInit){
  assert.ok(configuration);const original=new Request(input,init),url=new URL(original.url),headers=new Headers(original.headers);
  let destination:string;
  if(url.origin===configuration.cloudOrigin||url.origin===configuration.origin){headers.set("host",url.host);destination=configuration.cloudLoopback+url.pathname+url.search;}
  else if(url.href===configuration.callbackUrl){callbackPosts++;headers.set("host",url.host);destination=configuration.callbackLoopback;}
  else throw new Error("Canonical fixture attempted an unmapped transport");
  const body=original.body?Buffer.from(await original.arrayBuffer()):undefined;
  original.signal.throwIfAborted();
  return new Promise<Response>((resolve,reject)=>{
    const req=request(destination,{method:original.method,headers:Object.fromEntries(headers),signal:original.signal},res=>{
      const chunks:Buffer[]=[];let length=0;
      res.on("data",(part:Buffer)=>{length+=part.length;if(length>1_048_576){res.destroy(new Error("Canonical mapped response exceeds transport bound"));return;}chunks.push(part);});
      res.on("error",reject);res.on("end",()=>{const responseHeaders=new Headers();for(const [name,value] of Object.entries(res.headers))if(value!==undefined)for(const item of Array.isArray(value)?value:[value])responseHeaders.append(name,item);
        const status=res.statusCode!;resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:responseHeaders}));});
    });
    req.on("error",reject);req.end(body);
  });
}
async function initialize(input:Input){
  assert.equal(process.versions.node.split(".")[0],"24","Canonical Tenant fixture requires actual Node24 before initialization or claims");
  assert.equal(db,undefined);configuration=input;home=await mkdtemp(path.join(tmpdir(),"canonical-mcp-tenant-"));
  Object.assign(process.env,{PAPERCLIP_HOME:home,PAPERCLIP_PUBLIC_URL:input.origin,PAPERCLIP_CLOUD_STACK_ID:input.stackId,PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS:input.runtimeJwks,PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN:randomBytes(24).toString("base64url"),PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID:input.connector.instanceId,PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT:input.connector.environment,PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY:input.connector.signPrivateKey,PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY:input.connector.sealPrivateKey,PAPERCLIP_CLOUD_CONNECTOR_BASE_URL:input.connector.baseUrl,PAPERCLIP_SECRETS_MASTER_KEY:randomBytes(32).toString("base64")});
  await applyPendingMigrations(databaseUrl!);db=createDb(databaseUrl!,{maxConnections:2,applicationName:"sleep2-mcp-canonical-tenant"});
  (db.$client.options as unknown as {debug:(...args:unknown[])=>void}).debug=()=>{queryCount++;};
  await db.insert(companies).values([{id:input.companyId,name:"Selected company",issuePrefix:"SELECTED"},{id:input.otherCompanyId,name:"Primary company",issuePrefix:"PRIMARY"}]);
  await db.insert(authUsers).values({id:input.userId,name:"Canonical operator",email:`${input.userId}@example.test`,createdAt:new Date(),updatedAt:new Date()});
  await db.insert(companyMemberships).values([input.companyId,input.otherCompanyId].map(companyId=>({companyId,principalId:input.userId,principalType:"user" as const,membershipRole:"owner" as const,status:"active" as const})));
  await db.insert(issues).values([{id:input.taskId,companyId:input.companyId,title:"Canonical monitored task",status:"todo"},{id:input.otherTaskId,companyId:input.otherCompanyId,title:"Outside connection",status:"todo"}]);
  await instanceSettingsService(db).updateExperimental({enablePublicMcp:true,enableOpenAiDot:false,enableGrokBot:false});
  await initializeCloudRuntimeConfig(db);
  await initializeCloudRuntimeIdentity(db);await applyCloudRuntimeIdentityAssertion({db,compactJws:input.runtimeAssertion});
  const oauth=createPublicMcpOAuth(db,{origin:input.origin,resource:input.origin+"/mcp/paperclip"}),api=express.Router();
  api.use(issueRoutes(db,createStorageService(createLocalDiskStorageProvider(path.join(home,"storage")))));
  api.use(activityRoutes(db));
  const dispatch=createMcpApiDispatch(api),app=express();app.use(express.json({limit:"1mb"}));
  app.use((req,_res,next)=>{req.actor=req.headers["x-canonical-browser"]===input.browserSecret?{type:"board",source:"session",userId:input.userId,companyIds:[input.companyId,input.otherCompanyId]}:{type:"none",source:"none"};next();});
  events=createPublicMcpEvents(db,oauth,dispatch,{fetch:mappedFetch,cloudOrigin:input.cloudOrigin,isBackgroundWorkEnabled:()=>!draining});
  app.use(publicMcpIngressRoutes(oauth,createPublicMcpExecutor(db,oauth,dispatch),events));app.use("/api",publicMcpManagementRoutes(oauth));app.use(errorHandler);
  server=createServer(app);server.listen(0,"127.0.0.1");await once(server,"listening");
  delivery=createDeliveryWorkCoordinator({owner:db,canRun:()=>!draining,canReconcile:()=>true,onError:error=>errors.push(error instanceof Error?error.message:String(error))});
  await events.start(delivery).ready;
  const connector=createPaperclipCloudConnector({config:input.connector,request:mappedFetch});
  registerMirrorClient=name=>oauth.register({client_name:name,redirect_uris:["https://mirror-client.example.test/callback"],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none"},"mirror-experiment");
  const publishMirror=async(value:McpClientMirrorRequest)=>{
    const experiment=mirrorExperiment;
    if(experiment&&value.operation==="begin"&&(experiment.completedRevision!==null||experiment.partialRevision!==null)&&experiment.nextBegin===null){
      experiment.nextBegin={revision:value.revision,baseRevision:value.baseRevision};
      await new Promise<void>(resolve=>{experiment.release=resolve;});
    }
    if(experiment?.mode==="loss-repeat"&&experiment.recoveryBeginDropped&&value.operation==="begin"&&experiment.retryBegin===null){
      experiment.retryBegin={revision:value.revision,baseRevision:value.baseRevision};
      await new Promise<void>(resolve=>{experiment.release=resolve;});
    }
    const response=await connector.syncMcpClientMirror(JSON.stringify(value));
    if(experiment?.mode==="loss-partial"&&value.operation==="append"&&experiment.partialRevision===null){
      experiment.partialRevision=value.revision;throw new Error("controlled mirror append response loss");
    }
    if(experiment?.mode==="loss-repeat"&&value.operation==="begin"&&experiment.completedRevision!==null&&!experiment.recoveryBeginDropped){
      experiment.recoveryBeginDropped=true;throw new Error("controlled full mirror begin response loss");
    }
    if(experiment&&experiment.mode!=="loss-partial"&&value.operation==="complete"&&experiment.completedRevision===null){
      experiment.completedRevision=value.revision;
      if(experiment.mode==="mutation"||experiment.mode==="loss-advanced")await registerMirrorClient!("Client committed after remote mirror complete");
      if(experiment.mode!=="mutation")throw new Error("controlled mirror complete response loss");
    }
    return response;
  };
  await startMcpClientMirrorSync(db,delivery,input.origin,{instanceId:input.connector.instanceId,publish:publishMirror}).worker.ready;
  await startMcpRevocationIndexSync(db,delivery,{client:{publish:value=>connector.syncMcpRevocationIndex({subject:value.operatorId,companyId:value.companyId,serialized:JSON.stringify(value)})}}).ready;
  await startMcpIngressHandoffExpiry(db,delivery).ready;
  unregister=registerIdleMcpOwners(db,{config:oauth.config,personal:events,dot:null,clientMirrorInstanceId:input.connector.instanceId});
  await settled();
  return{origin:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,pid:process.pid,node:process.version,poolMaximums:{primary:2,dedicated:1,liveness:2,checkpoint:3,fileStorage:2},queryCount};
}
async function settled(){
  assert.ok(db&&events);const end=Date.now()+15_000;
  while(Date.now()<end){
    const [mirror]=await db.select().from(mcpOauthClientMirrorState),grants=await db.select().from(mcpOauthGrants);
    if(events.reconciliationSnapshot().reconciled&&idleWorkSnapshot().active===0&&mirror?.receipt?.revision===mirror?.revision&&grants.every(g=>g.revokedAt!==null||g.revocationIndexReceipt?.revision===g.revocationRevision))return{revision:mirror.revision,errors:[...errors]};
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error("Actual MCP owners did not settle within the fixture observation bound: "+errors.join("; "));
}
async function snapshot(){
  assert.ok(db);return{issues:await db.select({id:issues.id,status:issues.status}).from(issues),deliveries:await db.select().from(mcpEventDeliveries),subscriptions:await db.select({id:mcpEventSubscriptions.id,stoppedAt:mcpEventSubscriptions.stoppedAt}).from(mcpEventSubscriptions),receipts:await db.select().from(mcpMutationReceipts),activity:await db.select({action:activityLog.action,entityId:activityLog.entityId}).from(activityLog),queryCount,callbackPosts,errors:[...errors]};
}
async function proof(){
  assert.ok(db&&configuration);await settled();draining=true;
  return db.transaction(async tx=>{
    const started=Date.now();let reads=0;const context={stackId:configuration!.stackId,ownerId:randomUUID(),capabilityGeneration:"a".repeat(64),challenge:"c".repeat(64),now:Date.now(),budget:{beforeRead:async()=>{if(++reads>64||Date.now()-started>=2000)throw new Error("Canonical idle inspection exceeded shared budget");await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);},check:()=>{if(Date.now()-started>=2000)throw new Error("Canonical idle inspection timed out");}}};
    const value=await readIdleMcpSleepProof(tx,db!,context);return{...value,readCount:reads};
  },{isolationLevel:"repeatable read",accessMode:"read only"});
}
async function quiet(milliseconds:number){
  assert.ok(events&&delivery);assert.ok(milliseconds===15_000||milliseconds===60_000);await settled();assert.equal(delivery.nextWakeAt()===null||delivery.nextWakeAt()!>Date.now()+milliseconds,true);
  const before={queryCount,callbackPosts,revision:events.reconciliationSnapshot().revision},started=Date.now();await new Promise(resolve=>setTimeout(resolve,milliseconds));
  assert.equal(queryCount,before.queryCount,"tenant primary SQL remains quiet between useful operations");assert.equal(callbackPosts,before.callbackPosts);assert.equal(events.reconciliationSnapshot().revision,before.revision);assert.equal(errors.length,0,errors.join(";"));
  return{started,ended:Date.now(),before,after:{queryCount,callbackPosts},scope:"MCP owners and primary driver; auxiliary sockets counted separately"};
}
async function close(){
  mirrorExperiment?.release?.();
  unregister?.();await events?.stop();await delivery?.stop();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  if(db){await closeCheckpointDb(db,1);await closeLivenessDb(db,1);await closeFileStorageDb(db,1);await db.$client.end({timeout:1});await closeRegisteredClients(databaseUrl!,{scope:"database"});}
  if(home)await rm(home,{recursive:true,force:true});return{closed:true,pid:process.pid};
}
let chain=Promise.resolve();
process.on("message",(message:{id:number;operation:string;input?:unknown})=>{chain=chain.then(async()=>{
  try{
    let result:unknown;
    switch(message.operation){case"initialize":result=await initialize(message.input as Input);break;case"mirror-experiment-arm":{
      assert.ok(registerMirrorClient);assert.equal(mirrorExperiment,undefined);
      assert.ok(message.input==="mutation"||message.input==="loss-stable"||message.input==="loss-advanced"||message.input==="loss-repeat"||message.input==="loss-partial");
      mirrorExperiment={mode:message.input,completedRevision:null,partialRevision:null,recoveryBeginDropped:false,retryBegin:null,nextBegin:null,release:null};
      await registerMirrorClient("Client triggering actual mirror publication");result={armed:true};break;
    }case"mirror-experiment-snapshot":result=await mirrorExperimentSnapshot();break;
    case"mirror-experiment-records":result=await mirrorExperimentRecords();break;
    case"mirror-experiment-quiet":result=await mirrorExperimentQuiet();break;
    case"mirror-experiment-release":mirrorExperiment?.release?.();result={released:true};break;
    case"settled":result=await settled();break;case"snapshot":result=await snapshot();break;case"proof":result=await proof();break;case"quiet":result=await quiet(Number(message.input));break;case"resume":draining=false;result={resumed:true};break;case"close":result=await close();break;default:throw new Error("Unknown canonical fixture operation");}
    process.send?.({id:message.id,result});if(message.operation==="close")process.disconnect();
  }catch(error){process.send?.({id:message.id,error:error instanceof Error?error.stack:String(error)});}
});});

process.send?.({fixtureReady:true,node:process.version,pid:process.pid});
