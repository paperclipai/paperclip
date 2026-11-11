import { forkNormalDotApp } from "./helpers/owned-linux/physical-app-owner.js";
import { attachDotChild, type ChildSnapshot } from "./helpers/owned-linux/child-client.js";
import { usefulAfterPhysicalRestart } from "./helpers/owned-linux/useful-after-physical-restart.js";
import { nativeProviderRecoveryEvidence } from "../services/native-runtime/native-session-executor.js";
import { NATIVE_PREPARATION_FENCING_VERSION } from "../services/native-runtime/native-active-runs.js";
import { loadNativeRunnerCheckpointHeader, NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES } from "../services/native-runtime/native-runner-checkpoint.js";
import { stopCheckpointedOwnedRun } from "./helpers/owned-linux/checkpointed-fault.js";
import { beginOwnedPrivateCA } from "./helpers/owned-linux/private-ca-scope.js";
import { z } from "zod";
import { mcpClientMirrorGeneration, mcpClientMirrorReceiptSchema } from "../services/public-mcp/client-mirror-contract.js";
import { HttpError } from "../errors.js";
import type { EventFetch } from "../services/public-mcp/event-webhooks.js";
import { DEVICE_GRANT } from "../services/public-mcp/oauth.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { idleWorkSnapshot, isIdleTaskDrainActive } from "../services/task-admission.js";
import { readIdleMcpSleepProof } from "../services/public-mcp/idle-sleep-proof.js";
import { externalOperationDigest, inspectDurablePrpCheckpointHeader, inspectStagedRunAttachmentHeader } from "../vendor/paperclip-runner/index.js";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer, request as nodeRequest, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import request from "supertest";
import { startMinio, objectStoreServerEnvironment, type ObjectStore } from "../../../tests/restart-chaos/object-store.js";
import { startStorageFaultProxy } from "../../../tests/restart-chaos/storage-proxy.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, createDb, closeRegisteredClients, authUsers, companies, mcpOauthGrants, agents, dotAgentBindings, dotRunnerAssignments, dotRunnerOperations, mcpOauthRequests, mcpOauthTokens, mcpOauthClientChanges, mcpOauthClientMirrorState, mcpOauthDeviceRequests, heartbeatRuns, agentWakeupRequests, completionContracts, nativeRunResults, nativeRunFinalizations, issues, mcpEventDeliveries, mcpEventSubscriptions } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../lib/dedicated-test-database-url.js";
import { accessService } from "../services/access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { migrateCloudConfiguration } from "../services/cloud-configuration-migration.js";
import { initializeAdapterSettings } from "../services/adapter-settings.js";
import { initializeCloudRuntimeConfig } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createCloudWarmStandby } from "../services/cloud-warm-standby.js";
import { initializeCloudRuntimeIdentity, getCloudRuntimeIdentity, resetCloudRuntimeIdentityForTests, resetCloudControlReplayFenceForTests, CLOUD_RUNTIME_IDENTITY_HEADER } from "../services/cloud-runtime-identity.js";
import * as oauthModule from "../services/public-mcp/oauth.js";
import { removeTestHome } from "./remove-test-home.js";


const databaseObservation=vi.hoisted(()=>({queries:0,dedicatedOpen:0,listenersOpen:0,clients:0,connectionsOpened:0,connectionsClosed:0,liveConnections:new Set<string>()}));
vi.mock("@paperclipai/db",async importOriginal=>{
 const actual=await importOriginal<typeof import("@paperclipai/db")>();
 const observed=new WeakSet<object>();
 function attach(db:ReturnType<typeof actual.createDb>){
  if(!observed.has(db.$client)){
   observed.add(db.$client);const clientId=++databaseObservation.clients;
   const priorDebug=db.$client.options.debug,priorClose=db.$client.options.onclose;
   db.$client.options.debug=(...args)=>{
    const connection=`${clientId}:${args[0]}`;
    if(!databaseObservation.liveConnections.has(connection)){databaseObservation.liveConnections.add(connection);databaseObservation.connectionsOpened++;}
    databaseObservation.queries++;if(typeof priorDebug==="function")priorDebug(...args);
   };
   db.$client.options.onclose=connectionId=>{
    if(databaseObservation.liveConnections.delete(`${clientId}:${connectionId}`))databaseObservation.connectionsClosed++;
    if(typeof priorClose==="function")priorClose(connectionId);
   };
  }
  return db;
 }
 return {...actual,
  createDb:(...args:Parameters<typeof actual.createDb>)=>{
   const db=attach(actual.createDb(...args));attach(actual.livenessDb(db));attach(actual.checkpointDb(db));attach(actual.fileStorageDb(db));return db;
  },
  withDedicatedDbConnection:async<T>(db:ReturnType<typeof actual.createDb>,action:(dedicated:ReturnType<typeof actual.createDb>)=>Promise<T>)=>
   actual.withDedicatedDbConnection(db,async dedicated=>{attach(dedicated);databaseObservation.dedicatedOpen++;try{return await action(dedicated);}finally{databaseObservation.dedicatedOpen--;}}),
  createOwnedDatabaseListener:(db:ReturnType<typeof actual.createDb>)=>{
   const listener=actual.createOwnedDatabaseListener(db);databaseObservation.listenersOpen++;let closed=false;
   return{listen:listener.listen,async close(){await listener.close();if(!closed){closed=true;databaseObservation.listenersOpen--;}}};
  },
 };
});

type Namespace={instanceId:string;origin?:string;revision?:number;enabled?:boolean;dotProfile?:string};
type CodeState={tenantDeviceEnvelope?:string;requestedCompanyId?:string;scopes?:string[];flow?:string;status:string;expiresAt:number;issuerOrigin?:string;boundStackId?:string;stackId?:string;tenantOrigin?:string;profile?:string;clientId?:string;tenantClientId?:string;userId?:string;companyId?:string};
type PoolObservation={total:number;idle:number;waiting:number;max:number};
type GateReadResult<T>={kind:"read";value:T}|{kind:"refused"|"timeout"|"aborted"};
type GateReadOwner={read<T>(stack:string,source:string,signal:AbortSignal,load:()=>Promise<T>):Promise<GateReadResult<T>>};
type Instance={id:string;status:string;kind:string;companyStackId?:string;activeOrigin?:string;origins:string[]};
type Stack={id:string;primaryHost:string;stackSlug:string};
type GlobalOwner={id:string;email:string;displayName:string;externalSubject?:string;metadata?:Record<string,unknown>};
type RuntimeStack={id:string;lifecycleState:string;sleepState:string;sleepReason?:string;providerRefs:unknown[]};
type Registry={availabilityMonitor:()=>{getSnapshot:()=>{pool:PoolObservation}};getStack:(id:string)=>Promise<RuntimeStack|undefined>;readIdleMcpWakeAdmission:(id:string)=>Promise<unknown>;close:()=>Promise<void>;assistantMcpStore:()=>{getAuthorization:(id:string)=>Promise<CodeState|undefined>};connectorStore:()=>Instances;stackSecretDatabase:()=>unknown;updateStackWakeState:(id:string,input:unknown)=>Promise<unknown>;createFleetReleaseArtifact:(input:unknown)=>Promise<unknown>;importFeatureCatalog:(input:unknown)=>Promise<unknown>;getAssistantMcpStack:(id:string)=>Promise<Stack|undefined>;getGlobalUser:(id:string)=>Promise<GlobalOwner|undefined>;hasActiveStackMembership:(stack:string,user:string)=>Promise<boolean>;mcpClientMirrorStore:()=>{sync:(binding:{stackId:string},request:{operation:string})=>Promise<{complete:boolean;receipt?:unknown}>;readResponsibility:(stack:string,origin:string,purpose?:"metadata"|"established")=>Promise<Namespace|undefined>;readCurrent:(stack:string,origin:string)=>Promise<Namespace|undefined>;getClient:(binding:{stackId:string;companyId:string;origin:string;instanceId:string},id:string,receipt:Namespace)=>Promise<unknown>}};
type Instances={putCloudStackInstance:(input:unknown)=>Promise<unknown>;getInstance:(id:string)=>Promise<Instance|undefined>;setCloudStackOrigins:(input:{id:string;companyStackId:string;origins:string[];activeOrigin:string;now:Date})=>Promise<unknown>};
type Router=new(input:{registry:{findStackByHost:(host:string)=>Promise<Stack|undefined>;findStackBySlug:(slug:string)=>Promise<Stack|undefined>};baseDomain:string})=>{resolveRoute:(input:{trustedHost:string})=>Promise<{kind:string;target?:{stackId:string;primaryHost:string;stackSlug:string;activeAppOrigin?:string}}>};

const url=resolveExternalTestDatabaseUrl("PAPERCLIP_DOT_HOSTED_USEFUL_TEST_DATABASE_URL");
const cloudDatabaseUrl=resolveExternalTestDatabaseUrl("PAPERCLIP_DOT_HOSTED_CLOUD_TEST_DATABASE_URL");
const callbackPublicOrigin="https://receiver.hosted-dot.example.test";
const origin="https://principal-hop.paperclip.app",cloudOrigin="https://cloud.principal-hop.example.test",stackId="principal-hop-stack",slug="principal-hop";
const resource=origin+"/mcp/runner",redirect="https://chatgpt.com/connector_platform/oauth/callback";
const closedUnavailable=(response:{status:number;body:unknown;text?:string;headers:Record<string,unknown>}):{wireContract:"code-only-retry-after"|"fixed-broker-description";retryAfterMs:0|30000}|undefined=>{
  if(response.status!==503)return;
  let value:unknown=response.body;
  // Native front-door responses have JSON bytes without a Content-Type header.
  // Read the already-received bounded bytes; never expose parse errors or text.
  if((value===null||value===undefined||typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===0)&&typeof response.text==="string"&&Buffer.byteLength(response.text,"utf8")<=1024){
    try{value=JSON.parse(response.text);}catch{return;}
  }
  const retry=response.headers["retry-after"];
  if(retry==="30"&&z.object({error:z.literal("temporarily_unavailable")}).strict().safeParse(value).success)return{wireContract:"code-only-retry-after",retryAfterMs:30000};
  if((retry===undefined||retry==="30")&&z.object({error:z.literal("temporarily_unavailable"),error_description:z.literal("This workspace is not ready. Open Paperclip to check its status, then retry.")}).strict().safeParse(value).success)return{wireContract:"fixed-broker-description",retryAfterMs:retry==="30"?30000:0};
};
const listen=async(server:Server)=>{server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("Missing owned principal listener");return `http://127.0.0.1:${address.port}`;};
const close=async(server:Server|undefined)=>{if(!server?.listening)return;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));};
describe.skipIf(!url||!cloudDatabaseUrl)("current normal hosted Dot OAuth/device/subscription and genuine useful Retry",()=>{
  let objectStore:ObjectStore|undefined;
  let storageProxy:Awaited<ReturnType<typeof startStorageFaultProxy>>|undefined;
  let objectStoreRequests=0;
  let physicalApp:Awaited<ReturnType<typeof forkNormalDotApp>>|undefined;
  let childControl:ReturnType<typeof attachDotChild>|undefined;
  let childSnapshot:ChildSnapshot|undefined;
  const retiredChildren:ChildSnapshot[]=[];
  const physicalOwners:Array<Awaited<ReturnType<typeof forkNormalDotApp>>>=[];
  const knownChildProcesses:Array<{child:import("node:child_process").ChildProcess;owner:ReturnType<typeof import("../../../tests/runner-e2e/process-tree-owner.js")["createProcessTreeOwner"]>}>=[];
  let physicalFollowon:Awaited<ReturnType<typeof usefulAfterPhysicalRestart>>|undefined;
  let activeCaseDeadline:number|undefined,setupDeadline=0;
  const childDeadline=()=>Math.min(activeCaseDeadline??Infinity,performance.now()+15_000);
  const syncChildObservation=async(deadline=childDeadline())=>{
    if(!childControl)throw new Error("Missing actual child owner");
    const snapshot=await childControl.request({command:"snapshot"},deadline);childSnapshot=snapshot;
    expect(childControl.snapshot()).toEqual({pending:0,failures:0});
    const all=[...retiredChildren,snapshot];
    authenticateCalls=all.reduce((sum,value)=>sum+value.database.authenticateCalls,0);
    sessionCalls=all.reduce((sum,value)=>sum+value.owner.sessionCalls,0);
    unexpectedDecisionWakes=all.reduce((sum,value)=>sum+value.owner.unexpectedDecisionWakes,0);
    eventTransportCounts.factoryOwners=all.reduce((sum,value)=>sum+value.database.eventFactoryOwners,0);
    eventTransportCounts.authorityRequests=all.reduce((sum,value)=>sum+value.database.authorityRequests,0);
    eventTransportCounts.callbackRequests=all.reduce((sum,value)=>sum+value.database.callbackRequests,0);
    eventTransportCounts.unexpected=all.reduce((sum,value)=>sum+value.database.unexpectedEventRequests,0);
    pendingDeviceAckCheckObservers=snapshot.database.observerPending;
    pendingDeviceObservers=snapshot.database.observerPending;deviceObserverFailures=snapshot.database.observerFailures;
    if(snapshot.database.overflow!==0)throw new Error("Child observer overflow invalidates attribution");
    readinessStatuses.splice(0,readinessStatuses.length,...snapshot.owner.healthStatuses);readinessOverflow=snapshot.owner.healthOverflow;
    return snapshot;
  };
  const setChildDeviceStage=async(value:"first-select"|"retry-select"|"none")=>{
    if(!childControl)throw new Error("Missing actual child owner");
    await childControl.request({command:"device-stage",value},childDeadline());
  };
  const setChildHealth=async(value:"ready"|"unavailable"|"wake-once-then-unavailable")=>{
    if(!childControl)throw new Error("Missing actual child owner");
    await childControl.request({command:"health",value},childDeadline());
  };
  let db:ReturnType<typeof createDb>,home:string,cloudServer:Server|undefined;
  let cloudService:{handler:(req:IncomingMessage,res:ServerResponse)=>unknown;stopBackgroundTasks:()=>void}|undefined,restoreOAuth:(()=>void)|undefined,restoreEventFactory:(()=>void)|undefined;
  let signer:{publicJwks:string;signClaim:(input:{stackId:string;claimId:string;previousOrigin:string;canonicalOrigin:string;stackSlug:string})=>string;signControlAssertion:(input:{stackId:string;action:"mcp-dot:principal"|"task-drain:start"|"task-drain:read"|"task-drain:stop";requestId:string})=>string};
  let registry:Registry,connectorStore:Instances,CloudStackRouter:Router,metadataCompany:(id:string)=>string;
  let cloudLoopback="",appLoopback="",upstreamOrigin="",sessionCalls=0,authenticateCalls=0,unexpectedFetches=0,casePassed=false;
  const userId=randomUUID(),operatorId=userId,companyId=randomUUID(),otherCompanyId=randomUUID(),instanceId="inst_"+randomUUID();

  let agentId="",serial=0,callback:Server|undefined,callbackOrigin="",customerCookie="";
  let restoreLinuxCA:(()=>void)|undefined;
  let linuxInput:{catalogRoot:string;prebuiltPackageRoot:string;expectedBundleDigest:string;providerRoot:string;remoteBinary:string;caBundle:string;caSHA256:string};
  const callbacks:Array<{id:string;at:number;kind?:string}>=[],errors:unknown[]=[];
  let failures=1,unexpectedDecisionWakes=0;
  let reconstructCloudOwner:()=>Promise<void>,makePhysicalSecond:()=>Promise<void>;
  const controlledMasterKeys=new Map<string,Buffer>();
  let cloudOwnerGenerations=0,appOwnerGenerations=0;
  const ownedTenantOrigins=new Set<string>([origin]);
  let healthAvailability:"ready"|"wake-once-then-unavailable"|"unavailable"="ready";
  const readinessStatuses:number[]=[];let readinessOverflow=0;
  let wakeEvidence:{sleepStatus:number;failedReadinessStatus:number;retryStatus:number;admissionDigest:string;grantId:string;bindingGeneration:number;healthStatuses:number[];overflow:number}|undefined;

  type ObservedPhase="callback"|"token"|"device-first-select"|"device-retry-select";
  let observingPhase:ObservedPhase|undefined,tokenObservationOverflow=0,tokenObservationStart=0;
  let callbackHttp:{status:number;code:"temporarily_unavailable"|"invalid_grant"|"invalid_request"|"access_denied"|"unclassified";retryAfter30:boolean}|undefined;
  let observedMirrorStage:"unknown"|"pending"|"complete"="unknown";
  let restoreGateObservation:(()=>void)|undefined,gateObservationOverflow=0,gateObserverFailures=0,pendingGateObservers=0;
  const gateReads:Array<{phase:ObservedPhase;relativeMs:number;signalAlreadyAborted:boolean;kind:"pending"|"read"|"refused"|"timeout"|"aborted"|"original-rejection";load:"not-entered"|"pending"|"fulfilled"|"rejected";loadEnteredMs?:number;loadSettledMs?:number;readSettledMs?:number}>=[];
  const observeGateOwner=(owner:GateReadOwner)=>{
    const originalRead=owner.read;
    owner.read=function<T>(this:GateReadOwner,stack:string,source:string,signal:AbortSignal,load:()=>Promise<T>):Promise<GateReadResult<T>>{
      const invoke=originalRead<T>;
      if(!observingPhase||stack!==stackId)return invoke.call(this,stack,source,signal,load);
      if(gateReads.length>=16){gateObservationOverflow++;return invoke.call(this,stack,source,signal,load);}
      const started=performance.now();
      const record:typeof gateReads[number]={phase:observingPhase,relativeMs:started-tokenObservationStart,signalAlreadyAborted:signal.aborted,kind:"pending",load:"not-entered"};gateReads.push(record);
      const observe=<V,>(promise:Promise<V>,fulfilled:(value:V)=>void,rejected:()=>void)=>{
        pendingGateObservers++;
        try{void promise.then(value=>{pendingGateObservers--;try{fulfilled(value);}catch{gateObserverFailures++;}},()=>{pendingGateObservers--;try{rejected();}catch{gateObserverFailures++;}});}catch{pendingGateObservers--;gateObserverFailures++;}
      };
      const observedLoad=()=>{
        record.load="pending";record.loadEnteredMs=performance.now()-started;
        try{
          const originalLoadPromise=load();
          observe(originalLoadPromise,()=>{record.load="fulfilled";record.loadSettledMs=performance.now()-started;},()=>{record.load="rejected";record.loadSettledMs=performance.now()-started;});
          return originalLoadPromise;
        }catch(error){record.load="rejected";record.loadSettledMs=performance.now()-started;throw error;}
      };
      const originalReadPromise=invoke.call(this,stack,source,signal,observedLoad);
      observe(originalReadPromise,value=>{record.kind=value.kind;record.readSettledMs=performance.now()-started;},()=>{record.kind="original-rejection";record.readSettledMs=performance.now()-started;});
      return originalReadPromise;
    };
    restoreGateObservation=()=>{owner.read=originalRead;};
  };
  let tokenRetry:{firstStatus:number;safeError:string;wireContract:"code-only-retry-after"|"fixed-broker-description";readyBeforeRetry:boolean;appCodeUnconsumed:boolean;issuedTokensBeforeRetry:number;originalExpiry:number;retryAfterMs:number;attempts:number;sameOriginalRequest:boolean}|undefined;
  const tokenOwnerReads:Array<{phase:ObservedPhase;relativeMs:number;purpose:"metadata"|"established";before:PoolObservation;observedMirrorStage:"unknown"|"pending"|"complete";present:boolean;originMatches:boolean;instanceMatches:boolean;dotProfile:boolean;enabled:boolean;error?:"closed-owner-error"}>=[];
  let tokenHttp:{status:number;code:"temporarily_unavailable"|"invalid_grant"|"invalid_request"|"access_denied"|"unclassified"}|undefined;
  let deviceStage:"first-select"|"retry-select"|undefined,holdDeviceMirrorAck=false;
  let releaseDeviceMirrorAck:(()=>void)|undefined,resolveDeviceAckTarget:((revision:number|undefined)=>void)|undefined,resolveDeviceAckHeld:(()=>void)|undefined;
  let deviceAckTargetGate:Promise<number|undefined>=Promise.resolve(undefined),deviceAckReleaseGate:Promise<void>=Promise.resolve(),deviceAckHeldGate:Promise<void>=Promise.resolve();
  let deviceAckTargetRevision:number|undefined,deviceAckBaselineRevision=0,pendingDeviceObservers=0,pendingDeviceAckResponses=0,deviceObserverFailures=0,deviceWireOverflow=0;
  let actualDeviceRegistrationCalls=0,actualDeviceClientId:string|undefined,heldDeviceAck:{revision:number;generation:string}|undefined;
  let decodeDeviceRegistration:((raw:string)=>unknown)|undefined;
  let deviceRetryEvidence:{firstStatus:number;retryStatus:number;registrationCalls:number;sameClient:boolean;originalExpiryUnchanged:boolean;zeroInnerAuthorizationsBeforeRetry:boolean;pendingInnerAuthorizationsAfterRetry:number;ackRevision:number;ackGeneration:string;heldExactDcrRevision:boolean;scopeValidated:boolean}|undefined;
  type DeviceWire={stage:"first-select"|"retry-select";route:"register"|"device-mint";status:number;error:"none"|"closed-error"|"other"};
  const deviceWire:DeviceWire[]=[];
  const eventTransportCounts={factoryOwners:0,authorityRequests:0,callbackRequests:0,unexpected:0};
  type SubscriptionWitness={status:number;rpcCode:number|undefined;error:"none"|"hosted-authority-unavailable"|"invalid-destination"|"callback-verification-failed"|"unclassified"};
  let subscriptionWitness:SubscriptionWitness|undefined;
  const deviceAckChecks:Array<{stage:"first-select"|"retry-select";result:"pending"|"fulfilled"|"current-ack-denial"|"other"}>=[];
  let pendingDeviceAckCheckObservers=0;
  const observeDeviceWire=(pathname:string,status:number,bytes:Buffer)=>{
    if(!deviceStage)return;
    const route=pathname==="/mcp/runner/oauth/register"?"register":pathname==="/mcp/runner/oauth/device_authorization"?"device-mint":undefined;
    if(!route)return;
    if(deviceWire.length>=16){deviceWireOverflow++;return;}
    let error:DeviceWire["error"]=status<400?"none":"other";
    if(route==="device-mint"&&status===503&&bytes.length<=1024){
      try{if(z.object({error:z.literal("temporarily_unavailable"),error_description:z.literal("The hosted Dot connection is being reconciled.")}).strict().safeParse(JSON.parse(bytes.toString("utf8"))).success)error="closed-error";}catch{}
    }
    deviceWire.push({stage:deviceStage,route,status,error});
  };
  const releaseDeviceAckControl=()=>{holdDeviceMirrorAck=false;resolveDeviceAckTarget?.(undefined);releaseDeviceMirrorAck?.();};
  const observeRegistryOwner=(owner:Registry)=>{
    const actualFactory=owner.mcpClientMirrorStore.bind(owner);
    owner.mcpClientMirrorStore=()=>{
      const actual=actualFactory(),read=actual.readResponsibility.bind(actual),sync=actual.sync.bind(actual);
      actual.sync=(binding,request)=>{
        const captureHeldResponse=holdDeviceMirrorAck&&binding.stackId===stackId;
        const originalPromise=sync(binding,request);
        void originalPromise.then(value=>{if(binding.stackId===stackId)observedMirrorStage=value.complete?"complete":"pending";},()=>{});
        if(!captureHeldResponse)return originalPromise;
        // Only response delivery is delayed. The real store has already
        // committed its reducer and released its transaction/locks.
        pendingDeviceAckResponses++;
        return originalPromise.then(async value=>{
          if(!value.complete)return value;
          const target=await deviceAckTargetGate;
          if(!holdDeviceMirrorAck||target===undefined)return value;
          const receipt=mcpClientMirrorReceiptSchema.safeParse(value.receipt);
          if(!receipt.success){deviceObserverFailures++;return value;}
          if(receipt.data.revision!==target){if(receipt.data.revision>target){deviceObserverFailures++;resolveDeviceAckHeld?.();}return value;}
          if(receipt.data.origin!==origin||receipt.data.instanceId!==instanceId||!receipt.data.enabled||receipt.data.dotProfile!=="hosted-dot-v1"||receipt.data.generation!==mcpClientMirrorGeneration(receipt.data)){deviceObserverFailures++;return value;}
          if(heldDeviceAck){deviceObserverFailures++;return value;}
          heldDeviceAck={revision:receipt.data.revision,generation:receipt.data.generation};resolveDeviceAckHeld?.();
          await deviceAckReleaseGate;return value;
        }).finally(()=>{pendingDeviceAckResponses--;});
      };
      actual.readResponsibility=(stack,origin,purpose="metadata")=>{
        if(!observingPhase||stack!==stackId)return read(stack,origin,purpose);
        const phase=observingPhase;
        const before={...owner.availabilityMonitor().getSnapshot().pool},stageAtRead=observedMirrorStage,relativeMs=performance.now()-tokenObservationStart;
        const record=(value:Namespace|undefined,error?:"closed-owner-error")=>{
          if(tokenOwnerReads.length>=16){tokenObservationOverflow++;return;}
          tokenOwnerReads.push({phase,relativeMs,purpose,before,observedMirrorStage:stageAtRead,present:!!value,originMatches:value?.origin===origin,instanceMatches:value?.instanceId===instanceId,dotProfile:value?.dotProfile==="hosted-dot-v1",enabled:value?.enabled===true,...(error?{error}:{})});
        };
        const originalPromise=read(stack,origin,purpose);
        void originalPromise.then(value=>record(value),()=>record(undefined,"closed-owner-error"));
        return originalPromise;
      };
      return actual;
    };
  };
  const callbackSecret="whsec_"+randomBytes(32).toString("base64");
  // server.close's callback and each accepted Socket's close event are distinct
  // ownership signals. Join both without destroying or forgetting a socket.
  const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
  const host=new URL(origin).host;
  const boardPost=(target:string)=>request(appLoopback).post(target).set("Host",host).set("Origin",origin);
  const cloudCall=(target:string,body?:Record<string,unknown>,browser=false,accessToken?:string)=>{
   if(!cloudServer)throw new Error("Missing normal Cloud listener");
   const call=body===undefined?request(cloudServer).get(target):request(cloudServer).post(target).send(body);
   call.set("Host",new URL(browser?cloudOrigin:origin).host);
   if(browser)call.set("Origin",cloudOrigin).set("Cookie",customerCookie);
   if(accessToken)call.set("Authorization","Bearer "+accessToken);
   return call;
  };
  const rpc=(accessToken:string,method:string,params:Record<string,unknown>)=>cloudCall("/mcp/runner",{jsonrpc:"2.0",id:++serial,method,
   params:{...params,_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{events:{}}}}},false,accessToken)
   .set("Accept","application/json, text/event-stream").set("mcp-protocol-version","2026-07-28").set("mcp-method",method)
   .set("mcp-name",typeof params.name==="string"?params.name:"");
  const tool=(accessToken:string,name:string,args:Record<string,unknown>)=>rpc(accessToken,"tools/call",{name,arguments:args});

  type TransportRecord={direction:"outbound"|"inbound";surface:"cloud"|"tenant";path:"mirror"|"revocation-index"|"principal"|"other";method:"GET"|"POST"|"other";hostMatch?:boolean;status?:number;error?:"ECONNRESET"|"ECONNREFUSED"|"EPIPE"|"ABORT_ERR"|"ETIMEDOUT"|"other"};
  const transportRecords:TransportRecord[]=[];let transportOverflow=0;
  const record=(value:TransportRecord)=>{if(transportRecords.length<32)transportRecords.push(value);else transportOverflow++;return value;};
  const pathKind=(value:string):TransportRecord["path"]=>value==="/v1/connector/mcp-client-mirror"?"mirror":value==="/v1/connector/mcp-revocation-index"?"revocation-index":value==="/mcp/runner/oauth/cloud-principal"?"principal":"other";
  const methodKind=(value:string|undefined):TransportRecord["method"]=>value==="GET"||value==="POST"?value:"other";
  const observeInbound=(surface:"cloud"|"tenant",req:IncomingMessage,res:ServerResponse)=>{
    const value=record({direction:"inbound",surface,path:pathKind((req.url??"").split("?",1)[0]??""),method:methodKind(req.method),hostMatch:req.headers.host===new URL(surface==="cloud"?cloudOrigin:origin).host});
    res.once("finish",()=>{value.status=res.statusCode;});
  };
  const mapped:typeof fetch=async(input,init)=>{
    const original=new Request(input,init),target=new URL(original.url);
    const surface=target.origin===cloudOrigin?"cloud":ownedTenantOrigins.has(target.origin)||target.origin===upstreamOrigin?"tenant":undefined;
    if(!surface&&target.origin===callbackPublicOrigin){
      const sent=await fetchCallback(original);return sent;
    }
    if(!surface){unexpectedFetches++;throw new Error("Unexpected off-host principal fixture request");}
    const base=surface==="cloud"?cloudLoopback:appLoopback;
    const headers=new Headers(original.headers);headers.set("host",new URL(surface==="cloud"?cloudOrigin:origin).host);
    const body=original.body?Buffer.from(await original.arrayBuffer()):undefined;original.signal.throwIfAborted();
    const value=record({direction:"outbound",surface,path:pathKind(target.pathname),method:methodKind(original.method)});
    return new Promise<Response>((resolve,reject)=>{
      const sent=nodeRequest(new URL(target.pathname+target.search,base),{method:original.method,headers:Object.fromEntries(headers),signal:original.signal},res=>{
        const chunks:Buffer[]=[];let length=0;
        res.on("data",(part:Buffer)=>{length+=part.length;if(length>1_048_576){res.destroy(new Error("Canonical mapped response exceeds transport bound"));return;}chunks.push(part);});
        res.on("error",reject);res.on("end",()=>{value.status=res.statusCode;const responseHeaders=new Headers();for(const [name,header] of Object.entries(res.headers))if(header!==undefined)for(const item of Array.isArray(header)?header:[header])responseHeaders.append(name,item);
          const status=res.statusCode!;if(surface==="tenant")observeDeviceWire(target.pathname,status,Buffer.concat(chunks));resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:responseHeaders}));});
      });
      sent.on("error",error=>{const code="code" in error?error.code:undefined;value.error=code==="ECONNRESET"||code==="ECONNREFUSED"||code==="EPIPE"||code==="ABORT_ERR"||code==="ETIMEDOUT"?code:"other";reject(error);});sent.end(body);
    });
  };

  // Existing typed provider transport port, restricted to this fixture's two
  // actual owned HTTPS virtual destinations. Production DNS/peer/SSRF policy
  // stays unchanged and is NOT qualified by this controlled loopback mapping.
  const eventTransport:EventFetch=(url,init)=>{
    const target=new URL(url);
    const closed=target.protocol==="https:"&&!target.username&&!target.password&&!target.search&&!target.hash&&init.method==="POST"&&init.redirect==="error";
    if(closed&&target.origin===cloudOrigin&&target.pathname==="/v1/connector/mcp-dot-subscription-authority")eventTransportCounts.authorityRequests++;
    else if(closed&&target.origin===callbackPublicOrigin&&target.pathname==="/events")eventTransportCounts.callbackRequests++;
    else{eventTransportCounts.unexpected++;return Promise.reject(new Error("Event request is outside the exact owned transport boundary"));}
    return mapped(url,init);
  };
  async function fetchCallback(original:Request):Promise<Response>{
   if(!callbackOrigin)throw new Error("Missing owned callback listener");
   const bytes=original.body?Buffer.from(await original.arrayBuffer()):undefined;
   return new Promise<Response>((resolve,reject)=>{
    const sent=nodeRequest(new URL(new URL(original.url).pathname+new URL(original.url).search,callbackOrigin),{method:original.method,headers:Object.fromEntries(original.headers),signal:original.signal},res=>{
     const chunks:Buffer[]=[];res.on("data",chunk=>chunks.push(Buffer.from(chunk)));res.on("error",reject);res.on("end",()=>resolve(new Response(res.statusCode===204?null:Buffer.concat(chunks),{status:res.statusCode,headers:{"content-type":"application/json"}})));
    });sent.on("error",reject);sent.end(bytes);
   });
  }

  beforeAll(async()=>{setupDeadline=performance.now()+90_000;
    const checkout=process.env.PAPERCLIP_DOT_PRINCIPAL_CLOUD_CHECKOUT;if(!checkout||!path.isAbsolute(checkout))throw new Error("Explicit own compiled current Cloud checkout required");
    const load=(name:string)=>import(pathToFileURL(path.join(checkout,"dist",name)).href);
    const [runtime,postgresRegistry,provisioner,fake,stackSecrets,providers,service,routing,identity,wakeReadiness]=await Promise.all([
      load("runtime/runtime-identity-assertion.js"),load("registry/postgres.js"),load("provisioner/provisioner.js"),load("providers/fake.js"),load("providers/stack-secrets.js"),load("connections/providers.js"),load("service/app.js"),load("routing/router.js"),load("identity/tenant-company.js"),load("sleep/wake-readiness.js"),
    ]);
    const customerSession=await load("service/auth/customer-session.js");
    const gateModule=await load("service/tenant/incoming-wake.js");
    const gateOwner:GateReadOwner=gateModule.IncomingApiWakeGate.prototype;observeGateOwner(gateOwner);
    const [tenantDrain,idleCapabilities,idleStop,entryConstants,deployHealth]=await Promise.all([
      load("fleet/tenant-task-drain.js"),load("sleep/incoming-wake-capability.js"),load("sleep/idle-stop-window.js"),load("service/entry-readiness.js"),load("fleet/deploy-health.js"),
    ]);
    CloudStackRouter=routing.CloudStackRouter;metadataCompany=identity.tenantPaperclipCompanyIdForStack;
    const envelopeModule=await load("assistant-mcp/crypto.js");decodeDeviceRegistration=raw=>new envelopeModule.AssistantEnvelope(Buffer.alloc(32,9),resource).open("device-upstream",raw);
    home=await mkdtemp(path.join(tmpdir(),"dot-principal-hop-"));vi.stubEnv("PAPERCLIP_HOME",home);vi.stubEnv("PAPERCLIP_CONFIG",path.join(home,"runtime-config.json"));vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY",randomBytes(32).toString("base64"));
    const minio=process.env.PAPERCLIP_DOT_MINIO_BINARY;
    if(!minio||!path.isAbsolute(minio))throw new Error("Explicit verified normal MinIO fixture binary required");
    await access(minio);
    const storageSetupRemaining=Math.floor(setupDeadline-performance.now());
    if(storageSetupRemaining<=0)throw new Error("Original setup deadline expired before normal object-store startup");
    objectStore=await startMinio({binary:minio,root:path.join(home,"s3"),bucket:`dot-${randomUUID()}`,readyTimeoutMs:Math.min(30_000,storageSetupRemaining)});
    storageProxy=await startStorageFaultProxy(objectStore.endpoint);
    storageProxy.observe(()=>{objectStoreRequests++;}); // Existing pass-through port: no rule, fabricated response, key or header logging.
    for(const [key,value] of Object.entries(objectStoreServerEnvironment(objectStore,storageProxy.endpoint,"dot-qualification")))vi.stubEnv(key,value);
    vi.stubEnv("DATABASE_URL",url!);

    const ownBinary=process.env.PAPERCLIP_DOT_HOSTED_RUNNER_BINARY;if(!ownBinary||!path.isAbsolute(ownBinary))throw new Error("Explicit current own source-matched Runner required before normal App bootstrap");await access(ownBinary);
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY",ownBinary);vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR",path.join(home,"runner-state"));vi.stubEnv("PAPERCLIP_IN_WORKTREE","false");
    const control=generateKeyPairSync("ed25519"),sign=generateKeyPairSync("ed25519"),seal=generateKeyPairSync("x25519"),kid="principal-hop-current";
    const publicJwks=JSON.stringify({keys:[{...control.publicKey.export({format:"jwk"}),kid,alg:"EdDSA",use:"sig"}]});
    signer=runtime.createRuntimeIdentitySignerFromEnv({CLOUD_HARNESS_RUNTIME_IDENTITY_SIGNING_JWK:JSON.stringify({...control.privateKey.export({format:"jwk"}),kid,alg:"EdDSA",use:"sig"}),CLOUD_HARNESS_RUNTIME_IDENTITY_JWKS:publicJwks},{required:true});
        const connectCloud=(runMigrations:boolean):Promise<Registry>=>postgresRegistry.PostgresCloudHarnessRegistry.connect({connectionString:cloudDatabaseUrl!,maxConnections:4,runMigrations,migrationsPath:path.join(checkout,"migrations"),migrationLockTimeoutMs:5000});
    registry=await connectCloud(true);observeRegistryOwner(registry);const provider=new fake.FakeCloudStackProvider();connectorStore=registry.connectorStore();
    await registry.createFleetReleaseArtifact({id:"principal-hop-release",appVersion:"principal-hop"});await registry.importFeatureCatalog({releaseArtifactId:"principal-hop-release",catalogVersion:"principal-hop",features:{"cloud.feature-masking":{tier:"managed"}}});
    await new provisioner.CloudStackProvisioner({registry,provider}).provisionDevelopmentStack({idempotencyKey:stackId,accountGroup:{id:"principal-hop-account",slug,displayName:"Principal hop"},owner:{id:userId,email:userId+"@example.test"},stack:{stackId,accountGroupId:"principal-hop-account",stackSlug:slug,displayName:"Principal hop",kind:"demo",primaryHost:new URL(origin).hostname,region:"us-east-1"},versionPlan:{appVersion:"principal-hop",schemaVersion:"fixture",rolloutTrack:"stable"},sleepPolicy:{desiredState:"awake"},primaryCompany:{paperclipCompanyId:otherCompanyId,displayName:"Primary not consent",defaultBudgetCents:0}});
    const normallyProvisioned=await registry.getStack(stackId);if(!normallyProvisioned)throw new Error("Missing normally provisioned provider routing");
    const providerOrigin=deployHealth.resolveTenantAppOrigin(normallyProvisioned.providerRefs);if(providerOrigin)ownedTenantOrigins.add(new URL(providerOrigin).origin);
    const globalOwner=await registry.getGlobalUser(userId);if(!globalOwner)throw new Error("Missing normally provisioned current owner");
    const session=customerSession.issueCustomerSessionToken({globalUser:globalOwner,scopes:["portfolio:read","lifecycle:write"],signingKey:"principal-hop-customer-session-".repeat(3),ttlSeconds:600,sessionVersion:customerSession.customerSessionVersionFromMetadata(globalOwner.metadata)});
    if(typeof session.accessToken!=="string")throw new Error("Missing normal customer session");customerCookie=customerSession.customerSessionCookieDefaultName+"="+session.accessToken;
    await registry.updateStackWakeState(stackId,{providerRefs:[{provider:"railway",resourceType:"service_domain:web",externalId:"principal-hop-domain",name:"tenant",metadata:{upstreamOrigin:"https://principal-hop-provider.example.test"}}],lifecycleState:"active",sleepState:"awake"});
    await connectorStore.putCloudStackInstance({id:instanceId,kind:"cloud_stack",companyStackId:stackId,environment:"test",signPublicKey:sign.publicKey.export({format:"jwk"}).x!,sealPublicKey:seal.publicKey.export({format:"jwk"}).x!,origins:[origin],activeOrigin:origin,label:"Principal hop actual enrolled namespace",status:"active",createdAt:new Date(),updatedAt:new Date()});
    vi.stubGlobal("fetch",mapped);
    const makeCloudOwner=async()=>{
      const noSharedSecret=async()=>{throw new Error("Stack-scoped fixture must never access shared/provider secrets");};
      const vault=new stackSecrets.StackEncryptedSecretStore({region:"us-east-1",secretRefPrefix:"secret://principal-hop",database:registry.stackSecretDatabase(),
        keys:{getKey:async(name:string)=>controlledMasterKeys.get(name),createKeyIfAbsent:async(name:string,key:Buffer)=>{if(controlledMasterKeys.has(name))return"exists";controlledMasterKeys.set(name,Buffer.from(key));return"created";},deleteKey:async(name:string)=>{controlledMasterKeys.delete(name);},listKeyNames:async(prefix:string)=>[...controlledMasterKeys.keys()].filter(name=>name.startsWith(prefix+"/"))},
        shared:{getSecret:noSharedSecret,putSecret:noSharedSecret,deleteSecret:noSharedSecret,createSecretIfAbsent:noSharedSecret}});
    const actualWakeReadiness=wakeReadiness.createHttpWakeReadinessProbe({fetch:mapped});
    const actualEntryReadiness=wakeReadiness.createHttpWakeReadinessProbe({fetch:mapped,
      timeoutMs:entryConstants.ENTRY_READINESS_TIMEOUT_MS,intervalMs:entryConstants.ENTRY_READINESS_INTERVAL_MS,attemptTimeoutMs:entryConstants.ENTRY_READINESS_ATTEMPT_TIMEOUT_MS});
    const actualIdleDrain=tenantDrain.createTenantTaskDrainGate({fetchImpl:mapped,waitBudgetMs:0,
      idleStopWindow:idleStop.idleStopWindowFor(provider),signControlAssertion:signer.signControlAssertion,
      getIdleCapabilities:async({stackId:currentStackId,ownerId}:{stackId:string;ownerId:string})=>{
        const incomingWake=await idleCapabilities.createIdleIncomingWakeCapability({stackId:currentStackId,ownerId,store:connectorStore,apiEnabled:false,mcpEnabled:true,brokerEnabled:false});
        return incomingWake?{incomingWake}:undefined;
      }});
    cloudService=service.createCloudHarnessService({registry,provider,entryReadinessProbe:actualEntryReadiness,wakeReadinessProbe:actualWakeReadiness,idleSleepDrain:actualIdleDrain,baseDomain:"paperclip.app",customerAppOrigin:cloudOrigin,runtimeIdentity:signer,incomingMcpWakeEnabled:true,tenantSessionSigningKey:"principal-hop-tenant-session-".repeat(3),customerSessionSigningKey:"principal-hop-customer-session-".repeat(3),appVersion:"principal-hop",schemaVersion:"fixture",assistantMcp:{store:registry.assistantMcpStore(),encryptionKey:Buffer.alloc(32,9)},connector:{environment:"test",providers:providers.providerRegistryFromEnvironment({}),fetchImplementation:mapped,secrets:{resolve:async()=>{throw new Error("No external provider");}},store:connectorStore,stackEnrollment:{secrets:vault,secretRefPrefix:"secret://principal-hop"}}});
    cloudServer=createServer((req,res)=>{observeInbound("cloud",req,res);const current=cloudService;if(!current)throw new Error("Missing normal Cloud handler");current.handler(req,res);});cloudLoopback=await listen(cloudServer);
      cloudOwnerGenerations++;
    };
    await makeCloudOwner();
    reconstructCloudOwner=async()=>{
      await cloudService?.stopBackgroundTasks();await close(cloudServer);await registry.close();
      registry=await connectCloud(false);observeRegistryOwner(registry);connectorStore=registry.connectorStore();await makeCloudOwner();
    };
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID",stackId);vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN","principal-hop-tenant-token");vi.stubEnv("PAPERCLIP_CLOUD_WARM_STANDBY","1");
    vi.stubEnv("PAPERCLIP_PUBLIC_URL",origin);vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL",origin);vi.stubEnv("PAPERCLIP_API_URL",origin);vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS",publicJwks);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID",instanceId);vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT","test");vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL",cloudOrigin);vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",sign.privateKey.export({format:"jwk"}).d!);vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",seal.privateKey.export({format:"jwk"}).d!);
    await applyPendingMigrations(url!);
    const linuxInputFile=process.env.PAPERCLIP_DOT_LINUX_RUNTIME_INPUT;
    if(!linuxInputFile||!path.isAbsolute(linuxInputFile))throw new Error("Explicit owned Linux runtime input required");
    const absolute=z.string().refine(value=>path.isAbsolute(value));
    linuxInput=z.object({catalogRoot:absolute,prebuiltPackageRoot:absolute,expectedBundleDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),providerRoot:absolute,remoteBinary:absolute,caBundle:absolute,caSHA256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(await readFile(linuxInputFile,"utf8")));
    restoreLinuxCA=beginOwnedPrivateCA({pem:await readFile(linuxInput.caBundle,"utf8"),SHA256:linuxInput.caSHA256});
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH",linuxInput.remoteBinary);
    callback=createServer(async(req,res)=>{
      try{
       const parts:Buffer[]=[];let length=0;for await(const chunk of req){length+=Buffer.byteLength(chunk);if(length>1_048_576)throw new Error("Bounded callback body exceeded");parts.push(Buffer.from(chunk));}
       const bytes=Buffer.concat(parts).toString(),id=String(req.headers["webhook-id"]),at=String(req.headers["webhook-timestamp"]);
       expect(req.headers["webhook-signature"]).toBe("v1,"+createHmac("sha256",Buffer.from(callbackSecret.slice(6),"base64")).update(`${id}.${at}.${bytes}`).digest("base64"));
       const body=JSON.parse(bytes);if(body.type==="verification"){res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({challenge:body.challenge}));return;}
       expect(body.data).not.toHaveProperty("challenge");callbacks.push({id,at:Date.now(),kind:body.data?.kind});res.writeHead(failures-->0?500:204).end();
      }catch(error){errors.push(error);res.writeHead(500).end();}
    });callbackOrigin=await listen(callback);
    const makeAppOwner=async()=>{
      db=createDb(url!,{maxConnections:2,applicationName:"dot-principal-parent-observer"});
      // Parent observer has no delivery/Native/plugin owner. These normal setup
      // writes happen BEFORE generation1 starts, so both process snapshots read
      // the same persisted authorized fixture configuration.
      if(appOwnerGenerations===0){await migrateCloudConfiguration(db);await initializeAdapterSettings(db);await initializeCloudRuntimeConfig(db);}
      const generation=appOwnerGenerations+1;
      const inputFile=path.join(home,`dot-child-generation-${generation}.json`);
      await writeFile(inputFile,JSON.stringify({stackId,databaseUrl:url,home,origin,userId,companyId,generation,resource,
        cloudOrigin,cloudLoopback,callbackPublicOrigin,callbackLoopback:callbackOrigin,linuxInput}),{mode:0o600,flag:"wx"});
      const closedEnv=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&
        (key.startsWith("PAPERCLIP_")||["PATH","HOME","TMPDIR","LANG","TZ","NODE_OPTIONS","NODE_EXTRA_CA_CERTS",
          "MCP_SLEEP_GUARD_LOG","MCP_SLEEP_GUARD_PG_PORTS","CLOUD_SUITE_ATTEST_LOG","CLOUD_SUITE_ENTRY_MANIFEST",
          "DATABASE_URL","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_CREDENTIAL_EXPIRATION","AWS_EC2_METADATA_DISABLED"].includes(key)))) as Record<string,string>;
      closedEnv.PAPERCLIP_DOT_CHILD_INPUT=inputFile;
      physicalApp=await forkNormalDotApp({entry:new URL("./helpers/owned-linux/normal-app-child.ts",import.meta.url),
        nodeExecutable:process.execPath,normalTsxImport:new URL("../../node_modules/tsx/dist/loader.mjs",import.meta.url),
        cwd:process.cwd(),closedEnv,setupDeadline:activeCaseDeadline??setupDeadline,
        registerActualChild:(child,owner)=>{
          knownChildProcesses.push({child,owner});
          childControl=attachDotChild(child,event=>{
            if(event.kind==="dcr-committed"){
              actualDeviceRegistrationCalls++;actualDeviceClientId=z.string().min(1).parse(event.clientId);
              const revision=z.number().int().positive().parse(event.revision);
              if(holdDeviceMirrorAck){deviceAckTargetRevision=revision;resolveDeviceAckTarget?.(revision);}
            }else if(event.kind==="ack-check"){
              if(deviceAckChecks.length>=16){deviceWireOverflow++;return;}
              deviceAckChecks.push(z.object({stage:z.enum(["first-select","retry-select"]),result:z.enum(["fulfilled","current-ack-denial","other"])}).parse(event));
            }else if(event.kind==="stopped"){
              if(event.owner&&event.snapshot)retiredChildren.push({owner:event.owner as ChildSnapshot["owner"],database:event.snapshot as ChildSnapshot["database"]});
            }else if(event.kind==="failed")errors.push(new Error("Actual owned Dot child failed"));
          });
        },privateLog:(channel,bytes)=>{if(channel==="stdout")process.stdout.write(bytes);else process.stderr.write(bytes);}});
      physicalOwners.push(physicalApp);appLoopback=physicalApp.origin;appOwnerGenerations++;
      await syncChildObservation();
    };
    await makeAppOwner();makePhysicalSecond=makeAppOwner;



  },90_000);
  afterAll(async()=>{activeCaseDeadline=undefined;
    const errors:unknown[]=[];
    releaseDeviceAckControl();deviceStage=undefined;observingPhase=undefined;
    try{
      for(const physical of physicalOwners)await physical.stop(childDeadline());
      for(const known of knownChildProcesses){await known.owner.observe();
        if(known.child.exitCode!==0||known.child.signalCode!==null||known.owner.liveGroups().length)
          errors.push(new Error("Known child startup/execution ownership remains unknown; retain evidence"));}
    }catch(error){errors.push(error);}
    try{await cloudService?.stopBackgroundTasks();await close(cloudServer);await close(callback);await registry?.close();}catch(error){errors.push(error);}
    try{if(db)await db.$client.end({timeout:1});if(url)await closeRegisteredClients(url,{scope:"database"});}catch(error){errors.push(error);}
    try{await storageProxy?.close();}catch(error){errors.push(error);}
    try{await objectStore?.stop();}catch(error){errors.push(error);}
    try{restoreLinuxCA?.();}catch(error){errors.push(error);}
    restoreGateObservation?.();restoreOAuth?.();restoreEventFactory?.();setCloudRuntimeConfigSnapshot(null);resetCloudRuntimeIdentityForTests();resetCloudControlReplayFenceForTests();vi.unstubAllEnvs();vi.unstubAllGlobals();
    process.stdout.write(JSON.stringify({scope:"credential-free actual principal fixture transport",records:transportRecords,overflow:transportOverflow})+"\n");
    expect(unexpectedDecisionWakes).toBe(0);expect(physicalOwners.every(owner=>owner.child.exitCode===0)).toBe(true);expect(databaseObservation.listenersOpen).toBe(0);expect(databaseObservation.dedicatedOpen).toBe(0);
    const tokenDiagnostic=process.env.PAPERCLIP_DOT_ACCEPTANCE_RECEIPT;
    if(tokenDiagnostic){
      if(!path.isAbsolute(tokenDiagnostic))errors.push(new Error("Private token diagnostic needs absolute receipt path"));
      else try{await writeFile(tokenDiagnostic+".token-frontier.json",JSON.stringify({scope:"passive existing current-custody owner",callbackHttp,tokenHttp,tokenRetry,actualDeviceRegistrationCalls,deviceAckTargetRevision,heldDeviceAck,deviceWire,eventTransportCounts,subscriptionWitness,deviceAckChecks,pendingDeviceAckCheckObservers,deviceWireOverflow,deviceObserverFailures,pendingDeviceObservers,pendingDeviceAckResponses,deviceRetryEvidence,reads:tokenOwnerReads,overflow:tokenObservationOverflow,gateReads,gateObservationOverflow,gateObserverFailures,pendingGateObservers,writeFailures:0,noPassiveDiagnosticQueries:true,deviceValidationReadsOutsideQuiet:true,originalCodeRetryOnlyAfterDurableUnconsumedProof:true},null,2)+"\n",{mode:0o600,flag:"wx"});}catch(error){errors.push(error);}
    }
    if(!errors.length&&casePassed&&home)removeTestHome(home);
    if(errors.length)throw new AggregateError(errors,"Principal normal App owned cleanup failed");
  },30_000);

  it("uses real hosted code/device OAuth, reverse subscription and genuine failed-task recovery before strict quiet/revoke",async()=>{
    const caseStarted=performance.now();activeCaseDeadline=caseStarted+90_000;
    if(!physicalApp)throw new Error("Missing normal physical App");
    const claim=signer.signClaim({stackId,claimId:randomUUID(),previousOrigin:origin,canonicalOrigin:origin,stackSlug:slug});
    expect((await request(appLoopback).get("/api/health").set("Host",host).set(CLOUD_RUNTIME_IDENTITY_HEADER,claim)).status).toBe(200);
    expect((await syncChildObservation()).owner.runtimeIdentity).toMatchObject({stackId,canonicalOrigin:origin});
        await db.insert(companies).values([{id:companyId,name:"Hosted Dot original grant company",issuePrefix:"HDC"},{id:otherCompanyId,name:"Primary not consent",issuePrefix:"HDP"}]);
        await db.insert(authUsers).values({id:userId,name:"Current operator",email:userId+"@example.test",createdAt:new Date(),updatedAt:new Date()});
        await accessService(db).ensureMembership(companyId,"user",userId,"owner","active");
        await accessService(db).ensureRoleDefaultGrants(companyId,userId,"owner",userId);
        await instanceSettingsService(db).updateExperimental({enablePublicMcp:true,enableOpenAiDot:true,enableNativeRunner:true});
    const stack=await registry.getAssistantMcpStack(stackId);if(!stack)throw new Error("Missing normal stack");
    const route=await new CloudStackRouter({registry:{findStackByHost:async value=>value===stack.primaryHost?stack:undefined,findStackBySlug:async value=>value===stack.stackSlug?stack:undefined},baseDomain:"paperclip.app"}).resolveRoute({trustedHost:stack.primaryHost});
    if(route.kind!=="tenant"||!route.target?.activeAppOrigin)throw new Error("Missing normal tenant route");upstreamOrigin=route.target.activeAppOrigin;
    await vi.waitFor(async()=>{const receipt=await registry.mcpClientMirrorStore().readCurrent(stackId,origin);expect(receipt).toMatchObject({instanceId,origin,dotProfile:"hosted-dot-v1",enabled:true,frontDoor:"tenant-personal-v1"});},{timeout:10_000,interval:50});
    const initialClaim=await boardPost("/api/bootstrap/claim").set("x-selected-operator",userId).send({});expect(initialClaim.status).toBe(200);expect(initialClaim.body).toMatchObject({claimed:true,userId});
    const environment=await boardPost(`/api/companies/${companyId}/environments`).set("x-selected-operator",userId).send({name:"Owned real Linux Dot",driver:"sandbox",config:{provider:"dot-linux-qualification",qualificationId:"dot-owned-linux",reuseLease:false,runnerLifecycleMode:"per_turn"}});
    expect(environment.status).toBe(201);expect(z.uuid().safeParse(environment.body.id).success).toBe(true);
    const invited=await boardPost(`/api/companies/${companyId}/dot-invitations`).set("x-selected-operator",userId).send({});expect(invited.status).toBe(200);agentId=invited.body.agent.id;
    const workspace=path.join(home,"workspace");await mkdir(workspace,{recursive:true});await writeFile(path.join(workspace,"AGENTS.md"),"Use only the assigned Paperclip tools to save the requested arithmetic document.\n");
    const [invitedAgent]=await db.select().from(agents).where(eq(agents.id,agentId));
    const configuration=await request(appLoopback).patch(`/api/agents/${agentId}`).set("Host",host).set("Origin",origin).set("x-selected-operator",userId).send({adapterConfig:{...invitedAgent.adapterConfig,cwd:workspace}});expect(configuration.status).toBe(200);
    const pairing=await boardPost(`/api/companies/${companyId}/agents/${agentId}/dot-binding`).set("x-selected-operator",userId).send({});expect(pairing.status).toBe(201);
    const registration=await cloudCall("/mcp/runner/oauth/register",{client_name:"Actual hosted Dot",redirect_uris:[redirect],grant_types:["authorization_code","refresh_token",DEVICE_GRANT],response_types:["code"],token_endpoint_auth_method:"none"});expect(registration.status).toBe(201);
    const clientId=registration.body.client_id,verifier=randomBytes(48).toString("base64url");
    const begin=await cloudCall("/mcp/runner/oauth/authorize?"+new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:"code",resource,scope:"paperclip:agent offline_access",company_id:companyId,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"}));expect(begin.status).toBe(303);
    const id=new URL(begin.headers.location).pathname.split("/").at(-1)!;
    const selected=await cloudCall(`/v1/assistant-mcp/requests/${id}/select`,{stackId:slug},true);expect(selected.status).toBe(200);
    const consentPath=new URL(selected.body.redirectUrl).searchParams.get("returnTo");expect(consentPath).toMatch(/^\/dot-connect\//);const requestId=consentPath!.split("/").at(-1)!;
    const consent=await boardPost(`/api/mcp/requests/${requestId}/consent`).set("Origin",origin).set("x-selected-operator",userId).send({decision:"approve",companyId,allowWrites:false});expect(consent.status).toBe(200);
    const callbackUrl=new URL(consent.body.redirectUrl);
    const receiveCallback=async()=>{tokenObservationStart=performance.now();observingPhase="callback";try{return await cloudCall(callbackUrl.pathname+callbackUrl.search);}finally{observingPhase=undefined;}};
    const returned=await receiveCallback();
    const callbackCode=z.enum(["temporarily_unavailable","invalid_grant","invalid_request","access_denied"]).safeParse(returned.body?.error);
    callbackHttp={status:returned.status,code:closedUnavailable(returned)?"temporarily_unavailable":callbackCode.success?callbackCode.data:"unclassified",retryAfter30:returned.headers["retry-after"]==="30"};
    expect(returned.status,JSON.stringify({stage:"authorization-code-callback",...callbackHttp})).toBe(303);
    await syncChildObservation();const beforeAuth=authenticateCalls,tokenRequest={grant_type:"authorization_code",client_id:clientId,redirect_uri:redirect,resource,code:new URL(returned.headers.location).searchParams.get("code"),code_verifier:verifier};
    const originalRequestDigest=createHash("sha256").update(JSON.stringify(tokenRequest)).digest("hex");
    const exchange=async()=>{tokenObservationStart=performance.now();observingPhase="token";try{return await cloudCall("/mcp/runner/oauth/token",tokenRequest);}finally{observingPhase=undefined;}};
    let tokens=await exchange();
    const firstErrorCode=z.enum(["temporarily_unavailable","invalid_grant","invalid_request","access_denied"]).safeParse(tokens.body?.error);
    const firstUnavailable=closedUnavailable(tokens);
    tokenHttp={status:tokens.status,code:firstUnavailable?"temporarily_unavailable":firstErrorCode.success?firstErrorCode.data:"unclassified"};
    if(tokens.status===503){
      if(!firstUnavailable)throw new Error("503 did not match either exact closed public retry contract");
      const retryAfterMs=firstUnavailable.retryAfterMs;
      const checkUnconsumed=async()=>{
        const cloudCode=await registry.assistantMcpStore().getAuthorization(id);
        const [appCode]=await db.select({consumedAt:mcpOauthRequests.consumedAt,expiresAt:mcpOauthRequests.expiresAt,grantId:mcpOauthRequests.grantId,clientId:mcpOauthRequests.clientId,resource:mcpOauthRequests.resource}).from(mcpOauthRequests).where(eq(mcpOauthRequests.id,requestId));
        if(!cloudCode||!appCode?.grantId)throw new Error("Original code retry has no durable bound frontier");
        const issued=await db.select({kind:mcpOauthTokens.kind}).from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,appCode.grantId)).limit(1);
        const scope={ready:cloudCode.status==="ready",issuer:cloudCode.issuerOrigin===origin,stack:cloudCode.stackId===stackId&&cloudCode.boundStackId===stackId,profile:cloudCode.profile==="dot-mcp",user:cloudCode.userId===userId,company:cloudCode.companyId===companyId,client:cloudCode.clientId===clientId&&cloudCode.tenantClientId===appCode.clientId,resource:appCode.resource===resource,appCodeUnconsumed:appCode.consumedAt===null,issuedTokens:issued.length,unexpired:cloudCode.expiresAt>Date.now()&&appCode.expiresAt.getTime()>Date.now()};
        expect(scope).toEqual({ready:true,issuer:true,stack:true,profile:true,user:true,company:true,client:true,resource:true,appCodeUnconsumed:true,issuedTokens:0,unexpired:true});
        return {originalExpiry:Math.min(cloudCode.expiresAt,appCode.expiresAt.getTime()),issuedTokens:issued.length};
      };
      const frontier=await checkUnconsumed();
      expect(frontier.originalExpiry).toBeGreaterThan(Date.now()+retryAfterMs);
      expect(performance.now()-caseStarted+retryAfterMs).toBeLessThan(90_000);
      tokenRetry={firstStatus:503,safeError:"temporarily_unavailable",wireContract:firstUnavailable.wireContract,readyBeforeRetry:true,appCodeUnconsumed:true,issuedTokensBeforeRetry:frontier.issuedTokens,originalExpiry:frontier.originalExpiry,retryAfterMs,attempts:1,sameOriginalRequest:true};
      if(retryAfterMs)await pause(retryAfterMs);
      const current=await checkUnconsumed();expect(current.originalExpiry).toBe(frontier.originalExpiry);
      expect(createHash("sha256").update(JSON.stringify(tokenRequest)).digest("hex")).toBe(originalRequestDigest);
      tokens=await exchange();tokenRetry.attempts=2;
    }
    const errorCode=z.enum(["temporarily_unavailable","invalid_grant","invalid_request","access_denied"]).safeParse(tokens.body?.error);
    tokenHttp={status:tokens.status,code:closedUnavailable(tokens)?"temporarily_unavailable":errorCode.success?errorCode.data:"unclassified"};
    await syncChildObservation();expect(tokens.status,JSON.stringify({stage:"authorization-code-token",...tokenHttp})).toBe(200);expect(authenticateCalls).toBe(beforeAuth+1);
    let raw=tokens.body.access_token;expect(raw).toMatch(/^pcm1\./);
    const paired=await tool(raw,"paperclip_dot_pair",{pairingCode:pairing.body.pairingCode});expect(paired.status).toBe(200);expect(paired.body.result.isError).toBe(false);
    const [binding]=await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id,pairing.body.bindingId));expect(binding.grantId).toBeTruthy();
    const [originalGrant]=await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,binding.grantId!));expect(originalGrant).toMatchObject({companyId,userId,purpose:"agent",resource,agentId,revokedAt:null});
    const device=await cloudCall("/mcp/runner/oauth/device_authorization",{client_id:clientId,resource,scope:"paperclip:agent offline_access",company_id:companyId});expect(device.status).toBe(200);
    const currentMirrorAck=async()=>{
      let ack:{revision:number;generation:string}|undefined;
      const remaining=Math.min(15_000,90_000-(performance.now()-caseStarted));expect(remaining).toBeGreaterThan(0);
      await vi.waitFor(async()=>{
        const [row]=await db.select().from(mcpOauthClientMirrorState).where(eq(mcpOauthClientMirrorState.id,"public"));
        const parsed=mcpClientMirrorReceiptSchema.safeParse(row?.receipt);
        const closed={present:!!row,enabled:row?.enabled===true,responsibility:row?.remoteResponsibility===true,receipt:parsed.success,
          revision:parsed.success&&parsed.data.revision===row?.revision,instance:parsed.success&&parsed.data.instanceId===instanceId,
          origin:parsed.success&&parsed.data.origin===origin,profile:parsed.success&&parsed.data.dotProfile==="hosted-dot-v1",
          enabledReceipt:parsed.success&&parsed.data.enabled,deviceStatus:parsed.success&&!!parsed.data.deviceStatus,
          generation:parsed.success&&parsed.data.generation===mcpClientMirrorGeneration(parsed.data)};
        expect(Object.values(closed).every(Boolean)).toBe(true);
        if(!row||!parsed.success)throw new Error("Normal current mirror ACK is unavailable");
        ack={revision:row.revision,generation:parsed.data.generation};
      },{timeout:remaining,interval:25});
      if(!ack)throw new Error("Normal mirror ACK observation did not settle");return ack;
    };
    const initialDeviceAck=await currentMirrorAck();deviceAckBaselineRevision=initialDeviceAck.revision;
    const originalDeviceRequest=await registry.assistantMcpStore().getAuthorization(device.body.user_code);
    if(!originalDeviceRequest)throw new Error("Normal device request is unavailable");
    const originalDeviceExpiry=originalDeviceRequest.expiresAt;
    const selectArgs={stackId:slug},selectPath=`/v1/assistant-mcp/requests/${device.body.user_code}/select`;
    const selectDigest=createHash("sha256").update(JSON.stringify(selectArgs)).digest("hex");
    deviceAckTargetGate=new Promise(resolve=>{resolveDeviceAckTarget=resolve;});deviceAckReleaseGate=new Promise(resolve=>{releaseDeviceMirrorAck=resolve;});deviceAckHeldGate=new Promise(resolve=>{resolveDeviceAckHeld=resolve;});
    holdDeviceMirrorAck=true;await setChildDeviceStage("first-select");deviceStage="first-select";observingPhase="device-first-select";tokenObservationStart=performance.now();
    let knownClientId:string|undefined;
    try{
      const firstSelect=await cloudCall(selectPath,selectArgs,true);
      await syncChildObservation();expect(firstSelect.status).toBe(503);expect(closedUnavailable(firstSelect)!==undefined).toBe(true);
      expect(deviceWire.some(value=>value.stage==="first-select"&&value.route==="device-mint"&&value.status===503&&value.error==="closed-error")).toBe(true);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([deviceAckHeldGate,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("Actual complete ACK response was not observed within its existing15-second transport budget")),Math.min(15_000,90_000-(performance.now()-caseStarted)));})]);}finally{clearTimeout(timer);}
      expect(deviceObserverFailures).toBe(0);expect(deviceWireOverflow).toBe(0);expect(pendingDeviceObservers).toBe(0);
      expect(deviceAckChecks.filter(value=>value.stage==="first-select")).toEqual([{stage:"first-select",result:"current-ack-denial"}]);expect(pendingDeviceAckCheckObservers).toBe(0);
      expect(actualDeviceRegistrationCalls).toBe(1);expect(deviceAckTargetRevision!==undefined&&heldDeviceAck?.revision===deviceAckTargetRevision).toBe(true);
      const pending=await registry.assistantMcpStore().getAuthorization(device.body.user_code);
      const [waiting]=await db.select().from(mcpOauthClientMirrorState).where(eq(mcpOauthClientMirrorState.id,"public"));
      const closed={pending:pending?.status==="pending",flow:pending?.flow==="device",profile:pending?.profile==="dot-mcp",issuer:pending?.issuerOrigin===origin,
        stack:pending?.stackId===stackId&&pending?.boundStackId===stackId,user:pending?.userId===userId,company:pending?.companyId===companyId&&pending?.requestedCompanyId===companyId,
        client:pending?.clientId===clientId&&pending?.tenantClientId===actualDeviceClientId,origin:pending?.tenantOrigin===origin,expiry:pending?.expiresAt===originalDeviceExpiry,
        currentDcrRevision:waiting?.revision===deviceAckTargetRevision,staleAck:!!waiting&&waiting.receipt?.revision!==waiting.revision};
      expect(Object.values(closed).every(Boolean)).toBe(true);
      if(!pending?.tenantClientId||!pending.tenantDeviceEnvelope||!decodeDeviceRegistration)throw new Error("Known pending registration custody is unavailable");
      let decodedRegistration:unknown;try{decodedRegistration=decodeDeviceRegistration(pending.tenantDeviceEnvelope);}catch{throw new Error("Known registration envelope could not be authenticated");}
      const sealed=z.object({requestId:z.string(),clientId:z.string(),registration:z.object({requestId:z.string(),publicClientId:z.string(),userId:z.string(),stackId:z.string(),origin:z.string(),instanceId:z.string(),companyId:z.string().nullable(),scope:z.string()}).strict()}).strict().safeParse(decodedRegistration);
      expect(sealed.success).toBe(true);if(!sealed.success)throw new Error("Pending device registration envelope is not exact");
      const exact={request:sealed.data.requestId===device.body.user_code&&sealed.data.registration.requestId===device.body.user_code,client:sealed.data.clientId===pending.tenantClientId&&sealed.data.registration.publicClientId===clientId,
        user:sealed.data.registration.userId===userId,stack:sealed.data.registration.stackId===stackId,instance:sealed.data.registration.instanceId===instanceId,
        origin:sealed.data.registration.origin===origin,company:sealed.data.registration.companyId===companyId,scope:sealed.data.registration.scope===originalDeviceRequest.scopes?.join(" ")};
      expect(Object.values(exact).every(Boolean)).toBe(true);
      expect(await db.select({id:mcpOauthDeviceRequests.id}).from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.clientId,pending.tenantClientId)).limit(2)).toHaveLength(0);
      expect(await db.select({id:mcpOauthGrants.id}).from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId,pending.tenantClientId)).limit(2)).toHaveLength(0);
      expect(pending.expiresAt).toBeGreaterThan(Date.now());knownClientId=pending.tenantClientId;
    }finally{releaseDeviceAckControl();await setChildDeviceStage("none");deviceStage=undefined;observingPhase=undefined;}
    const acknowledgedDevice=await currentMirrorAck();expect(acknowledgedDevice.revision).toBe(deviceAckTargetRevision);expect(acknowledgedDevice.generation).toBe(heldDeviceAck?.generation);
    expect(pendingDeviceAckResponses).toBe(0);expect(deviceObserverFailures).toBe(0);expect(deviceWireOverflow).toBe(0);
    expect(createHash("sha256").update(JSON.stringify(selectArgs)).digest("hex")).toBe(selectDigest);
    await setChildDeviceStage("retry-select");deviceStage="retry-select";observingPhase="device-retry-select";tokenObservationStart=performance.now();
    let deviceSelect:Awaited<ReturnType<typeof cloudCall>>;
    try{deviceSelect=await cloudCall(selectPath,selectArgs,true);await syncChildObservation();}finally{await setChildDeviceStage("none");deviceStage=undefined;observingPhase=undefined;}
    expect(deviceSelect.status).toBe(200);expect(actualDeviceRegistrationCalls).toBe(1);
    const selectedDevice=await registry.assistantMcpStore().getAuthorization(device.body.user_code);
    expect(selectedDevice?.status==="selected"&&selectedDevice.tenantClientId===knownClientId&&selectedDevice.expiresAt===originalDeviceExpiry).toBe(true);
    if(!knownClientId||!heldDeviceAck)throw new Error("Successful device retry did not retain exact registration/ACK");
    const actualDeviceRows=await db.select({id:mcpOauthDeviceRequests.id,status:mcpOauthDeviceRequests.status,resource:mcpOauthDeviceRequests.resource,ingress:mcpOauthDeviceRequests.ingressOwner}).from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.clientId,knownClientId)).limit(2);
    expect(actualDeviceRows).toHaveLength(1);expect(actualDeviceRows[0]?.status==="pending"&&actualDeviceRows[0].resource===resource&&actualDeviceRows[0].ingress==="cloud").toBe(true);
    expect(deviceWire.filter(value=>value.route==="register")).toHaveLength(1);
    expect(deviceAckChecks.filter(value=>value.stage==="retry-select")).toEqual([{stage:"retry-select",result:"fulfilled"}]);expect(pendingDeviceAckCheckObservers).toBe(0);
    expect(deviceWire.some(value=>value.stage==="retry-select"&&value.route==="device-mint"&&value.status===200)).toBe(true);
    expect(deviceWireOverflow).toBe(0);expect(deviceObserverFailures).toBe(0);expect(tokenObservationOverflow).toBe(0);expect(gateObservationOverflow).toBe(0);expect(gateObserverFailures).toBe(0);expect(pendingGateObservers).toBe(0);
    deviceRetryEvidence={firstStatus:503,retryStatus:200,registrationCalls:actualDeviceRegistrationCalls,sameClient:selectedDevice?.tenantClientId===knownClientId,originalExpiryUnchanged:selectedDevice?.expiresAt===originalDeviceExpiry,
      zeroInnerAuthorizationsBeforeRetry:true,pendingInnerAuthorizationsAfterRetry:actualDeviceRows.length,ackRevision:heldDeviceAck.revision,ackGeneration:heldDeviceAck.generation,heldExactDcrRevision:true,scopeValidated:true};
    const deviceLocation=new URL(deviceSelect.body.redirectUrl),upstreamUserCode=deviceLocation.searchParams.get("user_code")??new URL(deviceLocation.searchParams.get("returnTo")!,origin).searchParams.get("user_code");expect(upstreamUserCode).toBeTruthy();
    const approved=await boardPost("/api/mcp/device/consent").set("Origin",origin).set("x-selected-operator",userId).send({userCode:upstreamUserCode,decision:"approve",companyId,allowWrites:false});expect(approved.status).toBe(200);
    await pause(device.body.interval*1000+1);const deviceToken=await cloudCall("/mcp/runner/oauth/token",{grant_type:DEVICE_GRANT,client_id:clientId,resource,device_code:device.body.device_code});expect(deviceToken.status).toBe(200);expect(deviceToken.body.access_token).toMatch(/^pcm1\./);
    expect((await cloudCall("/mcp/runner/oauth/revoke",{client_id:clientId,resource,token:deviceToken.body.refresh_token})).status).toBe(200);
    const subscription={name:"paperclip.dot.mailbox_updated",arguments:{companyId,bindingId:pairing.body.bindingId},delivery:{mode:"webhook",url:callbackPublicOrigin+"/events",secret:callbackSecret}};
    await syncChildObservation();expect(eventTransportCounts.factoryOwners).toBe(appOwnerGenerations);
    const subscribed=await rpc(raw,"events/subscribe",subscription);
    const rpcError=z.object({code:z.number().int(),message:z.string().max(300),data:z.unknown().optional()}).strict().safeParse(subscribed.body?.error);
    const error:SubscriptionWitness["error"]=subscribed.body?.error===undefined&&subscribed.status===200?"none":!rpcError.success?"unclassified":rpcError.data.code===-32602&&rpcError.data.message==="Hosted Dot subscription authority is unavailable."?"hosted-authority-unavailable":rpcError.data.message==="Callback endpoint is unavailable."?"invalid-destination":rpcError.data.message==="Callback verification failed."?"callback-verification-failed":"unclassified";
    subscriptionWitness={status:subscribed.status,rpcCode:rpcError.success&&[-32602,-32015,-32603].includes(rpcError.data.code)?rpcError.data.code:undefined,error};
    expect(subscriptionWitness).toEqual({status:200,rpcCode:undefined,error:"none"});
    await syncChildObservation();expect(eventTransportCounts.authorityRequests).toBeGreaterThan(0);expect(eventTransportCounts.callbackRequests).toBeGreaterThan(0);expect(eventTransportCounts.unexpected).toBe(0);
    await vi.waitFor(()=>expect(callbacks.length).toBeGreaterThanOrEqual(2),{timeout:10_000,interval:25});expect(callbacks[0].id).toBe(callbacks[1].id);expect(callbacks[1].at-callbacks[0].at).toBeGreaterThanOrEqual(1900);
    const inbox=await tool(raw,"paperclip_dot_inbox",{});expect(inbox.status).toBe(200);const challenge=inbox.body.result.structuredContent.result.items.find((item:{kind:string})=>item.kind==="readiness_challenge");expect(challenge).toBeTruthy();
    expect((await tool(raw,"paperclip_dot_confirm_event",{challenge:challenge.references.challenge})).body.result.isError).toBe(false);
    await vi.waitFor(async()=>{
      expect((await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id,pairing.body.bindingId)))[0].status).toBe("ready");
      const [readyAgent]=await db.select().from(agents).where(eq(agents.id,agentId));expect(readyAgent.lifecycleState).toBe("ready");expect(["active","idle"].includes(readyAgent.status)).toBe(true);
    },{timeout:10_000,interval:25});
    const environmentSelection=await request(appLoopback).patch(`/api/agents/${agentId}`).set("Host",host).set("Origin",origin).set("x-selected-operator",userId).send({defaultEnvironmentId:environment.body.id});
    expect(environmentSelection.status).toBe(200);expect(environmentSelection.body.defaultEnvironmentId).toBe(environment.body.id);
    const binary=process.env.PAPERCLIP_DOT_HOSTED_RUNNER_BINARY;
    expect(binary,"Explicit source-matched local Runner binary is required").toBeTruthy();if(!binary||!path.isAbsolute(binary))throw new Error("PAPERCLIP_DOT_HOSTED_RUNNER_BINARY must be absolute");await access(binary);
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY",binary);vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR",path.join(home,"runner-state"));vi.stubEnv("PAPERCLIP_IN_WORKTREE","false");
    if(!physicalApp)throw new Error("Missing actual normal App process/listener");
    const nativeOrigin=appLoopback;vi.stubEnv("PAPERCLIP_API_URL",nativeOrigin);vi.stubEnv("PAPERCLIP_RUNTIME_API_URL",nativeOrigin);vi.stubEnv("PAPERCLIP_LISTEN_HOST","127.0.0.1");vi.stubEnv("PAPERCLIP_LISTEN_PORT",String(new URL(nativeOrigin).port));
    expect(physicalApp.origin).toBe(nativeOrigin);
    expect((await syncChildObservation()).owner.pid).toBe(physicalApp.pid);
    const task=await issueService(db).create(companyId,{title:"Save the arithmetic report",description:"Save a report document containing 17 + 25 = 42 using the assigned Paperclip tools.",workMode:"standard",status:"todo",assigneeAgentId:agentId,createdByUserId:operatorId});
    const read=await tool(raw,"paperclip_dot_tasks",{});expect(read.status).toBe(200);expect(read.body.result.isError).toBe(false);expect(read.body.result.structuredContent.result.some((item:{id:string})=>item.id===task.id)).toBe(true);
    const admissionId=randomUUID(),requestArgs={issueId:task.id,requestId:admissionId};
    const admission=await tool(raw,"paperclip_dot_request_work",requestArgs);expect(admission.status,JSON.stringify(admission.body)).toBe(200);expect(admission.body.result.isError,JSON.stringify(admission.body)).toBe(false);
    const admissionKey=`dot-work:${pairing.body.bindingId}:${(await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id,pairing.body.bindingId)))[0].generation}:${admissionId}`;
    await vi.waitFor(async()=>{const [row]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,admissionKey));expect(row?.runId).toBeTruthy();},{timeout:30_000,interval:50});
    const changedRequest=await tool(raw,"paperclip_dot_request_work",{...requestArgs,issueId:randomUUID()});expect(changedRequest.body.result.isError).toBe(true);
    const [wake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,admissionKey));let runId=wake.runId!;
    const replay=await tool(raw,"paperclip_dot_request_work",requestArgs);expect(replay.body.result.structuredContent.result.runId).toBe(runId);expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,admissionKey))).toHaveLength(1);
    const failedRunId=runId;
    // A real offered assignment plus current durable checkpoint/header must
    // precede the fault. No useful business operation has been sent yet.
    await vi.waitFor(async()=>{
      expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId,failedRunId))).toHaveLength(1);
    },{timeout:30_000,interval:50});
    const checkpointObservationStarted=performance.now();
    let lastCheckpointOracle:{recoveryMode:Awaited<ReturnType<typeof nativeProviderRecoveryEvidence>>["recoveryMode"];
      checkpointExists:boolean;providerSessionEstablished:boolean;providerEventsExist:boolean;observedAtMs:number}|undefined;
    try {
    await vi.waitFor(async()=>{
      const evidence=await nativeProviderRecoveryEvidence({db,runId:failedRunId,
        sourceFailureCode:"native_session_interrupted",executionTargetKind:"remote"});
      lastCheckpointOracle={recoveryMode:evidence.recoveryMode,checkpointExists:evidence.checkpointExists,
        providerSessionEstablished:evidence.providerSessionEstablished,providerEventsExist:evidence.providerEventsExist,
        observedAtMs:performance.now()-checkpointObservationStarted};
      expect(evidence)
        .toMatchObject({recoveryMode:"exact_checkpoint_resume",checkpointExists:true,providerSessionEstablished:true});
    },{timeout:30_000,interval:50});
    } catch (primary) {
      // Freeze the last returned existing call at timeout: Vitest does not
      // cancel an in-flight callback when it rejects with its last error.
      const lastOracleAtCatch=lastCheckpointOracle,catchObservedAtMs=performance.now()-checkpointObservationStarted;
      let snapshotObservedAtMs:number|undefined,headerObservedAtMs:number|undefined;
      // Failure-only observation with the SAME live fixture key. Never grants
      // recovery, polls a header, or changes the original checkpoint oracle.
      let category="not_read",keyPresent=Boolean(process.env.PAPERCLIP_SECRETS_MASTER_KEY);
      let rowPresent=false,companyMatches=false,issuePresent=false,sessionPresent=false,instancePresent=false;
      let profileIsObject=false,snapshotCheckpointExists=false,snapshotProviderSessionEstablished=false,runnerBackend=false,currentFencingVersion=false,terminalStatePresent=false,terminalFailed=false,headerPresent=false,withinBound=false,directParsed=false,stagedParsed=false;
      let directRun=false,directSession=false,directInstance=false,stagedRun=false,stagedSession=false,stagedInstance=false;
      try {
        if(!keyPresent)category="live_key_missing";
        else if(activeCaseDeadline!==undefined&&performance.now()>=activeCaseDeadline)category="original_budget_exhausted";
        else {
          const [current]=await db.select({companyId:heartbeatRuns.companyId,issueId:heartbeatRuns.nativeIssueId,
            sessionId:heartbeatRuns.nativeSessionId,instanceId:heartbeatRuns.runnerInstanceId,profile:heartbeatRuns.runnerProfileJson})
            .from(heartbeatRuns).where(eq(heartbeatRuns.id,failedRunId)).limit(1);
          rowPresent=Boolean(current);companyMatches=current?.companyId===companyId;
          issuePresent=Boolean(current?.issueId);sessionPresent=Boolean(current?.sessionId);instancePresent=Boolean(current?.instanceId);
          snapshotObservedAtMs=performance.now()-checkpointObservationStarted;
          // Exact nativeProviderRecoveryEvidence record semantics, including
          // null/non-object/array -> {}. No stricter diagnostic profile schema.
          const record=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)
            ? (value as Record<string,unknown>) : {};
          const profile=record(current?.profile),checkpoint=record(profile.sessionCheckpoint),terminal=record(checkpoint.terminal);
          profileIsObject=Boolean(current?.profile)&&typeof current?.profile==="object"&&!Array.isArray(current?.profile);
          snapshotCheckpointExists=Object.keys(checkpoint).length>0;
          snapshotProviderSessionEstablished=typeof checkpoint.providerSessionId==="string"&&checkpoint.providerSessionId.length>0
            ||Object.keys(record(checkpoint.providerIdentity)).length>0;
          runnerBackend=checkpoint.backendKind==="runner";currentFencingVersion=profile.nativePreparationFencingVersion===NATIVE_PREPARATION_FENCING_VERSION;
          terminalStatePresent=terminal.runTerminalState!==undefined;terminalFailed=terminal.runTerminalState==="failed";
          if(!current||!companyMatches||!current.issueId)category="run_binding_unavailable";
          else if(activeCaseDeadline!==undefined&&performance.now()>=activeCaseDeadline)category="original_budget_exhausted";
          else {
            const header=await loadNativeRunnerCheckpointHeader(db,{companyId,issueId:current.issueId,runId:failedRunId});
            headerObservedAtMs=performance.now()-checkpointObservationStarted;
            headerPresent=header!==null;withinBound=header!==null&&Buffer.byteLength(header)<=NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES;
            if(header===null)category="header_unavailable_missing_or_decrypt";
            else if(!withinBound)category="header_oversize";
            else {
              const direct=inspectDurablePrpCheckpointHeader(header);
              const staged=inspectStagedRunAttachmentHeader(header);
              directParsed=direct!==null;stagedParsed=staged!==null;
              directRun=direct?.runId===failedRunId;directSession=Boolean(current.sessionId)&&direct?.normalizedSessionId===current.sessionId;
              directInstance=Boolean(current.instanceId)&&direct?.runnerInstanceId===current.instanceId;
              stagedRun=staged?.attachment.targetIdentity.runId===failedRunId;
              stagedSession=Boolean(current.sessionId)&&staged?.attachment.targetIdentity.normalizedSessionId===current.sessionId;
              stagedInstance=Boolean(current.instanceId)&&staged?.attachment.targetIdentity.runnerInstanceId===current.instanceId;
              category="observed";
            }
          }
        }
      }catch(observationError){category=observationError instanceof Error&&observationError.message==="native_runner_checkpoint_retired"?"header_retired":"normal_reader_failed";}
      const destination=process.env.PAPERCLIP_DOT_ACCEPTANCE_RECEIPT;
      try {
        if(!destination||!path.isAbsolute(destination))throw new Error("private_witness_destination_required");
        await writeFile(destination+".checkpoint-frontier.json",JSON.stringify({scope:"ONE failure-only live-key normal header observation",category,
          lastOracle:lastOracleAtCatch,catchObservedAtMs,snapshotObservedAtMs,headerObservedAtMs,
          keyPresent,rowPresent,companyMatches,issuePresent,sessionPresent,instancePresent,profileIsObject,snapshotCheckpointExists,snapshotProviderSessionEstablished,runnerBackend,currentFencingVersion,terminalStatePresent,terminalFailed,headerPresent,withinBound,directParsed,stagedParsed,
          directRun,directSession,directInstance,stagedRun,stagedSession,stagedInstance,
          controllerCheckpointMatches:directRun&&directSession&&directInstance||stagedRun&&stagedSession&&stagedInstance,
          noRawPayload:true,noPolling:true,originalFailureRethrown:true},null,2)+"\n",{flag:"wx",mode:0o600});
      }catch{process.stderr.write("owned_checkpoint_frontier_witness_unwritten\n");}
      throw primary;
    }
    const preFaultAssignments=await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId,failedRunId));
    expect(preFaultAssignments).toHaveLength(1);
    let assignment=preFaultAssignments[0];
    expect(assignment).toMatchObject({bindingId:pairing.body.bindingId,agentId,companyId,runId:failedRunId,status:"offered"});
    const preFaultRead=await tool(raw,"paperclip_dot_read",{assignmentId:assignment.id});
    expect(preFaultRead.status).toBe(200);expect(preFaultRead.body.result.isError).toBe(false);
    const operation=async(name:"paperclip_dot_accept"|"paperclip_dot_tool"|"paperclip_dot_finish",input:Record<string,unknown>,requestId=randomUUID(),expectedStatus:"completed"|"rejected"="completed")=>{
      const action=({paperclip_dot_accept:"accept",paperclip_dot_tool:"tool",paperclip_dot_finish:"finish"} as const)[name];
      const expectedOutcome=expectedStatus==="rejected"?"rejected":action==="accept"?"accepted":"completed";
      const sent=await tool(raw,name,{assignmentId:assignment.id,requestId,...input});expect(sent.status,JSON.stringify(sent.body)).toBe(200);expect(sent.body.result.isError,JSON.stringify(sent.body)).toBe(false);
      let receipt:Record<string,unknown>|undefined;
      await vi.waitFor(async()=>{
        const polled=await tool(raw,"paperclip_dot_operation_status",{assignmentId:assignment.id,requestId});expect(polled.status,JSON.stringify(polled.body)).toBe(200);expect(polled.body.result.isError,JSON.stringify(polled.body)).toBe(false);
        receipt=polled.body.result.structuredContent.result;expect(receipt?.status,JSON.stringify({name,requestId,receipt})).toBe(expectedOutcome);
        const rows=await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId,requestId));expect(rows).toHaveLength(1);const journal=rows[0];
        expect(journal).toMatchObject({companyId,assignmentId:assignment.id,requestId,status:expectedStatus,digest:externalOperationDigest(action,input)});
        expect(journal.command).toEqual({bindingId:assignment.bindingId,bindingGeneration:assignment.bindingGeneration,runId,normalizedSessionId:assignment.normalizedSessionId,turnId:assignment.turnId,assignmentRevision:assignment.revision,requestId,action,input,digest:externalOperationDigest(action,input)});
        expect(journal.outcome).toEqual(receipt);if(expectedStatus==="completed")expect(journal.sourceEventId).not.toBeNull();
        if(action==="accept"&&expectedStatus==="completed"){
          const [accepted]=await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id,assignment.id));
          expect(accepted).toMatchObject({companyId,agentId,bindingId:assignment.bindingId,bindingGeneration:assignment.bindingGeneration,runId,status:"accepted"});expect(accepted.acceptedAt).toBeInstanceOf(Date);
        }
      },{timeout:10_000,interval:50});return{requestId,receipt:receipt!};
    };
    // Exercise the original permission rejection at the actual pre-accept
    // frontier. No useful operation is admitted before the owned fault.
    const deniedId=randomUUID();const denied=await operation("paperclip_dot_tool",{name:"write_document",arguments:{key:"before-accept",title:"Forbidden",body:"must not exist",baseRevisionId:null,idempotencyKey:deniedId}},deniedId,"rejected");expect(denied.receipt).toMatchObject({status:"rejected"});expect(await documentService(db).getIssueDocumentByKey(task.id,"before-accept")).toBeNull();
    const preFaultAcceptId=randomUUID();
    const preFaultAccept=await operation("paperclip_dot_accept",{},preFaultAcceptId);
    const preFaultAcceptReplay=await operation("paperclip_dot_accept",{},preFaultAcceptId);
    expect(preFaultAcceptReplay.receipt).toEqual(preFaultAccept.receipt);
    expect(await documentService(db).getIssueDocumentByKey(task.id,"report")).toBeNull();
    if(!childControl)throw new Error("Missing actual installed child provider owner");
    const fault=z.object({status:z.literal("stopped"),runId:z.literal(failedRunId),providerLeaseId:z.string(),containerId:z.string(),
      kernel:z.object({pid:z.number().int().positive(),fingerprint:z.string()}).passthrough(),checkpoint:z.object({recoveryMode:z.literal("exact_checkpoint_resume")}).passthrough(),
      namespaceTerminationOnly:z.literal(true),termination:z.object({providerLeaseId:z.string(),state:z.literal("stopped")})}).strict()
      .parse((await childControl.request({command:"stop-checkpointed",runId:failedRunId,environmentId:environment.body.id},childDeadline())).result);
    expect(fault.termination).toEqual({providerLeaseId:fault.providerLeaseId,state:"stopped"});
    let failureEpisode:Record<string,unknown>|undefined;
    const historyObservationStartedAt=Date.now();
    let lastHistoryObservation:{observedAt:number;historyCount:number;retryableCount:number}|undefined;
    try {
    await vi.waitFor(async()=>{
      const [owner]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,failedRunId));
      const episodes=owner?.recoveryHistory.filter(row=>row.disposition==="retryable_failure")??[];
      lastHistoryObservation={observedAt:Date.now(),historyCount:Math.min(owner?.recoveryHistory.length??0,21),retryableCount:Math.min(episodes.length,21)};
      expect(episodes).toHaveLength(1);failureEpisode=episodes[0];
      expect(failureEpisode).toMatchObject({checkpointExists:true,providerSessionEstablished:true});
      // Observe the actual native settlement category; never substitute the
      // old local-adapter code or accept an arbitrary failure as this fault.
      expect(["native_runner_process_exited","native_session_interrupted","provider_process_exited",
        "provider_stdout_closed","provider_process_output_closed"]).toContain(failureEpisode.reason);
      expect(Date.parse(String(failureEpisode.at))).toBeGreaterThan(0);
    },{timeout:30_000,interval:50});
    } catch(primary) {
      // Failure-only timestamps/counts from the SAME existing wait callback.
      // No extra SQL, child request, retry, identity or provider observation.
      try {
        const destination=process.env.PAPERCLIP_DOT_ACCEPTANCE_RECEIPT;
        if(!destination||!path.isAbsolute(destination))throw new Error("private_witness_destination_required");
        await writeFile(destination+".recovery-history-frontier.json",JSON.stringify({version:1,
          historyObservationStartedAt,caughtAt:Date.now(),lastHistoryObservation,
          noAdditionalCalls:true,originalFailureRethrown:true})+"\n",{flag:"wx",mode:0o600});
      }catch{process.stderr.write("owned_recovery_history_witness_unwritten\n");}
      throw primary;
    }
    expect(await documentService(db).getIssueDocumentByKey(task.id,"report")).toBeNull();
    const failedAssignments=await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId,failedRunId));
    expect(failedAssignments).toHaveLength(1);
    let actualSuccessor:typeof heartbeatRuns.$inferSelect|undefined;
    const retryKey=randomUUID(),retryBody={idempotencyKey:retryKey,observedRunId:failedRunId};
    const unauthorizedRetry=await boardPost(`/api/issues/${task.id}/retry`).send(retryBody);expect(unauthorizedRetry.status).toBe(403);
    const retry=await boardPost(`/api/issues/${task.id}/retry`).set("x-selected-operator",operatorId).send(retryBody);
    expect(retry.status,JSON.stringify(retry.body)).toBe(202);
    expect(retry.body).toMatchObject({accepted:true,stale:false,observedRunId:failedRunId});expect(retry.body.requestId).toBeTruthy();
    const repeatedRetry=await boardPost(`/api/issues/${task.id}/retry`).set("x-selected-operator",operatorId).send(retryBody);
    expect(repeatedRetry.status).toBe(202);expect(repeatedRetry.body.requestId).toBe(retry.body.requestId);
    await vi.waitFor(async()=>{
      const [retryWake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,retry.body.requestId));
      expect(retryWake).toMatchObject({companyId,agentId,requestedByActorId:operatorId});
      expect(retryWake.payload).toMatchObject({issueId:task.id,taskRetry:{sourceRunId:failedRunId,actorId:operatorId}});
      expect(retryWake.runId).toBeTruthy();runId=retryWake.runId!;
      if(runId===failedRunId)expect(retryWake.status).toBe("coalesced");
      // A normal authorized Retry can admit a successor if it wins the race;
      // an automatic same-run resume can instead own the coalesced receipt.
      // Neither branch is forced by suppressing normal recovery workers.
      const [current]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));actualSuccessor=current;
      expect(current).toMatchObject({companyId,agentId});
      expect(current.status).toBe("running");
    },{timeout:30_000,interval:50});
    await vi.waitFor(async()=>{
      expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId,runId))).toHaveLength(1);
    },{timeout:30_000,interval:50});
    const successorAssignments=await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId,runId));
    assignment=successorAssignments[0];expect(assignment).toMatchObject({bindingId:pairing.body.bindingId,agentId,companyId});
    expect(["offered","accepted"]).toContain(assignment.status);
    const assigned=await tool(raw,"paperclip_dot_read",{assignmentId:assignment.id});expect(assigned.body.result.isError,JSON.stringify(assigned.body)).toBe(false);
    await operation("paperclip_dot_accept",{});expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id,assignment.id)))[0].status).toBe("accepted");
    const writeId=randomUUID(),writeArgs={name:"write_document",arguments:{key:"report",title:"Arithmetic",body:"17 + 25 = 42.",baseRevisionId:null,idempotencyKey:writeId}};
    const written=await operation("paperclip_dot_tool",writeArgs,writeId);expect(written.receipt).toMatchObject({status:"completed",isError:false});expect((await documentService(db).getIssueDocumentByKey(task.id,"report"))?.body).toBe("17 + 25 = 42.");
    const writeJournals=await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId,writeId));const journal=writeJournals[0];expect(journal).toMatchObject({assignmentId:assignment.id,companyId,status:"completed",digest:externalOperationDigest("tool",writeArgs)});expect(journal.outcome).toMatchObject({status:"completed",isError:false});expect(journal.command).toMatchObject({bindingId:assignment.bindingId,bindingGeneration:assignment.bindingGeneration,runId,normalizedSessionId:assignment.normalizedSessionId,turnId:assignment.turnId,assignmentRevision:assignment.revision,requestId:writeId,action:"tool",input:writeArgs});
    expect((await operation("paperclip_dot_tool",writeArgs,writeId)).receipt).toEqual(written.receipt);expect(await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId,writeId))).toHaveLength(1);
    const conflict=await tool(raw,"paperclip_dot_tool",{assignmentId:assignment.id,requestId:writeId,...writeArgs,arguments:{...writeArgs.arguments,body:"changed"}});expect(conflict.body.result.isError).toBe(true);expect((await documentService(db).getIssueDocumentByKey(task.id,"report"))?.body).toBe("17 + 25 = 42.");
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));const [contract]=await db.select().from(completionContracts).where(eq(completionContracts.id,run.completionContractId!));const specification=z.object({revision:z.string(),criteria:z.array(z.object({id:z.string()}))}).passthrough().parse(contract.contractJson);
    const result={reportedWorkDisposition:"completed",summary:"Saved the arithmetic report.",completionClaim:{contractRevision:specification.revision,objectiveSatisfied:true,criteria:specification.criteria.map(criterion=>({criterionId:criterion.id,status:"passed",evidenceRefs:[]})),remainingWork:[]},evidence:[],verification:[{commandOrCheck:"Read the persisted report: 17 + 25 = 42.",status:"pass"}]};
    expect((await operation("paperclip_dot_tool",{name:"paperclip_finish",arguments:result})).receipt).toMatchObject({status:"completed",isError:false});
    await operation("paperclip_dot_finish",{result});await childControl!.request({command:"drain-run",runId},childDeadline());
    const [settledAssignment]=await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id,assignment.id));expect(settledAssignment.status).toBe("settled");const successorResults=await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId,runId));expect(successorResults).toHaveLength(1);const [settledTask]=await db.select().from(issues).where(eq(issues.id,task.id));expect(settledTask.status).toBe("done");
    const passiveConnectionSnapshot=async(deadline=childDeadline())=>{
      const child=await syncChildObservation(deadline),all=[...retiredChildren,child];
      return{clients:databaseObservation.clients+all.reduce((n,v)=>n+v.database.clients,0),
        opened:databaseObservation.connectionsOpened+all.reduce((n,v)=>n+v.database.opened,0),
        closed:databaseObservation.connectionsClosed+all.reduce((n,v)=>n+v.database.closed,0),
        live:databaseObservation.liveConnections.size+all.reduce((n,v)=>n+v.database.connections,0),
        dedicated:databaseObservation.dedicatedOpen+all.reduce((n,v)=>n+v.database.dedicated,0),
        listeners:databaseObservation.listenersOpen+all.reduce((n,v)=>n+v.database.listeners,0)};
    };
    const totalTenantSnapshot=async(deadline=childDeadline())=>{
      const connections=await passiveConnectionSnapshot(deadline);
      const all=[...retiredChildren,childSnapshot!];
      if(!storageProxy)throw new Error("Missing normal owned object-store observation");
      expect(storageProxy.counts().injected).toBe(0);
      return{queryCount:databaseObservation.queries+all.reduce((n,v)=>n+v.database.queries,0),callbacks:callbacks.length,connections,objectStoreRequests};
    };
    const awaitPassiveConnectionClosure=async(deadline:number)=>{
      expect(databaseObservation.connectionsOpened).toBeGreaterThan(0);
      const remaining=deadline-performance.now();expect(remaining,"Original15-second settlement includes all used transports").toBeGreaterThan(0);
      await vi.waitFor(async()=>{
        const connections=await passiveConnectionSnapshot(deadline);
        expect(childSnapshot!.database.opened).toBeGreaterThan(0);expect(childSnapshot!.database.queries).toBeGreaterThan(0);
        expect(connections.live).toBe(0);expect(connections.dedicated).toBe(0);expect(connections.listeners).toBe(0);
        expect(connections.closed).toBe(connections.opened);
      },{timeout:remaining,interval:25});
    };
    const inspect=async(deadline=childDeadline())=>{
      const value=(await childControl!.request({command:"inspect"},deadline)).result;
      return z.object({frontDoor:z.object({blocked:z.boolean()}).passthrough(),subscriptions:z.object({blocked:z.boolean()}).passthrough(),
        schedule:z.object({blocked:z.boolean()}).passthrough()}).passthrough().parse(value);
    };
    const settleActualOwners=async(deadline:number)=>{
      await vi.waitFor(async()=>{
        const child=await syncChildObservation(deadline);
        expect(child.owner.taskDrain).toMatchObject({activeRuns:0,pendingWakes:0,quiescent:true});
        expect(child.owner.worker.active+idleWorkSnapshot().active).toBe(0);
        expect(child.owner.errorCount).toBe(0);expect(child.owner.unexpectedDecisionWakes).toBe(0);
        expect(child.database.observerPending).toBe(0);expect(child.database.observerFailures).toBe(0);expect(child.database.overflow).toBe(0);
        const childReadBefore=child.database.queries;
        const proof=await inspect(deadline);
        expect((await syncChildObservation(deadline)).database.queries).toBeGreaterThan(childReadBefore);
        expect(proof.frontDoor.blocked).toBe(false);expect(proof.subscriptions.blocked).toBe(false);expect(proof.schedule.blocked).toBe(false);
        expect((await db.select().from(mcpEventDeliveries)).every(row=>row.finishedAt!==null)).toBe(true);
      },{timeout:deadline-performance.now(),interval:25});
    };
    const firstSettlementDeadline=performance.now()+15_000;
    await settleActualOwners(firstSettlementDeadline);
    const beforeRead=databaseObservation.queries;expect((await documentService(db).getIssueDocumentByKey(task.id,"report"))?.body).toBe("17 + 25 = 42.");expect(databaseObservation.queries).toBeGreaterThan(beforeRead);
    await awaitPassiveConnectionClosure(firstSettlementDeadline);
    const before=await totalTenantSnapshot();let quietAfter:typeof before|undefined;const quietTraceStart=performance.now();
    // No SQL observer or child IPC request during this strict window. Only the
    // original actual tenant/Cloud owners can change the passive counters.
    await pause(15_000);const quietTraceEnd=performance.now();quietAfter=await totalTenantSnapshot();
    expect(quietAfter).toEqual(before);expect(errors).toEqual([]);
    // The normal owner route acquires the signed tenant idle hold, reads the
    // real current mirror/admission and calls the existing provider stop owner.
    // This is controlled local provider/HTTP availability, not deployed suspension.
    const sleepResponse=await cloudCall(`/v1/stacks/${slug}/sleep`,{reason:"idle"},true);expect(sleepResponse.status).toBe(200);
    expect(await registry.getStack(stackId)).toMatchObject({lifecycleState:"sleeping",sleepState:"sleeping",sleepReason:"idle"});
    const idleAdmission=await registry.readIdleMcpWakeAdmission(stackId);expect(idleAdmission).toBeTruthy();
    const admissionDigest=createHash("sha256").update(JSON.stringify(idleAdmission)).digest("hex");
    const [preWakeBinding]=await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id,pairing.body.bindingId));
    await setChildHealth("wake-once-then-unavailable");
    const failedReadiness=await tool(raw,"paperclip_dot_tasks",{});expect(failedReadiness.status).toBe(503);expect(failedReadiness.body).toMatchObject({error:"temporarily_unavailable"});
    await syncChildObservation();expect(readinessStatuses[0]).toBe(200);expect(readinessStatuses.some(status=>status===503)).toBe(true);expect(readinessOverflow).toBe(0);
    // Provider readiness has legitimately settled awake, but the original
    // credential request was refused by the real entry HTTP readiness owner.
    // Retry the same wrapped credential; do not mint or publish new authority.
    expect(await registry.getStack(stackId)).toMatchObject({lifecycleState:"active",sleepState:"awake"});
    await setChildHealth("ready");
    const readyRetry=await tool(raw,"paperclip_dot_tasks",{});expect(readyRetry.status).toBe(200);expect(readyRetry.body.result.isError).toBe(false);
    const [postWakeBinding]=await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id,pairing.body.bindingId));
    expect(postWakeBinding).toMatchObject({id:preWakeBinding.id,generation:preWakeBinding.generation,grantId:originalGrant.id,status:"ready"});
    expect((await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,originalGrant.id)))[0].revokedAt).toBeNull();
    wakeEvidence={sleepStatus:sleepResponse.status,failedReadinessStatus:failedReadiness.status,retryStatus:readyRetry.status,admissionDigest,grantId:originalGrant.id,bindingGeneration:postWakeBinding.generation,healthStatuses:[...readinessStatuses],overflow:readinessOverflow};
    const firstBindingSnapshot=(await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id,pairing.body.bindingId)))[0];
    const callbackCountBeforeRestart=callbacks.length;
    if(!physicalApp)throw new Error("Missing first physical App generation");
    let resumedBefore:Awaited<ReturnType<typeof totalTenantSnapshot>>|undefined,resumedAfter:typeof resumedBefore;
    let resumedElapsed=0;
    physicalFollowon=await usefulAfterPhysicalRestart({get db(){return db;},companyId,agentId,first:physicalApp,get cloudLoopback(){return cloudLoopback;},
      caseDeadline:caseStarted+90_000,
      startSecond:async()=>{
        // First real Node/group closed before this new child can be started.
        await db.$client.end({timeout:1});await closeRegisteredClients(url!,{scope:"database"});
        await makePhysicalSecond();
        await reconstructCloudOwner();
        expect(appOwnerGenerations).toBe(2);expect(cloudOwnerGenerations).toBe(2);
        const restoredBinding=(await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id,pairing.body.bindingId)))[0];
        expect(restoredBinding).toMatchObject({id:firstBindingSnapshot.id,companyId,agentId,grantId:originalGrant.id,generation:firstBindingSnapshot.generation,status:"ready"});
        expect((await documentService(db).getIssueDocumentByKey(task.id,"report"))?.body).toBe("17 + 25 = 42.");
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId,runId))).toHaveLength(1);
        const refreshed=await cloudCall("/mcp/runner/oauth/token",{grant_type:"refresh_token",client_id:clientId,resource,refresh_token:tokens.body.refresh_token});expect(refreshed.status).toBe(200);
        raw=refreshed.body.access_token;expect(raw).toMatch(/^pcm1\./);
        const afterRestart=await rpc(raw,"events/subscribe",subscription);expect(afterRestart.status).toBe(200);
        expect(callbacks.length).toBeGreaterThanOrEqual(callbackCountBeforeRestart);
        if(!physicalApp)throw new Error("Second real child did not start");return physicalApp;
      },
      createTask:async body=>{const response=await boardPost(`/api/companies/${companyId}/issues`).set("x-selected-operator",operatorId).send(body);return{status:response.status,body:response.body};},
      tool:async(name,args,ownedOrigin)=>{
        if(!ownedOrigin){const response=await tool(raw,name,args);return{status:response.status,body:response.body};}
        const selected=new URL(ownedOrigin);expect(selected.protocol).toBe("http:");expect(selected.hostname).toBe("127.0.0.1");
        // Same actual wrapped credential, virtual tenant Host, protocol and RPC
        // body through the ONE owned lost-response proxy. No retry/new requestID.
        const response=await request(ownedOrigin).post("/mcp/runner").set("Host",host).set("Authorization","Bearer "+raw)
          .set("Accept","application/json, text/event-stream").set("mcp-protocol-version","2026-07-28").set("mcp-method","tools/call").set("mcp-name",name)
          .send({jsonrpc:"2.0",id:++serial,method:"tools/call",params:{name,arguments:args,_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{events:{}}}}});
        return{status:response.status,body:response.body};
      },
      assertPassiveQuiet:async duration=>{
        const resumedSettlementDeadline=performance.now()+15_000;
        await settleActualOwners(resumedSettlementDeadline);await awaitPassiveConnectionClosure(resumedSettlementDeadline);
        resumedBefore=await totalTenantSnapshot();const resumedStart=performance.now();
        await pause(duration);resumedElapsed=performance.now()-resumedStart;resumedAfter=await totalTenantSnapshot();
        expect(resumedElapsed).toBeGreaterThanOrEqual(15_000);expect(resumedAfter).toEqual(resumedBefore);expect(errors).toEqual([]);
      },
    });
    const [retainedFailure]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,failedRunId));
    expect(retainedFailure).toMatchObject({id:failedRunId,companyId,agentId});
    const [retainedOwner]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,failedRunId));
    expect(retainedOwner.recoveryHistory.filter(row=>row.disposition==="retryable_failure")).toEqual([failureEpisode]);
    if(runId===failedRunId)expect(retainedFailure.status).toBe("succeeded");
    else expect(retainedFailure.status).toBe("failed");
    const failedResults=await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId,failedRunId));expect(failedResults).toHaveLength(runId===failedRunId?1:0);
    const retryReceipts=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,`task-retry:${retryKey}`));
    expect(retryReceipts).toHaveLength(1);expect(retryReceipts[0].runId).toBe(runId);
    if(runId===failedRunId)expect(retryReceipts[0].status).toBe("coalesced");
    const subscriptionsBefore=await db.select().from(mcpEventSubscriptions);
    const wrongBinding=await rpc(raw,"events/subscribe",{...subscription,arguments:{companyId,bindingId:randomUUID()}});expect(wrongBinding.status).toBe(400);expect(wrongBinding.body.error).toMatchObject({code:-32602,message:"Invalid arguments or unavailable authority."});expect(await db.select().from(mcpEventSubscriptions)).toEqual(subscriptionsBefore);
    const revoked=await request(appLoopback).delete(`/api/companies/${companyId}/agents/${agentId}/dot-binding`).set("Host",host).set("Origin",origin).set("x-selected-operator",userId);expect(revoked.status).toBe(204);
    const revokedTasks=await tool(raw,"paperclip_dot_tasks",{});expect(revokedTasks.status).toBe(503);expect(revokedTasks.body).toMatchObject({error:"temporarily_unavailable"});
    const revokedOperation=await tool(raw,"paperclip_dot_operation_status",{assignmentId:assignment.id,requestId:writeId});expect(revokedOperation.status).toBe(503);expect(revokedOperation.body).toMatchObject({error:"temporarily_unavailable"});
    const revokedFreshOperation=await tool(raw,"paperclip_dot_operation_status",{assignmentId:physicalFollowon.assignmentId,requestId:physicalFollowon.requestId});
    expect(revokedFreshOperation.status).toBe(503);expect(revokedFreshOperation.body).toMatchObject({error:"temporarily_unavailable"});
    expect((await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.id,pairing.body.bindingId)))[0].generation).toBeGreaterThan(1);
    expect((await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,originalGrant.id)))[0].revokedAt).not.toBeNull();
    await syncChildObservation();expect(eventTransportCounts.factoryOwners).toBe(appOwnerGenerations);expect(eventTransportCounts.unexpected).toBe(0);
    expect(deviceRetryEvidence).toMatchObject({firstStatus:503,retryStatus:200,registrationCalls:1,sameClient:true,originalExpiryUnchanged:true,zeroInnerAuthorizationsBeforeRetry:true,pendingInnerAuthorizationsAfterRetry:1,heldExactDcrRevision:true,scopeValidated:true});
    const evidencePath=process.env.PAPERCLIP_DOT_ACCEPTANCE_RECEIPT;
    if(!evidencePath)throw new Error("Explicit owned Dot acceptance receipt path required");
    await writeFile(evidencePath,JSON.stringify({
      version:1,scope:"controlled-normal-hosted-Dot-useful-retry",companyId,agentId,taskId:task.id,
      retryHttpStatus:retry.status,retryBranch:runId===failedRunId?"normal-native-resume-retry-coalesced":"authorized-retry-successor",
      originalFailureEpisode:failureEpisode,ownedFault:fault,recoveryIdentity:runId===failedRunId?"same-run-native-resume":"authorized-retry-successor",
      originalRun:{id:failedRunId,status:retainedFailure.status,errorCode:retainedFailure.errorCode,runtimeMode:retainedFailure.runtimeMode,
        nativeSessionPresent:retainedFailure.nativeSessionId!==null,assignmentCount:failedAssignments.length,resultCount:failedResults.length,
        costAccountingPending:retainedFailure.costAccountingPending},
      successor:{id:runId,companyId:actualSuccessor?.companyId,agentId:actualSuccessor?.agentId,issueId:actualSuccessor?.issueId,
        retryOfRunId:actualSuccessor?.retryOfRunId,invocationSource:actualSuccessor?.invocationSource,
        assignmentCount:successorAssignments.length,assignmentStatus:settledAssignment.status,resultCount:successorResults.length,taskStatus:settledTask.status},
      operation:{requestId:writeId,journalCount:writeJournals.length,journalStatus:journal.status,sourceEventPresent:journal.sourceEventId!==null},
      quiet:{elapsedMs:quietTraceEnd-quietTraceStart,queryCountBefore:before.queryCount,queryCountAfter:quietAfter?.queryCount,objectStoreRequestsBefore:before.objectStoreRequests,objectStoreRequestsAfter:quietAfter?.objectStoreRequests,
        callbackCountBefore:before.callbacks,
        callbackCountAfter:quietAfter?.callbacks,connectionCountsBefore:before.connections,connectionCountsAfter:quietAfter?.connections,allCreatedClientsObserved:before.connections.clients,closedDedicatedOwners:before.connections.dedicated,closedListenerOwners:before.connections.listeners},
      managedStorage:{normalMinio:true,requests:objectStoreRequests,proxyInjected:storageProxy?.counts().injected,preservedAcrossAppProcessRestart:true,providerDeploymentProof:false},
      errorsCount:errors.length,revocationChecksCompleted:true,
      successorAccounting:{finalRecorded:false,reason:"No added post-settlement accounting query; original443had no final accounting assertion"},
      reconstruction:{appOwners:appOwnerGenerations,cloudOwners:cloudOwnerGenerations,newDbOwners:true,fullProcessRestart:true,physicalRestart:{first:physicalFollowon.firstIdentity,second:physicalFollowon.secondIdentity},freshUseful2:{taskId:physicalFollowon.taskId,runId:physicalFollowon.runId,assignmentId:physicalFollowon.assignmentId,requestId:physicalFollowon.requestId,lostCommittedReply:physicalFollowon.committedReplyLoss},masterKeyProvider:"controlled provider port retained outside reconstructed owners",quiet:{elapsedMs:resumedElapsed,before:resumedBefore,after:resumedAfter}},
      controlledNormalAppCloud:true,hostedCredentialWake:wakeEvidence,originalGrantId:originalGrant.id,codeAndDeviceVerified:true,deviceSelectionRetry:deviceRetryEvidence,eventTransport:{...eventTransportCounts,scope:"controlled exact-owned virtual HTTP; production DNS/peer/SSRF NOT qualified"},subscriptionWitness,fullDotMirrorVerified:true,
    }),{mode:0o600});
    casePassed=true;
  },90_000);
});
