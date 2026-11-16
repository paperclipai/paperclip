// PRIVATE UNRUN extraction of the SAME v4 normal App owner graph.
// Target: server/src/__tests__/helpers/owned-linux/normal-app-generation.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadConfig } from "../../../config.js";
import { logger } from "../../../middleware/logger.js";
import { instanceSettingsService } from "../../../services/instance-settings.js";
import { createDatabaseBackupOwner } from "../../../services/database-backup-owner.js";
import { registerDatabaseBackupWork } from "../../../services/database-backup-work.js";
import { idleBackupWakeMarker } from "../../../services/idle-database-backup.js";
import { markIdleStartupComplete } from "../../../services/idle-local-work.js";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { DELIVERY_QUEUES } from "../../../services/delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../../../services/delivery-work-coordinator.js";
import { createDb, closeRegisteredClients, authUsers, agents } from "@paperclipai/db";
import { prepareOwnedLinuxDistribution } from "./normal-distribution-bootstrap.js";
import { heartbeatService } from "../../../services/heartbeat.js";
import { registerEnvironmentCleanupWork } from "../../../services/environment-cleanup-work.js";
import { setupRunnerPrpWebSocketServer } from "../../../realtime/runner-prp-ws.js";
import { migrateCloudConfiguration } from "../../../services/cloud-configuration-migration.js";
import { initializeAdapterSettings } from "../../../services/adapter-settings.js";
import { initializeCloudRuntimeConfig } from "../../../services/cloud-runtime-config.js";
import { createCloudWarmStandby } from "../../../services/cloud-warm-standby.js";
import { getCloudRuntimeIdentity, initializeCloudRuntimeIdentity, resetCloudRuntimeIdentityForTests, resetCloudControlReplayFenceForTests } from "../../../services/cloud-runtime-identity.js";
import { getStorageService } from "../../../storage/index.js";
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
  const nativeTrace:Array<{at:number;event:string;value?:number|boolean|null}>=[];let nativeTraceDropped=0;
  const nativeEventCounts={registered:0,run_enter:0,run_fulfilled:0,run_rejected:0,has_pending:0,settled:0,next_run_at:0};
  let nativeGate:{at:number;allowed:boolean;taskDrain:boolean;warmStandby:boolean|null}|undefined;
  const recordNative=(event:keyof typeof nativeEventCounts,value?:number|boolean|null)=>{
    nativeEventCounts[event]++;nativeTrace.push({at:Date.now(),event,...(value===undefined?{}:{value})});
    if(nativeTrace.length>32){nativeTrace.shift();nativeTraceDropped++;}
  };
  const healthStatuses:number[]=[];let healthOverflow=0;
  const linuxBootstrap=await prepareOwnedLinuxDistribution(input.linuxInput);
  const db=createDb(input.databaseUrl,{maxConnections:2,applicationName:"dot-principal-normal-app"});
  let stopDatabaseBackups:(()=>Promise<void>)|undefined;
  const nativeSockets=new Set<Socket>();
  let dispatchWork:ReturnType<ReturnType<typeof heartbeatService>["registerRunDispatchWork"]>|undefined;
  let stopBudgetOwners:(()=>Promise<void>)|undefined;
  let app:Awaited<ReturnType<typeof import("../../../app.js")["createApp"]>>|undefined;
  let owner:ReturnType<typeof heartbeatService>|undefined;
  let appServer:ReturnType<typeof createServer>|undefined;
  let stopping:Promise<void>|undefined;
  const stop=()=>stopping??=(async()=>{
    const shutdownErrors:unknown[]=[];
    const attempt=async(stage:string,action:()=>unknown|Promise<unknown>)=>{
      try{await action();}catch(error){
        shutdownErrors.push(error);
        try{
        const knownNames=new Set(["Error","TypeError","RangeError","AssertionError","AggregateError","AbortError"]);
        const name=error instanceof Error?error.name:"non_error";
        const code=error&&typeof error==="object"&&"code" in error?String(error.code):undefined;
        const knownCodes=new Set(["ERR_ASSERTION","ERR_IPC_CHANNEL_CLOSED","ABORT_ERR","ETIMEDOUT","ECONNRESET","ENOENT"]);
        const sourceFrame=error instanceof Error?error.stack?.split("\n").slice(1).map(line=>line.match(/([A-Za-z0-9_./:-]+\.(?:ts|js|mjs):\d+:\d+)\)?$/)?.[1]).find(Boolean):undefined;
        process.stderr.write(JSON.stringify({kind:"owned_normal_app_shutdown_stage_failed",stage,errorName:knownNames.has(name)?name:"other",errorCode:code&&knownCodes.has(code)?code:undefined,otherCodePresent:code!==undefined&&!knownCodes.has(code),sourceFrame})+"\n");
        }catch{}
      }
    };
    try{
      await attempt("dispatch_stop",()=>dispatchWork?.stop());
      if(owner){
        await attempt("stop_invocations",async()=>{
          const ownedAgents=await db.select({id:agents.id}).from(agents).where(eq(agents.companyId,input.companyId));
          await owner!.stopInvocationsForAgents(ownedAgents.map(agent=>agent.id),"Owned physical App generation shutdown");
        });
        await attempt("execution_drain",()=>owner!.drainActiveRunExecutions());
      }
    }finally{
      await attempt("database_backups_stop",()=>stopDatabaseBackups?.());
      await attempt("budget_stop",()=>stopBudgetOwners?.());
      await attempt("app_shutdown",()=>app?.locals.paperclipShutdown?.());
      await attempt("plugin_workers_stop",()=>linuxBootstrap.workerManager.stopAll());
      await attempt("http_socket_join",async()=>{
        if(appServer){
          const joins=[...nativeSockets].map(socket=>once(socket,"close"));
          await Promise.all([new Promise<void>((resolve,reject)=>appServer!.close(error=>error?reject(error):resolve())),...joins]);
        }
      });
      await attempt("socket_assertion",()=>assert.equal(nativeSockets.size,0,"all actual owned close events must be joined"));
      await attempt("main_database_end",()=>db.$client.end({timeout:1}));
      await attempt("registered_database_end",()=>closeRegisteredClients(input.databaseUrl,{scope:"database"}));
      await attempt("decision_wake_assertion",()=>assert.equal(unexpectedDecisionWakes,0));
      await attempt("owner_error_assertion",()=>assert.deepEqual(errors,[]));
    }
    if(shutdownErrors.length===1)throw shutdownErrors[0];
    if(shutdownErrors.length>1)throw new AggregateError(shutdownErrors,"owned_normal_app_shutdown_failed",{cause:shutdownErrors[0]});
  })();
  try{
    await migrateCloudConfiguration(db);await initializeAdapterSettings(db);await initializeCloudRuntimeConfig(db);
    resetCloudRuntimeIdentityForTests();resetCloudControlReplayFenceForTests();await initializeCloudRuntimeIdentity(db);
    // The persistent per-journey directory is shared by both real App boots.
    // Refuse ambient/default host backup storage before allocating backup owners.
    const config=loadConfig();
    assert.equal(config.databaseBackupEnabled,true,"qualification retains automatic backups");
    assert.equal(process.env.PAPERCLIP_DB_BACKUP_DIR,path.join(input.home,"database-backups"));
    assert.equal(config.databaseBackupDir,path.join(input.home,"database-backups"));
    assert(process.env.PAPERCLIP_PG_DUMP_PATH&&path.isAbsolute(process.env.PAPERCLIP_PG_DUMP_PATH),"qualification requires an explicitly configured absolute pg_dump path");
    const backupSettings=instanceSettingsService(db);
    const runDatabaseBackup=createDatabaseBackupOwner({connectionString:input.databaseUrl,
      backupDir:config.databaseBackupDir,getRetention:async()=>(await backupSettings.getGeneral()).backupRetention,logger});
    const idleDatabaseBackupEnabled=config.databaseBackupEnabled&&process.env.PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED==="1";
    const standby=await createCloudWarmStandby(db);assert.equal(standby(),input.generation===1);
    const {createApp}=await import("../../../app.js");
    const budgetResumeDelivery:BudgetResumeDelivery={};
    const storageService=getStorageService(); // Same normal configured owner used by Native durable restoration.
    app=await createApp(db,{...linuxBootstrap.appOptions,budgetResumeDelivery,uiMode:"none",serverPort:3100,
      storageService,
      prepareIdleDatabaseBackup:idleDatabaseBackupEnabled?async()=>(await runDatabaseBackup("idle"))!==null:undefined,
      deploymentMode:"authenticated",deploymentExposure:"private",bindHost:"127.0.0.1",allowedHostnames:[new URL(input.origin).hostname],
      authPublicBaseUrl:input.origin,authReady:true,companyDeletionEnabled:false,cloudWarmStandby:standby,
      decisionServiceOptions:{wakeOriginAgent:async()=>{unexpectedDecisionWakes++;throw new Error("Unexpected Decision dependency in closed Dot journey");}},
      resolveSession:async req=>{sessionCalls++;if(req.get("x-selected-operator")!==input.userId)return null;
        const [user]=await db.select().from(authUsers).where(eq(authUsers.id,input.userId));
        return user?{session:{id:"principal-hop-session",userId:input.userId},user}:null;}});
    assert.equal(getStorageService(),storageService,"App and Native must share the normal configured storage owner");
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
    const coordinator:ReturnType<typeof createDeliveryWorkCoordinator>=app.locals.deliveryWork;assert(coordinator&&typeof coordinator.register==="function");
    const normalOwner=heartbeatService(db,{pluginWorkerManager:linuxBootstrap.workerManager});owner=normalOwner;
    const canRun=()=>{
      const taskDrain=isIdleTaskDrainActive(),warmStandby=taskDrain?null:standby();
      const allowed=!taskDrain&&!warmStandby;nativeGate={at:Date.now(),allowed,taskDrain,warmStandby};return allowed;
    };
    const observedResidualCoordinator={...coordinator,register(...args:Parameters<typeof coordinator.register>){
      const [queue,task]=args;
      if(queue!==DELIVERY_QUEUES.nativeProcessSessions)return coordinator.register(queue,task);
      recordNative("registered");
      return coordinator.register(queue,{...task,
        run:async signal=>{recordNative("run_enter");try{const value=await task.run(signal);recordNative("run_fulfilled");return value;}
          catch(error){recordNative("run_rejected");throw error;}},
        hasPending:async allowed=>{const pending=await task.hasPending(allowed);recordNative("has_pending",pending);return pending;},
        ...(task.onSettled?{onSettled:(hints?:ReadonlySet<string>)=>{recordNative("settled",hints?.size??0);return task.onSettled!(hints);}}:{}),
        ...(task.nextRunAt?{nextRunAt:()=>{const at=task.nextRunAt!();recordNative("next_run_at",at);return at;}}:{}),
      });
    }};
      await normalOwner.registerResidualRecoveryWork(observedResidualCoordinator,canRun).ready;
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
      const environmentCleanup=registerEnvironmentCleanupWork(db,coordinator,{
        sweepPending:backoffMs=>normalOwner.sweepPendingCleanupLeases({backoffMs}),canRun,
      });
      appServer.once("close",environmentCleanup.stop);
      await environmentCleanup.ready;
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
      if(config.databaseBackupEnabled){
        const backups=registerDatabaseBackupWork(coordinator,{intervalMs:config.databaseBackupIntervalMinutes*60*1000,
          run:()=>runDatabaseBackup("scheduled")});
        stopDatabaseBackups=()=>backups.stop();
        await backups.ready;
        // Match index: a retained wake checkpoint must settle before idle eligibility.
        if(!standby()&&existsSync(idleBackupWakeMarker(config.databaseBackupDir)))await runDatabaseBackup("scheduled");
      }
      // All actually registered owners are ready and the real HTTP ingress is listening.
      // Preserve the configured backup obligation; never substitute a sleep-friendly default.
      markIdleStartupComplete({scheduledBackups:config.databaseBackupEnabled});

    return {origin,db,heartbeat:owner,workerManager:linuxBootstrap.workerManager,stop,
      snapshot:()=>({pid:process.pid,nativeRecovery:{gate:nativeGate,counts:{...nativeEventCounts},last32:[...nativeTrace],droppedEarlier:nativeTraceDropped},worker:idleWorkSnapshot(),taskDrain:owner!.getTaskDrainStatus(),nativeSockets:nativeSockets.size,
        unexpectedDecisionWakes,errorCount:errors.length,sessionCalls,healthStatuses:[...healthStatuses],healthOverflow,
        runtimeIdentity:{stackId:getCloudRuntimeIdentity()?.stackId,canonicalOrigin:getCloudRuntimeIdentity()?.canonicalOrigin}})};
  }catch(primary){try{await stop();}catch(cleanup){throw new AggregateError([primary,cleanup],"normal_dot_child_start_cleanup_failed");}throw primary;}
}
