// PRIVATE UNRUN extraction of the SAME v4 normal App owner graph.
// Target: server/src/__tests__/helpers/owned-linux/normal-app-generation.ts
import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { createDb, closeRegisteredClients, authUsers, agents } from "@paperclipai/db";
import { prepareOwnedLinuxDistribution } from "./normal-distribution-bootstrap.js";
import { heartbeatService } from "../../../services/heartbeat.js";
import { setupRunnerPrpWebSocketServer } from "../../../realtime/runner-prp-ws.js";
import { migrateCloudConfiguration } from "../../../services/cloud-configuration-migration.js";
import { initializeAdapterSettings } from "../../../services/adapter-settings.js";
import { initializeCloudRuntimeConfig } from "../../../services/cloud-runtime-config.js";
import { createCloudWarmStandby } from "../../../services/cloud-warm-standby.js";
import { getCloudRuntimeIdentity, initializeCloudRuntimeIdentity, resetCloudRuntimeIdentityForTests, resetCloudControlReplayFenceForTests } from "../../../services/cloud-runtime-identity.js";
import { createStorageService } from "../../../storage/service.js";
import { createLocalDiskStorageProvider } from "../../../storage/local-disk-provider.js";
import { isIdleTaskDrainActive, idleWorkSnapshot } from "../../../services/task-admission.js";
import { registerNativeCancellationDelivery } from "../../../services/native-runtime/native-cancellation-delivery.js";
import { registerNativeRuntimeResponseDelivery } from "../../../services/native-runtime/native-runtime-response-delivery.js";
import { registerNativeCleanupReleaseWake } from "../../../services/native-runtime/native-cleanup-release-wake.js";
import { registerCostAccountingWork, registerBudgetEnforcementWork } from "../../../services/budget-enforcement-worker.js";
import { deliverBudgetResumeContinuations, type BudgetResumeDelivery } from "../../../services/budget-resume-continuation.js";
import type { Socket } from "node:net";

export async function startNormalDotAppGeneration(input: {
  databaseUrl: string; home: string; origin: string; userId: string; companyId: string; generation: number;
  linuxInput: Parameters<typeof prepareOwnedLinuxDistribution>[0];
  health: () => "ready"|"unavailable"|"wake-once-then-unavailable";
  consumedWakeHealth: () => void;
}) {
  const errors: unknown[]=[]; let unexpectedDecisionWakes=0,sessionCalls=0;
  const healthStatuses:number[]=[];let healthOverflow=0;
  const linuxBootstrap=await prepareOwnedLinuxDistribution(input.linuxInput);
  const db=createDb(input.databaseUrl,{maxConnections:2,applicationName:"dot-principal-normal-app"});
  const nativeSockets=new Set<Socket>();
  let dispatchWork:ReturnType<ReturnType<typeof heartbeatService>["registerRunDispatchWork"]>|undefined;
  let stopBudgetOwners:(()=>Promise<void>)|undefined;
  let app:Awaited<ReturnType<typeof import("../../../app.js")["createApp"]>>|undefined;
  let owner:ReturnType<typeof heartbeatService>|undefined;
  let appServer:ReturnType<typeof createServer>|undefined;
  let stopping:Promise<void>|undefined;
  const stop=()=>stopping??=(async()=>{
    // Same real owner order, with no signals or broad process cleanup. A child
    // must not exit0 until all normal execution/plugin/DB/socket owners close.
    await dispatchWork?.stop();
    if(owner){
      const ownedAgents=await db.select({id:agents.id}).from(agents).where(eq(agents.companyId,input.companyId));
      await owner.stopInvocationsForAgents(ownedAgents.map(agent=>agent.id),"Owned physical App generation shutdown");
      await owner.drainActiveRunExecutions();
    }
    await stopBudgetOwners?.();await app?.locals.paperclipShutdown?.();
    await linuxBootstrap.workerManager.stopAll();
    if(appServer){
      const joins=[...nativeSockets].map(socket=>once(socket,"close"));
      await Promise.all([new Promise<void>((resolve,reject)=>appServer!.close(error=>error?reject(error):resolve())),...joins]);
    }
    assert.equal(nativeSockets.size,0,"all actual owned close events must be joined");
    await db.$client.end({timeout:1});await closeRegisteredClients(input.databaseUrl,{scope:"database"});
    assert.equal(unexpectedDecisionWakes,0);assert.deepEqual(errors,[]);
  })();
  try{
    await migrateCloudConfiguration(db);await initializeAdapterSettings(db);await initializeCloudRuntimeConfig(db);
    resetCloudRuntimeIdentityForTests();resetCloudControlReplayFenceForTests();await initializeCloudRuntimeIdentity(db);
    const standby=await createCloudWarmStandby(db);assert.equal(standby(),input.generation===1);
    const {createApp}=await import("../../../app.js");
    const budgetResumeDelivery:BudgetResumeDelivery={};
    app=await createApp(db,{...linuxBootstrap.appOptions,budgetResumeDelivery,uiMode:"none",serverPort:3100,
      storageService:createStorageService(createLocalDiskStorageProvider(path.join(input.home,"objects"))),
      deploymentMode:"authenticated",deploymentExposure:"private",bindHost:"127.0.0.1",allowedHostnames:[new URL(input.origin).hostname],
      authPublicBaseUrl:input.origin,authReady:true,companyDeletionEnabled:false,cloudWarmStandby:standby,
      decisionServiceOptions:{wakeOriginAgent:async()=>{unexpectedDecisionWakes++;throw new Error("Unexpected Decision dependency in closed Dot journey");}},
      resolveSession:async req=>{sessionCalls++;if(req.get("x-selected-operator")!==input.userId)return null;
        const [user]=await db.select().from(authUsers).where(eq(authUsers.id,input.userId));
        return user?{session:{id:"principal-hop-session",userId:input.userId},user}:null;}});
    await app.locals.bundledPluginsStartup;
    const actualApp=app;
    appServer=createServer((req,res)=>{
      if(req.method==="GET"&&(req.url??"").split("?",1)[0]==="/api/health"&&input.health()!=="ready"){
        if(healthStatuses.length<32)res.once("finish",()=>healthStatuses.push(res.statusCode));else healthOverflow++;
        if(input.health()==="wake-once-then-unavailable")input.consumedWakeHealth();
        else{res.writeHead(503,{"content-type":"application/json"}).end(JSON.stringify({status:"unavailable"}));return;}
      }
      actualApp(req,res);
    });
    appServer.on("connection",socket=>{nativeSockets.add(socket);socket.once("close",()=>nativeSockets.delete(socket));});
    setupRunnerPrpWebSocketServer(appServer);
    await new Promise<void>((resolve,reject)=>{appServer!.once("error",reject);appServer!.listen(0,"127.0.0.1",resolve);});
    const address=appServer.address();assert(address&&typeof address!=="string");
    const origin=`http://127.0.0.1:${address.port}`;
    Object.assign(process.env,{PAPERCLIP_API_URL:origin,PAPERCLIP_RUNTIME_API_URL:origin,PAPERCLIP_LISTEN_HOST:"127.0.0.1",PAPERCLIP_LISTEN_PORT:String(address.port)});
    const coordinator=app.locals.deliveryWork;assert(coordinator&&typeof coordinator.register==="function");
    const normalOwner=heartbeatService(db,{pluginWorkerManager:linuxBootstrap.workerManager});owner=normalOwner;
    const canRun=()=>!isIdleTaskDrainActive()&&!standby();
      await normalOwner.registerResidualRecoveryWork(coordinator,canRun).ready;
      await normalOwner.registerActiveRunSilenceWork(coordinator,canRun).ready;
      await normalOwner.registerIssueStateRecoveryWork(coordinator,canRun).ready;
      dispatchWork=normalOwner.registerRunDispatchWork(coordinator,canRun);await dispatchWork.ready;
      registerNativeCancellationDelivery(db,coordinator);registerNativeRuntimeResponseDelivery(db,coordinator);
      const release=registerNativeCleanupReleaseWake(db,error=>{errors.push(error);});appServer.once("close",release);
      await normalOwner.registerDeferredReceiptWork(coordinator,canRun).ready;
      await normalOwner.registerScheduledRetryCancellationWork(coordinator,canRun).ready;
      await normalOwner.registerCapturedInstructionCommitWork(coordinator,canRun).ready;
      await normalOwner.registerInstructionDirectoryCleanupWork(coordinator,canRun).ready;
      await normalOwner.registerNativeWorkspaceFinalizationWork(coordinator,canRun).ready;
      await normalOwner.registerRetainedNativeSessionCleanupWork(coordinator,canRun).ready;
      await normalOwner.registerExternalConversationSettlementWork(coordinator,canRun).ready;
      await normalOwner.registerNativeRecoveryNoticeWork(coordinator,canRun).ready;
      await normalOwner.registerNativeEnvironmentSettlementWork(coordinator,canRun).ready;
      await normalOwner.registerNativeRunProjectionWork(coordinator,canRun).ready;
      await normalOwner.registerNativeResultCommitWork(coordinator,canRun).ready;
      await normalOwner.registerNativeStatusReassessmentWork(coordinator,canRun).ready;
      await normalOwner.registerNativeReviewResponseWork(coordinator,canRun).ready;
      await normalOwner.registerNativeResponsePresentationWork(coordinator,canRun).ready;
      await normalOwner.registerNativePendingEffectWork(coordinator,canRun).ready;
      await normalOwner.registerUnsafeWorkspaceExportWork(coordinator,canRun).ready;
      await normalOwner.registerAutomaticCompletionReviewWork(coordinator,canRun).ready;
      await normalOwner.registerObsoletePolicyReviewWork(coordinator,canRun).ready;
      await normalOwner.registerCancelledWorkspacePreservationWork(coordinator,canRun).ready;
      await normalOwner.registerStoppedInstructionCollectionWork(coordinator,canRun).ready;
      const enforcement=registerBudgetEnforcementWork(db,coordinator,{cancelWorkForScope:normalOwner.cancelBudgetScopeWork,
        deliverResumeContinuations:()=>deliverBudgetResumeContinuations(db,{...budgetResumeDelivery,resumeTaskRetry:(company,request)=>normalOwner.resumeTaskRetry(company,request)})});
      const accounting=registerCostAccountingWork(db,coordinator,normalOwner.reconcileCostAccounting);
      stopBudgetOwners=async()=>{try{await enforcement.stop();}finally{await accounting.stop();}};
      await enforcement.ready;await accounting.ready;

    return {origin,db,heartbeat:owner,workerManager:linuxBootstrap.workerManager,stop,
      snapshot:()=>({pid:process.pid,worker:idleWorkSnapshot(),taskDrain:owner!.getTaskDrainStatus(),nativeSockets:nativeSockets.size,
        unexpectedDecisionWakes,errorCount:errors.length,sessionCalls,healthStatuses:[...healthStatuses],healthOverflow,
        runtimeIdentity:{stackId:getCloudRuntimeIdentity()?.stackId,canonicalOrigin:getCloudRuntimeIdentity()?.canonicalOrigin}})};
  }catch(primary){try{await stop();}catch(cleanup){throw new AggregateError([primary,cleanup],"normal_dot_child_start_cleanup_failed");}throw primary;}
}
