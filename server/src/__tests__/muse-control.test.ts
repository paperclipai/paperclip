import { subscribeDatabaseWork } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import express from "express";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activityLog, agentCommentary, documents, issueDocuments } from "@paperclipai/db";
import request from "supertest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, closeRegisteredClients, applyPendingMigrations, externalAgentHolds, heartbeatRuns, issueAccessGrants, issueComments, issues, projects, principalPermissionGrants, mcpOauthGrants, mcpOauthRequests, mcpOauthTokens, dotAgentBindings, dotRunnerAssignments, dotRunnerOperations, museIdleReceipts, museAgentBindings as bindings, museCredentials, museInputDeliveries, museReceiverContactBuckets, museMailboxItems as mailbox, museRunnerAssignments as assignments, museRunnerOperations as operations, nativeRunFinalizations } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { startAgentLifecycle } from "../services/agent-lifecycle.js";
import { agentHarnessVerificationService } from "../services/agent-harness-verification.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { MUSE_PUBLIC_ROUTES, MUSE_CLIENT_VERSION, type MuseCredentials } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { museOAuth } from "../services/muse-oauth.js";
import { createPublicMcpOAuth, hashMcpSecret } from "../services/public-mcp/oauth.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import { inspectMuseConnectionCredential, assertMuseSubjectCredential } from "../services/muse-identity.js";
import { sql } from "drizzle-orm";
import { museIdentity, museCredentialHash } from "../services/muse-identity.js";
import * as museIdentityModule from "../services/muse-identity.js";
import { museTransportRoutes, museBoardRoutes } from "../routes/muse.js";
import { projectRoutes } from "../routes/projects.js";
import { activityRoutes } from "../routes/activity.js";
import * as activityLogModule from "../services/activity-log.js";
import { errorHandler } from "../middleware/error-handler.js";
import { museRunnerBroker } from "../services/muse-runner-broker.js";
import { museReceiver } from "../services/muse-receiver.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { boardAuthService } from "../services/board-auth.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { LOW_TRUST_QUARANTINED_BODY, buildLowTrustSourceTrust, buildPromotedSourceTrust, sanitizeQuarantinedCommentForHigherTrust } from "../services/source-trust.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { documentService } from "../services/documents.js";
import { assertNoExternalOverlap, withExternalAdmissionGuard } from "../modules/external-agents/index.js";
import { digestPaperclipSemanticContent, externalOperationDigest, parseNativeExecutionInput, canonicalNativeRuntimeContextDigest, nativeRuntimePromptDigest, NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION, type ExternalProviderOperation } from "../vendor/paperclip-runner/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

/** Real database/transport authority tests; synthetic provider receipts do not
 * count as live Muse/native qualification evidence. */
describe("personal Muse control plane",()=>{
  let temporary:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>|undefined,db:ReturnType<typeof createDb>,externalDatabaseUrl:string|undefined;
  beforeAll(async()=>{
    externalDatabaseUrl=process.env.PAPERCLIP_MUSE_CONTROL_TEST_DATABASE_URL?.trim();
    if(externalDatabaseUrl){await applyPendingMigrations(externalDatabaseUrl);db=createDb(externalDatabaseUrl);}
    else {temporary=await startEmbeddedPostgresTestDatabase("muse-control-");db=createDb(temporary.connectionString);}
    await instanceSettingsService(db).updateExperimental({enableNativeRunner:true,enableMuse:true});
  },30000);
  afterAll(async()=>{vi.unstubAllEnvs();await museReceiver(db).stop();if(externalDatabaseUrl)await closeRegisteredClients(externalDatabaseUrl);await temporary?.cleanup();});
  async function fixture(ready=true) {
    const operatorId=randomUUID();await db.insert(authUsers).values({id:operatorId,name:"Muse authorizer",email:operatorId+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    const [company]=await db.insert(companies).values({name:"Muse control",issuePrefix:"MU"+randomBytes(3).toString("hex")}).returning();
    const [agent]=await db.insert(agents).values({companyId:company.id,name:"Muse",role:"engineer",status:"active",adapterType:"paperclip_runner",adapterConfig:{provider:"muse",allowUnmeteredProvider:true,lifecycle:"per_turn"},permissions:{canCreateTasks:true}}).returning();
    await db.insert(companyMemberships).values([{companyId:company.id,principalType:"user",principalId:operatorId,membershipRole:"owner",status:"active"},{companyId:company.id,principalType:"agent",principalId:agent.id,membershipRole:"member",status:"active"}]);
    const ticket=randomBytes(32).toString("base64url");const [binding]=await db.insert(bindings).values({companyId:company.id,agentId:agent.id,operatorId,ticketHash:museCredentialHash(ticket),ticketExpiresAt:new Date(Date.now()+600000)}).returning();
    await db.update(agents).set({adapterConfig:{...agent.adapterConfig,museBindingId:binding.id}}).where(eq(agents.id,agent.id));
    const identity=museIdentity(db),credentials=await identity.pair(ticket,"2"),broker=museRunnerBroker(db,{publicOrigin:"https://paperclip.example",heartbeat:{wakeup:vi.fn().mockResolvedValue(null),cancelRun:vi.fn()}});
    if(ready)await db.update(bindings).set({status:"ready",receiverContactAt:new Date(),verifiedReplyAt:new Date()}).where(eq(bindings.id,binding.id));
    return {company,agent,operatorId,binding,ticket,identity,credentials,broker,subject:await identity.authenticate(credentials.accessToken)};
  }
  function transport(allowLegacyCredentials=false) { const app=express();app.use(museTransportRoutes(db,"https://paperclip.example",{allowLegacyCredentials}));app.use(errorHandler);return app; }
  const oauthOrigin="https://paperclip.example",oauthResource=oauthOrigin+"/api/muse/v1",oauthCallback="https://authd.example/callback";
  async function oauthFixture(ready=false,authorize=true) {
    const f=await fixture(false),ticket=randomBytes(32).toString("base64url");
    // This fixture starts the production OAuth journey from an unredeemed binding.
    await db.delete(museCredentials).where(eq(museCredentials.bindingId,f.binding.id));
    await db.update(bindings).set({status:"pairing",pairedAt:null,workerActivityAt:null,ticketHash:museCredentialHash(ticket),ticketExpiresAt:new Date(Date.now()+600000)}).where(eq(bindings.id,f.binding.id));
    const oauth=museOAuth(db,oauthOrigin),client=await oauth.register({client_name:"Muse authd",redirect_uris:[oauthCallback],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"]},randomUUID());
    const verifier=randomBytes(32).toString("base64url"),input={client_id:client.client_id,redirect_uri:oauthCallback,response_type:"code",scope:"paperclip:agent offline_access",state:"opaque-state+/☂",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",pairing_ticket:ticket};
    const authorizationUrl=authorize?await oauth.authorize(input):undefined;
    const tokenInput=()=>({grant_type:"authorization_code",client_id:client.client_id,redirect_uri:oauthCallback,code:new URL(authorizationUrl!).searchParams.get("code")!,code_verifier:verifier});
    const tokens=ready?await oauth.token(tokenInput()):undefined;
    const subject=tokens?await f.identity.authenticateOAuthAccess(tokens.access_token,oauthOrigin):f.subject;
    if(ready)await db.update(bindings).set({status:"ready",receiverContactAt:new Date(),verifiedReplyAt:new Date()}).where(eq(bindings.id,f.binding.id));
    const [binding]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));
    return {...f,binding,ticket,oauth,client,verifier,input,authorizationUrl,tokenInput,tokens,subject};
  }
  it("signals maintenance from real qualification, assignment, and OAuth revocation producers", async () => {
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.museMaintenance, event => events.push(event));
    let detach: (() => Promise<void>) | undefined;
    try {
      const f = await oauthFixture(true);
      expect(events).toContain("intent");
      expect(events.at(-1)).toBe("settled");
      events.length = 0;
      const [binding] = await db.select().from(bindings).where(eq(bindings.id, f.binding.id));
      await f.broker.beginQualification({ companyId: f.company.id, agentId: f.agent.id,
        bindingId: binding.id, generation: binding.generation, expectedRevision: binding.revision,
        qualificationId: randomUUID(), expiresAt: new Date(Date.now() + 60_000), operatorId: f.operatorId });
      expect(events).toEqual(["intent", "settled"]);
      events.length = 0;
      const running = await active(f);
      detach = running.detach;
      expect(events).toContain("intent");
      expect(events.at(-1)).toBe("settled");
      events.length = 0;
      await f.oauth.revokeConnection(binding.grantId!, f.operatorId);
      expect(events).toContain("intent");
      expect(events.at(-1)).toBe("settled");
      expect((await db.select().from(bindings).where(eq(bindings.id, binding.id)))[0].revokedAt).not.toBeNull();
    } finally { unsubscribe(); await detach?.(); }
  });
  it("permits a paused handoff recipient authority read while retaining connection revocation checks", async () => {
    const f = await oauthFixture(true);
    const ref = { companyId: f.company.id, agentId: f.agent.id, bindingId: f.binding.id, bindingGeneration: f.binding.generation };
    await expect(f.broker.authorizingUserIdForBinding(ref)).resolves.toBe(f.operatorId);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    await expect(f.broker.authorizingUserIdForBinding(ref)).rejects.toMatchObject({ status: 403 });
    await expect(f.broker.authorizingUserIdForBinding(ref, { allowPaused: true })).resolves.toBe(f.operatorId);
    await db.update(bindings).set({ revokedAt: new Date() }).where(eq(bindings.id, f.binding.id));
    await expect(f.broker.authorizingUserIdForBinding(ref, { allowPaused: true })).rejects.toMatchObject({ status: 403 });
  });
  async function active(provided?:Awaited<ReturnType<typeof fixture>>,afterSettle?: (command:ExternalProviderOperation)=>Promise<void>) {
    const f=provided??await fixture(),runId=randomUUID(),session=randomUUID(),turnId="turn_"+randomUUID();
    const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"Muse task",status:"in_progress",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    await db.insert(heartbeatRuns).values({id:runId,companyId:f.company.id,agentId:f.agent.id,status:"running",runtimeMode:"native",driverKind:"muse_external",nativeIssueId:issue.id,nativeSessionId:session,nativePhase:"turn_running",responsibleUserId:f.operatorId});
    await db.update(issues).set({checkoutRunId:runId,executionRunId:runId}).where(eq(issues.id,issue.id));
    await db.insert(nativeRunFinalizations).values({runId,companyId:f.company.id,issueId:issue.id,phase:"running",controllerGeneration:1,leaseExpiresAt:new Date(Date.now()+600000)});
    const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId},provider:{binding:await f.broker.snapshot(f.company.id,f.agent.id,f.binding.id)}};
    const port=f.broker.port(execution),sent:ExternalProviderOperation[]=[];
    const detach=await port.attach(async command=>{sent.push(command);await port.settle({sourceEventId:"settle_"+command.requestId,payload:{binding:ref,requestId:command.requestId,outcome:command.action==="consume_input"?{status:"consumed",requestId:command.input.requestId,inputDigest:command.input.inputDigest}:{status:command.action==="accept"?"accepted":"completed"}}});await afterSettle?.(command);});
    const ref={...execution.provider.binding,runId,normalizedSessionId:session,turnId,assignmentRevision:1};
    await port.dispatch({sourceEventId:"offer_"+randomUUID(),payload:{kind:"assignment",binding:ref,tools:[],acceptByUnixMs:Date.now()+600000,expiresAtUnixMs:Date.now()+3600000}});
    const [assignment]=await db.select().from(assignments).where(eq(assignments.runId,runId));
    return {...f,runId,issue,port,ref,assignment,sent,detach};
  }
  function projectWriteExecution(f: Awaited<ReturnType<typeof active>>) {
    const digest="0".repeat(64),now=Date.now();
    const context={
      prompt:{revision:PAPERCLIP_EXECUTION_PROMPT_REVISION,text:PAPERCLIP_EXECUTION_PROMPT,digest:nativeRuntimePromptDigest()},
      instructions:{entryPath:"AGENTS.md",bundle:{schema:NATIVE_RUNTIME_ASSET_SCHEMA,digest,manifestDigest:digest,rootPath:"/synthetic/muse-jwt-instructions",fileCount:1,totalBytes:4}},
      skills:[],mcp:{assignmentSetId:"none",digest,bindingId:null},
    };
    const execution=parseNativeExecutionInput({
      schema:"paperclip.native-execution-input.v8",
      binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId,issueId:f.issue.id,executionWorkspaceId:randomUUID()},
      task:{identifier:f.issue.identifier??"MUSE-JWT",title:f.issue.title,description:null,prompt:"Read the current actor.",workMode:"standard"},
      provider:{kind:"muse",model:null,bridgeRevision:"muse-v1",binding:{companyId:f.company.id,agentId:f.agent.id,bindingId:f.binding.id,bindingGeneration:f.binding.generation,acceptByUnixMs:now+600000,expiresAtUnixMs:now+3600000}},
      workspace:{access:"none",cwd:null,repoUrl:null,repoRef:null,branchName:null},
      session:{normalizedSessionId:f.ref.normalizedSessionId,driverKind:"muse_external",protocolVersion:1,lifecyclePolicy:{mode:"per_turn",idleTimeoutMs:null}},
      executionMode:"default",planningContext:null,
      completionContract:{id:randomUUID(),sha256:"sha256:"+digest,schemaVersion:"paperclip.completion-contract.v1",contract:{revision:"1",objective:"Read the actor",criteria:[{id:"actor",requirement:"Read the actor"}]}},
      runtimeContext:{...context,aggregateDigest:canonicalNativeRuntimeContextDigest(context)},interactionResponses:[],credentialBindings:[],
    });
    if(execution.schema!=="paperclip.native-execution-input.v8")throw new Error("Muse JWT fixture is not V8");
    return execution;
  }
  it.each([
    { wait: "task", fault: "assignment_expired", replay: false },
    { wait: "task", fault: "grant_revoked", replay: false },
    { wait: "receipt", fault: "assignment_expired", replay: true },
    { wait: "receipt", fault: "grant_revoked", replay: true },
    { wait: "task", fault: "unchanged", replay: false },
    { wait: "receipt", fault: "unchanged", replay: true },
  ] as const)("rechecks Muse project-write authority after a real $wait lock wait ($fault, replay=$replay)", async ({ wait, fault, replay }) => {
    const f = await active(await oauthFixture(true));
    const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomBytes(32).toString("hex");
    let releaseAfterAuth = () => {}, releaseHolder = () => {};
    let holder: Promise<void> | undefined;
    let operation: Promise<{ response?: { status: number; body: Record<string, unknown> }; error?: unknown }> | undefined;
    try {
      await ensureHumanRoleDefaultGrants(db, { companyId: f.company.id, principalId: f.operatorId, membershipRole: "owner", grantedByUserId: f.operatorId });
      expect((await f.broker.act(f.subject, { version: 1, command: "accept", assignmentId: f.assignment.id, requestId: randomUUID() })).status).toBe("accepted");
      // The strict V8 profile is an HTTP authentication fixture, not a provider
      // launch, scheduler admission, or release of the accepted Muse holds.
      const execution = projectWriteExecution(f);
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.runId));
      await expect(f.broker.assertRunAuthority(execution)).resolves.toBeUndefined();
      const token = createLocalAgentJwt(f.agent.id, f.company.id, "paperclip_runner", f.runId, f.operatorId, undefined, f.operatorId);
      expect(typeof token).toBe("string");
      let armed = false, authenticated = () => {};
      let observedActor: unknown;
      const reachedAuth = new Promise<void>(resolve => { authenticated = resolve; });
      const afterAuth = new Promise<void>(resolve => { releaseAfterAuth = resolve; });
      const app = express();
      app.use(express.json());
      app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
      app.use((req, _res, next) => {
        if (!armed) { next(); return; }
        observedActor = req.actor;
        authenticated();
        void afterAuth.then(() => next(), next);
      });
      app.use("/api", projectRoutes(db));
      app.use(errorHandler);
      const input = { name: "Muse project authority canary", description: "A bounded project result", idempotencyKey: randomUUID() };
      const receiptKey = `project:${f.company.id}:${f.agent.id}:${f.issue.id}:${input.idempotencyKey}`;
      const send = (body = input) => request(app).post(`/api/companies/${f.company.id}/projects`)
        .set("Authorization", "Bearer " + token).set("X-Paperclip-Run-Id", f.runId).send(body);
      let priorId: string | undefined;
      if (replay) {
        const first = await send();
        expect(first.status).toBe(201);
        priorId = first.body.id;
        expect(typeof priorId).toBe("string");
        const duplicate = await send();
        expect(duplicate.status).toBe(200);
        expect(duplicate.body.id).toBe(priorId);
      }
      const snapshot = async () => ({
        projects: await db.select().from(projects).where(eq(projects.companyId, f.company.id)).orderBy(projects.id),
        activity: await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id)).orderBy(activityLog.id),
        run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0],
        assignment: await db.select({ status: assignments.status, acceptedResultAt: assignments.acceptedResultAt, finalizedAt: assignments.finalizedAt }).from(assignments).where(eq(assignments.id, f.assignment.id)),
        holds: await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId, f.assignment.id)).orderBy(externalAgentHolds.id),
      });
      const before = await snapshot();
      const oldReceipts = before.activity.filter(row => row.action === "project.created" && row.details?.idempotencyKey === receiptKey);
      expect(oldReceipts).toHaveLength(replay ? 1 : 0);
      expect(before.projects).toHaveLength(replay ? 1 : 0);
      armed = true;
      operation = send().then(response => ({ response: { status: response.status, body: response.body } }), error => ({ error }));
      await expect.poll(() => observedActor !== undefined, { timeout: 5000, interval: 25 }).toBe(true);
      await reachedAuth;
      expect(observedActor).toMatchObject({ type: "agent", source: "agent_jwt", companyId: f.company.id, agentId: f.agent.id, runId: f.runId, authorizingUserId: f.operatorId });
      // The holder starts only after real middleware authorization. Holding it
      // before the request could block middleware instead of the project path.
      let locked = () => {}, holderPid = 0;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const gate = new Promise<void>(resolve => { releaseHolder = resolve; });
      holder = db.transaction(async tx => {
        holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid;
        if (wait === "task") await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, f.company.id), eq(issues.id, f.issue.id))).for("update");
        else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${receiptKey}, 0))`);
        locked();
        await gate;
      });
      await ready;
      releaseAfterAuth();
      await expect.poll(async () => {
        const [observed] = wait === "task"
          ? await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity waiter
              inner join pg_locks waiting on waiting.pid=waiter.pid and waiting.locktype='transactionid' and not waiting.granted
              inner join pg_locks held on held.pid=${holderPid} and held.locktype='transactionid' and held.granted and held.transactionid=waiting.transactionid
              where waiter.datname=current_database() and ${holderPid}=any(pg_blocking_pids(waiter.pid))
                and exists(select 1 from pg_locks tuple_lock where tuple_lock.pid=waiter.pid and tuple_lock.locktype='tuple'
                  and tuple_lock.relation='issues'::regclass and tuple_lock.mode in ('ExclusiveLock','AccessExclusiveLock') and tuple_lock.granted)) as waiting`)
          : await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity waiter
              inner join pg_locks waiting on waiting.pid=waiter.pid and waiting.locktype='advisory' and not waiting.granted
              inner join pg_locks held on held.pid=${holderPid} and held.locktype='advisory' and held.granted
                and held.database=waiting.database and held.classid=waiting.classid and held.objid=waiting.objid and held.objsubid=waiting.objsubid
              where waiter.datname=current_database() and ${holderPid}=any(pg_blocking_pids(waiter.pid))) as waiting`);
        return observed.waiting;
      }, { timeout: 5000, interval: 25 }).toBe(true);
      await expect(f.broker.assertRunAuthority(execution)).resolves.toBeUndefined();
      if (fault === "assignment_expired") await db.update(assignments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(assignments.id, f.assignment.id));
      if (fault === "grant_revoked") await db.update(mcpOauthGrants).set({ revokedAt: new Date() }).where(eq(mcpOauthGrants.id, f.binding.grantId!));
      if (fault === "unchanged") await expect(f.broker.assertRunAuthority(execution)).resolves.toBeUndefined();
      else await expect(f.broker.assertRunAuthority(execution)).rejects.toMatchObject({ status: 403 });
      releaseHolder();
      await holder;
      const outcome = await operation;
      expect(outcome.error).toBeUndefined();
      armed = false;
      if (fault !== "unchanged") {
        // The old route returns 201/200 here; denial must precede any effect or replay.
        expect(outcome.response?.status).toBe(403);
        expect(outcome.response?.body).toEqual({ error: "Muse native tool authority is unavailable" });
        expect(await snapshot()).toEqual(before);
      } else {
        expect(outcome.response?.status).toBe(replay ? 200 : 201);
        const id = outcome.response?.body.id;
        expect(typeof id).toBe("string");
        if (replay) expect(id).toBe(priorId);
        const committed = await snapshot();
        expect(committed.projects).toHaveLength(1);
        expect(committed.projects[0].id).toBe(id);
        expect(committed.activity.filter(row => row.action === "project.created" && row.details?.idempotencyKey === receiptKey)).toHaveLength(1);
        const duplicate = await send();
        expect(duplicate.status).toBe(200);
        expect(duplicate.body.id).toBe(id);
        expect(await snapshot()).toEqual(committed);
        const conflict = await send({ ...input, name: input.name + " changed" });
        expect(conflict.status).toBe(409);
        expect(await snapshot()).toEqual(committed);
        expect(committed.holds).toEqual(before.holds);
        expect(committed.assignment).toEqual(before.assignment);
        expect(committed.run).toEqual(before.run);
      }
    } finally {
      releaseAfterAuth();
      releaseHolder();
      await Promise.allSettled([holder, operation].filter(value => value !== undefined));
      if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
      await f.detach();
    }
  }, 15000);
  it("authenticates current Muse V8 JWT actors and denies changed native bindings and grants",async()=>{
    const f=await active(await oauthFixture(true)),previousSecret=process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET=randomBytes(32).toString("hex");
    try {
      await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      // Strict launch data for an authentication fixture; no provider launch,
      // scheduler admission, or runtime-asset qualification is claimed here.
      const digest="0".repeat(64),now=Date.now();
      const context={
        prompt:{revision:PAPERCLIP_EXECUTION_PROMPT_REVISION,text:PAPERCLIP_EXECUTION_PROMPT,digest:nativeRuntimePromptDigest()},
        instructions:{entryPath:"AGENTS.md",bundle:{schema:NATIVE_RUNTIME_ASSET_SCHEMA,digest,manifestDigest:digest,rootPath:"/synthetic/muse-jwt-instructions",fileCount:1,totalBytes:4}},
        skills:[],mcp:{assignmentSetId:"none",digest,bindingId:null},
      };
      const execution=parseNativeExecutionInput({
        schema:"paperclip.native-execution-input.v8",
        binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId,issueId:f.issue.id,executionWorkspaceId:randomUUID()},
        task:{identifier:f.issue.identifier??"MUSE-JWT",title:f.issue.title,description:null,prompt:"Read the current actor.",workMode:"standard"},
        provider:{kind:"muse",model:null,bridgeRevision:"muse-v1",binding:{companyId:f.company.id,agentId:f.agent.id,bindingId:f.binding.id,bindingGeneration:f.binding.generation,acceptByUnixMs:now+600000,expiresAtUnixMs:now+3600000}},
        workspace:{access:"none",cwd:null,repoUrl:null,repoRef:null,branchName:null},
        session:{normalizedSessionId:f.ref.normalizedSessionId,driverKind:"muse_external",protocolVersion:1,lifecyclePolicy:{mode:"per_turn",idleTimeoutMs:null}},
        executionMode:"default",planningContext:null,
        completionContract:{id:randomUUID(),sha256:"sha256:"+digest,schemaVersion:"paperclip.completion-contract.v1",contract:{revision:"1",objective:"Read the actor",criteria:[{id:"actor",requirement:"Read the actor"}]}},
        runtimeContext:{...context,aggregateDigest:canonicalNativeRuntimeContextDigest(context)},interactionResponses:[],credentialBindings:[],
      });
      if(execution.schema!=="paperclip.native-execution-input.v8")throw new Error("Muse JWT fixture is not V8");
      const profile={nativeExecutionInput:execution};
      await db.update(heartbeatRuns).set({runnerProfileJson:profile}).where(eq(heartbeatRuns.id,f.runId));
      await expect(f.broker.assertRunAuthority(execution)).resolves.toBeUndefined();
      const token=createLocalAgentJwt(f.agent.id,f.company.id,"paperclip_runner",f.runId,f.operatorId,undefined,f.operatorId);
      expect(typeof token).toBe("string");
      const app=express();app.use(actorMiddleware(db,{deploymentMode:"authenticated",resolveSession:async()=>null}));
      app.get("/actor",(req,res)=>res.json(req.actor));app.use(errorHandler);
      const read=()=>request(app).get("/actor").set("Authorization","Bearer "+token).set("X-Paperclip-Run-Id",f.runId);
      const positive=await read();
      expect(positive.status).toBe(200);expect(positive.body).toMatchObject({type:"agent",source:"agent_jwt",companyId:f.company.id,agentId:f.agent.id,runId:f.runId,authorizingUserId:f.operatorId,onBehalfOfUserId:f.operatorId});
      const beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const beforeAssignment=(await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0];
      const beforeActivity=await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id)).orderBy(activityLog.id);
      await db.update(heartbeatRuns).set({runtimeMode:"legacy"}).where(eq(heartbeatRuns.id,f.runId));
      const nonNative=await read();expect(nonNative.status).toBe(403);expect(nonNative.body).toEqual({error:"Muse native tool authority is unavailable"});
      await db.update(heartbeatRuns).set({runtimeMode:"native"}).where(eq(heartbeatRuns.id,f.runId));
      expect((await read()).status).toBe(200);
      // This remains a valid V8 shape, but names a different current run.
      const otherRun={...execution,binding:{...execution.binding,runId:randomUUID()}};
      expect(parseNativeExecutionInput(otherRun).schema).toBe("paperclip.native-execution-input.v8");
      await db.update(heartbeatRuns).set({runnerProfileJson:{nativeExecutionInput:otherRun}}).where(eq(heartbeatRuns.id,f.runId));
      const wrongRun=await read();expect(wrongRun.status).toBe(403);expect(wrongRun.body).toEqual({error:"Muse native tool authority is unavailable"});
      await db.update(heartbeatRuns).set({runnerProfileJson:profile}).where(eq(heartbeatRuns.id,f.runId));
      expect((await read()).status).toBe(200);
      const otherAuthorizer=createLocalAgentJwt(f.agent.id,f.company.id,"paperclip_runner",f.runId,f.operatorId,undefined,randomUUID());
      expect(typeof otherAuthorizer).toBe("string");
      const wrongAuthorizer=await request(app).get("/actor").set("Authorization","Bearer "+otherAuthorizer).set("X-Paperclip-Run-Id",f.runId);
      expect(wrongAuthorizer.status).toBe(403);expect(wrongAuthorizer.body).toEqual({error:"Muse native tool authority is unavailable"});
      // A synthetic current-DB grant revocation must affect the same signed JWT.
      await db.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
      const revoked=await read();expect(revoked.status).toBe(403);expect(revoked.body).toEqual({error:"Muse native tool authority is unavailable"});
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual(beforeAssignment);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id)).orderBy(activityLog.id)).toEqual(beforeActivity);
      expect((await db.select({status:heartbeatRuns.status,runtimeMode:heartbeatRuns.runtimeMode,runnerProfileJson:heartbeatRuns.runnerProfileJson,resultJson:heartbeatRuns.resultJson}).from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)))[0]).toMatchObject({status:"running",runtimeMode:"native",runnerProfileJson:profile,resultJson:null});
    }finally{
      if(previousSecret===undefined)delete process.env.PAPERCLIP_AGENT_JWT_SECRET;else process.env.PAPERCLIP_AGENT_JWT_SECRET=previousSecret;
      await f.detach();
    }
  });
  it.each([true,false])("retains native Muse progress source trust and idempotent history (low trust: %s)",async lowTrust=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const executionPolicy={authorizationPolicy:{trustBoundary:{mode:"low_trust_review",companyId:f.company.id,rootIssueId:f.issue.id}}};
      const writerContext={issueId:f.issue.id,...(lowTrust?{executionPolicy}:{})};
      await db.update(heartbeatRuns).set({contextSnapshot:writerContext}).where(eq(heartbeatRuns.id,f.runId));
      const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}};
      const checks:string[]=[],authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,
        museRuntime:true,externalAuthorizingUserId:f.operatorId,assertBridgeAuthority:async(database=db)=>{
          await f.broker.assertRunAuthority(execution,database);checks.push(database===db?"discovery":"transaction");
        }});
      const body="NATIVE_MUSE_PROGRESS_QUARANTINE_CANARY",idempotencyKey=randomUUID();
      const call={tool:"report_progress",callId:randomUUID(),arguments:{body,idempotencyKey}};
      const beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const first=await authority.execute(call) as {commentId:string,issueId:string,disposition:string};
      expect(first).toMatchObject({issueId:f.issue.id,disposition:"applied"});
      expect(checks).toEqual(["discovery","transaction"]);
      const [comment]=await db.select().from(issueComments).where(eq(issueComments.id,first.commentId));
      const expectedTrust=lowTrust?buildLowTrustSourceTrust({issueId:f.issue.id,agentId:f.agent.id,runId:f.runId}):null;
      // The baseline must reach the actual persisted tag; the previous producer stores null.
      expect(comment.sourceTrust).toEqual(expectedTrust);
      expect(comment).toMatchObject({companyId:f.company.id,issueId:f.issue.id,authorAgentId:f.agent.id,createdByRunId:f.runId,body});
      const snapshot=async()=>({
        comments:await db.select().from(issueComments).where(eq(issueComments.issueId,f.issue.id)).orderBy(issueComments.id),
        activity:await db.select().from(activityLog).where(eq(activityLog.companyId,f.company.id)).orderBy(activityLog.id),
        run:(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)))[0],
      });
      const committed=await snapshot();
      expect(committed.comments).toHaveLength(1);
      expect(committed.activity.filter(row=>row.action==="issue.comment_added")).toHaveLength(1);
      expect((committed.run.resultJson as {semanticToolReceipts:Record<string,unknown>}).semanticToolReceipts).toEqual({
        [idempotencyKey]:{operationId:"report_progress",input:call.arguments,result:first},
      });
      expect(await authority.execute({...call,callId:randomUUID()})).toEqual(first);
      expect(await snapshot()).toEqual(committed);
      await expect(authority.execute({...call,callId:randomUUID(),arguments:{...call.arguments,body:body+" changed"}})).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
      expect(await snapshot()).toEqual(committed);
      const history=await authority.execute({tool:"get_task_history",callId:randomUUID(),arguments:{limit:50}}) as {comments:Array<{id:string,body:string,sourceTrust:unknown}>};
      expect(history.comments).toHaveLength(1);
      expect(history.comments[0]).toMatchObject({id:comment.id,body,sourceTrust:expectedTrust});
      if(lowTrust){
        const promotedId=randomUUID(),standardId=randomUUID(),at=comment.createdAt.getTime();
        const promotedTrust=buildPromotedSourceTrust({sourceIssueId:f.issue.id,sourceArtifactKind:"comment",sourceArtifactId:comment.id,promotedByActorType:"user",promotedByActorId:f.operatorId});
        await db.insert(issueComments).values([
          {id:promotedId,companyId:f.company.id,issueId:f.issue.id,authorUserId:f.operatorId,authorType:"user",body:"Reviewed progress summary",sourceTrust:promotedTrust,createdAt:new Date(at+1000)},
          {id:standardId,companyId:f.company.id,issueId:f.issue.id,authorUserId:f.operatorId,authorType:"user",body:"Ordinary coordination",createdAt:new Date(at+2000)},
        ]);
        // Construct a distinct, genuinely standard read context. This is a DB
        // read fixture, not scheduler admission, a handoff, or worker release.
        const [reader]=await db.insert(agents).values({companyId:f.company.id,name:"Standard history reader",role:"engineer",status:"active",adapterType:"paperclip_runner",adapterConfig:{provider:"codex"}}).returning();
        await db.insert(companyMemberships).values({companyId:f.company.id,principalType:"agent",principalId:reader.id,membershipRole:"member",status:"active"});
        const readerRunId=randomUUID();
        await db.insert(heartbeatRuns).values({id:readerRunId,companyId:f.company.id,agentId:reader.id,status:"running",runtimeMode:"native",nativeIssueId:f.issue.id,responsibleUserId:f.operatorId,contextSnapshot:{issueId:f.issue.id}});
        await db.update(issues).set({assigneeAgentId:reader.id,executionRunId:readerRunId,checkoutRunId:readerRunId}).where(eq(issues.id,f.issue.id));
        const readerAuthority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:reader.id,issueId:f.issue.id,runId:readerRunId});
        const stored=await db.select().from(issueComments).where(eq(issueComments.issueId,f.issue.id)).orderBy(issueComments.id);
        const read=await readerAuthority.execute({tool:"get_task_history",callId:randomUUID(),arguments:{limit:50}}) as {comments:Array<{id:string,body:string,sourceTrust:unknown}>};
        expect(read.comments.find(row=>row.id===comment.id)).toMatchObject({body:LOW_TRUST_QUARANTINED_BODY,sourceTrust:expectedTrust});
        expect(JSON.stringify(read)).not.toContain(body);
        expect(read.comments.find(row=>row.id===promotedId)).toMatchObject({body:"Reviewed progress summary",sourceTrust:promotedTrust});
        expect(read.comments.find(row=>row.id===standardId)).toMatchObject({body:"Ordinary coordination",sourceTrust:null});
        expect(await db.select().from(issueComments).where(eq(issueComments.issueId,f.issue.id)).orderBy(issueComments.id)).toEqual(stored);
      }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)))[0]).toEqual(committed.run);
      expect(committed.run.contextSnapshot).toEqual(writerContext);
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      expect((await db.select({status:assignments.status,acceptedResultAt:assignments.acceptedResultAt,finalizedAt:assignments.finalizedAt}).from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual({status:"accepted",acceptedResultAt:null,finalizedAt:null});
    }finally{await f.detach();}
  });
  it.each(["refresh_expired","muse_disabled","runner_disabled","grant_revoked","binding_revoked","assignment_fenced","qualification_expired","unchanged"] as const)("rechecks native Muse document authority after the real task-lock wait (%s)",async fault=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},holder:Promise<void>|undefined,write:Promise<{result?:unknown;error?:unknown}>|undefined;
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}};
      const checks:string[]=[],authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,
        museRuntime:true,externalAuthorizingUserId:f.operatorId,assertBridgeAuthority:async(database=db)=>{
          await museRunnerBroker(database,{publicOrigin:oauthOrigin}).assertRunAuthority(execution);
          checks.push(database===db?"discovery":"transaction");
        }});
      const idempotencyKey=randomUUID(),call={tool:"write_document",callId:randomUUID(),arguments:{key:"report",title:"Report",body:"MUSE_LOCK_WAIT_DOCUMENT_CANARY",baseRevisionId:null,idempotencyKey}};
      const beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      let ready=()=>{},holderPid=0;const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        await tx.select({id:issues.id}).from(issues).where(eq(issues.id,f.issue.id)).for("update");ready();await gate;
      });
      await locked;
      write=authority.execute(call).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [observed]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity waiter
          where waiter.datname=current_database() and waiter.wait_event_type='Lock' and ${holderPid}=any(pg_blocking_pids(waiter.pid))
            and waiter.query ~* '(from|join)[[:space:]]+"?issues"?' and waiter.query ~* 'for[[:space:]]+update') as waiting`);
        return observed.waiting;
      },{timeout:5000,interval:25}).toBe(true);
      expect(checks).toEqual(["discovery"]);
      if(fault==="refresh_expired")await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(and(eq(mcpOauthTokens.grantId,f.binding.grantId!),eq(mcpOauthTokens.kind,"refresh")));
      if(fault==="muse_disabled")await instanceSettingsService(db).updateExperimental({enableMuse:false});
      if(fault==="runner_disabled")await instanceSettingsService(db).updateExperimental({enableNativeRunner:false});
      if(fault==="grant_revoked")await db.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
      if(fault==="binding_revoked")await db.update(bindings).set({revokedAt:new Date(),status:"revoked"}).where(eq(bindings.id,f.binding.id));
      if(fault==="assignment_fenced")await db.update(assignments).set({status:"fenced"}).where(eq(assignments.id,f.assignment.id));
      if(fault==="qualification_expired")await db.update(bindings).set({qualificationId:randomUUID(),qualificationExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
      if(fault==="unchanged")await expect(f.broker.assertRunAuthority(execution)).resolves.toBeUndefined();
      else await expect(f.broker.assertRunAuthority(execution)).rejects.toMatchObject({status:403});
      release();await holder;
      const outcome=await write;
      const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
      const receipts=(run.resultJson as {semanticToolReceipts?:Record<string,unknown>}|null)?.semanticToolReceipts;
      if(fault==="unchanged"){
        expect(outcome.error).toBeUndefined();expect(outcome.result).toMatchObject({disposition:"applied",document:{body:call.arguments.body}});
        expect(receipts?.[idempotencyKey]).toMatchObject({operationId:"write_document",input:call.arguments,result:outcome.result});
        expect(await documentService(db).getIssueDocumentByKey(f.issue.id,"report")).toMatchObject({body:call.arguments.body});
        expect(await authority.execute({...call,callId:randomUUID()})).toEqual(outcome.result);
        expect(await documentService(db).listIssueDocumentRevisions(f.issue.id,"report")).toHaveLength(1);
      }else{
        expect(outcome.error).toMatchObject({status:403});expect(outcome.result).toBeUndefined();
        expect(await db.select({id:issueDocuments.id}).from(issueDocuments).where(eq(issueDocuments.issueId,f.issue.id))).toEqual([]);
        expect(await db.select({id:documents.id}).from(documents).where(eq(documents.companyId,f.company.id))).toEqual([]);
        expect(receipts?.[idempotencyKey]).toBeUndefined();
        expect(await db.select({id:activityLog.id}).from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"issue.document_created")))).toEqual([]);
      }
      expect(run.status).toBe("running");
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
    }finally{release();await holder;await write;await instanceSettingsService(db).updateExperimental({enableMuse:true,enableNativeRunner:true});await f.detach();}
  });
  it.each([
    {deadline:"expired" as const,replay:false},
    {deadline:"nonfinite" as const,replay:false},
    {deadline:"expired" as const,replay:true},
    {deadline:"nonfinite" as const,replay:true},
  ])("rejects native document effects and receipt replay after assignment deadline changes during the real task-lock wait ($deadline, replay=$replay)",async({deadline,replay})=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},holder:Promise<void>|undefined,operation:Promise<{result?:unknown;error?:unknown}>|undefined;
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}};
      const checks:string[]=[],authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,
        museRuntime:true,externalAuthorizingUserId:f.operatorId,assertBridgeAuthority:async(database=db)=>{
          checks.push(database===db?"discovery":"transaction");await f.broker.assertRunAuthority(execution,database);
        }});
      const idempotencyKey=randomUUID(),call={tool:"write_document",callId:randomUUID(),arguments:{key:"report",title:"Assignment authority",body:"MUSE_ASSIGNMENT_DEADLINE_DOCUMENT_CANARY",baseRevisionId:null,idempotencyKey}};
      let priorResult:unknown;
      if(replay){
        priorResult=await authority.execute(call);
        expect(priorResult).toMatchObject({disposition:"applied",document:{body:call.arguments.body}});
        expect(await authority.execute({...call,callId:randomUUID()})).toEqual(priorResult);
        expect(await documentService(db).listIssueDocumentRevisions(f.issue.id,"report")).toHaveLength(1);
      }
      const snapshot=async()=>({
        run:await db.select({status:heartbeatRuns.status,resultJson:heartbeatRuns.resultJson}).from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)),
        issueDocuments:await db.select().from(issueDocuments).where(eq(issueDocuments.issueId,f.issue.id)).orderBy(issueDocuments.id),
        documents:await db.select().from(documents).where(eq(documents.companyId,f.company.id)).orderBy(documents.id),
        revisions:await documentService(db).listIssueDocumentRevisions(f.issue.id,"report"),
        activity:await db.select({id:activityLog.id,action:activityLog.action,entityId:activityLog.entityId}).from(activityLog).where(eq(activityLog.companyId,f.company.id)).orderBy(activityLog.id),
        assignment:await db.select({status:assignments.status,acceptedResultAt:assignments.acceptedResultAt,finalizedAt:assignments.finalizedAt}).from(assignments).where(eq(assignments.id,f.assignment.id)),
      });
      const [initialAssignment]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));
      expect(initialAssignment.expiresAt).toBeInstanceOf(Date);
      expect(Number.isFinite(initialAssignment.expiresAt.getTime())).toBe(true);
      expect(initialAssignment.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const before=await snapshot(),beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      checks.length=0;
      let ready=()=>{},holderPid=0;const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        await tx.select({id:issues.id}).from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.id,f.issue.id))).for("update");ready();await gate;
      });
      await locked;
      operation=authority.execute({...call,callId:randomUUID()}).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [observed]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity waiter
          inner join pg_locks waiting on waiting.pid=waiter.pid and waiting.locktype='transactionid' and not waiting.granted
          inner join pg_locks held on held.pid=${holderPid} and held.locktype='transactionid' and held.granted and held.transactionid=waiting.transactionid
          where waiter.datname=current_database() and ${holderPid}=any(pg_blocking_pids(waiter.pid))
            and exists(select 1 from pg_locks tuple_lock where tuple_lock.pid=waiter.pid and tuple_lock.locktype='tuple'
              and tuple_lock.relation='issues'::regclass and tuple_lock.mode='AccessExclusiveLock' and tuple_lock.granted)) as waiting`);
        return observed.waiting;
      },{timeout:5000,interval:25}).toBe(true);
      expect(checks).toEqual(["discovery"]);
      if(deadline==="expired")await db.update(assignments).set({expiresAt:new Date(Date.now()-1)}).where(eq(assignments.id,f.assignment.id));
      else await db.execute(sql`update muse_runner_assignments set expires_at='infinity'::timestamptz where id=${f.assignment.id}::uuid`);
      const [changedAssignment]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));
      expect(changedAssignment.status).toBe("accepted");expect(changedAssignment.expiresAt).toBeInstanceOf(Date);
      if(deadline==="expired")expect(changedAssignment.expiresAt.getTime()).toBeLessThan(Date.now());
      else expect(Number.isFinite(changedAssignment.expiresAt.getTime())).toBe(false);
      // Connection authority stays live; only the assignment deadline changed.
      await expect(assertMuseSubjectCredential(db,f.subject,oauthResource)).resolves.toBeDefined();
      expect((await inspectMuseConnectionCredential(db,f.binding,oauthResource)).state).toBe("active");
      expect(checks).toEqual(["discovery"]);
      release();await holder;
      const outcome=await operation;
      expect(checks).toEqual(["discovery","transaction"]);
      expect(outcome.error).toMatchObject({status:403,message:"Muse assignment unavailable."});expect(outcome.result).toBeUndefined();
      const after=await snapshot();expect(after).toEqual(before);expect(after.run[0].status).toBe("running");
      const receipts=(after.run[0].resultJson as {semanticToolReceipts?:Record<string,unknown>}|null)?.semanticToolReceipts;
      if(replay)expect(receipts?.[idempotencyKey]).toMatchObject({operationId:"write_document",input:call.arguments,result:priorResult});
      else expect(receipts?.[idempotencyKey]).toBeUndefined();
      expect(after.assignment).toEqual([{status:"accepted",acceptedResultAt:null,finalizedAt:null}]);
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
    }finally{release();await Promise.allSettled([holder,operation]);await f.detach();}
  });
  it("preserves the ordinary non-Muse document receipt path without invoking Muse authority",async()=>{
    const f=await active();try{
      await db.update(agents).set({adapterConfig:{provider:"codex"}}).where(eq(agents.id,f.agent.id));
      await db.update(heartbeatRuns).set({driverKind:"codex_app_server"}).where(eq(heartbeatRuns.id,f.runId));
      const assertBridgeAuthority=vi.fn(async()=>{throw new Error("Muse authority must not guard this ordinary native binding");});
      const authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,assertBridgeAuthority});
      const call={tool:"write_document",callId:randomUUID(),arguments:{key:"report",title:"Report",body:"Ordinary native document",baseRevisionId:null,idempotencyKey:randomUUID()}};
      const result=await authority.execute(call);expect(result).toMatchObject({disposition:"applied",document:{body:call.arguments.body}});
      expect(await authority.execute({...call,callId:randomUUID()})).toEqual(result);
      expect(await documentService(db).listIssueDocumentRevisions(f.issue.id,"report")).toHaveLength(1);expect(assertBridgeAuthority).not.toHaveBeenCalled();
    }finally{await f.detach();}
  });
  it.each(["prepare","commit","replay"] as const)("rejects contended Muse reassignment targets without an idle-comment deadlock (%s)",async phase=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},native:Promise<{result?:unknown;error?:unknown}>|undefined,idle:Promise<{result?:Record<string,unknown>;error?:unknown}>|undefined;
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const [target]=await db.insert(issues).values({companyId:f.company.id,title:"Reassignment target",status:phase==="commit"?"in_progress":"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
      const oldRun=phase==="commit"?randomUUID():null;
      if(oldRun){
        await db.insert(heartbeatRuns).values({id:oldRun,companyId:f.company.id,agentId:f.agent.id,nativeIssueId:target.id,status:"running",runtimeMode:"native",invocationSource:"assignment",triggerDetail:"system"});
        await db.update(issues).set({executionRunId:oldRun,checkoutRunId:oldRun}).where(eq(issues.id,target.id));
      }
      const stopTaskForReassignment=vi.fn(async()=>{
        // Existing stop callback boundary: persist a cancellation acknowledgment
        // outside row locks, so the production compensation path is exercised.
        if(oldRun)await db.update(heartbeatRuns).set({status:"cancelled",errorCode:"issue_reassigned"}).where(eq(heartbeatRuns.id,oldRun));
      });
      const enqueueWakeup=vi.fn(async()=>({id:randomUUID()}));
      const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}};
      let armed=false,txChecks=0,nativePid=0,idlePid=0,ready=()=>{};
      const entered=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      const authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,
        museRuntime:true,externalAuthorizingUserId:f.operatorId,stopTaskForReassignment,enqueueWakeup,
        assertBridgeAuthority:async(database=db)=>{
          await f.broker.assertRunAuthority(execution,database);
          if(database!==db&&armed&&++txChecks===(phase==="prepare"?1:2)){
            nativePid=(await database.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
            ready();await gate;
          }
        }});
      const call={tool:"reassign_task",callId:randomUUID(),arguments:{taskId:target.id,assigneeActorId:null,assigneeUserId:f.operatorId,expectedAssigneeActorId:f.agent.id,expectedStatusVersion:0,reason:"Retain target context while handing work to its operator",idempotencyKey:randomUUID()}};
      let priorReceipt:unknown;
      if(phase==="replay"){
        priorReceipt=await authority.execute(call);
        expect(await authority.execute({...call,callId:randomUUID()})).toEqual(priorReceipt);
        expect((await db.select().from(issues).where(eq(issues.id,target.id)))[0]).toMatchObject({assigneeAgentId:null,assigneeUserId:f.operatorId,statusVersion:1});
      }
      const readTarget=async()=>{
        const [row]=await db.select({assigneeAgentId:issues.assigneeAgentId,assigneeUserId:issues.assigneeUserId,status:issues.status,statusVersion:issues.statusVersion,executionRunId:issues.executionRunId,checkoutRunId:issues.checkoutRunId}).from(issues).where(eq(issues.id,target.id));return row;
      };
      const readReassignments=()=>db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.entityId,target.id),eq(activityLog.action,"issue.reassigned")));
      const beforeTarget=await readTarget(),beforeReassignments=await readReassignments();
      const beforeRun=(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)))[0];
      const beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const beforeAssignment=(await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0];
      const beforeStops=stopTaskForReassignment.mock.calls.length,beforeWakes=enqueueWakeup.mock.calls.length;
      const command={version:1 as const,command:"task.comment" as const,requestId:randomUUID(),issueId:target.id,body:"Concurrent idle coordination"};
      armed=true;native=authority.execute({...call,callId:randomUUID()}).then(result=>({result}),error=>({error}));
      await expect.poll(()=>nativePid,{timeout:5000,interval:25}).toBeGreaterThan(0);
      await entered;
      const admissionKey=`paperclip:external-admission:${f.company.id}:${f.agent.id}`;
      const nativeAdmission=await db.execute<{pid:number}>(sql`select pid from pg_locks where pid=${nativePid} and locktype='advisory' and granted and objsubid=1
        and classid=((hashtextextended(${admissionKey},0)>>32)&4294967295)::oid and objid=(hashtextextended(${admissionKey},0)&4294967295)::oid`);
      expect(nativeAdmission).toHaveLength(1);
      idle=f.broker.act(f.subject,command).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [waiter]=await db.execute<{pid:number}>(sql`select waiting.pid from pg_locks waiting
          inner join pg_locks held on held.pid=${nativePid} and held.locktype='advisory' and held.granted
            and held.classid=waiting.classid and held.objid=waiting.objid and held.objsubid=waiting.objsubid
          where waiting.locktype='advisory' and not waiting.granted and ${nativePid}=any(pg_blocking_pids(waiting.pid))
            and waiting.objsubid=1 and waiting.classid=((hashtextextended(${admissionKey},0)>>32)&4294967295)::oid
            and waiting.objid=(hashtextextended(${admissionKey},0)&4294967295)::oid`);
        idlePid=waiter?.pid??0;return idlePid;
      },{timeout:5000,interval:25}).toBeGreaterThan(0);
      // The real idle path acquired target before requesting this admission key.
      // Releasing the native callback now permits the original B <-> admission cycle.
      release();
      const [nativeOutcome,idleOutcome]=await Promise.all([native,idle]);
      const observed=JSON.stringify({phase,nativePid,idlePid,nativeCode:(nativeOutcome.error as {cause?:{code?:string};code?:string}|undefined)?.cause?.code??(nativeOutcome.error as {code?:string}|undefined)?.code,idleCode:(idleOutcome.error as {cause?:{code?:string};code?:string}|undefined)?.cause?.code??(idleOutcome.error as {code?:string}|undefined)?.code});
      expect(nativeOutcome.error,observed).toMatchObject({status:409,message:"paperclip_runner_reassignment_conflict: target is busy; retry after current work settles"});
      expect(idleOutcome.error,observed).toBeUndefined();expect(idleOutcome.result).toMatchObject({status:"commented",issueId:target.id});
      expect(await readTarget()).toEqual(beforeTarget);expect(await readReassignments()).toEqual(beforeReassignments);
      const [afterRun]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
      expect(afterRun.resultJson).toEqual(beforeRun.resultJson);expect(afterRun.status).toBe(beforeRun.status);
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual(beforeAssignment);
      expect(stopTaskForReassignment).toHaveBeenCalledTimes(beforeStops+(phase==="commit"?1:0));
      expect(enqueueWakeup).toHaveBeenCalledTimes(beforeWakes+(phase==="commit"?1:0));
      if(oldRun){
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,oldRun)))[0]).toMatchObject({status:"cancelled",errorCode:"issue_reassigned"});
        expect(enqueueWakeup).toHaveBeenLastCalledWith(f.agent.id,expect.objectContaining({payload:{issueId:target.id,mutation:"reassign_task_rollback",interruptedRunId:oldRun},issueStateGuard:{statuses:["todo","in_progress"],assigneeAgentId:f.agent.id,statusVersion:0}}));
      }
      const idleReceipts=await db.select().from(museIdleReceipts).where(and(eq(museIdleReceipts.bindingId,f.binding.id),eq(museIdleReceipts.bindingGeneration,f.binding.generation),eq(museIdleReceipts.requestId,command.requestId)));
      expect(idleReceipts).toHaveLength(1);expect(idleReceipts[0].outcome).toEqual(idleOutcome.result);
      expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId,target.id),eq(issueComments.body,command.body)))).toHaveLength(1);
      armed=false;
      const result=await authority.execute({...call,callId:randomUUID()});
      if(phase==="replay")expect(result).toEqual(priorReceipt);
      expect(await authority.execute({...call,callId:randomUUID()})).toEqual(result);
      expect(await f.broker.act(f.subject,command)).toEqual(idleOutcome.result);
      expect(await readTarget()).toMatchObject({assigneeAgentId:null,assigneeUserId:f.operatorId,status:"todo",statusVersion:1,executionRunId:null,checkoutRunId:null});
      expect(await readReassignments()).toHaveLength(1);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId,target.id))).toHaveLength(2);
      const [settledRun]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
      expect((settledRun.resultJson as {semanticToolReceipts:Record<string,unknown>}).semanticToolReceipts[call.arguments.idempotencyKey]).toMatchObject({operationId:"reassign_task",input:call.arguments,result});
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual(beforeAssignment);
    }finally{release();await Promise.allSettled([native,idle]);await f.detach();}
  });
  it("preserves ordinary native reassignment waiting on a held target",async()=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},holder:Promise<void>|undefined,native:Promise<{result?:unknown;error?:unknown}>|undefined;
    try {
      await db.update(heartbeatRuns).set({driverKind:"codex_app_server"}).where(eq(heartbeatRuns.id,f.runId));
      const [target]=await db.insert(issues).values({companyId:f.company.id,title:"Ordinary reassignment target",status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
      let ready=()=>{},holderPid=0;const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        await tx.select({id:issues.id}).from(issues).where(and(eq(issues.id,target.id),eq(issues.companyId,f.company.id))).for("update");ready();await gate;
      });
      await locked;
      const assertBridgeAuthority=vi.fn(async()=>{throw new Error("Muse authority must not guard ordinary reassignment");});
      const authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,assertBridgeAuthority,stopTaskForReassignment:vi.fn(async()=>{})});
      const call={tool:"reassign_task",callId:randomUUID(),arguments:{taskId:target.id,assigneeActorId:null,assigneeUserId:f.operatorId,expectedAssigneeActorId:f.agent.id,expectedStatusVersion:0,reason:"Ordinary handoff",idempotencyKey:randomUUID()}};
      native=authority.execute(call).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [observed]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks waiting
          inner join pg_locks held on held.pid=${holderPid} and held.locktype='transactionid' and held.granted and held.transactionid=waiting.transactionid
          where waiting.locktype='transactionid' and not waiting.granted and ${holderPid}=any(pg_blocking_pids(waiting.pid))) as waiting`);
        return observed.waiting;
      },{timeout:5000,interval:25}).toBe(true);
      release();await holder;
      const result=await native;expect(result.error).toBeUndefined();expect(result.result).toMatchObject({disposition:"applied",stateRevision:1});
      expect(await authority.execute({...call,callId:randomUUID()})).toEqual(result.result);
      expect((await db.select().from(issues).where(eq(issues.id,target.id)))[0]).toMatchObject({assigneeAgentId:null,assigneeUserId:f.operatorId,statusVersion:1});
      expect(assertBridgeAuthority).not.toHaveBeenCalled();
    }finally{release();await Promise.allSettled([holder,native]);await f.detach();}
  });
  it("serializes native and idle child creation without a privacy-tree deadlock",async()=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},holder:Promise<void>|undefined,native:Promise<{result?:unknown;error?:unknown}>|undefined,idle:Promise<{result?:unknown;error?:unknown}>|undefined;
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}};
      const authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,
        museRuntime:true,externalAuthorizingUserId:f.operatorId,assertBridgeAuthority:(database=db)=>f.broker.assertRunAuthority(execution,database)});
      const call={tool:"create_task",callId:randomUUID(),arguments:{title:"Native child",idempotencyKey:randomUUID()}};
      const command={version:1 as const,command:"task.create" as const,requestId:randomUUID(),title:"Idle child",parentId:f.issue.id};
      const beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      let ready=()=>{},holderPid=0,nativePid=0,idlePid=0;
      const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        await tx.select({id:agents.id}).from(agents).where(and(eq(agents.id,f.agent.id),eq(agents.companyId,f.company.id))).for("update");
        ready();await gate;
      });
      await locked;
      native=authority.execute(call).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [waiter]=await db.execute<{pid:number}>(sql`select waiter.pid from pg_stat_activity waiter
          inner join pg_locks waiting on waiting.pid=waiter.pid and waiting.locktype='transactionid' and not waiting.granted
          inner join pg_locks held on held.pid=${holderPid} and held.locktype='transactionid' and held.granted
            and held.transactionid=waiting.transactionid
          where waiter.datname=current_database() and waiter.wait_event_type='Lock' and ${holderPid}=any(pg_blocking_pids(waiter.pid))
            and exists(select 1 from pg_locks tuple_lock where tuple_lock.pid=waiter.pid and tuple_lock.locktype='tuple'
              and tuple_lock.relation='agents'::regclass and tuple_lock.mode='AccessExclusiveLock' and tuple_lock.granted)
            and (select count(distinct relation) from pg_locks context_lock where context_lock.pid=waiter.pid
              and context_lock.locktype='relation' and context_lock.mode='RowShareLock' and context_lock.granted
              and context_lock.relation in ('issues'::regclass,'heartbeat_runs'::regclass,'agents'::regclass))=3`);
        nativePid=waiter?.pid??0;return nativePid;
      },{timeout:5000,interval:25}).toBeGreaterThan(0);
      idle=f.broker.act(f.subject,command).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [waiter]=await db.execute<{pid:number}>(sql`select waiter.pid from pg_stat_activity waiter
          where waiter.datname=current_database() and waiter.wait_event_type='Lock' and ${nativePid}=any(pg_blocking_pids(waiter.pid))`);
        idlePid=waiter?.pid??0;return idlePid;
      },{timeout:5000,interval:25}).toBeGreaterThan(0);
      const privacyKey=`issue-privacy-tree:${f.company.id}`;
      const privacyOwners=await db.execute<{pid:number}>(sql`select pid from pg_locks where locktype='advisory' and granted
        and pid in (${nativePid},${idlePid}) and objsubid=1
        and classid=((hashtextextended(${privacyKey},0)>>32)&4294967295)::oid
        and objid=(hashtextextended(${privacyKey},0)&4294967295)::oid order by pid`);
      expect(privacyOwners).toHaveLength(1);
      const observed=JSON.stringify({holderPid,nativePid,idlePid,privacyOwners:privacyOwners.map(row=>row.pid)});
      release();await holder;
      const [nativeOutcome,idleOutcome]=await Promise.all([native,idle]);
      expect(nativeOutcome.error,observed).toBeUndefined();expect(idleOutcome.error,observed).toBeUndefined();
      expect(nativeOutcome.result).toMatchObject({disposition:"applied",task:{parentId:f.issue.id,status:"todo",assigneeActorId:f.agent.id}});
      expect(idleOutcome.result).toMatchObject({status:"created"});
      const nativeChildId=(nativeOutcome.result as {task:{id:string}}).task.id,idleChildId=String((idleOutcome.result as {issueId:string}).issueId);
      expect(nativeChildId).not.toBe(idleChildId);
      const children=await db.select().from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.parentId,f.issue.id)));
      expect(children.map(child=>child.id).sort()).toEqual([nativeChildId,idleChildId].sort());
      const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
      expect(run.status).toBe("running");
      expect((run.resultJson as {semanticToolReceipts:Record<string,unknown>}).semanticToolReceipts[call.arguments.idempotencyKey])
        .toMatchObject({operationId:"create_task",input:call.arguments,result:nativeOutcome.result});
      const receipts=await db.select().from(museIdleReceipts).where(and(eq(museIdleReceipts.bindingId,f.binding.id),eq(museIdleReceipts.bindingGeneration,f.binding.generation),eq(museIdleReceipts.requestId,command.requestId)));
      expect(receipts).toHaveLength(1);expect(receipts[0].outcome).toEqual(idleOutcome.result);
      expect(await authority.execute({...call,callId:randomUUID()})).toEqual(nativeOutcome.result);
      expect(await f.broker.act(f.subject,command)).toEqual(idleOutcome.result);
      await expect(authority.execute({...call,callId:randomUUID(),arguments:{...call.arguments,title:"Changed native child"}})).rejects.toThrow("idempotency_conflict");
      await expect(f.broker.act(f.subject,{...command,title:"Changed idle child"})).rejects.toThrow("changed input");
      expect(await db.select({id:issues.id}).from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.parentId,f.issue.id)))).toHaveLength(2);
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toMatchObject({status:"accepted",acceptedResultAt:null,finalizedAt:null});
    }finally{release();await Promise.allSettled([holder,native,idle]);await f.detach();}
  });
  it("keeps native document writes independent of the task-creation privacy lock",async()=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},holder:Promise<void>|undefined,write:Promise<{result?:unknown;error?:unknown}>|undefined,outcome:{result?:unknown;error?:unknown}|undefined;
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}};
      const authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,
        museRuntime:true,externalAuthorizingUserId:f.operatorId,assertBridgeAuthority:(database=db)=>f.broker.assertRunAuthority(execution,database)});
      let ready=()=>{};const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holder=db.transaction(async tx=>{
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.company.id}`},0))`);ready();await gate;
      });
      await locked;
      const call={tool:"write_document",callId:randomUUID(),arguments:{key:"report",title:"Report",body:"Unrelated native mutation",baseRevisionId:null,idempotencyKey:randomUUID()}};
      write=authority.execute(call).then(result=>(outcome={result}),error=>(outcome={error}));
      await expect.poll(()=>outcome!==undefined,{timeout:5000,interval:25}).toBe(true);
      expect(outcome?.error).toBeUndefined();expect(outcome?.result).toMatchObject({disposition:"applied",document:{body:call.arguments.body}});
      expect(await documentService(db).getIssueDocumentByKey(f.issue.id,"report")).toMatchObject({body:call.arguments.body});
      expect(await authority.execute({...call,callId:randomUUID()})).toEqual(outcome?.result);
      expect(await documentService(db).listIssueDocumentRevisions(f.issue.id,"report")).toHaveLength(1);
    }finally{release();await Promise.allSettled([holder,write]);await f.detach();}
  });
  it.each(["report_progress","set_task_title","submit_complaint","submit_suggestion"].flatMap(tool=>[
    {tool,replay:false,fault:"grant_revoked" as const},
    {tool,replay:true,fault:"qualification_expired" as const},
  ]))("rechecks local Muse mutation authority after a real task-lock wait ($tool/$fault/replay=$replay)",async({tool,replay,fault})=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},holder:Promise<void>|undefined,operation:Promise<{result?:unknown;error?:unknown}>|undefined;
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}};
      const checks:string[]=[],authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,
        museRuntime:true,externalAuthorizingUserId:f.operatorId,assertBridgeAuthority:async(database=db)=>{
          await f.broker.assertRunAuthority(execution,database);checks.push(database===db?"discovery":"transaction");
        }});
      const idempotencyKey=randomUUID(),body="Muse current-authority regression",title="Current-authority title";
      const call={tool,callId:randomUUID(),arguments:tool==="set_task_title"?{title,onlyIfProvisional:false,idempotencyKey}:{body,idempotencyKey}};
      const snapshot=async()=>({
        issue:await db.select({title:issues.title,status:issues.status,statusVersion:issues.statusVersion}).from(issues).where(eq(issues.id,f.issue.id)),
        run:await db.select({status:heartbeatRuns.status,resultJson:heartbeatRuns.resultJson}).from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)),
        comments:await db.select({id:issueComments.id,body:issueComments.body}).from(issueComments).where(eq(issueComments.issueId,f.issue.id)).orderBy(issueComments.id),
        commentary:await db.select({id:agentCommentary.id,kind:agentCommentary.kind,body:agentCommentary.body,idempotencyKey:agentCommentary.idempotencyKey}).from(agentCommentary).where(eq(agentCommentary.runId,f.runId)).orderBy(agentCommentary.id),
        activity:await db.select({id:activityLog.id,action:activityLog.action,entityId:activityLog.entityId}).from(activityLog).where(eq(activityLog.companyId,f.company.id)).orderBy(activityLog.id),
      });
      if(replay){
        const first=await authority.execute(call),second=await authority.execute({...call,callId:randomUUID()});
        if(tool==="report_progress"){
          expect(first).toMatchObject({issueId:f.issue.id,disposition:"applied"});expect(second).toEqual(first);
          expect(await db.select({body:issueComments.body}).from(issueComments).where(eq(issueComments.issueId,f.issue.id))).toEqual([{body}]);
        }else if(tool==="set_task_title"){
          expect(first).toMatchObject({id:f.issue.id,title,changed:true});expect(second).toEqual(first);
          expect((await db.select({title:issues.title}).from(issues).where(eq(issues.id,f.issue.id)))[0]).toEqual({title});
        }else{
          const kind=tool==="submit_complaint"?"complaint":"suggestion";
          expect(first).toMatchObject({kind,replayed:false});expect(second).toEqual({...(first as Record<string,unknown>),replayed:true});
          expect(await db.select({kind:agentCommentary.kind,body:agentCommentary.body}).from(agentCommentary).where(eq(agentCommentary.runId,f.runId))).toEqual([{kind,body}]);
        }
      }
      const before=await snapshot(),beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      checks.length=0;
      let ready=()=>{},holderPid=0;const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        await tx.select({id:issues.id}).from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.id,f.issue.id))).for("update");ready();await gate;
      });
      await locked;
      operation=authority.execute({...call,callId:randomUUID()}).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [observed]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity waiter
          inner join pg_locks waiting on waiting.pid=waiter.pid and waiting.locktype='transactionid' and not waiting.granted
          inner join pg_locks held on held.pid=${holderPid} and held.locktype='transactionid' and held.granted and held.transactionid=waiting.transactionid
          where waiter.datname=current_database() and ${holderPid}=any(pg_blocking_pids(waiter.pid))
            and exists(select 1 from pg_locks tuple_lock where tuple_lock.pid=waiter.pid and tuple_lock.locktype='tuple'
              and tuple_lock.relation='issues'::regclass and tuple_lock.mode='AccessExclusiveLock' and tuple_lock.granted)) as waiting`);
        return observed.waiting;
      },{timeout:5000,interval:25}).toBe(true);
      expect(checks).toEqual(["discovery"]);
      if(fault==="grant_revoked")await db.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
      else await db.update(bindings).set({qualificationId:randomUUID(),qualificationExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
      await expect(f.broker.assertRunAuthority(execution)).rejects.toMatchObject({status:403});
      release();await holder;
      const outcome=await operation;
      expect(outcome.error).toMatchObject({status:403});expect(outcome.result).toBeUndefined();
      expect(await snapshot()).toEqual(before);
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      expect((await db.select({status:assignments.status,acceptedResultAt:assignments.acceptedResultAt,finalizedAt:assignments.finalizedAt}).from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual({status:"accepted",acceptedResultAt:null,finalizedAt:null});
    }finally{release();await Promise.allSettled([holder,operation]);await f.detach();}
  });
  it("rechecks native child creation authority after the real company privacy-lock wait",async()=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},holder:Promise<void>|undefined,operation:Promise<{result?:unknown;error?:unknown}>|undefined;
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}};
      const checks:string[]=[],authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:f.issue.id,runId:f.runId,
        museRuntime:true,externalAuthorizingUserId:f.operatorId,assertBridgeAuthority:async(database=db)=>{
          await f.broker.assertRunAuthority(execution,database);checks.push(database===db?"discovery":"transaction");
        }});
      const idempotencyKey=randomUUID(),call={tool:"create_task",callId:randomUUID(),arguments:{title:"Must not create after qualification expiry",idempotencyKey}};
      const beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      let ready=()=>{},holderPid=0;const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${f.company.id}`},0))`);ready();await gate;
      });
      await locked;
      operation=authority.execute(call).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [observed]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks waiting
          inner join pg_locks held on held.pid=${holderPid} and held.locktype='advisory' and held.granted
            and held.database=waiting.database and held.classid=waiting.classid and held.objid=waiting.objid and held.objsubid=waiting.objsubid
          where waiting.locktype='advisory' and not waiting.granted and ${holderPid}=any(pg_blocking_pids(waiting.pid))) as waiting`);
        return observed.waiting;
      },{timeout:5000,interval:25}).toBe(true);
      expect(checks).toEqual(["discovery"]);
      await db.update(bindings).set({qualificationId:randomUUID(),qualificationExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
      await expect(f.broker.assertRunAuthority(execution)).rejects.toMatchObject({status:403});
      release();await holder;
      const outcome=await operation;
      expect(outcome.error).toMatchObject({status:403});expect(outcome.result).toBeUndefined();
      expect(await db.select({id:issues.id}).from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.parentId,f.issue.id)))).toEqual([]);
      expect(await db.select({id:activityLog.id}).from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"issue.created")))).toEqual([]);
      const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
      expect((run.resultJson as {semanticToolReceipts?:Record<string,unknown>}|null)?.semanticToolReceipts?.[idempotencyKey]).toBeUndefined();expect(run.status).toBe("running");
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      expect((await db.select({status:assignments.status,acceptedResultAt:assignments.acceptedResultAt,finalizedAt:assignments.finalizedAt}).from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual({status:"accepted",acceptedResultAt:null,finalizedAt:null});
    }finally{release();await Promise.allSettled([holder,operation]);await f.detach();}
  });
  async function detectorCleanupFixture(provided?:Awaited<ReturnType<typeof oauthFixture>>) {
    const f=provided??await oauthFixture(true),qualificationId=randomUUID(),expiresAt=new Date(Date.now()-60_000);
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    await db.update(bindings).set({qualificationId,qualificationStartedAt:new Date(expiresAt.getTime()-86_400_000),qualificationExpiresAt:expiresAt}).where(eq(bindings.id,f.binding.id));
    await f.broker.endQualification({companyId:f.company.id,agentId:f.agent.id,bindingId:f.binding.id,qualificationId,operatorId:f.operatorId});
    const [binding]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));
    const input={bindingId:binding.id,generation:binding.generation,expectedRevision:binding.revision,qualificationId,hookScript:`~/hooks/scripts/paperclip-muse-${binding.id}.sh`,detectorRemoved:true as const,
      observation:{method:"hooks.list" as const,includeDisabled:true as const,hookId:"paperclip-synthetic-hook",outcome:"exact_hook_absent" as const,observedAt:new Date().toISOString(),sha256:"d".repeat(64)}};
    const app=express();app.use(express.json());app.use(async(req,_res,next)=>{
      const access=await boardAuthService(db).resolveBoardAccess(f.operatorId);
      Object.assign(req,{actor:{type:"board",source:"session",userId:access.user?.id,userName:access.user?.name??null,userEmail:access.user?.email??null,companyIds:access.companyIds,memberships:access.memberships,isInstanceAdmin:access.isInstanceAdmin}});next();
    });app.use(museBoardRoutes(db,oauthOrigin));app.use(activityRoutes(db));app.use(errorHandler);
    const path=`/companies/${f.company.id}/agents/${f.agent.id}/muse-binding/attest-detector-cleanup`;
    return {...f,binding,input,app,path};
  }
  it("records exact supported-runtime detector removal after OAuth expiry without restoring worker authority",async()=>{
    const f=await detectorCleanupFixture();
    await expect(f.identity.authenticateOAuthAccess(f.tokens!.access_token,oauthOrigin)).rejects.toThrow();
    const beforeTokens=await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!));
    const beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.agentId,f.agent.id));
    await instanceSettingsService(db).updateExperimental({enableMuse:false});
    try {
      const result=await request(f.app).post(f.path).send(f.input);expect(result.status).toBe(200);expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.body).toMatchObject({revision:f.binding.revision+1,evidence:{source:"operator_runtime_attestation",operatorId:f.operatorId,hookId:f.input.observation.hookId,bindingId:f.binding.id,generation:f.binding.generation,qualificationId:f.input.qualificationId}});
      const projected=await f.broker.bindingForAgent(f.company.id,f.agent.id);expect(projected!.cleanup.detectorEvidence).toEqual(result.body.evidence);expect(projected!.cleanup.attestationEligible).toBe(false);
      const evidence=await f.broker.readQualificationEvidence(f.company.id,f.agent.id,f.binding.id,f.input.qualificationId);expect(evidence.detectorCleanup).toEqual(result.body.evidence);
      expect((await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!)))).toEqual(beforeTokens);expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.agentId,f.agent.id)))).toEqual(beforeHolds);
      await expect(f.identity.authenticateOAuthAccess(f.tokens!.access_token,oauthOrigin)).rejects.toThrow();
      const rows=await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.agent.id),eq(activityLog.action,"muse.detector_cleanup_attested")));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({actorType:"user",actorId:f.operatorId,responsibleUserId:f.operatorId,agentId:f.agent.id});
      expect(rows[0].details).toMatchObject({method:"hooks.list",includeDisabled:true,outcome:"exact_hook_absent",externalStopConfirmed:false});
      expect(JSON.stringify(rows)).not.toContain(f.tokens!.access_token);expect(JSON.stringify(rows)).not.toContain(f.tokens!.refresh_token);
    }finally{await instanceSettingsService(db).updateExperimental({enableMuse:true});}
  });
  it.each(["generation","revision","qualification","script","binding"])("rejects stale detector cleanup %s",async field=>{
    const f=await detectorCleanupFixture(),input=structuredClone(f.input);
    if(field==="generation")input.generation++;if(field==="revision")input.expectedRevision++;if(field==="qualification")input.qualificationId=randomUUID();if(field==="binding")input.bindingId=randomUUID();if(field==="script")input.hookScript="~/hooks/scripts/other.sh";
    expect((await request(f.app).post(f.path).send(input)).status).toBe(409);
    const [b]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));expect(b.detectorRemovedAt).toBeNull();expect(b.revision).toBe(f.binding.revision);
  });
  it("supersedes only stale worker detector provenance with an exact post-deadline operator observation",async()=>{
    const original=await oauthFixture(true);
    const reported=await request(transport()).post("/api/muse/v1/detector-cleanup").set("Authorization",`Bearer ${original.tokens!.access_token}`).send({version:1,requestId:randomUUID(),bindingId:original.binding.id,generation:original.binding.generation,detectorRemoved:true});expect(reported.status).toBe(200);
    const [workerRow]=await db.select().from(activityLog).where(and(eq(activityLog.entityId,original.agent.id),eq(activityLog.action,"muse.detector_removal_reported")));
    const [workerBinding]=await db.select().from(bindings).where(eq(bindings.id,original.binding.id));
    const f=await detectorCleanupFixture(original);
    await db.update(bindings).set({qualificationExpiresAt:new Date(workerRow.createdAt.getTime()+1),qualificationStartedAt:new Date(workerRow.createdAt.getTime()+1-86_400_000)}).where(eq(bindings.id,f.binding.id));
    const before=await f.broker.bindingForAgent(f.company.id,f.agent.id);expect(before!.cleanup.detectorEvidence).toMatchObject({source:"authenticated_worker_report",recordedAt:workerRow.createdAt.toISOString()});expect(before!.cleanup.attestationEligible).toBe(true);
    const result=await request(f.app).post(f.path).send(f.input);expect(result.status).toBe(200);
    const after=await f.broker.bindingForAgent(f.company.id,f.agent.id);expect(after!.cleanup.detectorEvidence).toEqual(result.body.evidence);expect(after!.cleanup.detectorEvidence?.source).toBe("operator_runtime_attestation");expect(after!.cleanup.attestationEligible).toBe(false);
    expect(await db.select().from(activityLog).where(eq(activityLog.id,workerRow.id))).toEqual([workerRow]);
    expect(workerBinding.detectorRemovedAt).not.toBeNull();
    expect((await f.broker.readQualificationEvidence(f.company.id,f.agent.id,f.binding.id,f.input.qualificationId)).detectorCleanup).toEqual(result.body.evidence);
    await expect(f.identity.authenticateOAuthAccess(f.tokens!.access_token,oauthOrigin)).rejects.toThrow();
  });
  it("does not clear claimed-worker or unknown-native-effect holds when recording detector removal",async()=>{
    const activeRun=await active(await oauthFixture(true));
    try {
      expect((await activeRun.broker.act(activeRun.subject,{version:1,command:"accept",assignmentId:activeRun.assignment.id,requestId:randomUUID()})).status).toBe("accepted");
      const f=await detectorCleanupFixture(activeRun);
      await db.update(externalAgentHolds).set({nativeEffectsUnknown:true}).where(eq(externalAgentHolds.assignmentId,activeRun.assignment.id));
      const before=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,activeRun.assignment.id));expect(before).toHaveLength(1);expect(before[0]).toMatchObject({workerUnknown:true,nativeEffectsUnknown:true,releasedAt:null});
      expect((await request(f.app).post(f.path).send(f.input)).status).toBe(200);
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,activeRun.assignment.id))).toEqual(before);
      expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))!.stop).toMatchObject({status:"cannot_confirm",nativeEffectsUnknown:true});
    }finally{await activeRun.detach();}
  });
  it("requires a full supported hook listing and exact absence, not disablement or arbitrary evidence",async()=>{
    const f=await detectorCleanupFixture();
    for(const observation of [{...f.input.observation,includeDisabled:false},{...f.input.observation,includeDisabled:undefined},{...f.input.observation,outcome:"disabled"},{...f.input.observation,method:"summary"},{...f.input.observation,hookId:"https://private.example"},{...f.input.observation,sha256:"private-canary"},{...f.input.observation,url:"https://private.example"}])expect((await request(f.app).post(f.path).send({...f.input,observation})).status).toBe(400);
    expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))!.cleanup.detectorEvidence).toBeNull();
  });
  it("keeps detector evidence atomic, serialized and exact-replay idempotent",async()=>{
    const f=await detectorCleanupFixture(),spy=vi.spyOn(activityLogModule,"logActivity").mockRejectedValueOnce(new Error("synthetic audit storage failure"));
    try{expect((await request(f.app).post(f.path).send(f.input)).status).toBe(500);}finally{spy.mockRestore();}
    let [b]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));expect(b.revision).toBe(f.binding.revision);expect(b.detectorRemovedAt).toBeNull();expect(b.detectorRemovalRequestedAt).toBeNull();
    const replies=await Promise.all([request(f.app).post(f.path).send(f.input),request(f.app).post(f.path).send(f.input)]);expect(replies.map(r=>r.status)).toEqual([200,200]);expect(replies[0].body).toEqual(replies[1].body);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.agent.id),eq(activityLog.action,"muse.detector_cleanup_attested")))).toHaveLength(1);
    expect((await request(f.app).post(f.path).send({...f.input,observation:{...f.input.observation,sha256:"e".repeat(64)}})).status).toBe(409);
    [b]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));await db.update(bindings).set({revision:b.revision+1}).where(eq(bindings.id,b.id));expect((await request(f.app).post(f.path).send(f.input)).status).toBe(409);
  });
  it("does not trust public activity forgery as detector evidence or a completed replay",async()=>{
    const f=await detectorCleanupFixture();
    const forged=await request(f.app).post(`/companies/${f.company.id}/activity`).send({actorType:"user",actorId:f.operatorId,agentId:f.agent.id,responsibleUserId:f.operatorId,action:"muse.detector_cleanup_attested",entityType:"agent",entityId:f.agent.id,details:{...f.input,source:"operator_runtime_attestation",method:"hooks.list",includeDisabled:true,hookId:f.input.observation.hookId,outcome:"exact_hook_absent",recordedAt:new Date().toISOString(),observedAt:f.input.observation.observedAt}});expect(forged.status).toBe(201);expect(forged.body.responsibleUserId).toBeNull();
    await db.update(bindings).set({detectorRemovalRequestedAt:new Date(),detectorRemovedAt:new Date()}).where(eq(bindings.id,f.binding.id));
    expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))!.cleanup.detectorEvidence).toBeNull();
    expect((await request(f.app).post(f.path).send(f.input)).status).toBe(200);
    const trusted=await f.broker.bindingForAgent(f.company.id,f.agent.id);expect(trusted!.cleanup.detectorEvidence?.source).toBe("operator_runtime_attestation");
  });
  it("rejects premature, future, replaced and no-longer-authorized detector attestations",async()=>{
    const f=await detectorCleanupFixture();
    for(const observedAt of [new Date(f.binding.revokedAt!.getTime()-1).toISOString(),new Date(Date.now()+60_000).toISOString()])expect((await request(f.app).post(f.path).send({...f.input,observation:{...f.input.observation,observedAt}})).status).toBe(409);
    await db.update(companyMemberships).set({membershipRole:"viewer"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    expect((await request(f.app).post(f.path).send(f.input)).status).toBe(403);
    await db.update(companyMemberships).set({membershipRole:"owner"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    await db.insert(bindings).values({companyId:f.company.id,agentId:f.agent.id,operatorId:f.operatorId,generation:f.binding.generation+1,status:"pairing"});
    expect((await request(f.app).post(f.path).send(f.input)).status).toBe(409);
    expect((await f.broker.readQualificationEvidence(f.company.id,f.agent.id,f.binding.id,f.input.qualificationId)).detectorCleanup).toBeNull();
  });
  it("consumes a ten-minute ticket once and separates credential lanes",async()=>{
    const f=await fixture(false);await expect(f.identity.pair(f.ticket,"2")).rejects.toThrow("consumed");
    expect(f.credentials).not.toHaveProperty("signalToken");
    await expect(f.identity.authenticate(f.credentials.cleanupToken)).rejects.toThrow();
    await expect(f.identity.authenticate(f.credentials.accessToken,"signal")).rejects.toThrow();
    const legacySignal=randomBytes(32).toString("base64url");await db.insert(museCredentials).values({companyId:f.company.id,bindingId:f.binding.id,bindingGeneration:1,kind:"signal",familyId:randomUUID(),tokenHash:museCredentialHash(legacySignal),expiresAt:new Date(Date.now()+600000)});
    await expect(f.identity.authenticate(legacySignal,"signal")).rejects.toThrow("no longer supported");
    await db.delete(museCredentials).where(eq(museCredentials.tokenHash,museCredentialHash(legacySignal)));
    const rows=await db.select().from(museCredentials).where(eq(museCredentials.bindingId,f.binding.id));
    expect(rows).toHaveLength(4);expect(rows.some(r=>r.kind==="signal")).toBe(false);expect(rows.some(r=>r.tokenHash===f.credentials.accessToken)).toBe(false);
    expect(new Date(f.credentials.accessExpiresAt).getTime()-Date.now()).toBeLessThanOrEqual(15*60000);
  });
  it("rotates refresh once and commits family revocation on consumed-token replay",async()=>{
    const f=await fixture(),rotated=await f.identity.refresh(f.credentials.refreshToken);
    await expect(f.identity.authenticate(f.credentials.accessToken)).rejects.toThrow();
    await expect(f.identity.refresh(f.credentials.refreshToken)).rejects.toThrow("replay");
    await expect(f.identity.authenticate(rotated.accessToken)).rejects.toThrow();
    await expect(museReceiver(db).signal(f.binding.id)).rejects.toMatchObject({status:410});
  });
  it("polling does not extend refresh inactivity and independent contact creates the first challenge",async()=>{
    const f=await fixture(false);
    const [before]=await db.select().from(museCredentials).where(and(eq(museCredentials.bindingId,f.binding.id),eq(museCredentials.kind,"refresh")));
    expect((await museReceiver(db).signal(f.binding.id)).signal).toBeNull();await museReceiver(db).flush();
    expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))?.backgroundReplyVerified).toBe(false);
    const [after]=await db.select().from(museCredentials).where(eq(museCredentials.id,before.id));expect(after.expiresAt).toEqual(before.expiresAt);
    const items=await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:0}) as {items:Array<{references:{nonce:string}}>};expect(items.items).toHaveLength(1);
    const requestId = randomUUID(), nonce = items.items[0].references.nonce;
    await f.broker.act(f.subject,{version:1,command:"challenge.confirm",nonce,requestId});
    expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))?.backgroundReplyVerified).toBe(true);
    const logs = await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"muse.background_reply_verified")));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({actorType:"agent",actorId:f.agent.id,agentId:f.agent.id,responsibleUserId:f.operatorId,details:{bindingId:f.binding.id,generation:1,authorizingUserId:f.operatorId,requestId}});
    expect(JSON.stringify(logs)).not.toContain(nonce);
  });
  it("keeps expired public readiness quiet after an acknowledged item becomes eligible for rearm",async()=>{
    const f=await fixture();
    const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
    await f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
    const [challenge]=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge")));
    await db.update(bindings).set({challengeExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
    const poll=()=>museReceiver(db).signal(f.binding.id);
    expect(await poll()).toEqual({version:1,signal:null});
    await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:challenge.id});
    await db.update(mailbox).set({signalNotifiedAt:new Date(Date.now()-60000)}).where(eq(mailbox.id,challenge.id));
    expect(await poll()).toEqual({version:1,signal:null});
    expect((await db.select().from(mailbox).where(eq(mailbox.id,challenge.id)))[0].signalAttempt).toBe(0);
  });
  it("signals only the current unread public readiness nonce with a stable reference",async()=>{
    const f=await fixture();
    const verify=async()=>{const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;return f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});};
    const firstPending=await verify();expect(await verify()).toEqual(firstPending);
    expect(await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge")))).toHaveLength(1);
    await db.update(bindings).set({challengeExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));await verify();
    const challenges=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge"))).orderBy(mailbox.id);
    expect(challenges).toHaveLength(2);
    const current=(await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0];
    expect(museCredentialHash(String(challenges[1].references.nonce))).toBe(current.challengeHash);
    const poll=()=>museReceiver(db).signal(f.binding.id),first=await poll();
    expect(first).toEqual({version:1,signal:{reference:"sha256:"+createHash("sha256").update(`${f.binding.id}:1:${challenges[1].sourceEventId}:1`).digest("hex")}});expect(await poll()).toEqual(first);
    const saved=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge"))).orderBy(mailbox.id);
    expect(saved.map(item=>item.signalAttempt)).toEqual([0,1]);
    await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:challenges[1].id});expect(await poll()).toEqual({version:1,signal:null});
    await db.update(bindings).set({challengeExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));await verify();
    const all=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge"))).orderBy(mailbox.id);
    expect(all).toHaveLength(3);expect(await poll()).toEqual({version:1,signal:{reference:"sha256:"+createHash("sha256").update(`${f.binding.id}:1:${all[2].sourceEventId}:1`).digest("hex")}});
  });
  it.each(["automatic","board"] as const)("audits %s readiness only on first change with the actual actor",async source=>{
    const f=await fixture(false),operatorId=source==="board"?randomUUID():undefined;
    if(operatorId){
      await db.insert(authUsers).values({id:operatorId,name:"Actual board caller",email:operatorId+"@example.test",createdAt:new Date(),updatedAt:new Date()});
      await db.insert(companyMemberships).values({companyId:f.company.id,principalType:"user",principalId:operatorId,membershipRole:"owner",status:"active"});
      await db.update(bindings).set({receiverContactAt:new Date()}).where(eq(bindings.id,f.binding.id));
    }
    const events:Array<Record<string,unknown>>=[];
    const unsubscribe=subscribeCompanyLiveEvents(f.company.id,event=>{if(event.type==="activity.logged")events.push(event.payload);});
    try {
      if(source==="automatic"){
        await museReceiver(db).signal(f.binding.id);await museReceiver(db).flush();
      } else {
        const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
        await f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision},operatorId);
      }
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      const challenge=(await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge"))))[0]!;
      const pending=await f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision},operatorId);
      expect(pending).toMatchObject({revision:state.revision,expiresAt:state.challengeExpiresAt});
      await expect(f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:2,expectedRevision:state.revision},operatorId)).rejects.toThrow("before verifying");
      const logs=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"muse.readiness_challenge_created")));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({actorType:source==="board"?"user":"system",actorId:operatorId??"muse-runner",agentId:f.agent.id,responsibleUserId:operatorId??f.operatorId,entityType:"agent",entityId:f.agent.id,details:{bindingId:f.binding.id,generation:1,revision:state.revision,authorizingUserId:f.operatorId,expiresAt:state.challengeExpiresAt}});
      expect(events.filter(event=>event.action==="muse.readiness_challenge_created")).toHaveLength(1);
      expect((await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge"))))).toHaveLength(1);
      const serialized=JSON.stringify({logs,events});
      for(const secret of [f.ticket,f.credentials.accessToken,f.credentials.refreshToken,f.credentials.cleanupToken,f.credentials.detectorCleanupToken,String(challenge.references.nonce)])expect(serialized).not.toContain(secret);
    } finally {unsubscribe();}
  });
  it("audits first qualification with the actual operator and preserves idempotent reads",async()=>{
    const f=await fixture(),operatorId=randomUUID();
    await db.insert(authUsers).values({id:operatorId,name:"Qualification board caller",email:operatorId+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    await db.insert(companyMemberships).values({companyId:f.company.id,principalType:"user",principalId:operatorId,membershipRole:"owner",status:"active"});
    const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!,qualificationId=randomUUID();
    const input={companyId:f.company.id,agentId:f.agent.id,bindingId:f.binding.id,generation:1,expectedRevision:state.revision,qualificationId,expiresAt:new Date(Date.now()+24*60*60_000),operatorId};
    const events:Array<Record<string,unknown>>=[];
    const unsubscribe=subscribeCompanyLiveEvents(f.company.id,event=>{if(event.type==="activity.logged")events.push(event.payload);});
    try {
      const first=await f.broker.beginQualification(input);
      expect(await f.broker.beginQualification({...input,expiresAt:new Date(Date.now()+60_000)})).toEqual(first);
      expect(await f.broker.beginQualification({...input,expectedRevision:first.revision})).toEqual(first);
      await f.broker.readQualificationEvidence(f.company.id,f.agent.id,f.binding.id,qualificationId);
      await expect(f.broker.beginQualification({...input,companyId:randomUUID()})).rejects.toThrow("Connection changed");
      const logs=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"muse.qualification_started")));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({actorType:"user",actorId:operatorId,agentId:f.agent.id,responsibleUserId:operatorId,entityType:"agent",entityId:f.agent.id,details:{bindingId:f.binding.id,generation:1,revision:first.revision,authorizingUserId:f.operatorId,qualificationId,startedAt:first.startedAt,expiresAt:first.expiresAt}});
      expect(events.filter(event=>event.action==="muse.qualification_started")).toHaveLength(1);
      const serialized=JSON.stringify({logs,events});
      for(const secret of [f.ticket,f.credentials.accessToken,f.credentials.refreshToken,f.credentials.signalToken,f.credentials.cleanupToken,f.credentials.detectorCleanupToken])expect(serialized).not.toContain(secret);
    } finally {unsubscribe();}
  });
  it("retains a mailbox batch until its prior durable cursor is acknowledged",async()=>{
    const f=await fixture();await db.insert(mailbox).values({companyId:f.company.id,bindingId:f.binding.id,bindingGeneration:1,kind:"follow_up",sourceEventId:randomUUID(),references:{}});
    const batch=await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:0}) as {nextCursor:number};
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].workerCursor).toBe(0);
    await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:batch.nextCursor});
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].workerCursor).toBe(batch.nextCursor);
  });
  it("filters current idle task visibility even with global privacy disabled",async()=>{
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE","off");const f=await fixture();
    const other=randomUUID();await db.insert(authUsers).values({id:other,name:"other",email:other+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"secret",visibility:"private",responsibleUserId:other,assigneeAgentId:f.agent.id}).returning();
    expect((await f.broker.inspect(f.subject,{version:1,query:"task.list"}) as {tasks:unknown[]}).tasks).toEqual([]);
    await db.insert(issueAccessGrants).values({issueId:issue.id,subjectType:"user",subjectId:f.operatorId,source:"explicit"});
    expect((await f.broker.inspect(f.subject,{version:1,query:"task.list"}) as {tasks:unknown[]}).tasks).toHaveLength(1);
    await db.update(companyMemberships).set({status:"inactive"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    await expect(f.broker.inspect(f.subject,{version:1,query:"task.read",issueId:issue.id})).rejects.toThrow();vi.unstubAllEnvs();
  });
  async function idleReadFixture() {
    const f=await oauthFixture(true);
    const [allowedProject,outsideProject]=await db.insert(projects).values([
      {companyId:f.company.id,name:"Allowed project"},{companyId:f.company.id,name:"Outside project"},
    ]).returning();
    await db.update(agents).set({permissions:{trustPreset:"low_trust_review",authorizationPolicy:{trustBoundary:{mode:"low_trust_review",companyId:f.company.id,projectIds:[allowedProject.id]}}}}).where(eq(agents.id,f.agent.id));
    const [allowed,outside]=await db.insert(issues).values([
      {companyId:f.company.id,projectId:allowedProject.id,title:"idle-scope allowed",description:"allowed task content"},
      {companyId:f.company.id,projectId:outsideProject.id,title:"idle-scope forbidden",description:"outside task content"},
    ]).returning();
    for(const issue of [allowed,outside]) {
      await db.insert(issueComments).values({companyId:f.company.id,issueId:issue.id,authorType:"user",authorUserId:f.operatorId,body:issue.title+" history"});
      const [document]=await db.insert(documents).values({companyId:f.company.id,title:issue.title,latestBody:issue.title+" document"}).returning();
      await db.insert(issueDocuments).values({companyId:f.company.id,issueId:issue.id,documentId:document.id,key:"plan"});
    }
    return {...f,allowedProject,outsideProject,allowed,outside};
  }
  it.each(["task.read","task.history","task.document.read"] as const)("enforces ordinary low-trust authorization for idle %s",async(query)=>{
    const f=await idleReadFixture();
    const request=(issueId:string)=>query==="task.document.read"?{version:1 as const,query,issueId,key:"plan"}:{version:1 as const,query,issueId};
    await expect(f.broker.inspect(f.subject,request(f.outside.id))).rejects.toThrow("unavailable");
    expect(JSON.stringify(await f.broker.inspect(f.subject,request(f.allowed.id)))).toContain("idle-scope allowed");
    await db.update(agents).set({permissions:{trustPreset:"low_trust_review",authorizationPolicy:{trustBoundary:{mode:"low_trust_review",companyId:f.company.id,projectIds:[f.outsideProject.id]}}}}).where(eq(agents.id,f.agent.id));
    await expect(f.broker.inspect(f.subject,request(f.allowed.id))).rejects.toThrow("unavailable");
    expect(JSON.stringify(await f.broker.inspect(f.subject,request(f.outside.id)))).toContain("idle-scope forbidden");
  });
  it.each(["task.list","task.search"] as const)("filters idle %s with ordinary authorization without exposing restricted cursors",async(query)=>{
    const f=await idleReadFixture();
    const request=query==="task.search"?{version:1 as const,query,text:"idle-scope"}:{version:1 as const,query};
    const page=await f.broker.inspect(f.subject,request) as {tasks:Array<{id:string;title:string}>,nextCursor:string|null};
    expect(page.tasks.map(task=>task.id)).toEqual([f.allowed.id]);expect(page.nextCursor).toBe(f.allowed.id);
    expect(JSON.stringify(page)).not.toContain(f.outside.id);expect(JSON.stringify(page)).not.toContain(f.outside.title);
  });
  it.each(["task.list","task.search"] as const)("fills bounded authorized pages after rejected idle %s candidates",async(query)=>{
    const f=await idleReadFixture();await db.delete(issues).where(eq(issues.companyId,f.company.id));
    const ids=(high:boolean)=>Array.from({length:51},()=>`${high?"f0000000":"00000000"}-${randomBytes(2).toString("hex")}-4${randomBytes(2).toString("hex").slice(1)}-8${randomBytes(2).toString("hex").slice(1)}-${randomBytes(6).toString("hex")}`).sort();
    const denied=ids(false),allowed=ids(true);
    await db.insert(issues).values([...denied.map(id=>({id,companyId:f.company.id,projectId:f.outsideProject.id,title:"pagination-forbidden"})),...allowed.map(id=>({id,companyId:f.company.id,projectId:f.allowedProject.id,title:"pagination-allowed"}))]);
    const request=query==="task.search"?{version:1 as const,query,text:"pagination"}:{version:1 as const,query};
    const first=await f.broker.inspect(f.subject,request) as {tasks:Array<{id:string}>,nextCursor:string};
    expect(first.tasks.map(task=>task.id)).toEqual(allowed.slice(0,50));expect(first.nextCursor).toBe(allowed[49]);
    const last=await f.broker.inspect(f.subject,{...request,after:first.nextCursor}) as {tasks:Array<{id:string}>,nextCursor:string};
    expect(last.tasks.map(task=>task.id)).toEqual(allowed.slice(50));expect(last.nextCursor).toBe(allowed[50]);
    expect((await f.broker.inspect(f.subject,{...request,after:last.nextCursor}) as {tasks:unknown[]}).tasks).toEqual([]);
    for(const id of denied)expect(JSON.stringify([first,last])).not.toContain(id);
  });
  it.each(["task.list","task.search"] as const)("fails closed at the authorized scan limit for idle %s and accepts narrower search",async(query)=>{
    const f=await idleReadFixture();await db.delete(issues).where(eq(issues.companyId,f.company.id));
    const denied=Array.from({length:201},()=>`00000000-${randomBytes(2).toString("hex")}-4${randomBytes(2).toString("hex").slice(1)}-8${randomBytes(2).toString("hex").slice(1)}-${randomBytes(6).toString("hex")}`);
    const allowedId=`f0000000-${randomBytes(2).toString("hex")}-4${randomBytes(2).toString("hex").slice(1)}-8${randomBytes(2).toString("hex").slice(1)}-${randomBytes(6).toString("hex")}`;
    await db.insert(issues).values([...denied.map(id=>({id,companyId:f.company.id,projectId:f.outsideProject.id,title:"bounded-collection forbidden"})),{id:allowedId,companyId:f.company.id,projectId:f.allowedProject.id,title:"bounded-collection narrow-match"}]);
    const request=query==="task.search"?{version:1 as const,query,text:"bounded-collection"}:{version:1 as const,query};
    await expect(f.broker.inspect(f.subject,request)).rejects.toMatchObject({status:422,message:"Task collection exceeds its read limit. Use task.search with a narrower query."});
    const narrow=await f.broker.inspect(f.subject,{version:1,query:"task.search",text:"narrow-match"}) as {tasks:Array<{id:string}>,nextCursor:string};
    expect(narrow.tasks.map(task=>task.id)).toEqual([allowedId]);expect(narrow.nextCursor).toBe(allowedId);
  },30000);
  it("uses only the current server-derived human-directed run context for native assignment reads",async()=>{
    const f=await active(await oauthFixture(true));try {
      const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Unrelated allowed project"}).returning();
      await db.update(agents).set({permissions:{trustPreset:"low_trust_review",authorizationPolicy:{trustBoundary:{mode:"low_trust_review",companyId:f.company.id,projectIds:[project.id]}}}}).where(eq(agents.id,f.agent.id));
      await db.update(issues).set({visibility:"private"}).where(eq(issues.id,f.issue.id));
      await db.update(heartbeatRuns).set({contextSnapshot:{issueId:f.issue.id}}).where(eq(heartbeatRuns.id,f.runId));
      const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.company.id,agentId:f.agent.id,runId:f.runId,source:"assignment",status:"claimed",requestedByActorType:"user",requestedByActorId:f.operatorId,payload:{issueId:f.issue.id,_paperclipWakeContext:{source:"issue.update"}}}).returning();
      const idleRequest={version:1 as const,query:"task.read" as const,issueId:f.issue.id,runId:f.runId};
      await expect(f.broker.inspect(f.subject,idleRequest)).rejects.toThrow("unavailable");
      expect(await f.broker.inspect(f.subject,{version:1,query:"assignment.read",assignmentId:f.assignment.id})).toMatchObject({assignmentId:f.assignment.id,status:"offered"});
      await db.update(agentWakeupRequests).set({status:"cancelled"}).where(eq(agentWakeupRequests.id,wake.id));
      await expect(f.broker.inspect(f.subject,{version:1,query:"assignment.read",assignmentId:f.assignment.id})).rejects.toThrow("unavailable");
    }finally{await f.detach();}
  });
  it("rechecks current authorizer grants for every idle task read surface",async()=>{
    const f=await idleReadFixture(),other=randomUUID();
    await db.insert(authUsers).values({id:other,name:"Other author",email:other+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    await db.update(issues).set({visibility:"private",responsibleUserId:other,assigneeAgentId:f.agent.id}).where(eq(issues.id,f.allowed.id));
    const reads=[{version:1 as const,query:"task.read" as const,issueId:f.allowed.id},{version:1 as const,query:"task.history" as const,issueId:f.allowed.id},{version:1 as const,query:"task.document.read" as const,issueId:f.allowed.id,key:"plan"}];
    for(const request of reads)await expect(f.broker.inspect(f.subject,request)).rejects.toThrow();
    const [grant]=await db.insert(issueAccessGrants).values({issueId:f.allowed.id,subjectType:"user",subjectId:f.operatorId,source:"explicit"}).returning();
    for(const request of reads)expect(JSON.stringify(await f.broker.inspect(f.subject,request))).toContain("idle-scope allowed");
    await db.delete(issueAccessGrants).where(eq(issueAccessGrants.id,grant.id));
    for(const request of reads)await expect(f.broker.inspect(f.subject,request)).rejects.toThrow();
    expect((await f.broker.inspect(f.subject,{version:1,query:"task.list"}) as {tasks:unknown[]}).tasks).toEqual([]);
  });
  it("creates visible idle tasks with supported creation authority and a stable mutation receipt",async()=>{
    const f=await fixture(),command={version:1 as const,command:"task.create" as const,requestId:randomUUID(),title:"Idle intake",description:"Ordinary task intake"};
    const result=await f.broker.act(f.subject,command);
    expect(result.status).toBe("created");expect(await f.broker.act(f.subject,command)).toEqual(result);
    const [issue]=await db.select().from(issues).where(eq(issues.id,String(result.issueId)));
    expect(issue.createdByAgentId).toBe(f.agent.id);expect(issue.responsibleUserId).toBe(f.operatorId);expect(issue.status).toBe("todo");expect(issue.sourceTrust).toBeNull();
    await expect(f.broker.act(f.subject,{...command,title:"Changed intake"})).rejects.toThrow("changed input");
  });
  it("comments on an idle task using its complete current permission resource",async()=>{
    const f=await fixture();const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"Idle comment",status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const command={version:1 as const,command:"task.comment" as const,requestId:randomUUID(),issueId:issue.id,body:"Idle coordination"};
    const result=await f.broker.act(f.subject,command);expect(result.status).toBe("commented");expect(await f.broker.act(f.subject,command)).toEqual(result);
    const rows=await db.select().from(issueComments).where(eq(issueComments.issueId,issue.id));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({authorAgentId:f.agent.id,authorUserId:null,onBehalfOfUserId:f.operatorId,body:command.body,sourceTrust:null});
    await db.update(companyMemberships).set({membershipRole:"viewer"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    await expect(f.broker.act(f.subject,{...command,requestId:randomUUID()})).rejects.toThrow("authority");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId,issue.id))).toHaveLength(1);
  });
  it.each(["agent","project"] as const)("quarantines idle Muse output and retains the resolved %s trust boundary",async source=>{
    const f=await fixture();
    const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Restricted idle coordination"}).returning();
    const boundary={mode:"low_trust_review",companyId:f.company.id,projectIds:[project.id]};
    const policy={trustPreset:"low_trust_review",trustBoundary:boundary};
    if(source==="agent")await db.update(agents).set({permissions:{canCreateTasks:true,authorizationPolicy:policy}}).where(eq(agents.id,f.agent.id));
    else await db.update(projects).set({executionWorkspacePolicy:{authorizationPolicy:policy}}).where(eq(projects.id,project.id));
    const command={version:1 as const,command:"task.create" as const,requestId:randomUUID(),title:"Unreviewed idle task",description:"Untrusted task instructions",projectId:project.id};
    const created=await f.broker.act(f.subject,command);
    const [issue]=await db.select().from(issues).where(eq(issues.id,String(created.issueId)));
    expect(issue.executionPolicy).toMatchObject({authorizationPolicy:policy});
    expect(issue.sourceTrust).toMatchObject({preset:"low_trust_review",disposition:"quarantined",sourceIssueId:issue.id,sourceAgentId:f.agent.id,sourceRunId:null});
    expect(issue).toMatchObject({createdByAgentId:f.agent.id,responsibleUserId:f.operatorId,projectId:project.id});
    expect(await f.broker.act(f.subject,command)).toEqual(created);
    const [coordination]=await db.insert(issues).values({companyId:f.company.id,projectId:project.id,title:"Existing coordination",status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const commentCommand={version:1 as const,command:"task.comment" as const,requestId:randomUUID(),issueId:coordination.id,body:"Untrusted idle instructions"};
    const written=await f.broker.act(f.subject,commentCommand);
    expect(await f.broker.act(f.subject,commentCommand)).toEqual(written);
    const comments=await db.select().from(issueComments).where(eq(issueComments.issueId,coordination.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({body:commentCommand.body,authorAgentId:f.agent.id,onBehalfOfUserId:f.operatorId,sourceTrust:{preset:"low_trust_review",disposition:"quarantined",sourceIssueId:coordination.id,sourceAgentId:f.agent.id,sourceRunId:null}});
    expect(sanitizeQuarantinedCommentForHigherTrust(comments[0]).body).toBe(LOW_TRUST_QUARANTINED_BODY);
    const runId=randomUUID();
    await db.insert(heartbeatRuns).values({id:runId,companyId:f.company.id,agentId:f.agent.id,nativeIssueId:coordination.id,responsibleUserId:f.operatorId,status:"running",runtimeMode:"native",invocationSource:"assignment"});
    await db.update(issues).set({executionRunId:runId}).where(eq(issues.id,coordination.id));
    const authority=new PaperclipRunnerToolAuthority(db,{companyId:f.company.id,agentId:f.agent.id,issueId:coordination.id,runId,museRuntime:true,externalAuthorizingUserId:f.operatorId,assertBridgeAuthority:async()=>{}});
    const before=await authority.execute({tool:"get_task_history",callId:"restricted-history",arguments:{limit:50}}) as {comments:Array<{id:string,body:string}>};
    expect(before.comments.find(comment=>comment.id===comments[0].id)?.body).toBe(commentCommand.body);
    await db.update(agents).set({permissions:{canCreateTasks:true}}).where(eq(agents.id,f.agent.id));
    await db.update(projects).set({executionWorkspacePolicy:{}}).where(eq(projects.id,project.id));
    const ordinary=await f.broker.act(f.subject,{...commentCommand,requestId:randomUUID(),body:"Reviewed ordinary coordination"});
    const after=await authority.execute({tool:"get_task_history",callId:"higher-trust-history",arguments:{limit:50}}) as {comments:Array<{id:string,body:string}>};
    expect(after.comments.map(comment=>comment.id)).toEqual([comments[0].id,ordinary.commentId]);
    expect(after.comments[0].body).toBe(LOW_TRUST_QUARANTINED_BODY);
    expect(after.comments[1].body).toBe("Reviewed ordinary coordination");
    await db.update(agents).set({permissions:{canCreateTasks:true,...(source==="agent"?{authorizationPolicy:policy}:{})}}).where(eq(agents.id,f.agent.id));
    const [outside]=await db.insert(projects).values({companyId:f.company.id,name:"Outside idle boundary"}).returning();
    if(source==="agent"){
      await expect(f.broker.act(f.subject,{...command,requestId:randomUUID(),projectId:outside.id})).rejects.toThrow();
      expect(await db.select().from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.projectId,outside.id)))).toEqual([]);
    }
  });
  it.each(["agent","project"] as const)("idle history rechecks the current %s reader trust without rewriting stored comments",async source=>{
    const f=await fixture();
    const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Idle history trust"}).returning();
    const policy={trustPreset:"low_trust_review",trustBoundary:{mode:"low_trust_review",companyId:f.company.id,projectIds:[project.id]}};
    if(source==="agent")await db.update(agents).set({permissions:{canCreateTasks:true,authorizationPolicy:policy}}).where(eq(agents.id,f.agent.id));
    else await db.update(projects).set({executionWorkspacePolicy:{authorizationPolicy:policy}}).where(eq(projects.id,project.id));
    const [issue]=await db.insert(issues).values({companyId:f.company.id,projectId:project.id,title:"Idle history",status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const created=await f.broker.act(f.subject,{version:1,command:"task.comment",requestId:randomUUID(),issueId:issue.id,body:"QUARANTINED idle body canary"});
    const quarantinedId=String(created.commentId),promotedId=randomUUID(),standardId=randomUUID(),at=new Date("2026-10-13T12:00:00Z");
    const presentation={kind:"message" as const,tone:"neutral" as const,title:"QUARANTINED idle title canary",detailsDefaultOpen:false};
    const metadata={version:1 as const,sections:[{rows:[{type:"text" as const,text:"QUARANTINED idle metadata canary"}]}]};
    await db.update(issueComments).set({presentation,metadata,createdAt:at}).where(eq(issueComments.id,quarantinedId));
    await db.insert(issueComments).values([
      {id:promotedId,companyId:f.company.id,issueId:issue.id,authorAgentId:f.agent.id,authorType:"agent",body:"Reviewed promoted summary",sourceTrust:buildPromotedSourceTrust({sourceIssueId:issue.id,sourceArtifactKind:"comment",sourceArtifactId:quarantinedId,promotedByActorType:"user",promotedByActorId:f.operatorId}),createdAt:new Date(at.getTime()+1000)},
      {id:standardId,companyId:f.company.id,issueId:issue.id,authorUserId:f.operatorId,authorType:"user",body:"Ordinary human coordination",createdAt:new Date(at.getTime()+2000)},
    ]);
    const saved=await db.select().from(issueComments).where(eq(issueComments.issueId,issue.id)).orderBy(issueComments.id);
    const read=async()=>await f.broker.inspect(f.subject,{version:1,query:"task.history",issueId:issue.id}) as {comments:Array<typeof issueComments.$inferSelect>};
    const before=await read();
    expect(before.comments.map(comment=>comment.id)).toEqual([standardId,promotedId,quarantinedId]);
    expect(before.comments[2]).toMatchObject({body:"QUARANTINED idle body canary",presentation,metadata,sourceTrust:{disposition:"quarantined",sourceAgentId:f.agent.id,sourceRunId:null}});
    await db.update(agents).set({permissions:{canCreateTasks:true}}).where(eq(agents.id,f.agent.id));
    await db.update(projects).set({executionWorkspacePolicy:{}}).where(eq(projects.id,project.id));
    const after=await read();
    expect(after.comments.map(({id,sourceTrust})=>({id,sourceTrust}))).toEqual(before.comments.map(({id,sourceTrust})=>({id,sourceTrust})));
    expect(after.comments.map(comment=>comment.body)).toEqual(["Ordinary human coordination","Reviewed promoted summary",LOW_TRUST_QUARANTINED_BODY]);
    expect(after.comments[2]).toMatchObject({presentation:null,metadata:null});
    expect(JSON.stringify(after)).not.toContain("QUARANTINED idle");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId,issue.id)).orderBy(issueComments.id)).toEqual(saved);
  });
  it("idle history quarantines another restricted author and retains private and current-authorizer checks",async()=>{
    const f=await fixture(),owner=randomUUID();
    await db.insert(authUsers).values({id:owner,name:"Private owner",email:owner+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Shared history"}).returning();
    const [restricted]=await db.insert(agents).values({companyId:f.company.id,name:"Restricted author",role:"engineer",status:"active",adapterType:"process",permissions:{authorizationPolicy:{trustPreset:"low_trust_review",trustBoundary:{mode:"low_trust_review",companyId:f.company.id,projectIds:[project.id]}}}}).returning();
    const [issue]=await db.insert(issues).values({companyId:f.company.id,projectId:project.id,title:"Private mixed history",status:"todo",visibility:"private",assigneeAgentId:f.agent.id,responsibleUserId:owner}).returning();
    const [comment]=await db.insert(issueComments).values({companyId:f.company.id,issueId:issue.id,authorAgentId:restricted.id,authorType:"agent",body:"Other restricted author canary",sourceTrust:buildLowTrustSourceTrust({issueId:issue.id,agentId:restricted.id})}).returning();
    const request={version:1 as const,query:"task.history" as const,issueId:issue.id};
    await expect(f.broker.inspect(f.subject,request)).rejects.toThrow("unavailable");
    const [grant]=await db.insert(issueAccessGrants).values({issueId:issue.id,subjectType:"user",subjectId:f.operatorId,source:"explicit"}).returning();
    const history=await f.broker.inspect(f.subject,request) as {comments:Array<typeof issueComments.$inferSelect>};
    expect(history.comments).toHaveLength(1);
    expect(history.comments[0]).toMatchObject({id:comment.id,authorAgentId:restricted.id,sourceTrust:comment.sourceTrust,body:LOW_TRUST_QUARANTINED_BODY});
    expect(JSON.stringify(history)).not.toContain(comment.body);
    expect((await db.select().from(issueComments).where(eq(issueComments.id,comment.id)))[0]).toEqual(comment);
    await db.delete(issueAccessGrants).where(eq(issueAccessGrants.id,grant.id));
    await expect(f.broker.inspect(f.subject,request)).rejects.toThrow("unavailable");
    await db.insert(issueAccessGrants).values({issueId:issue.id,subjectType:"user",subjectId:f.operatorId,source:"explicit"});
    expect((await f.broker.inspect(f.subject,request) as {comments:unknown[]}).comments).toHaveLength(1);
    await db.update(companyMemberships).set({status:"inactive"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    await expect(f.broker.inspect(f.subject,request)).rejects.toThrow();
  });
  it.each(["agent","project"] as const)("idle documents recheck current %s reader trust and preserve stored bytes",async source=>{
    const f=await fixture();
    const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Idle document trust"}).returning();
    const policy={trustPreset:"low_trust_review",trustBoundary:{mode:"low_trust_review",companyId:f.company.id,projectIds:[project.id]}};
    if(source==="agent")await db.update(agents).set({permissions:{canCreateTasks:true,authorizationPolicy:policy}}).where(eq(agents.id,f.agent.id));
    else await db.update(projects).set({executionWorkspacePolicy:{authorizationPolicy:policy}}).where(eq(projects.id,project.id));
    const [issue]=await db.insert(issues).values({companyId:f.company.id,projectId:project.id,title:"Idle document context",status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const [quarantined]=await db.insert(documents).values({companyId:f.company.id,title:"Restricted plan",latestBody:"QUARANTINED document body canary",latestRevisionNumber:3,createdByAgentId:f.agent.id,sourceTrust:buildLowTrustSourceTrust({issueId:issue.id,agentId:f.agent.id})}).returning();
    const [promoted]=await db.insert(documents).values({companyId:f.company.id,title:"Reviewed plan",latestBody:"Reviewed promoted document",sourceTrust:buildPromotedSourceTrust({sourceIssueId:issue.id,sourceArtifactKind:"document",sourceArtifactId:quarantined.id,promotedByActorType:"user",promotedByActorId:f.operatorId})}).returning();
    const [standard]=await db.insert(documents).values({companyId:f.company.id,title:"Ordinary plan",latestBody:"Ordinary human document",createdByUserId:f.operatorId}).returning();
    await db.insert(issueDocuments).values([quarantined,promoted,standard].map((document,index)=>({companyId:f.company.id,issueId:issue.id,documentId:document.id,key:["plan","reviewed","ordinary"][index]!})));
    const saved=await db.select().from(documents).where(eq(documents.companyId,f.company.id)).orderBy(documents.id);
    const read=async(key:string)=>await f.broker.inspect(f.subject,{version:1,query:"task.document.read",issueId:issue.id,key}) as {document:{key:string,title:string|null,body:string,revision:number,sourceTrust:typeof quarantined.sourceTrust}};
    expect((await read("plan")).document.body).toBe(quarantined.latestBody);
    await db.update(agents).set({permissions:{canCreateTasks:true}}).where(eq(agents.id,f.agent.id));
    await db.update(projects).set({executionWorkspacePolicy:{}}).where(eq(projects.id,project.id));
    const after=await read("plan");
    expect(after.document.body).toBe(LOW_TRUST_QUARANTINED_BODY);
    expect(after.document).toEqual({key:"plan",title:quarantined.title,body:LOW_TRUST_QUARANTINED_BODY,revision:3,sourceTrust:quarantined.sourceTrust});
    expect(JSON.stringify(after)).not.toContain(quarantined.latestBody);
    expect((await read("reviewed")).document).toMatchObject({body:promoted.latestBody,sourceTrust:promoted.sourceTrust});
    expect((await read("ordinary")).document).toMatchObject({body:standard.latestBody,sourceTrust:null});
    expect(await db.select().from(documents).where(eq(documents.companyId,f.company.id)).orderBy(documents.id)).toEqual(saved);
  });
  it("idle documents retain private, company and current-authorizer checks",async()=>{
    const f=await fixture(),owner=randomUUID();
    await db.insert(authUsers).values({id:owner,name:"Private document owner",email:owner+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    const [restricted]=await db.insert(agents).values({companyId:f.company.id,name:"Restricted document author",role:"engineer",status:"active",adapterType:"process"}).returning();
    const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"Private document",status:"todo",visibility:"private",assigneeAgentId:f.agent.id,responsibleUserId:owner}).returning();
    const [document]=await db.insert(documents).values({companyId:f.company.id,title:"Private plan",latestBody:"OTHER restricted document canary",createdByAgentId:restricted.id,sourceTrust:buildLowTrustSourceTrust({issueId:issue.id,agentId:restricted.id})}).returning();
    await db.insert(issueDocuments).values({companyId:f.company.id,issueId:issue.id,documentId:document.id,key:"plan"});
    const request={version:1 as const,query:"task.document.read" as const,issueId:issue.id,key:"plan"};
    await expect(f.broker.inspect(f.subject,request)).rejects.toThrow("unavailable");
    const [grant]=await db.insert(issueAccessGrants).values({issueId:issue.id,subjectType:"user",subjectId:f.operatorId,source:"explicit"}).returning();
    const result=await f.broker.inspect(f.subject,request) as {document:{body:string,sourceTrust:typeof document.sourceTrust}};
    expect(result.document.body).toBe(LOW_TRUST_QUARANTINED_BODY);
    expect(result.document.sourceTrust).toEqual(document.sourceTrust);
    expect((await db.select().from(documents).where(eq(documents.id,document.id)))[0]).toEqual(document);
    const [foreign]=await db.insert(companies).values({name:"Foreign documents",issuePrefix:"FD"+randomBytes(3).toString("hex")}).returning();
    const [foreignIssue]=await db.insert(issues).values({companyId:foreign.id,title:"Foreign issue"}).returning();
    const [foreignDocument]=await db.insert(documents).values({companyId:foreign.id,latestBody:"Foreign document canary"}).returning();
    await db.insert(issueDocuments).values({companyId:f.company.id,issueId:issue.id,documentId:foreignDocument.id,key:"foreign"});
    await expect(f.broker.inspect(f.subject,{...request,issueId:foreignIssue.id})).rejects.toThrow("unavailable");
    await expect(f.broker.inspect(f.subject,{...request,key:"foreign"})).rejects.toThrow("Document not found");
    await db.delete(issueAccessGrants).where(eq(issueAccessGrants.id,grant.id));
    await expect(f.broker.inspect(f.subject,request)).rejects.toThrow("unavailable");
    await db.insert(issueAccessGrants).values({issueId:issue.id,subjectType:"user",subjectId:f.operatorId,source:"explicit"});
    await db.update(companyMemberships).set({status:"inactive"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    await expect(f.broker.inspect(f.subject,request)).rejects.toThrow();
  });
  it("applies idle creation grants to the actual inherited parent project",async()=>{
    const f=await fixture();const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Protected intake",executionWorkspacePolicy:{authorizationPolicy:{assignmentPolicy:{mode:"protected"}}}}).returning();
    const [parent]=await db.insert(issues).values({companyId:f.company.id,title:"Intake parent",projectId:project.id,status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const command={version:1 as const,command:"task.create" as const,requestId:randomUUID(),title:"Scoped child",parentId:parent.id};
    await expect(f.broker.act(f.subject,command)).rejects.toThrow("protected");
    await db.insert(principalPermissionGrants).values({companyId:f.company.id,principalType:"agent",principalId:f.agent.id,permissionKey:"tasks:assign_scope",scope:{projectIds:[randomUUID()]}});
    await expect(f.broker.act(f.subject,command)).rejects.toThrow();
    await db.update(principalPermissionGrants).set({scope:{projectIds:[project.id]}}).where(and(eq(principalPermissionGrants.companyId,f.company.id),eq(principalPermissionGrants.principalId,f.agent.id)));
    await expect(f.broker.act(f.subject,command)).rejects.toThrow("Authorizing user");
    await db.insert(principalPermissionGrants).values({companyId:f.company.id,principalType:"user",principalId:f.operatorId,permissionKey:"tasks:assign_scope",scope:{projectIds:[randomUUID()]}});
    await expect(f.broker.act(f.subject,command)).rejects.toThrow();
    await db.update(principalPermissionGrants).set({scope:{projectIds:[project.id]}}).where(and(eq(principalPermissionGrants.companyId,f.company.id),eq(principalPermissionGrants.principalId,f.operatorId)));
    const result=await f.broker.act(f.subject,command);expect(result.status).toBe("created");
    const [child]=await db.select().from(issues).where(eq(issues.id,String(result.issueId)));expect(child.parentId).toBe(parent.id);expect(child.projectId).toBe(project.id);
  });
  it("creates an assigned turn intake atomically before requesting ordinary admission",async()=>{
    const f=await fixture(),wakeup=vi.fn().mockImplementation(async(agentId,options)=>{
      const [issue]=await db.select().from(issues).where(eq(issues.id,options.payload.issueId));
      expect(agentId).toBe(f.agent.id);expect(issue.assigneeAgentId).toBe(f.agent.id);expect(issue.responsibleUserId).toBe(f.operatorId);return null;
    });
    museRunnerBroker(db,{heartbeat:{wakeup,cancelRun:vi.fn()}});
    const command={version:1 as const,command:"turn.request" as const,requestId:randomUUID(),prompt:"Research ordinary intake"};
    expect((await f.broker.act(f.subject,command)).status).toBe("requested");expect(wakeup).toHaveBeenCalledTimes(1);
    await expect(f.broker.act(f.subject,{...command,prompt:"Changed intake"})).rejects.toThrow("changed input");
    expect(await db.select().from(issues).where(eq(issues.companyId,f.company.id))).toHaveLength(1);
  });
  it("atomically reserves a work identity across competing issue locks and replays its original run",async()=>{
    // This fixture exercises ordinary admission independently of a managed worktree env.
    const f=await active(),heartbeat=heartbeatService(db,{runtimeEnv:{}}),wakeup=vi.fn(heartbeat.wakeup);
    museRunnerBroker(db,{heartbeat:{wakeup,cancelRun:heartbeat.cancelRun}});
    await db.update(companies).set({defaultResponsibleUserId:f.operatorId}).where(eq(companies.id,f.company.id));
    await db.update(agents).set({runtimeConfig:{heartbeat:{maxConcurrentRuns:20,wakeOnDemand:true}}}).where(eq(agents.id,f.agent.id));
    const task=async(title:string)=>(await db.insert(issues).values({companyId:f.company.id,title,status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning())[0]!;
    const first=await task("First request"),second=await task("Changed request"),requestId=randomUUID();
    const commands=[first,second].map(issue=>({version:1 as const,command:"work.request" as const,requestId,issueId:issue.id}));
    try {
      const race=await Promise.allSettled(commands.map(command=>f.broker.act(f.subject,command)));
      expect(race.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(race.filter(r=>r.status==="rejected")).toHaveLength(1);
      const receipts=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId,f.agent.id),eq(agentWakeupRequests.idempotencyKey,`muse-work:${f.binding.id}:1:${requestId}`)));
      expect(receipts).toHaveLength(1);const receipt=receipts[0],command=commands.find(c=>c.issueId===receipt.payload?.issueId)!;
      expect(receipt.payload?.museRequestDigest).toBe(externalOperationDigest("tool",{command}));expect(receipt.runId).toBeTruthy();
      const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,receipt.runId!));expect(run.contextSnapshot?.issueId).toBe(command.issueId);expect(run.status).toBe("queued");
      const response=(race.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<Record<string,unknown>>).value;
      wakeup.mockClear();
      expect(await Promise.all(Array.from({length:3},()=>f.broker.act(f.subject,command)))).toEqual([response,response,response]);
      await db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,run.id));
      await db.update(issues).set({status:"done"}).where(eq(issues.id,command.issueId));
      expect(await f.broker.act(f.subject,command)).toEqual(response);expect(wakeup).not.toHaveBeenCalled();
      await expect(f.broker.act(f.subject,commands.find(c=>c.issueId!==command.issueId)!)).rejects.toThrow("changed input");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agent.id))).toHaveLength(2);
    }finally{await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.agentId,f.agent.id));await f.detach();}
  },30000);
  it("keeps concurrent turn retries on one assigned intake and one durable wake",async()=>{
    // This fixture exercises ordinary admission independently of a managed worktree env.
    const f=await active(),heartbeat=heartbeatService(db,{runtimeEnv:{}}),wakeup=vi.fn(heartbeat.wakeup);
    museRunnerBroker(db,{heartbeat:{wakeup,cancelRun:heartbeat.cancelRun}});
    await db.update(companies).set({defaultResponsibleUserId:f.operatorId}).where(eq(companies.id,f.company.id));
    await db.update(agents).set({runtimeConfig:{heartbeat:{maxConcurrentRuns:20,wakeOnDemand:true}}}).where(eq(agents.id,f.agent.id));
    const command={version:1 as const,command:"turn.request" as const,requestId:randomUUID(),prompt:"One ordinary turn intake"};
    try {
      const responses=await Promise.all(Array.from({length:3},()=>f.broker.act(f.subject,command)));
      expect(responses).toEqual([responses[0],responses[0],responses[0]]);
      const intake=await db.select().from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.title,command.prompt)));
      expect(intake).toHaveLength(1);expect(intake[0].assigneeAgentId).toBe(f.agent.id);
      const rows=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId,f.agent.id),eq(agentWakeupRequests.idempotencyKey,`muse-work:${f.binding.id}:1:${command.requestId}`)));
      expect(rows).toHaveLength(1);expect(rows[0].payload?.museRequestDigest).toBe(externalOperationDigest("tool",{command}));expect(rows[0].runId).toBe(responses[0].runId);
      wakeup.mockClear();expect(await f.broker.act(f.subject,command)).toEqual(responses[0]);expect(wakeup).not.toHaveBeenCalled();
      await expect(f.broker.act(f.subject,{version:1,command:"work.request",issueId:intake[0].id,requestId:command.requestId})).rejects.toThrow("changed input");
      await expect(f.broker.act(f.subject,{...command,prompt:"Changed turn prompt"})).rejects.toThrow("changed input");expect(wakeup).not.toHaveBeenCalled();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agent.id))).toHaveLength(2);
    }finally{await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.agentId,f.agent.id));await f.detach();}
  },30000);
  it("does not enqueue a replacement for an older receipt without an exact payload digest",async()=>{
    const f=await fixture(),wakeup=vi.fn();museRunnerBroker(db,{heartbeat:{wakeup,cancelRun:vi.fn()}});
    const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"Old receipt",status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const command={version:1 as const,command:"work.request" as const,issueId:issue.id,requestId:randomUUID()};
    await db.insert(agentWakeupRequests).values({companyId:f.company.id,agentId:f.agent.id,source:"assignment",requestedByActorType:"agent",requestedByActorId:f.agent.id,idempotencyKey:`muse-work:${f.binding.id}:1:${command.requestId}`,payload:{issueId:issue.id,museRequestId:command.requestId}});
    await expect(f.broker.act(f.subject,command)).rejects.toThrow("changed input");expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agent.id))).toHaveLength(1);
  });
  it("admits one authenticated claim and keeps claimed/native accepted times distinct",async()=>{
    const f=await active();try {
      const requestId=randomUUID(),claim={version:1 as const,command:"accept" as const,assignmentId:f.assignment.id,requestId};
      expect((await f.broker.act(f.subject,claim)).status).toBe("accepted");expect(f.sent).toHaveLength(1);
      expect((await f.broker.act(f.subject,claim)).status).toBe("accepted");expect(f.sent).toHaveLength(1);
      await expect(f.broker.act(f.subject,{...claim,requestId:randomUUID()})).rejects.toThrow("claimed");
      const [a]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));expect(a.claimedAt).toBeInstanceOf(Date);expect(a.nativeAcceptedAt).toBeInstanceOf(Date);
      await expect(db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)))).rejects.toMatchObject({details:{code:"external_agent_overlap"}});
    }finally{await f.detach();}
  });

  it.each([
    ["oauth","accept"],["oauth","tool"],["legacy","accept"],["legacy","tool"],
  ] as const)("rechecks exact %s access after native %s waits for admission",async(source,action)=>{
    const oauth=source==="oauth"?await oauthFixture(true):undefined;
    const f=await active(oauth??await fixture());
    try {
      if(action==="tool")await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const requestId=randomUUID();
      const command=action==="accept"
        ? {version:1 as const,command:"accept" as const,assignmentId:f.assignment.id,requestId}
        : {version:1 as const,command:"tool" as const,assignmentId:f.assignment.id,requestId,name:"get_task_history",arguments:{}};
      const [before]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));
      const heldBefore=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const sentBefore=f.sent.length;
      let outcome:Promise<{value?:unknown;error?:unknown}>|undefined;
      await db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,async()=>{
        await tx.select().from(bindings).where(eq(bindings.id,f.binding.id)).for("update");
        outcome=f.broker.act(f.subject,command).then(value=>({value}),error=>({error}));
        // The caller passed the initial exact-token check and now really waits
        // on the production admission lock. Only its presented access expires.
        await expect.poll(async()=>{const rows=await db.execute(sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and lower(wait_event)='advisory'`);return Number(rows[0]?.count??0);},{timeout:5000,interval:25}).toBeGreaterThan(0);
        if(source==="oauth")await tx.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthTokens.id,f.subject.credentialId));
        else await tx.update(museCredentials).set({expiresAt:new Date(Date.now()-1)}).where(eq(museCredentials.id,f.subject.credentialId));
      }));
      expect((await outcome!).error).toBeDefined();
      expect(await db.select().from(operations).where(eq(operations.requestId,requestId))).toHaveLength(0);
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual(before);
      expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(heldBefore);
      expect(f.sent).toHaveLength(sentBefore);
      const [binding]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));
      expect((await inspectMuseConnectionCredential(db,binding,source==="oauth"?oauthResource:undefined)).state).toBe("active");
      // A normal refresh can retry the same still-unreserved command exactly
      // once; the access check must not turn into a refresh-family denial.
      const fresh=oauth
        ? await f.identity.authenticateOAuthAccess((await oauth.oauth.token({grant_type:"refresh_token",client_id:oauth.client.client_id,refresh_token:oauth.tokens!.refresh_token})).access_token,oauthOrigin)
        : await f.identity.authenticate((await f.identity.refresh(f.credentials.refreshToken)).accessToken);
      expect(await f.broker.act(fresh,command)).toMatchObject({status:action==="accept"?"accepted":"completed"});
      expect(await db.select().from(operations).where(eq(operations.requestId,requestId))).toHaveLength(1);
      expect(f.sent).toHaveLength(sentBefore+1);
    }finally{await f.detach();}
  });
  it("recovers a durably admitted command after normal OAuth access rotation",async()=>{
    const oauth=await oauthFixture(true),f=await active(oauth),requestId=randomUUID();
    await f.detach();let detach:()=>Promise<void>|void=()=>{};
    try {
      expect(await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId})).toMatchObject({status:"pending"});
      const [reserved]=await db.select().from(operations).where(eq(operations.requestId,requestId));expect(reserved.status).toBe("reserved");expect(f.sent).toHaveLength(0);
      const rotated=await oauth.oauth.token({grant_type:"refresh_token",client_id:oauth.client.client_id,refresh_token:oauth.tokens!.refresh_token});
      const fresh=await f.identity.authenticateOAuthAccess(rotated.access_token,oauthOrigin);
      // Refresh rotates its own family member; an older access can remain
      // valid until its TTL. Model that TTL elapsing after durable admission.
      await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthTokens.id,f.subject.credentialId));
      await expect(assertMuseSubjectCredential(db,f.subject,oauthResource)).rejects.toThrow();
      detach=await f.port.attach(async command=>{f.sent.push(command);await f.port.settle({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId:command.requestId,outcome:{status:"accepted"}}});},undefined,true);
      await expect.poll(async()=>(await db.select().from(operations).where(eq(operations.id,reserved.id)))[0].status).toBe("settled");
      expect(f.sent).toHaveLength(1);
      expect(await f.broker.inspect(fresh,{version:1,query:"operation.receipt",assignmentId:f.assignment.id,requestId})).toMatchObject({status:"accepted"});
      const [claimed]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));expect(claimed.claimedAt).toBeInstanceOf(Date);expect(claimed.nativeAcceptedAt).toBeInstanceOf(Date);
    }finally{await detach();}
  });
  it.each([false,true])("excludes fenced historical answers from pending health while retaining stop barriers:effects=%s",async(nativeEffectsUnknown)=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const requestId="cancelled_question",response={schema:"paperclip.question_response.v1",answers:[]},inputDigest=digestPaperclipSemanticContent({requestId,turnId:f.ref.turnId,response});
      await f.port.inputAvailable({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId,turnId:f.ref.turnId,inputDigest,response}});
      const [answer]=await db.select().from(museInputDeliveries).where(eq(museInputDeliveries.assignmentId,f.assignment.id));
      expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))!.pendingInputs).toBe(1);
      if(nativeEffectsUnknown)await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"pending",command:{action:"tool"},status:"pending"});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      const stopped=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      expect(stopped.pendingInputs).toBe(0);expect(stopped.stop.nativeEffectsUnknown).toBe(nativeEffectsUnknown);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0].workerUnknown).toBe(true);
      await expect(f.broker.act(f.subject,{version:1,command:"consume_input",assignmentId:f.assignment.id,requestId:randomUUID(),nativeRequestId:requestId,inputDigest,continuationReceiptId:randomUUID(),continuationPersisted:true})).rejects.toThrow();
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:stopped.stop.boundary!,expectedRevision:stopped.stop.bindingRevision!,workerStopped:true});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(hold.workerUnknown).toBe(false);expect(hold.nativeEffectsUnknown).toBe(nativeEffectsUnknown);
      const admission=db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)));
      if(nativeEffectsUnknown){expect(hold.releasedAt).toBeNull();await expect(admission).rejects.toMatchObject({details:{code:"external_agent_overlap"}});}
      else {expect(hold.releasedAt).toBeInstanceOf(Date);await expect(admission).resolves.toBeUndefined();}
      expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))!.pendingInputs).toBe(0);
      expect((await db.select().from(museInputDeliveries).where(eq(museInputDeliveries.id,answer.id)))[0]).toEqual(answer);expect(answer.consumedAt).toBeNull();
    }finally{await f.detach();}
  });

  it("persists canonical input before ACK and separates client proof from exact native input",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const requestId="native_question",response={schema:"paperclip.question_response.v1",answers:[]},inputDigest=digestPaperclipSemanticContent({requestId,turnId:f.ref.turnId,response});
      await f.port.inputAvailable({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId,turnId:f.ref.turnId,inputDigest,response}});
      expect(await db.select().from(museInputDeliveries).where(eq(museInputDeliveries.assignmentId,f.assignment.id))).toHaveLength(1);
      await expect(f.broker.act(f.subject,{version:1,command:"finish",assignmentId:f.assignment.id,requestId:randomUUID(),result:{}})).rejects.toThrow("input");
      const proof=randomUUID();await f.broker.act(f.subject,{version:1,command:"consume_input",assignmentId:f.assignment.id,requestId:randomUUID(),nativeRequestId:requestId,inputDigest,continuationReceiptId:proof,continuationPersisted:true});
      expect(f.sent.at(-1)?.input).toEqual({requestId,inputDigest});expect((await db.select().from(museInputDeliveries).where(eq(museInputDeliveries.assignmentId,f.assignment.id)))[0].continuationReceiptId).toBe(proof);
    }finally{await f.detach();}
  });
  it("accepts exact connected OAuth cleanup and rejects revoked OAuth replay",async()=>{
    const oauth=await oauthFixture(true),f=await active(oauth);try {
      expect(await db.select().from(museCredentials).where(eq(museCredentials.bindingId,f.binding.id))).toEqual([]);
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"oauth-cleanup-pending",command:{action:"tool"},status:"pending"});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [before]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const inspect=await request(transport()).post("/api/muse/v1/cleanup").set("Authorization","Bearer "+oauth.tokens!.access_token).send({version:1,command:"control.inspect"});
      expect(inspect.status).toBe(200);expect(inspect.body).toMatchObject({boundaries:[{boundary:before.stopBoundary,nativeEffectsUnknown:true}],externalStopConfirmed:false});
      const report={version:1,command:"worker.quiescent",boundary:before.stopBoundary,requestId:randomUUID()};
      const response=await request(transport()).post("/api/muse/v1/cleanup").set("Authorization","Bearer "+oauth.tokens!.access_token).send(report);
      expect(response.status).toBe(200);expect(response.body).toMatchObject({status:"worker_reported",externalStopConfirmed:false,nativeEffectsUnknown:true});
      const [after]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,before.id));
      expect(after.workerReportedAt).toBeInstanceOf(Date);expect(after).toMatchObject({workerUnknown:true,nativeEffectsUnknown:true,releasedAt:null});
      await oauth.oauth.revokeToken(oauth.tokens!.refresh_token,oauth.client.client_id);
      expect((await request(transport()).post("/api/muse/v1/cleanup").set("Authorization","Bearer "+oauth.tokens!.access_token).send(report)).status).toBe(401);
      await expect(f.broker.cleanup(f.subject,{command:"worker.quiescent",boundary:before.stopBoundary!,requestId:report.requestId})).rejects.toThrow();
    }finally{await f.detach();}
  });
  it.each(["expired older hold","released older hold","Dot older hold","live older assignment"])("scopes connected OAuth cleanup to its current boundary despite %s",async(kind)=>{
    const oauth=await oauthFixture(true),f=await active(oauth);try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [current]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const [olderAssignment]=await db.insert(assignments).values({...f.assignment,id:randomUUID(),turnId:"older_"+randomUUID(),status:kind==="live older assignment"?"accepted":"fenced"}).returning();
      const boundary={...current.stopBoundary!,assignmentId:olderAssignment.id,turnId:olderAssignment.turnId,stopNonce:randomUUID()};
      const [older]=await db.insert(externalAgentHolds).values({companyId:f.company.id,agentId:f.agent.id,provider:kind==="Dot older hold"?"openai_dot":"muse",bindingId:f.binding.id,bindingGeneration:1,assignmentId:olderAssignment.id,runId:f.runId,stopBoundary:boundary,releasedAt:kind==="released older hold"?new Date():null}).returning();
      await db.insert(mailbox).values({companyId:f.company.id,bindingId:f.binding.id,bindingGeneration:1,assignmentId:olderAssignment.id,kind:"authority_revoked",sourceEventId:randomUUID(),references:{boundary},createdAt:kind==="expired older hold"?new Date(Date.now()-25*60*60_000):new Date()});
      const inspect=await request(transport()).post("/api/muse/v1/cleanup").set("Authorization","Bearer "+oauth.tokens!.access_token).send({version:1,command:"control.inspect"});
      expect(inspect.status).toBe(200);expect(inspect.body).toMatchObject({boundaries:[{boundary:current.stopBoundary}],externalStopConfirmed:false});
      const report=await request(transport()).post("/api/muse/v1/cleanup").set("Authorization","Bearer "+oauth.tokens!.access_token).send({version:1,command:"worker.quiescent",boundary,requestId:randomUUID()});
      expect(report.status).toBe(409);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,older.id)))[0]).toEqual(older);
    }finally{await f.detach();}
  });
  it("bounds connected OAuth cleanup by the earliest exact fence receipt without sliding its deadline",async()=>{
    const oauth=await oauthFixture(true),f=await active(oauth);try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [receipt]=await db.select().from(mailbox).where(and(eq(mailbox.assignmentId,f.assignment.id),eq(mailbox.kind,"authority_revoked")));
      await db.update(mailbox).set({createdAt:new Date(Date.now()-25*60*60_000)}).where(eq(mailbox.id,receipt.id));
      await db.update(externalAgentHolds).set({updatedAt:new Date()}).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      await db.update(assignments).set({lastActivityAt:new Date()}).where(eq(assignments.id,f.assignment.id));
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      expect(await db.select().from(mailbox).where(and(eq(mailbox.assignmentId,f.assignment.id),eq(mailbox.kind,"authority_revoked")))).toHaveLength(2);
      const response=await request(transport()).post("/api/muse/v1/cleanup").set("Authorization","Bearer "+oauth.tokens!.access_token).send({version:1,command:"control.inspect"});
      expect(response.status).toBe(403);
      expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))!.credentialState).toBe("active");
    }finally{await f.detach();}
  });
  it.each(["expired access","used access","revoked grant","expired refresh family","wrong resource","binding generation","operator changed"])("revalidates connected OAuth cleanup before stale-subject effects: %s",async(reason)=>{
    const oauth=await oauthFixture(true),f=await active(oauth);try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      if(reason==="expired access")await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthTokens.id,f.subject.credentialId));
      if(reason==="used access")await db.update(mcpOauthTokens).set({usedAt:new Date()}).where(eq(mcpOauthTokens.id,f.subject.credentialId));
      if(reason==="revoked grant")await db.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.subject.grantId!));
      if(reason==="expired refresh family")await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(and(eq(mcpOauthTokens.grantId,f.subject.grantId!),eq(mcpOauthTokens.kind,"refresh")));
      if(reason==="wrong resource")await db.update(mcpOauthGrants).set({resource:oauthOrigin+"/api/mcp"}).where(eq(mcpOauthGrants.id,f.subject.grantId!));
      if(reason==="binding generation")await db.update(bindings).set({generation:2}).where(eq(bindings.id,f.binding.id));
      if(reason==="operator changed")await db.update(bindings).set({operatorId:randomUUID()}).where(eq(bindings.id,f.binding.id));
      await expect(f.broker.cleanup(f.subject,{command:"control.inspect"})).rejects.toThrow();
      await expect(f.broker.cleanup(f.subject,{command:"worker.quiescent",boundary:hold.stopBoundary!,requestId:randomUUID()})).rejects.toThrow();
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,hold.id)))[0]).toEqual(hold);
    }finally{await f.detach();}
  });

  it("allows connected legacy fenced cleanup without granting normal or detector authority",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      // Acceptance precedes the fence: the hold's creation time is not its cleanup deadline.
      await db.update(externalAgentHolds).set({createdAt:new Date(Date.now()-48*60*60_000)}).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"cleanup-pending",command:{action:"tool"},status:"pending"});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [binding]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));
      expect(binding.revokedAt).toBeNull();
      const [before]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const subject=await f.identity.authenticate(f.credentials.cleanupToken,"cleanup");
      await expect(f.identity.authenticate(f.credentials.cleanupToken)).rejects.toThrow();
      await expect(f.broker.inspect(subject,{version:1,query:"task.list"})).rejects.toMatchObject({status:401,message:"Muse test credential is unavailable."});
      await expect(f.identity.authenticate(f.credentials.detectorCleanupToken,"detector_cleanup")).rejects.toThrow();
      const inspection=await f.broker.cleanup(subject,{command:"control.inspect"});
      expect(inspection.externalStopConfirmed).toBe(false);
      expect(inspection).toMatchObject({boundaries:[{boundary:before.stopBoundary,nativeEffectsUnknown:true}]});
      await expect(f.broker.cleanup(subject,{command:"worker.quiescent",boundary:{...before.stopBoundary!,stopNonce:randomUUID()},requestId:randomUUID()})).rejects.toThrow("boundary");
      const report=await f.broker.cleanup(subject,{command:"worker.quiescent",boundary:before.stopBoundary!,requestId:randomUUID()});
      expect(report).toMatchObject({status:"worker_reported",externalStopConfirmed:false,nativeEffectsUnknown:true});
      const [after]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(after.workerReportedAt).toBeInstanceOf(Date);expect(after.workerUnknown).toBe(true);
      expect(after.nativeEffectsUnknown).toBe(true);expect(after.releasedAt).toBeNull();
      await expect(f.broker.act(subject,{version:1,command:"tool",assignmentId:f.assignment.id,requestId:randomUUID(),name:"paperclip_task_read",arguments:{}})).rejects.toThrow();
    }finally{await f.detach();}
  });

  it.each(["expired older hold","released older hold","Dot older hold","live older assignment"])("scopes connected legacy cleanup to its current boundary despite %s",async(kind)=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [current]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const [olderAssignment]=await db.insert(assignments).values({...f.assignment,id:randomUUID(),turnId:"older_"+randomUUID(),status:kind==="live older assignment"?"accepted":"fenced"}).returning();
      const boundary={...current.stopBoundary!,assignmentId:olderAssignment.id,turnId:olderAssignment.turnId,stopNonce:randomUUID()};
      const [older]=await db.insert(externalAgentHolds).values({companyId:f.company.id,agentId:f.agent.id,provider:kind==="Dot older hold"?"openai_dot":"muse",bindingId:f.binding.id,bindingGeneration:1,assignmentId:olderAssignment.id,runId:f.runId,stopBoundary:boundary,releasedAt:kind==="released older hold"?new Date():null}).returning();
      await db.insert(mailbox).values({companyId:f.company.id,bindingId:f.binding.id,bindingGeneration:1,assignmentId:olderAssignment.id,kind:"authority_revoked",sourceEventId:randomUUID(),references:{boundary},createdAt:kind==="expired older hold"?new Date(Date.now()-25*60*60_000):new Date()});
      const cleanup=await f.identity.authenticate(f.credentials.cleanupToken,"cleanup");
      expect(await f.broker.cleanup(cleanup,{command:"control.inspect"})).toMatchObject({boundaries:[{boundary:current.stopBoundary}],externalStopConfirmed:false});
      await expect(f.broker.cleanup(cleanup,{command:"worker.quiescent",boundary,requestId:randomUUID()})).rejects.toThrow("boundary");
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,older.id)))[0]).toEqual(older);
      expect(await f.broker.cleanup(cleanup,{command:"worker.quiescent",boundary:current.stopBoundary!,requestId:randomUUID()})).toMatchObject({status:"worker_reported",externalStopConfirmed:false});
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,current.id)))[0]).toMatchObject({workerUnknown:true,releasedAt:null});
    }finally{await f.detach();}
  });
  it("replays an identical legacy revoked historical cleanup report without mutating or accepting a new report",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!,boundary=state.stop.boundary!,requestId=randomUUID();
      const command={command:"worker.quiescent" as const,boundary,requestId};
      const connected=await f.identity.authenticate(f.credentials.cleanupToken,"cleanup");
      const report=await f.broker.cleanup(connected,command);
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary,expectedRevision:state.stop.bindingRevision!,workerStopped:true});
      const attested=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:1,expectedRevision:attested.revision});
      const revoked=await f.identity.authenticate(f.credentials.cleanupToken,"cleanup");
      const [before]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));expect(before.releasedAt).toBeInstanceOf(Date);
      const logsBefore=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"muse.worker_quiescence_reported")));
      expect(await f.broker.cleanup(revoked,command)).toEqual(report);
      await expect(f.broker.cleanup(revoked,{...command,requestId:randomUUID()})).rejects.toThrow("boundary");
      expect(await f.broker.cleanup(revoked,{command:"control.inspect"})).toEqual({boundaries:[],externalStopConfirmed:false});
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toEqual(before);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"muse.worker_quiescence_reported")))).toEqual(logsBefore);
    }finally{await f.detach();}
  });

  it("does not renew connected cleanup from mutable holds or later revocation receipts",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [original]=await db.select().from(mailbox).where(and(eq(mailbox.assignmentId,f.assignment.id),eq(mailbox.kind,"authority_revoked")));
      await db.update(mailbox).set({createdAt:new Date(Date.now()-24*60*60_000-60_000)}).where(eq(mailbox.id,original.id));
      await db.update(externalAgentHolds).set({updatedAt:new Date()}).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      await db.update(assignments).set({lastActivityAt:new Date()}).where(eq(assignments.id,f.assignment.id));
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const receipts=await db.select().from(mailbox).where(and(eq(mailbox.assignmentId,f.assignment.id),eq(mailbox.kind,"authority_revoked")));
      expect(receipts).toHaveLength(2);expect(receipts.some(row=>row.createdAt.getTime()>Date.now()-60_000)).toBe(true);
      await expect(f.identity.authenticate(f.credentials.cleanupToken,"cleanup")).rejects.toThrow("Cleanup authority");
    }finally{await f.detach();}
  });

  it.each(["no hold","released hold","other provider","hold company","hold agent","hold binding","hold generation","binding generation","assignment company","assignment agent","assignment binding","assignment generation","live assignment","missing boundary","boundary binding","boundary generation","boundary run","boundary turn","boundary revision","missing fence receipt","expired credential","revoked credential","consumed credential"])(
    "denies connected cleanup with %s",async(reason)=>{
      const f=await active();try {
        await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
        await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
        const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
        const other=reason.endsWith("company")||reason.endsWith("agent")||reason.endsWith("binding")?await fixture():null;
        const holdChanges:Partial<typeof externalAgentHolds.$inferInsert>={
          ...(reason==="released hold"?{releasedAt:new Date()}:{}),
          ...(reason==="other provider"?{provider:"openai_dot"}:{}),
          ...(reason==="hold company"?{companyId:other!.company.id}:{}),
          ...(reason==="hold agent"?{agentId:other!.agent.id}:{}),
          ...(reason==="hold binding"?{bindingId:other!.binding.id}:{}),
          ...(reason==="hold generation"?{bindingGeneration:2}:{}),
          ...(reason==="missing boundary"?{stopBoundary:null}:{}),
        };
        if(reason.startsWith("boundary "))holdChanges.stopBoundary={...hold.stopBoundary!,
          ...(reason==="boundary binding"?{bindingId:other!.binding.id}:{}),
          ...(reason==="boundary generation"?{generation:2}:{}),
          ...(reason==="boundary run"?{runId:randomUUID()}:{}),
          ...(reason==="boundary turn"?{turnId:"different-turn"}:{}),
          ...(reason==="boundary revision"?{assignmentRevision:99}:{}),
        };
        if(reason==="no hold")await db.delete(externalAgentHolds).where(eq(externalAgentHolds.id,hold.id));
        else if(Object.keys(holdChanges).length)await db.update(externalAgentHolds).set(holdChanges).where(eq(externalAgentHolds.id,hold.id));
        const assignmentChanges:Partial<typeof assignments.$inferInsert>={
          ...(reason==="assignment company"?{companyId:other!.company.id}:{}),
          ...(reason==="assignment agent"?{agentId:other!.agent.id}:{}),
          ...(reason==="assignment binding"?{bindingId:other!.binding.id}:{}),
          ...(reason==="assignment generation"?{bindingGeneration:2}:{}),
          ...(reason==="live assignment"?{status:"accepted"}:{}),
        };
        if(Object.keys(assignmentChanges).length)await db.update(assignments).set(assignmentChanges).where(eq(assignments.id,f.assignment.id));
        if(reason==="binding generation")await db.update(bindings).set({generation:2}).where(eq(bindings.id,f.binding.id));
        if(reason==="missing fence receipt")await db.delete(mailbox).where(and(eq(mailbox.assignmentId,f.assignment.id),eq(mailbox.kind,"authority_revoked")));
        if(reason.endsWith("credential"))await db.update(museCredentials).set({
          ...(reason==="expired credential"?{expiresAt:new Date(Date.now()-1)}:{}),
          ...(reason==="revoked credential"?{revokedAt:new Date()}:{}),
          ...(reason==="consumed credential"?{consumedAt:new Date()}:{}),
        }).where(eq(museCredentials.tokenHash,museCredentialHash(f.credentials.cleanupToken)));
        await expect(f.identity.authenticate(f.credentials.cleanupToken,"cleanup")).rejects.toThrow();
      }finally{await f.detach();}
    },
  );

  it("keeps revoked cleanup bounded to its existing deadline and current generation",async()=>{
    const f=await fixture();const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
    await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
    await expect(f.identity.authenticate(f.credentials.cleanupToken,"cleanup")).resolves.toMatchObject({bindingId:f.binding.id,generation:1});
    await db.update(bindings).set({generation:2}).where(eq(bindings.id,f.binding.id));
    await expect(f.identity.authenticate(f.credentials.cleanupToken,"cleanup")).rejects.toThrow();
    await db.update(bindings).set({generation:1,cleanupExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
    await expect(f.identity.authenticate(f.credentials.cleanupToken,"cleanup")).rejects.toThrow();
    await expect(f.identity.authenticate(f.credentials.detectorCleanupToken,"detector_cleanup")).rejects.toThrow();
  });

  it("fences without fabricating private stop and retains unknown native effects across operator attestation",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await db.update(externalAgentHolds).set({nativeEffectsUnknown:true}).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
      const stopped=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!,boundary=stopped.stop.boundary!;expect(stopped.stop.status).toBe("cannot_confirm");
      await instanceSettingsService(db).updateExperimental({enableMuse:false});
      const cleanup=await f.identity.authenticate(f.credentials.cleanupToken,"cleanup"), requestId=randomUUID();
      expect((await f.broker.cleanup(cleanup,{command:"worker.quiescent",boundary,requestId})).externalStopConfirmed).toBe(false);
      await f.broker.cleanup(cleanup,{command:"worker.quiescent",boundary,requestId});
      const logs=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"muse.worker_quiescence_reported")));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({actorType:"agent",actorId:f.agent.id,responsibleUserId:f.operatorId,details:{authorizingUserId:f.operatorId,bindingId:f.binding.id,generation:1,boundary,nativeEffectsUnknown:true,externalStopConfirmed:false,requestId}});
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary,expectedRevision:stopped.revision,workerStopped:true});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));expect(hold.workerUnknown).toBe(false);expect(hold.nativeEffectsUnknown).toBe(true);expect(hold.releasedAt).toBeNull();
      await expect(f.identity.authenticate(f.credentials.accessToken)).rejects.toThrow();
    }finally{await instanceSettingsService(db).updateExperimental({enableMuse:true});await f.detach();}
  });
  it.each([false,true].flatMap(removed=>["access_expired","grant_revoked","refresh_expired","qualification_expired","unchanged"].map(fault=>({removed,fault}))))("rechecks OAuth detector evidence after the exact binding wait ($fault; removed: $removed)",async({removed,fault})=>{
      const f=await oauthFixture(true),app=transport(),beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.agentId,f.agent.id));
      const events:Record<string,unknown>[]=[];const unsubscribe=subscribeCompanyLiveEvents(f.company.id,event=>{if(event.type==="activity.logged")events.push(event.payload);});
      let enter=()=>{},release=()=>{},ready=()=>{},holderPid=0,holder:Promise<void>|undefined,response:Promise<{result?:{status:number;body:Record<string,unknown>};error?:unknown}>|undefined;
      const entry=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{ready=resolve;});
      // OAuth authentication updates workerActivityAt first. Pause only after it
      // reaches the actual cleanup method, then observe that method's row wait.
      const original=f.broker.detectorCleanup.bind(f.broker),observer=vi.spyOn(f.broker,"detectorCleanup").mockImplementation(async(subject,wasRemoved)=>{await entry;return original(subject,wasRemoved);});
      try{
        const body={version:1,bindingId:f.binding.id,generation:f.binding.generation,requestId:randomUUID(),...(removed?{detectorRemoved:true}:{detectorRemovalRequested:true})};
        response=request(app).post("/api/muse/v1/detector-cleanup").set("Authorization","Bearer "+f.tokens!.access_token).send(body).then(result=>({result}),error=>({error}));
        await expect.poll(()=>observer.mock.calls.length,{timeout:5000,interval:25}).toBe(1);
        expect(observer.mock.calls[0][0]).toMatchObject({credentialSource:"oauth",credentialId:f.subject.credentialId,grantId:f.subject.grantId,bindingId:f.binding.id,generation:f.binding.generation});
        holder=db.transaction(async tx=>{
          holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
          await tx.select({id:bindings.id}).from(bindings).where(eq(bindings.id,f.binding.id)).for("update");ready();await gate;
          if(fault==="access_expired")await tx.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthTokens.id,f.subject.credentialId));
          if(fault==="grant_revoked")await tx.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.subject.grantId!));
          if(fault==="refresh_expired")await tx.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(and(eq(mcpOauthTokens.grantId,f.subject.grantId!),eq(mcpOauthTokens.kind,"refresh")));
          if(fault==="qualification_expired")await tx.update(bindings).set({qualificationId:randomUUID(),qualificationStartedAt:new Date(Date.now()-60000),qualificationExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
        });
        await locked;enter();
        await expect.poll(async()=>{
          const [row]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity waiter
            inner join pg_locks waiting on waiting.pid=waiter.pid and waiting.locktype='transactionid' and not waiting.granted
            inner join pg_locks held on held.pid=${holderPid} and held.locktype='transactionid' and held.granted and held.transactionid=waiting.transactionid
            where waiter.datname=current_database() and ${holderPid}=any(pg_blocking_pids(waiter.pid))
              and exists(select 1 from pg_locks tuple_lock where tuple_lock.pid=waiter.pid and tuple_lock.locktype='tuple'
                and tuple_lock.relation='muse_agent_bindings'::regclass and tuple_lock.mode='AccessExclusiveLock' and tuple_lock.granted)) as waiting`);
          return row.waiting;
        },{timeout:5000,interval:25}).toBe(true);
        release();await holder;const outcome=await response;expect(outcome.error).toBeUndefined();
        const [binding]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));
        const audits=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),sql`${activityLog.action} like 'muse.detector_removal_%'`));
        if(fault==="unchanged"){
          expect(outcome.result!.status).toBe(200);expect(outcome.result!.body).toMatchObject({status:removed?"detector_removed":"detector_removal_requested",externalStopConfirmed:false});
          expect(removed?binding.detectorRemovedAt:binding.detectorRemovalRequestedAt).toBeInstanceOf(Date);
          expect(audits).toHaveLength(1);expect(audits[0]).toMatchObject({actorType:"agent",actorId:f.agent.id,agentId:f.agent.id,responsibleUserId:f.operatorId,details:{bindingId:f.binding.id,generation:f.binding.generation,authorizingUserId:f.operatorId,externalStopConfirmed:false}});
          const replay=await request(app).post("/api/muse/v1/detector-cleanup").set("Authorization","Bearer "+f.tokens!.access_token).send(body);expect(replay.status).toBe(200);
          expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),sql`${activityLog.action} like 'muse.detector_removal_%'`))).toEqual(audits);
          expect(events.filter(event=>event.action===audits[0].action)).toHaveLength(1);
        }else{
          expect(outcome.result!.status).toBe(401);expect(binding.detectorRemovalRequestedAt).toBeNull();expect(binding.detectorRemovedAt).toBeNull();
          expect(audits).toEqual([]);expect(events.filter(event=>String(event.action).startsWith("muse.detector_removal_"))).toEqual([]);
        }
        expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.agentId,f.agent.id))).toEqual(beforeHolds);
      }finally{enter();release();await Promise.allSettled([holder,response]);observer.mockRestore();unsubscribe();}
  });
  it.each(["credential_expired","window_expired","unchanged"] as const)("retains bounded legacy detector authority after a real binding wait (%s)",async fault=>{
    const f=await fixture(),state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
    await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:f.binding.generation,expectedRevision:state.revision});
    let release=()=>{},ready=()=>{},holderPid=0,holder:Promise<void>|undefined,response:Promise<{status:number;body:Record<string,unknown>}>|undefined;
    const gate=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{ready=resolve;});
    try{
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        await tx.select({id:bindings.id}).from(bindings).where(eq(bindings.id,f.binding.id)).for("update");ready();await gate;
        if(fault==="credential_expired")await tx.update(museCredentials).set({expiresAt:new Date(Date.now()-1)}).where(and(eq(museCredentials.bindingId,f.binding.id),eq(museCredentials.kind,"detector_cleanup")));
        if(fault==="window_expired")await tx.update(bindings).set({cleanupExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
      });
      await locked;
      response=request(transport(true)).post("/api/muse/v1/detector-cleanup").set("Authorization","Bearer "+f.credentials.detectorCleanupToken).send({version:1,bindingId:f.binding.id,generation:f.binding.generation,requestId:randomUUID(),detectorRemoved:true}).then(result=>result);
      await expect.poll(async()=>{
        const [row]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity waiter
          inner join pg_locks waiting on waiting.pid=waiter.pid and waiting.locktype='transactionid' and not waiting.granted
          inner join pg_locks held on held.pid=${holderPid} and held.locktype='transactionid' and held.granted and held.transactionid=waiting.transactionid
          where waiter.datname=current_database() and ${holderPid}=any(pg_blocking_pids(waiter.pid))
            and exists(select 1 from pg_locks tuple_lock where tuple_lock.pid=waiter.pid and tuple_lock.locktype='tuple'
              and tuple_lock.relation='muse_agent_bindings'::regclass and tuple_lock.mode='AccessExclusiveLock' and tuple_lock.granted)) as waiting`);
        return row.waiting;
      },{timeout:5000,interval:25}).toBe(true);
      release();await holder;const result=await response;
      const [binding]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));
      const audits=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"muse.detector_removal_reported")));
      if(fault==="unchanged"){expect(result.status).toBe(200);expect(binding.detectorRemovedAt).toBeInstanceOf(Date);expect(audits).toHaveLength(1);}
      else{expect(result.status).toBe(403);expect(binding.detectorRemovedAt).toBeNull();expect(audits).toEqual([]);}
      expect(binding.revokedAt).toBeInstanceOf(Date);expect(binding.detectorRemovalRequestedAt).toBeNull();expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.agentId,f.agent.id))).toEqual([]);
    }finally{release();await Promise.allSettled([holder,response]);}
  });

  it("audits detector cleanup once per observation and preserves exact agent attribution",async()=>{
    const f=await fixture();
    const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
    await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
    const subject=await f.identity.authenticate(f.credentials.detectorCleanupToken,"detector_cleanup");
    for (const removed of [false,false,true,true]) expect((await f.broker.detectorCleanup(subject,removed)).externalStopConfirmed).toBe(false);
    const logs=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),sql`${activityLog.action} like 'muse.detector_removal_%'`));
    expect(logs.map(row=>row.action).sort()).toEqual(["muse.detector_removal_reported","muse.detector_removal_requested"]);
    for (const log of logs) expect(log).toMatchObject({actorType:"agent",actorId:f.agent.id,agentId:f.agent.id,responsibleUserId:f.operatorId,details:{bindingId:f.binding.id,generation:1,authorizingUserId:f.operatorId,externalStopConfirmed:false}});
    await expect(f.broker.detectorCleanup({...subject,agentId:randomUUID()},true)).rejects.toThrow("binding changed");
  });
  it("reports the exact old stop revision after repair and cancels only the fenced native run",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const cancelRun=vi.fn().mockResolvedValue(null);
      museRunnerBroker(db,{heartbeat:{wakeup:vi.fn().mockResolvedValue(null),cancelRun}});
      const before=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      const pairing=await f.broker.createPairing({companyId:f.company.id,agentId:f.agent.id,operatorId:f.operatorId,replaceBindingId:f.binding.id,expectedRevision:before.revision});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      expect(state.id).toBe(pairing.bindingId);expect(state.stop.boundary?.bindingId).toBe(f.binding.id);
      expect(state.stop.bindingRevision).toBe(before.revision+1);expect(state.revision).not.toBe(state.stop.bindingRevision);
      expect(cancelRun).toHaveBeenCalledWith(f.runId,"Muse connection replaced");
      const boundary=state.stop.boundary!;
      await expect(f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary,expectedRevision:state.revision,workerStopped:true})).rejects.toThrow("Stop boundary changed");
      await db.update(bindings).set({revision:state.revision+10}).where(eq(bindings.id,state.id));
      const refreshed=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      expect(refreshed.stop.bindingRevision).toBe(state.stop.bindingRevision);expect(refreshed.stop.boundary).toEqual(boundary);
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary,expectedRevision:refreshed.stop.bindingRevision!,workerStopped:true});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(hold.workerUnknown).toBe(false);expect(hold.operatorAttestedAt).toBeInstanceOf(Date);
      await expect(f.identity.authenticate(f.credentials.accessToken)).rejects.toThrow();
    }finally{await f.detach();}
  });

  it.each(["prior_window","overlapping_window","unreleased_effect_hold"] as const)("retains historical pending-input qualification periods without blocking later proven idle:%s",async(kind)=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const requestId="historical_question",response={schema:"paperclip.question_response.v1",answers:[]},inputDigest=digestPaperclipSemanticContent({requestId,turnId:f.ref.turnId,response});
      await f.port.inputAvailable({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId,turnId:f.ref.turnId,inputDigest,response}});
      if(kind==="unreleased_effect_hold")await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"pending",command:{action:"tool"},status:"pending"});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      const stop=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!.stop;
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:stop.boundary!,expectedRevision:stop.bindingRevision!,workerStopped:true});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      // Reconstruct exact historical fixture times in this disposable database.
      // The retained answer was never consumed; only native terminal evidence
      // ends its active-input period, and private/effect holds end separately.
      const start=new Date(Date.now()-90000),at=(ms:number)=>new Date(start.getTime()+ms),overlap=kind==="overlapping_window";
      const workStart=at(overlap?10000:-60000),nativeEnd=at(overlap?30000:-40000),privateEnd=at(overlap?50000:-30000),qualificationId=randomUUID();
      await db.update(assignments).set({createdAt:workStart,offeredAt:workStart,claimedAt:workStart,nativeAcceptedAt:workStart,finalizedAt:null}).where(eq(assignments.id,f.assignment.id));
      await db.update(heartbeatRuns).set({startedAt:workStart,finishedAt:nativeEnd}).where(eq(heartbeatRuns.id,f.runId));
      await db.update(museInputDeliveries).set({createdAt:workStart}).where(eq(museInputDeliveries.assignmentId,f.assignment.id));
      await db.update(externalAgentHolds).set({createdAt:workStart,releasedAt:kind==="unreleased_effect_hold"?null:privateEnd}).where(eq(externalAgentHolds.id,hold.id));
      await db.update(bindings).set({qualificationId,qualificationStartedAt:start,qualificationExpiresAt:at(86400000)}).where(eq(bindings.id,f.binding.id));
      const before=(await db.select().from(museInputDeliveries).where(eq(museInputDeliveries.assignmentId,f.assignment.id)))[0];
      const buckets=new Map<number,string[]>(),replicaId=randomUUID();
      for(let ms=0;ms<=80000;ms+=5000){const time=at(ms),bucket=Math.floor(time.getTime()/30000)*30000;const stamps=buckets.get(bucket)??[];stamps.push(time.toISOString());buckets.set(bucket,stamps);}
      await db.insert(museReceiverContactBuckets).values([...buckets].map(([bucketAt,timestamps])=>({companyId:f.company.id,bindingId:f.binding.id,bindingGeneration:1,replicaId,bucketAt:new Date(bucketAt),firstAt:new Date(timestamps[0]),lastAt:new Date(timestamps.at(-1)!),timestamps,contacts:timestamps.length,gapsAtMostSevenSeconds:timestamps.length-1,maxGapMs:5000})));
      const evidence=await f.broker.readQualificationEvidence(f.company.id,f.agent.id,f.binding.id,qualificationId);
      const expected=kind==="unreleased_effect_hold"?[]:overlap
        ? [{startedAt:start.toISOString(),endedAt:at(10000).toISOString()},{startedAt:at(50000).toISOString(),endedAt:at(80000).toISOString()}]
        : [{startedAt:start.toISOString(),endedAt:at(80000).toISOString()}];
      expect(evidence.idleWindows).toEqual(expected);
      expect((await db.select().from(museInputDeliveries).where(eq(museInputDeliveries.id,before.id)))[0]).toEqual(before);expect(before.consumedAt).toBeNull();
      const [after]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,hold.id));
      expect(after.workerUnknown).toBe(false);expect(after.nativeEffectsUnknown).toBe(kind==="unreleased_effect_hold");
      expect(after.releasedAt).toEqual(kind==="unreleased_effect_hold"?null:privateEnd);
    }finally{await f.detach();}
  });

  it("preserves a persisted qualification deadline on retry and enforces it without a watcher",async()=>{
    const f=await fixture(),state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!,qualificationId=randomUUID(),input={companyId:f.company.id,agentId:f.agent.id,bindingId:f.binding.id,generation:1,expectedRevision:state.revision,operatorId:f.operatorId,qualificationId,expiresAt:new Date(Date.now()+86400000)};
    const start=await f.broker.beginQualification(input),retry=await f.broker.beginQualification({...input,expiresAt:new Date(Date.now()+86400000)});expect(retry.expiresAt).toEqual(start.expiresAt);expect(Date.parse(start.expiresAt)-Date.parse(start.startedAt)).toBe(86400000);
    await db.update(bindings).set({qualificationExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
    await expect(f.identity.authenticate(f.credentials.accessToken)).rejects.toThrow("deadline");
    const [ended]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));expect(ended.revokedAt).toBeInstanceOf(Date);expect(ended.deadlineEnforcedAt).toBeInstanceOf(Date);
  });
  it("reads actual raw assignment timestamps as strings and schema timestamps as Dates",async()=>{
    const f=await active(await oauthFixture(true));
    try {
      const [raw]=await db.execute<{acceptBy:unknown;expiresAt:unknown;createdAt:unknown}>(sql`select accept_by as "acceptBy",expires_at as "expiresAt",created_at as "createdAt" from muse_runner_assignments where id=${f.assignment.id}::uuid`);
      const [mapped]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));
      for(const key of ["acceptBy","expiresAt","createdAt"] as const){
        expect(typeof raw[key]).toBe("string");expect(mapped[key]).toBeInstanceOf(Date);
        expect(Date.parse(String(raw[key]))).toBe(mapped[key].getTime());
      }
    }finally{await f.detach();}
  });
  it.each(["accept_by","expires_at","nonfinite_accept_by","nonfinite_expires_at","unchanged"] as const)("rechecks actual assignment deadlines after a proven claim admission wait (%s)",async deadline=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    let release=()=>{},holder:Promise<void>|undefined,claim:Promise<{result?:unknown;error?:unknown}>|undefined;
    try {
      expect(f.assignment.acceptBy.getTime()).toBeGreaterThan(Date.now());expect(f.assignment.expiresAt.getTime()).toBeGreaterThan(Date.now());
      const requestId=randomUUID(),beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(beforeHolds).toEqual([]);
      let ready=()=>{},holderPid=0;const locked=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        await tx.select({id:issues.id}).from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.id,f.issue.id))).for("update");ready();await gate;
      });
      await locked;
      claim=f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId}).then(result=>({result}),error=>({error}));
      await expect.poll(async()=>{
        const [observed]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity waiter
          inner join pg_locks waiting on waiting.pid=waiter.pid and waiting.locktype='transactionid' and not waiting.granted
          inner join pg_locks held on held.pid=${holderPid} and held.locktype='transactionid' and held.granted and held.transactionid=waiting.transactionid
          where waiter.datname=current_database() and ${holderPid}=any(pg_blocking_pids(waiter.pid))
            and exists(select 1 from pg_locks tuple_lock where tuple_lock.pid=waiter.pid and tuple_lock.locktype='tuple'
              and tuple_lock.relation='issues'::regclass and tuple_lock.mode='AccessExclusiveLock' and tuple_lock.granted)) as waiting`);
        return observed.waiting;
      },{timeout:5000,interval:25}).toBe(true);
      if(deadline==="accept_by")await db.update(assignments).set({acceptBy:new Date(Date.now()-1)}).where(eq(assignments.id,f.assignment.id));
      if(deadline==="expires_at")await db.update(assignments).set({expiresAt:new Date(Date.now()-1)}).where(eq(assignments.id,f.assignment.id));
      if(deadline==="nonfinite_accept_by")await db.execute(sql`update muse_runner_assignments set accept_by='infinity'::timestamptz where id=${f.assignment.id}::uuid`);
      if(deadline==="nonfinite_expires_at")await db.execute(sql`update muse_runner_assignments set expires_at='infinity'::timestamptz where id=${f.assignment.id}::uuid`);
      release();await holder;
      const outcome=await claim;
      const [current]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));
      const receipts=await db.select().from(operations).where(eq(operations.assignmentId,f.assignment.id));
      if(deadline==="unchanged"){
        expect(outcome.error).toBeUndefined();expect(outcome.result).toMatchObject({status:"accepted"});
        expect(current.status).toBe("accepted");expect(current.claimedAt).toBeInstanceOf(Date);expect(current.nativeAcceptedAt).toBeInstanceOf(Date);
        expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({requestId,status:"settled",outcome:{status:"accepted"}});
        const holds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
        expect(holds).toHaveLength(1);expect(holds[0]).toMatchObject({workerUnknown:true,nativeEffectsUnknown:false,releasedAt:null});
        expect(await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId})).toEqual(outcome.result);
        expect(await db.select().from(operations).where(eq(operations.assignmentId,f.assignment.id))).toEqual(receipts);
        expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(holds);expect(f.sent).toHaveLength(1);
      }else{
        expect(outcome.error).toMatchObject({status:409});expect(outcome.result).toBeUndefined();
        expect(current).toMatchObject({status:"offered",claimedAt:null,nativeAcceptedAt:null,acceptedResultAt:null,finalizedAt:null});
        expect(receipts).toEqual([]);expect(f.sent).toEqual([]);
        expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      }
    }finally{release();await Promise.allSettled([holder,claim]);await f.detach();}
  });
  it.each(["expired","unchanged"] as const)("checks actual assignment expiry before forwarding a recovered reserved receipt (%s)",async deadline=>{
    const f=await active(await oauthFixture(true));
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    const send=vi.fn(async(_command:ExternalProviderOperation)=>{});
    let transaction:ReturnType<typeof vi.spyOn>|undefined,detach:(()=>Promise<void>)|undefined,failure:unknown,requestId=randomUUID();
    try {
      expect((await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe("accepted");await f.detach();
      const input={text:"Recovered progress"},command={requestId,bindingId:f.binding.id,bindingGeneration:f.binding.generation,runId:f.runId,normalizedSessionId:f.assignment.normalizedSessionId,turnId:f.assignment.turnId,assignmentRevision:f.assignment.revision,action:"progress",input,digest:externalOperationDigest("progress",input)};
      const [reserved]=await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId,digest:command.digest,command,status:"reserved"}).returning();
      const beforeHolds=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      if(deadline==="expired")await db.update(assignments).set({expiresAt:new Date(Date.now()-1)}).where(eq(assignments.id,f.assignment.id));
      transaction=vi.spyOn(db,"transaction");
      detach=await f.port.attach(send,undefined,true);
      await expect.poll(()=>transaction!.mock.results.length,{timeout:5000,interval:25}).toBeGreaterThanOrEqual(2);
      expect(transaction.mock.results[1].type).toBe("return");await transaction.mock.results[1].value;
      if(deadline==="expired"){
        expect(send).not.toHaveBeenCalled();
        expect((await db.select().from(operations).where(eq(operations.id,reserved.id)))[0]).toEqual(reserved);
        expect(await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id))).toEqual(beforeHolds);
      }else{
        await expect.poll(async()=>(await db.select().from(operations).where(eq(operations.id,reserved.id)))[0].status,{timeout:5000,interval:25}).toBe("pending");
        expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toEqual(command);
        await f.port.settle({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId,outcome:{status:"completed"}}});
        expect(await f.broker.act(f.subject,{version:1,command:"progress",assignmentId:f.assignment.id,requestId,text:input.text})).toEqual({status:"completed"});
        expect(send).toHaveBeenCalledTimes(1);
        const receipts=await db.select().from(operations).where(eq(operations.requestId,requestId));expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({id:reserved.id,status:"settled",outcome:{status:"completed"}});
        expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toMatchObject({workerUnknown:true,nativeEffectsUnknown:false,releasedAt:null});
      }
    }catch(error){failure=error;}
    finally{
      try {
        if(send.mock.calls.length)await expect.poll(async()=>["pending","settled"].includes((await db.select().from(operations).where(eq(operations.requestId,requestId)))[0]?.status??""),{timeout:5000,interval:25}).toBe(true);
      }catch(error){if(failure)console.error("MUSE_ASSIGNMENT_FORWARD_CLEANUP_ACK_FAILED");else failure=error;}
      await detach?.();transaction?.mockRestore();await f.detach();
    }
    if(failure)throw failure;
  });
  it("rejects a claim when reassignment commits while its exact issue lock is held",async()=>{
    const f=await active();let unlock!:()=>void,held!:()=>void,holderPid!:number;
    const gate=new Promise<void>(resolve=>{unlock=resolve;}),locked=new Promise<void>(resolve=>{held=resolve;});
    const reassignment=db.transaction(async tx=>{
      holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
      await tx.select({id:issues.id}).from(issues).where(eq(issues.id,f.issue.id)).for("update");held();await gate;
      await tx.update(issues).set({assigneeAgentId:null,checkoutRunId:null,executionRunId:null}).where(eq(issues.id,f.issue.id));
    });
    await locked;let settled=false;
    const claim=f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()}).finally(()=>{settled=true;});
    void claim.catch(()=>{});
    try {
      // Observe the real DB wait, rather than assume asynchronous preflight
      // checks have reached reservation after an arbitrary sleep. This holder
      // locks only this task; blocker PID + issues FOR UPDATE identifies the
      // claim's admission barrier without recording private SQL or parameters.
      let waiting=false;const deadline=Date.now()+5000;
      while(Date.now()<deadline&&!settled) {
        const waiters=await db.execute<{pid:number}>(sql`
          select waiter.pid from pg_stat_activity waiter
          where waiter.datname=current_database() and waiter.wait_event_type='Lock'
            and ${holderPid}=any(pg_blocking_pids(waiter.pid))
            and waiter.query ~* '(from|join)[[:space:]]+"?issues"?'
            and waiter.query ~* 'for[[:space:]]+update'
          limit 2`);
        if(waiters.length===1){waiting=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      expect(waiting).toBe(true);expect(settled).toBe(false);
      unlock();await reassignment;
      await expect(claim).rejects.toThrow("current task");
      expect(f.sent).toEqual([]);
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0].claimedAt).toBeNull();
    } finally {unlock();await reassignment;await claim.catch(()=>{});await f.detach();}
  });
  it("reconciles pending sends to an independent unknown barrier on controller recovery",async()=>{
    const f=await active();await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});await f.detach();
    const requestId=randomUUID(),input={name:"write_document",arguments:{}},command={requestId,bindingId:f.binding.id,bindingGeneration:1,runId:f.runId,normalizedSessionId:f.assignment.normalizedSessionId,turnId:f.assignment.turnId,assignmentRevision:1,action:"tool",input,digest:externalOperationDigest("tool",input)};
    await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId,digest:command.digest,command,status:"pending"});
    const send=vi.fn(),detach=await f.port.attach(send,undefined,true);
    try {expect((await db.select().from(operations).where(eq(operations.requestId,requestId)))[0].status).toBe("unknown");expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0].nativeEffectsUnknown).toBe(true);expect((await f.broker.act(f.subject,{version:1,command:"tool",assignmentId:f.assignment.id,requestId,name:input.name,arguments:{}})).status).toBe("unknown");expect(send).not.toHaveBeenCalled();}finally{await detach();}
  });
  it("does not restore native uncertainty when a saved result precedes a lost command acknowledgement",async()=>{
    let releaseFailure!:()=>void;
    const failAfterResult=new Promise<void>(resolve=>{releaseFailure=resolve;});
    const f=await active(undefined,async command=>{if(command.action==="accept"){await failAfterResult;throw new Error("Command acknowledgement lost after result");}});
    let transaction:ReturnType<typeof vi.spyOn>|undefined;
    try {
      const requestId=randomUUID();
      expect(await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId})).toMatchObject({status:"accepted"});
      await f.broker.act(f.subject,{version:1,command:"finish",assignmentId:f.assignment.id,requestId:randomUUID(),result:{}});
      const [saved]=await db.select().from(operations).where(eq(operations.requestId,requestId));
      // Observe completion of the real failure transaction, without timing the
      // negative hold assertion or replacing the database implementation.
      transaction=vi.spyOn(db,"transaction");
      releaseFailure();
      await expect.poll(()=>transaction!.mock.results.length).toBeGreaterThan(0);
      await transaction.mock.results[0].value;
      transaction.mockRestore();transaction=undefined;
      expect((await db.select().from(operations).where(eq(operations.id,saved.id)))[0]).toEqual(saved);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0].nativeEffectsUnknown).toBe(false);
      await db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      await f.broker.reconcileTerminalAssignments(f.company.id,f.agent.id,f.binding.id);
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(hold.workerUnknown).toBe(false);expect(hold.nativeEffectsUnknown).toBe(false);expect(hold.releasedAt).toBeInstanceOf(Date);
      await expect(db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)))).resolves.toBeUndefined();
    }finally{releaseFailure();transaction?.mockRestore();await f.detach();}
  });

  it("retains native uncertainty for an unconfirmed failed send until its actual result arrives",async()=>{
    const f=await active();await f.detach();
    const detach=await f.port.attach(async()=>{throw new Error("No command acknowledgement or result");},undefined,true);
    try {
      const requestId=randomUUID();
      expect(await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId})).toMatchObject({status:"unknown",canReplay:false});
      const [pending]=await db.select().from(operations).where(eq(operations.requestId,requestId));expect(pending.status).toBe("unknown");expect(pending.outcome).toBeNull();
      const [held]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));expect(held.workerUnknown).toBe(true);expect(held.nativeEffectsUnknown).toBe(true);expect(held.releasedAt).toBeNull();
      await f.port.settle({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId,outcome:{status:"accepted"}}});
      const [resolved]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,held.id));expect(resolved.workerUnknown).toBe(true);expect(resolved.nativeEffectsUnknown).toBe(false);expect(resolved.releasedAt).toBeNull();
    }finally{await detach();}
  });

  it("makes identical native result replay idempotent after finish and finalization",async()=>{
    const f=await active();try {
      const acceptId=randomUUID(),finishId=randomUUID();
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:acceptId});
      await f.broker.act(f.subject,{version:1,command:"finish",assignmentId:f.assignment.id,requestId:finishId,result:{}});
      const [finished]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));expect(finished.status).toBe("settled");
      const receipts=await db.select().from(operations).where(eq(operations.assignmentId,f.assignment.id));
      const replay=(requestId:string,status:string)=>f.port.settle({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId,outcome:{status}}});
      await Promise.all([replay(acceptId,"accepted"),replay(acceptId,"accepted"),replay(finishId,"completed")]);
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual(finished);
      expect(await db.select().from(operations).where(eq(operations.assignmentId,f.assignment.id)).orderBy(operations.id)).toEqual([...receipts].sort((a,b)=>a.id.localeCompare(b.id)));
      await db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      await f.broker.reconcileTerminalAssignments(f.company.id,f.agent.id,f.binding.id);
      const [finalized]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));
      const [released]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));expect(released.releasedAt).toBeInstanceOf(Date);
      await Promise.all([replay(acceptId,"accepted"),replay(finishId,"completed")]);
      await expect(replay(acceptId,"completed")).rejects.toThrow("conflicts");
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0]).toEqual(finalized);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,released.id)))[0]).toEqual(released);
      await expect(db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)))).resolves.toBeUndefined();
    }finally{await f.detach();}
  });

  it("keeps historical Dot result replay idempotent after provider replacement",async()=>{
    const f=await fixture(),runId=randomUUID(),session=randomUUID(),turnId="dot_"+randomUUID();
    // A retained Dot journal can settle after its agent switches provider. It
    // grants no fresh work authority and does not require a live connection.
    const [binding]=await db.insert(dotAgentBindings).values({companyId:f.company.id,agentId:f.agent.id,operatorId:f.operatorId,status:"revoked",revokedAt:new Date()}).returning();
    await db.insert(heartbeatRuns).values({id:runId,companyId:f.company.id,agentId:f.agent.id,status:"succeeded",runtimeMode:"native",driverKind:"openai_dot_mcp",nativeSessionId:session});
    const [assignment]=await db.insert(dotRunnerAssignments).values({companyId:f.company.id,agentId:f.agent.id,bindingId:binding.id,bindingGeneration:1,runId,normalizedSessionId:session,turnId,controllerGeneration:1,catalogDigest:"dot",status:"offered",projection:{},acceptBy:new Date(),expiresAt:new Date(Date.now()+60000)}).returning();
    const acceptId=randomUUID(),finishId=randomUUID();
    await db.insert(dotRunnerOperations).values([{companyId:f.company.id,assignmentId:assignment.id,requestId:acceptId,digest:"accept",command:{action:"accept"},status:"admitted"},{companyId:f.company.id,assignmentId:assignment.id,requestId:finishId,digest:"finish",command:{action:"finish"},status:"admitted"}]);
    const ref={bindingId:binding.id,bindingGeneration:1,companyId:f.company.id,agentId:f.agent.id,acceptByUnixMs:Date.now(),expiresAtUnixMs:Date.now()+60000,runId,normalizedSessionId:session,turnId,assignmentRevision:1};
    const port=dotRunnerBroker(db).port({binding:{companyId:f.company.id,agentId:f.agent.id,runId},provider:{binding:ref}});
    const settle=(requestId:string,status:string)=>port.settle({sourceEventId:randomUUID(),payload:{binding:ref,requestId,outcome:{status}}});
    await settle(acceptId,"accepted");await settle(finishId,"completed");
    const [finished]=await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id,assignment.id));expect(finished.status).toBe("settled");
    const receipts=await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.assignmentId,assignment.id)).orderBy(dotRunnerOperations.id);
    await Promise.all([settle(acceptId,"accepted"),settle(finishId,"completed")]);
    await expect(settle(acceptId,"completed")).rejects.toThrow("conflicts");
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id,assignment.id)))[0]).toEqual(finished);
    expect(await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.assignmentId,assignment.id)).orderBy(dotRunnerOperations.id)).toEqual(receipts);
  });

  it("rearms an unclaimed offer after a lost wake but never restarts a claimed assignment",async()=>{
    const f=await active();try {
      const first=await museReceiver(db).signal(f.binding.id);
      await db.update(mailbox).set({signalNotifiedAt:new Date(Date.now()-31000)}).where(eq(mailbox.assignmentId,f.assignment.id));
      const retry=await museReceiver(db).signal(f.binding.id);expect(retry.signal?.reference).not.toEqual(first.signal?.reference);
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});expect((await museReceiver(db).signal(f.binding.id)).signal).toBeNull();
    }finally{await f.detach();}
  });
  it("wakes the exact v9 detector for a distinct offer after native success and mailbox acknowledgement",async()=>{
    const first=await active(await oauthFixture(true));
    let second:Awaited<ReturnType<typeof active>>|undefined;
    try {
      const poll=()=>museReceiver(db).signal(first.binding.id,oauthResource);
      const offeredA=await poll();expect(offeredA.signal?.reference).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(await first.broker.act(first.subject,{version:1,command:"accept",assignmentId:first.assignment.id,requestId:randomUUID()})).toMatchObject({status:"accepted"});
      expect(await first.broker.act(first.subject,{version:1,command:"finish",assignmentId:first.assignment.id,requestId:randomUUID(),result:{}})).toMatchObject({status:"completed"});
      await db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,first.runId));
      await first.broker.reconcileTerminalAssignments(first.company.id,first.agent.id,first.binding.id);
      const [completed]=await db.select().from(assignments).where(eq(assignments.id,first.assignment.id));
      expect(completed).toMatchObject({status:"settled",nativeAcceptedAt:expect.any(Date),acceptedResultAt:expect.any(Date),finalizedAt:expect.any(Date)});
      const inbox=await first.broker.inspect(first.subject,{version:1,query:"mailbox",after:0}) as {items:Array<{assignmentId:string|null}>;nextCursor:number};
      expect(inbox.items.some(item=>item.assignmentId===first.assignment.id)).toBe(true);
      await first.broker.inspect(first.subject,{version:1,query:"mailbox",after:inbox.nextCursor});
      expect((await db.select().from(bindings).where(eq(bindings.id,first.binding.id)))[0].workerCursor).toBe(inbox.nextCursor);
      const idleAfterSuccess=await poll();expect(idleAfterSuccess).toEqual({version:1,signal:null});
      await first.detach();
      second=await active(first);
      expect(second.assignment.id).not.toBe(first.assignment.id);expect(second.runId).not.toBe(first.runId);
      expect(second.assignment.bindingId).toBe(first.binding.id);expect(second.assignment.bindingGeneration).toBe(first.binding.generation);
      const [offerB]=await db.select().from(mailbox).where(and(eq(mailbox.assignmentId,second.assignment.id),eq(mailbox.kind,"assignment")));
      const offeredB=await poll();
      expect(offeredB).toEqual({version:1,signal:{reference:"sha256:"+createHash("sha256").update(`${first.binding.id}:${first.binding.generation}:${offerB.sourceEventId}:1`).digest("hex")}});
      expect(offeredB.signal?.reference).not.toBe(offeredA.signal?.reference);
      const duplicateB=await poll();expect(duplicateB).toEqual(offeredB);
      await db.update(mailbox).set({signalNotifiedAt:new Date(Date.now()-31000)}).where(eq(mailbox.id,offerB.id));
      const rearmedB=await poll();
      expect(rearmedB).toEqual({version:1,signal:{reference:"sha256:"+createHash("sha256").update(`${first.binding.id}:${first.binding.generation}:${offerB.sourceEventId}:2`).digest("hex")}});
      expect(rearmedB.signal?.reference).not.toBe(offeredB.signal?.reference);
      expect(await second.broker.act(second.subject,{version:1,command:"accept",assignmentId:second.assignment.id,requestId:randomUUID()})).toMatchObject({status:"accepted"});
      const [claimed]=await db.select().from(assignments).where(eq(assignments.id,second.assignment.id));
      expect(claimed).toMatchObject({claimedAt:expect.any(Date),nativeAcceptedAt:expect.any(Date)});
      const idleAfterClaim=await poll();expect(idleAfterClaim).toEqual({version:1,signal:null});
      const proof=JSON.parse(execFileSync("python3",[
        fileURLToPath(new URL("./fixtures/muse-client-contract.py",import.meta.url)),
        fileURLToPath(new URL("../services/scripts/v9/client.py",import.meta.url)),"--receiver-sequence",
      ],{input:JSON.stringify({bindingId:first.binding.id,origin:oauthOrigin,scope:{companyId:first.company.id,companyName:first.company.name,agentId:first.agent.id,agentName:first.agent.name},responses:[offeredA,idleAfterSuccess,offeredB,duplicateB,rearmedB,idleAfterClaim]}),encoding:"utf8",timeout:10000}));
      expect(proof).toEqual({outputs:["wake","idle","wake","duplicate","wake","idle"],providerAcknowledgement:"not_observed"});
    }finally{await second?.detach();await first.detach();}
  });
  it("rejects missing public origin before replacing a durable connection",async()=>{
    const f=await fixture(),state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
    // A broker instance keeps its configured public origin; use a fresh DB
    // wrapper to exercise the same persisted binding with a bad setup origin.
    const bad=museRunnerBroker(createDb(externalDatabaseUrl??temporary!.connectionString),{publicOrigin:"http://invalid.example"});
    await expect(bad.createPairing({companyId:f.company.id,agentId:f.agent.id,operatorId:f.operatorId,replaceBindingId:f.binding.id,expectedRevision:state.revision})).rejects.toThrow("HTTPS");
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].revokedAt).toBeNull();
  });

  it("denies an existing subject after its same-provider configured binding changes",async()=>{
    const f=await fixture();await db.update(agents).set({adapterConfig:{provider:"muse",museBindingId:randomUUID(),allowUnmeteredProvider:true}}).where(eq(agents.id,f.agent.id));
    await expect(f.broker.inspect(f.subject,{version:1,query:"task.list"})).rejects.toThrow("authority");
    await expect(f.identity.authenticate(f.credentials.accessToken)).rejects.toThrow("authority");
  });

  it("gives a settled result an exact stop boundary when native finalization fails",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await db.update(assignments).set({status:"settled",acceptedResultAt:new Date()}).where(eq(assignments.id,f.assignment.id));
      await db.update(heartbeatRuns).set({status:"failed",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      await f.broker.reconcileTerminalAssignments(f.company.id,f.agent.id,f.binding.id);
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;expect(state.stop.status).toBe("cannot_confirm");expect(state.stop.boundary?.assignmentId).toBe(f.assignment.id);
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:state.stop.boundary!,expectedRevision:state.revision,workerStopped:true});
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0].releasedAt).toBeInstanceOf(Date);
    }finally{await f.detach();}
  });

  it("keeps the native-effect barrier when a Runner fence precedes worker attestation",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"pending",command:{action:"tool"},status:"pending"});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;expect(state.stop.nativeEffectsUnknown).toBe(true);
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:state.stop.boundary!,expectedRevision:state.revision,workerStopped:true});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));expect(hold.releasedAt).toBeNull();expect(hold.nativeEffectsUnknown).toBe(true);
    }finally{await f.detach();}
  });

  it("preserves the original stop receipt across concurrent Runner replays and worker reporting",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const event={sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}};
      await f.port.dispatch(event);
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!,boundary=state.stop.boundary!;
      const [before]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      await Promise.all([f.port.dispatch(event),f.port.dispatch(event)]);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toEqual(before);
      await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
      const cleanup=await f.identity.authenticate(f.credentials.cleanupToken,"cleanup");
      await f.broker.cleanup(cleanup,{command:"worker.quiescent",boundary,requestId:randomUUID()});
      const [reported]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(reported.workerReportedAt).toBeInstanceOf(Date);
      await f.port.dispatch(event);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toEqual(reported);
      const receipts=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.sourceEventId,event.sourceEventId)));
      expect(receipts).toHaveLength(1);expect(receipts[0].references.boundary).toEqual(boundary);
    }finally{await f.detach();}
  });

  it("does not revive an attested and released hold when its Runner stop event replays",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const event={sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}};
      await f.port.dispatch(event);
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:state.stop.boundary!,expectedRevision:state.stop.bindingRevision!,workerStopped:true});
      await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      const [attested]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(attested.workerUnknown).toBe(false);expect(attested.releasedAt).toBeInstanceOf(Date);
      await db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)));
      await f.port.dispatch(event);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toEqual(attested);
      await db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)));
    }finally{await f.detach();}
  });

  it("preserves reported worker stop and independent native uncertainty on Runner replay",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"pending",command:{action:"tool"},status:"pending"});
      const event={sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}};
      await f.port.dispatch(event);
      const before=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:1,expectedRevision:before.revision});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      const cleanup=await f.identity.authenticate(f.credentials.cleanupToken,"cleanup");
      await f.broker.cleanup(cleanup,{command:"worker.quiescent",boundary:state.stop.boundary!,requestId:randomUUID()});
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:state.stop.boundary!,expectedRevision:state.stop.bindingRevision!,workerStopped:true});
      const [attested]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(attested.workerUnknown).toBe(false);expect(attested.nativeEffectsUnknown).toBe(true);expect(attested.releasedAt).toBeNull();
      expect(attested.workerReportedAt).toBeInstanceOf(Date);expect(attested.operatorAttestedAt).toBeInstanceOf(Date);
      await f.port.dispatch(event);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toEqual(attested);
      await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      await expect(db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)))).rejects.toThrow("unresolved");
    }finally{await f.detach();}
  });

  it("retains an attested server fence when its distinct late Runner stop fact arrives",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const before=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:1,expectedRevision:before.revision});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!,boundary=state.stop.boundary!;
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary,expectedRevision:state.stop.bindingRevision!,workerStopped:true});
      const [attested]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const event={sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}};
      await f.port.dispatch(event);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toEqual(attested);
      const [receipt]=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.sourceEventId,event.sourceEventId)));
      expect(receipt.references.boundary).toEqual(boundary);
    }finally{await f.detach();}
  });

  it("holds newly unresolved native effects without erasing an attested worker stop",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:state.stop.boundary!,expectedRevision:state.stop.bindingRevision!,workerStopped:true});
      await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      const [attested]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(attested.releasedAt).toBeInstanceOf(Date);
      await db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)));
      await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"recovered-pending",command:{action:"tool"},status:"pending"});
      const event={sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}};
      await f.port.dispatch(event);
      const [held]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(held.stopBoundary).toEqual(attested.stopBoundary);expect(held.operatorAttestedAt).toEqual(attested.operatorAttestedAt);
      expect(held.workerReportedAt).toEqual(attested.workerReportedAt);expect(held.workerUnknown).toBe(false);
      expect(held.nativeEffectsUnknown).toBe(true);expect(held.releasedAt).toBeNull();
      await expect(db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)))).rejects.toThrow("unresolved");
      await f.port.dispatch(event);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toEqual(held);
    }finally{await f.detach();}
  });

  it("rejects a conflicting Runner source event before changing assignment or stop state",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const [offer]=await db.select().from(mailbox).where(and(eq(mailbox.assignmentId,f.assignment.id),eq(mailbox.kind,"assignment")));
      const [before]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      await expect(f.port.dispatch({sourceEventId:offer.sourceEventId,payload:{kind:"authority_revoked",binding:f.ref}})).rejects.toThrow("event identity");
      expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0].status).toBe("accepted");
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0]).toEqual(before);
    }finally{await f.detach();}
  });

  it("denies already-dispatched native authority immediately at the qualification deadline",async()=>{
    const f=await active();try {
      await db.update(bindings).set({qualificationId:randomUUID(),qualificationExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
      await expect(f.broker.assertRunAuthority({binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}})).rejects.toThrow("deadline");
      await expect(f.broker.authorizingUserIdForBinding(f.ref)).rejects.toThrow("deadline");
      expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].revokedAt).toBeNull();
    }finally{await f.detach();}
  });

  it("promotes a verifying Muse hire through the ordinary lifecycle after authenticated background confirmation",async()=>{
    const f=await fixture(false);
    await db.update(agents).set({status:"paused",lifecycleState:"verifying",lifecycleOperation:{id:randomUUID(),hostComplete:false,completedPluginIds:[],attempts:0,responsibleUserId:f.operatorId},lifecycleRequiredPluginIds:[]}).where(eq(agents.id,f.agent.id));
    const harness=agentHarnessVerificationService(db,{} as PluginWorkerManager),onReady=vi.fn();
    const lifecycle=startAgentLifecycle(db,{requiredPluginIds:async()=>[],runPlugin:async()=>"complete",runHost:snapshot=>harness.verify(snapshot),onReady},()=>true);
    const deliveryErrors=vi.fn(),coordinator=createDeliveryWorkCoordinator({owner:db,canRun:()=>true,onError:deliveryErrors});
    const delivery=coordinator.register(DELIVERY_QUEUES.agentLifecycle,{retryMs:1000,run:()=>lifecycle.sweep(),hasPending:()=>lifecycle.hasPending(),nextRunAt:()=>lifecycle.nextRunAt()});
    lifecycle.setWake(delivery.wake);
    try {
      await delivery.ready;expect((await db.select().from(agents).where(eq(agents.id,f.agent.id)))[0].lifecycleState).toBe("verifying");
      // The authenticated confirmation must retry this hire, not wait for a
      // periodic scan or a previously persisted long backoff to expire.
      await db.update(agents).set({lifecycleOperation:sql`${agents.lifecycleOperation} || jsonb_build_object('retryAt', ${new Date(Date.now()+60_000).toISOString()}::text)`}).where(eq(agents.id,f.agent.id));
      await museReceiver(db).signal(f.binding.id);await museReceiver(db).flush();
      const items=await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:0}) as {items:Array<{references:{nonce:string}}>};
      await f.broker.act(f.subject,{version:1,command:"challenge.confirm",nonce:items.items[0].references.nonce,requestId:randomUUID()});
      await expect.poll(async()=> (await db.select().from(agents).where(eq(agents.id,f.agent.id)))[0].lifecycleState,{timeout:8000,interval:100}).toBe("ready");
      expect((await db.select().from(agents).where(eq(agents.id,f.agent.id)))[0].status).toBe("idle");expect(onReady).toHaveBeenCalledOnce();
      expect(deliveryErrors).not.toHaveBeenCalled();
    }finally{await coordinator.stop();await lifecycle.stop();}
  });

  it("serves opaque public wake digests while worker and cleanup APIs still require private bearer authority",async()=>{
    const f=await active();try {
      const app=transport(),reply=await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id);
      expect(reply.status).toBe(200);expect(Object.keys(reply.body)).toEqual(["version","signal"]);expect(Object.keys(reply.body.signal)).toEqual(["reference"]);
      const [item]=await db.select().from(mailbox).where(eq(mailbox.assignmentId,f.assignment.id));
      expect(reply.body.signal.reference).toBe("sha256:"+createHash("sha256").update(`${f.binding.id}:1:${item.sourceEventId}:${item.signalAttempt}`).digest("hex"));
      expect(JSON.stringify(reply.body)).not.toContain(f.assignment.id);expect(JSON.stringify(reply.body)).not.toContain(f.issue.title);
      expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id)).body).toEqual(reply.body);
      expect((await request(app).get("/api/muse/v1/signal")).status).toBe(400);
      expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding","invalid")).status).toBe(400);
      expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",randomUUID())).status).toBe(410);
      expect((await request(app).get("/api/muse/v1/signal?binding="+f.binding.id)).status).toBe(404);
      expect((await request(app).post("/api/muse/v1/commands").set("X-Paperclip-Muse-Binding",f.binding.id).send({version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).status).toBe(401);
      expect((await request(app).post("/api/muse/v1/detector-cleanup").set("X-Paperclip-Muse-Binding",f.binding.id).send({version:1,bindingId:f.binding.id,generation:1,requestId:randomUUID(),detectorRemoved:true})).status).toBe(401);
      expect((await request(app).post("/api/muse/v1/queries").set("X-Paperclip-Muse-Binding",f.binding.id).send({version:1,query:"identify"})).status).toBe(401);
      expect((await request(app).post("/api/muse/v1/cleanup").set("X-Paperclip-Muse-Binding",f.binding.id).send({version:1,command:"control.inspect"})).status).toBe(401);
    }finally{await f.detach();}
  });
  it.each(["input", "challenge"] as const)("signals pending stop control while paused and keeps ordinary %s quiet",async(kind)=>{
    const oauth=await oauthFixture(true),f=await active(oauth);try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      if(kind==="input") {
        const requestId="paused_question",response={schema:"paperclip.question_response.v1",answers:[]},inputDigest=digestPaperclipSemanticContent({requestId,turnId:f.ref.turnId,response});
        await f.port.inputAvailable({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId,turnId:f.ref.turnId,inputDigest,response}});
      } else {
        const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
        await f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
      }
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      await db.update(agents).set({status:"paused"}).where(eq(agents.id,f.agent.id));
      const app=transport(),poll=()=>request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id);
      const first=await poll();expect(first.status).toBe(200);expect(first.body.signal?.reference).toMatch(/^sha256:/);
      const [stop]=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"authority_revoked")));
      expect(stop.signalAttempt).toBe(1);expect(stop.signalNotifiedAt).toBeInstanceOf(Date);
      const ordinary=await db.select().from(mailbox).where(eq(mailbox.bindingId,f.binding.id));
      expect(ordinary.filter(item=>item.kind!=="authority_revoked").every(item=>item.signalNotifiedAt===null)).toBe(true);
      const inbox=await request(app).post("/api/muse/v1/queries").set("Authorization","Bearer "+oauth.tokens!.access_token).send({version:1,query:"mailbox",after:0});
      expect(inbox.status).toBe(200);expect(inbox.body).toMatchObject({items:expect.arrayContaining([expect.objectContaining({kind:"authority_revoked",references:stop.references})])});
      const ack=await request(app).post("/api/muse/v1/queries").set("Authorization","Bearer "+oauth.tokens!.access_token).send({version:1,query:"mailbox",after:stop.id});
      expect(ack.status).toBe(200);expect((await poll()).body).toEqual({version:1,signal:null});
      const accept=await request(app).post("/api/muse/v1/commands").set("Authorization","Bearer "+oauth.tokens!.access_token).send({version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      expect(accept.status).toBe(403);expect(f.sent).toHaveLength(1);
      expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))!.stop.status).toBe("cannot_confirm");
    }finally{await f.detach();}
  });

  it.each(["enableMuse","enableNativeRunner"] as const)("delivers only feature-disabled stop control while %s is off",async flag=>{
    const oauth=await oauthFixture(true),f=await active(oauth),app=transport();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      await f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
      const nativeRequestId="disabled_question",response={schema:"paperclip.question_response.v1",answers:{answer:{text:"PRIVATE pending input canary"}}};
      const inputDigest=digestPaperclipSemanticContent({requestId:nativeRequestId,turnId:f.ref.turnId,response});
      await f.port.inputAvailable({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId:nativeRequestId,turnId:f.ref.turnId,inputDigest,response}});
      await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"pending",command:{action:"tool"},status:"pending"});
      await instanceSettingsService(db).updateExperimental({[flag]:false});
      // A real native fence fact must remain ingestible after ordinary work is
      // disabled. Both exact replay and a later fact preserve the same boundary.
      const fence={sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}};
      await f.port.dispatch(fence);await f.port.dispatch(fence);
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const [stop]=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"authority_revoked")));
      const authorization="Bearer "+oauth.tokens!.access_token;
      const poll=()=>request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id);
      const [signal,inbox,inspection]=await Promise.all([
        poll(),request(app).post("/api/muse/v1/queries").set("Authorization",authorization).send({version:1,query:"mailbox",after:0}),
        request(app).post("/api/muse/v1/cleanup").set("Authorization",authorization).send({version:1,command:"control.inspect"}),
      ]);
      expect({signal:!!signal.body.signal,mailbox:inbox.status,cleanup:inspection.status}).toEqual({signal:true,mailbox:200,cleanup:200});
      expect(signal.body.signal.reference).toMatch(/^sha256:/);expect((await poll()).body).toEqual(signal.body);
      expect(inbox.body.items.map((item:{kind:string})=>item.kind)).toEqual(["authority_revoked"]);
      expect(inbox.body.items[0].references.boundary).toEqual(hold.stopBoundary);
      expect(JSON.stringify(inbox.body)).not.toContain("PRIVATE pending input canary");
      expect(inspection.body).toMatchObject({boundaries:[{boundary:hold.stopBoundary,nativeEffectsUnknown:true}],externalStopConfirmed:false});
      const workQueries=[{query:"identify"},{query:"assignment.read",assignmentId:f.assignment.id},{query:"input.pending",assignmentId:f.assignment.id,nativeRequestId},
        {query:"task.list"},{query:"task.search",text:"Muse"},{query:"task.read",issueId:f.issue.id},{query:"task.history",issueId:f.issue.id},
        {query:"task.document.read",issueId:f.issue.id,key:"memo"},{query:"operation.receipt",assignmentId:f.assignment.id,requestId:f.sent[0].requestId}];
      for(const query of workQueries)expect((await request(app).post("/api/muse/v1/queries").set("Authorization",authorization).send({version:1,...query})).status).toBe(503);
      const workCommands=[{command:"accept",assignmentId:f.assignment.id},{command:"progress",assignmentId:f.assignment.id,text:"no new effect"},
        {command:"tool",assignmentId:f.assignment.id,name:"read_task",input:{}},{command:"finish",assignmentId:f.assignment.id,result:{schema:"paperclip.run_result.v1"}},
        {command:"request_user_input",assignmentId:f.assignment.id,nativeRequestId:"new_question",questionSet:{schema:"paperclip.question_set.v1",questions:[{id:"answer",prompt:"No new question",required:true,answerMode:"text"}]}},
        {command:"consume_input",assignmentId:f.assignment.id,nativeRequestId,inputDigest,continuationReceiptId:randomUUID(),continuationPersisted:true},
        {command:"challenge.confirm",nonce:"unchanged-private-challenge"},{command:"work.request",issueId:f.issue.id},
        {command:"task.comment",issueId:f.issue.id,body:"No idle effect"},{command:"task.create",title:"No idle task"}];
      for(const command of workCommands)expect((await request(app).post("/api/muse/v1/commands").set("Authorization",authorization).send({version:1,requestId:randomUUID(),...command})).status).toBe(503);
      await expect(f.broker.snapshot(f.company.id,f.agent.id,f.binding.id)).rejects.toThrow("disabled");
      await expect(f.broker.act(f.subject,{version:1,command:"task.comment",issueId:f.issue.id,requestId:randomUUID(),body:"No direct idle effect"})).rejects.toThrow();
      await expect(f.broker.assertRunAuthority({binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}} as Parameters<typeof f.broker.assertRunAuthority>[0])).rejects.toThrow();
      const report={version:1,command:"worker.quiescent",boundary:hold.stopBoundary,requestId:randomUUID()};
      for(let retry=0;retry<2;retry++)expect((await request(app).post("/api/muse/v1/cleanup").set("Authorization",authorization).send(report)).body).toEqual({status:"worker_reported",externalStopConfirmed:false,nativeEffectsUnknown:true});
      for(let retry=0;retry<2;retry++)expect((await request(app).post("/api/muse/v1/queries").set("Authorization",authorization).send({version:1,query:"mailbox",after:stop.id})).body).toMatchObject({items:[],nextCursor:stop.id});
      expect((await poll()).body).toEqual({version:1,signal:null});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:fence.payload});
      const [saved]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,hold.id));
      expect(saved).toMatchObject({stopBoundary:hold.stopBoundary,workerUnknown:true,nativeEffectsUnknown:true,releasedAt:null});expect(saved.workerReportedAt).toBeInstanceOf(Date);
      expect(f.sent).toHaveLength(1);
      const ordinary=await db.select().from(mailbox).where(eq(mailbox.bindingId,f.binding.id));
      expect(ordinary.filter(item=>item.kind!=="authority_revoked").every(item=>item.signalNotifiedAt===null)).toBe(true);
      expect((await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.action,"muse.worker_quiescence_reported"))))).toHaveLength(1);
    }finally{await instanceSettingsService(db).updateExperimental({enableMuse:true,enableNativeRunner:true});await f.detach();}
  });
  it.each(["access_expired","grant_revoked","connection_revoked","refresh_expired","membership_lost","resource_changed","generation_changed","released","stop_window_expired"] as const)("disabled stop control retains current credential and boundary denial: %s",async fault=>{
    const oauth=await oauthFixture(true),f=await active(oauth),app=transport();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      await instanceSettingsService(db).updateExperimental({enableMuse:false});
      if(fault==="access_expired")await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthTokens.id,f.subject.credentialId));
      if(fault==="connection_revoked")await f.broker.revoke(f.company.id,f.agent.id,f.operatorId);
      if(fault==="grant_revoked")await db.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
      if(fault==="refresh_expired")await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(and(eq(mcpOauthTokens.grantId,f.binding.grantId!),eq(mcpOauthTokens.kind,"refresh")));
      if(fault==="membership_lost")await db.update(companyMemberships).set({status:"inactive"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
      if(fault==="resource_changed")await db.update(mcpOauthGrants).set({resource:"https://other.example/api/muse/v1"}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
      if(fault==="generation_changed")await db.update(bindings).set({generation:2}).where(eq(bindings.id,f.binding.id));
      if(fault==="released")await db.update(externalAgentHolds).set({releasedAt:new Date(),workerUnknown:false}).where(eq(externalAgentHolds.id,hold.id));
      if(fault==="stop_window_expired")await db.update(mailbox).set({createdAt:new Date(Date.now()-24*60*60000-1)}).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"authority_revoked")));
      const authorization="Bearer "+oauth.tokens!.access_token;
      const expected=["generation_changed","released","stop_window_expired"].includes(fault)?403:401;
      for(const command of [{command:"control.inspect"},{command:"worker.quiescent",boundary:hold.stopBoundary,requestId:randomUUID()}])expect((await request(app).post("/api/muse/v1/cleanup").set("Authorization",authorization).send({version:1,...command})).status).toBe(expected);
      expect((await request(app).post("/api/muse/v1/queries").set("Authorization",authorization).send({version:1,query:"mailbox",after:0})).status).toBe(expected);
      const [saved]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,hold.id));expect(saved.workerReportedAt).toBeNull();expect(saved.stopBoundary).toEqual(hold.stopBoundary);expect(f.sent).toHaveLength(1);
      const signal=await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id);
      if(["grant_revoked","connection_revoked","refresh_expired","membership_lost","resource_changed"].includes(fault))expect(signal.status).toBe(410);
      else expect(signal.body).toEqual({version:1,signal:null});
    }finally{await instanceSettingsService(db).updateExperimental({enableMuse:true,enableNativeRunner:true});await f.detach();}
  });
  it.each(["mailbox","report"] as const)("disabled stop control rechecks an access token that expires while its %s lock is held",async kind=>{
    const oauth=await oauthFixture(true),f=await active(oauth),app=transport();let release=()=>{},holder:Promise<void>|undefined;try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      await instanceSettingsService(db).updateExperimental({enableMuse:false});
      let ready=()=>{},holderPid=0;const gate=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{ready=resolve;});
      holder=db.transaction(async tx=>{
        holderPid=(await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`))[0].pid;
        const wait=async()=>{ready();await gate;};
        if(kind==="report")await withExternalAdmissionGuard(tx,f.company.id,f.agent.id,wait);
        else {await tx.select({id:bindings.id}).from(bindings).where(eq(bindings.id,f.binding.id)).for("update");await wait();}
      });
      await locked;let settled=false;
      const body=kind==="mailbox"?{version:1,query:"mailbox",after:0}:{version:1,command:"worker.quiescent",boundary:hold.stopBoundary,requestId:randomUUID()};
      const call=request(app).post(kind==="mailbox"?"/api/muse/v1/queries":"/api/muse/v1/cleanup").set("Authorization","Bearer "+oauth.tokens!.access_token).send(body).then(response=>{settled=true;return response;});
      let waiting=false;const deadline=Date.now()+5000;
      while(Date.now()<deadline&&!settled) {
        const [observed]=await db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and ${holderPid} = any(pg_blocking_pids(pid)) and (query ilike '%muse_agent_bindings%' or query ilike '%pg_advisory_xact_lock%')) as waiting`);
        if(observed.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
      }
      expect(waiting).toBe(true);expect(settled).toBe(false);
      await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthTokens.id,f.subject.credentialId));
      release();await holder;expect((await call).status).toBe(401);
      const [current]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));expect(current.workerCursor).toBe(0);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,hold.id)))[0].workerReportedAt).toBeNull();expect(f.sent).toHaveLength(1);
    }finally{release();await holder;await instanceSettingsService(db).updateExperimental({enableMuse:true,enableNativeRunner:true});await f.detach();}
  });
  it.each(["enableMuse","enableNativeRunner"] as const)("disabled stop control requires a durable fence before using %s current credentials",async flag=>{
    const f=await oauthFixture(true),app=transport();try {
      await instanceSettingsService(db).updateExperimental({[flag]:false});
      expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id)).body).toEqual({version:1,signal:null});
      expect((await request(app).post("/api/muse/v1/queries").set("Authorization","Bearer "+f.tokens!.access_token).send({version:1,query:"mailbox",after:0})).status).toBe(403);
      expect((await request(app).post("/api/muse/v1/cleanup").set("Authorization","Bearer "+f.tokens!.access_token).send({version:1,command:"control.inspect"})).status).toBe(403);
    }finally{await instanceSettingsService(db).updateExperimental({enableMuse:true,enableNativeRunner:true});}
  });
  it("disabled stop control cannot report or disclose another company's boundary",async()=>{
    const firstOauth=await oauthFixture(true),secondOauth=await oauthFixture(true),first=await active(firstOauth),second=await active(secondOauth),app=transport();try {
      for(const f of [first,second]){await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});}
      const [firstHold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,first.assignment.id));
      await instanceSettingsService(db).updateExperimental({enableMuse:false});
      const authorization="Bearer "+secondOauth.tokens!.access_token;
      const inbox=await request(app).post("/api/muse/v1/queries").set("Authorization",authorization).send({version:1,query:"mailbox",after:0});expect(inbox.status).toBe(200);
      expect(inbox.body.items.every((item:{kind:string;bindingId:string})=>item.kind==="authority_revoked"&&item.bindingId===second.binding.id)).toBe(true);
      expect(JSON.stringify(inbox.body)).not.toContain(first.assignment.id);
      const report=await request(app).post("/api/muse/v1/cleanup").set("Authorization",authorization).send({version:1,command:"worker.quiescent",boundary:firstHold.stopBoundary,requestId:randomUUID()});expect(report.status).toBe(409);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,firstHold.id)))[0].workerReportedAt).toBeNull();
    }finally{await instanceSettingsService(db).updateExperimental({enableMuse:true,enableNativeRunner:true});await first.detach();await second.detach();}
  });

  it("keeps expired readiness quiet even after an acknowledged item becomes eligible for rearm",async()=>{
    const f=await oauthFixture(true),app=transport();
    const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
    await f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
    const [challenge]=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge")));
    await db.update(bindings).set({challengeExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
    const poll=()=>request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id);
    expect((await poll()).body).toEqual({version:1,signal:null});
    const ack=await request(app).post("/api/muse/v1/queries").set("Authorization","Bearer "+f.tokens!.access_token).send({version:1,query:"mailbox",after:challenge.id});
    expect(ack.status).toBe(200);
    await db.update(mailbox).set({signalNotifiedAt:new Date(Date.now()-60000)}).where(eq(mailbox.id,challenge.id));
    expect((await poll()).body).toEqual({version:1,signal:null});
    expect((await db.select().from(mailbox).where(eq(mailbox.id,challenge.id)))[0].signalAttempt).toBe(0);
  });
  it("signals only the current unread readiness nonce and keeps its opaque reference stable",async()=>{
    const f=await oauthFixture(true),app=transport();
    const verify=async()=>{const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;await f.broker.verify(f.company.id,f.agent.id,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});};
    await verify();await db.update(bindings).set({challengeExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));await verify();
    const challenges=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge"))).orderBy(mailbox.id);
    expect(challenges).toHaveLength(2);
    const current=(await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0];
    expect(museCredentialHash(String(challenges[1].references.nonce))).toBe(current.challengeHash);
    const poll=()=>request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id);
    const first=await poll(),second=await poll();expect(first.status).toBe(200);expect(first.body.signal?.reference).toMatch(/^sha256:/);expect(second.body).toEqual(first.body);
    const saved=await db.select().from(mailbox).where(and(eq(mailbox.bindingId,f.binding.id),eq(mailbox.kind,"readiness_challenge"))).orderBy(mailbox.id);
    expect(saved.map(item=>item.signalAttempt)).toEqual([0,1]);
    const ack=await request(app).post("/api/muse/v1/queries").set("Authorization","Bearer "+f.tokens!.access_token).send({version:1,query:"mailbox",after:challenges[1].id});
    expect(ack.status).toBe(200);expect((await poll()).body).toEqual({version:1,signal:null});
    await db.update(bindings).set({challengeExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));await verify();expect((await poll()).body.signal?.reference).toMatch(/^sha256:/);
  });

  it("keeps paused and feature-disabled public receivers idle, resumes them, and fences lost current authority",async()=>{
    const f=await active();try {
      const app=transport(),poll=()=>request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id);
      await db.update(agents).set({status:"paused"}).where(eq(agents.id,f.agent.id));expect((await poll()).body).toEqual({version:1,signal:null});
      await db.update(agents).set({status:"active"}).where(eq(agents.id,f.agent.id));expect((await poll()).body.signal.reference).toMatch(/^sha256:/);
      await instanceSettingsService(db).updateExperimental({enableMuse:false});expect((await poll()).body).toEqual({version:1,signal:null});
      await instanceSettingsService(db).updateExperimental({enableMuse:true});expect((await poll()).body.signal.reference).toMatch(/^sha256:/);
      await db.update(companyMemberships).set({status:"inactive"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));expect((await poll()).status).toBe(410);
    }finally{await instanceSettingsService(db).updateExperimental({enableMuse:true});await f.detach();}
  });
  it("returns410 for expired refresh authority and thirty days of authenticated inactivity",async()=>{
    const expired=await fixture(false),inactive=await fixture(false),app=transport();
    await db.update(museCredentials).set({expiresAt:new Date(Date.now()-1)}).where(and(eq(museCredentials.bindingId,expired.binding.id),eq(museCredentials.kind,"refresh")));
    expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",expired.binding.id)).status).toBe(410);
    await db.update(bindings).set({workerActivityAt:new Date(Date.now()-30*86400000)}).where(eq(bindings.id,inactive.binding.id));
    expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",inactive.binding.id)).status).toBe(410);
  });
  it("keeps transient authority-check failures retryable and records no failed public contact",async()=>{
    const f=await fixture(false),app=transport(),check=vi.spyOn(museIdentityModule,"assertMuseReceiverAuthority").mockRejectedValueOnce(new Error("Synthetic database transport failure"));
    try {
      expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id)).status).toBe(500);
      await museReceiver(db).flush();expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].receiverContactAt).toBeNull();
      expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id)).status).toBe(200);
    }finally{check.mockRestore();}
  });
  it("retains immutable asset1 through asset8 bytes and advertises finite asset9 routes",async()=>{
    const app=transport(),manifests=await Promise.all([1,2,3,4,5,6,7,8,9].map(version=>request(app).get(`/api/muse/v1/assets/${version}/manifest.json`)));
    expect(manifests[0].body.assets).toEqual({"client.py":{sha256:"8926534cce48e11d5ea157dfd4deb435c9f8d7d8ea58d3d8a5424b45ab31d1f7"},"detector.sh":{sha256:"09981df12ebce8c50b68e5da64edfe5ab5350d56bf6392ec52023c4990ca658d"},"instructions.md":{sha256:"d347f4d0e7a03bb0397dd4b2ddf38350c8b73ee3c0a91b50cd6c3cd84458a45f"}});
    expect(manifests[1].body.assets).toEqual({"client.py":{sha256:"a89a90cf6ca6ae76be1662a9efda83f69dba3bccdd4c37cfe1935563b1f7330f"},"detector.sh":{sha256:"8e9f5de4f7dc18cbca7121fff6bcab4039dc66056441396826460d7f396c3b41"},"instructions.md":{sha256:"6770734ec4494a5d0403e5cc56ac69613faab96b66a96cf56108cec8dcda07a0"}});
    expect(manifests[2].body.assets).toEqual({"client.py":{sha256:"ed171e60dac5d1ea92b5cce40323ad10d5c87448a926678e9e32aacdd5feca0f"},"detector.sh":{sha256:"8e9f5de4f7dc18cbca7121fff6bcab4039dc66056441396826460d7f396c3b41"},"instructions.md":{sha256:"2e7a4677b1b55ca391b62c7530736441c51e9f7ec9354ed50c776bc786bfa901"}});
    expect(manifests[3].body.assets).toEqual({"client.py":{sha256:"42d9a1a9d795da54393bc9616e9e3ae6e9d9f6735d7728148e6080608aafdfc7"},"detector.sh":{sha256:"8e9f5de4f7dc18cbca7121fff6bcab4039dc66056441396826460d7f396c3b41"},"instructions.md":{sha256:"d57f1c43c0d3c7a76f9ed99e73a5a5cdb46c2b7e470efd451519bc3cc3d7d8f3"}});
    expect(manifests[4].body.assets).toEqual({"client.py":{sha256:"55001af1ac3f5e2e904af1254180d4852025e41ed5c424c0814831a9537e50ca"},"detector.sh":{sha256:"1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7"},"instructions.md":{sha256:"46488fc1f50520e5f0a53e2a1cd4f944fcf4bd5cacad57de1d68d41d10904041"}});
    expect(manifests[5].body.assets).toEqual({"client.py":{sha256:"cf207b0823bc59271d5d4ca930e8960eb9362b1244aea1a4e16eabc3889613bb"},"detector.sh":{sha256:"1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7"},"instructions.md":{sha256:"7957130682c5a8d2a1faf0e56e9505f548a2d95c294048e979c8499b698aa8d5"}});
    expect(manifests[6].body.assets).toEqual({"client.py":{sha256:"bd3a70f650b16b7d28a67ec78e96a465741be1203e062e6680ebb6dc4d0db427"},"detector.sh":{sha256:"1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7"},"instructions.md":{sha256:"ad86ec766cd009fb11095407460f0e0362f0dd10749b94d51ebb1f3fd13bd357"}});
    expect(manifests[7].body.assets).toEqual({"client.py":{sha256:"4eb06c9a0399f1cb94faba4f83ef945c509d39c6eb1c650cf6083e9c2363956a"},"detector.sh":{sha256:"1cbd1dd379987c7dadebbc466af312d72065e322d19c1ac2d8931ae2779885d7"},"instructions.md":{sha256:"fb76062f9f4179e39a317cf7f0635847996132195f3cbe7a5a071232b2fe0eb0"}});
    for(const version of [1,2,3,4,5,6,7,8,9]){
      const manifest=manifests[version-1];expect(manifest.status).toBe(200);expect(manifest.body.assetVersion).toBe(version);expect(manifest.body.clientVersion).toBe(String(version));expect(manifest.headers["cache-control"]).toContain("immutable");
      for(const name of ["client.py","detector.sh","instructions.md"]){const response=await request(app).get(`/api/muse/v1/assets/${version}/${name}`);expect(response.status).toBe(200);expect(response.headers["cache-control"]).toContain("immutable");expect(createHash("sha256").update(response.text).digest("hex")).toBe(manifest.body.assets[name].sha256);}
    }
    expect(MUSE_PUBLIC_ROUTES).toHaveLength(48);
    for(const path of ["/api/muse/v1/assets/10/client.py","/api/muse/v1/assets/6/extra.py","/api/muse/v1/assets/6/client.py?version=6"]){expect((await request(app).get(path)).status).toBe(404);}
    expect((await request(app).post("/api/muse/v1/assets/4/client.py")).status).toBe(404);
    expect((await request(transport(true)).post("/api/muse/v1/pair").send({version:1,ticket:"synthetic-unused-ticket",clientVersion:"1"})).status).toBe(400);
  });
  it("creates setup standing delegation from the actual scoped pairing company and agent",async()=>{
    const f=await fixture(false),state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
    const pairing=await f.broker.createPairing({companyId:f.company.id,agentId:f.agent.id,operatorId:f.operatorId,replaceBindingId:f.binding.id,expectedRevision:state.revision});
    expect(pairing.setupInstruction).toContain(JSON.stringify({companyId:f.company.id,companyName:f.company.name,agentId:f.agent.id,agentName:f.agent.name,bindingId:pairing.bindingId}));
    expect(pairing.setupInstruction).toContain("standing authorization");expect(pairing.setupInstruction).toContain("autonomously accept");expect(pairing.setupInstruction).toContain("native accepted lease before any task effect");
    expect(pairing.setupInstruction).toContain(`--company-id '${f.company.id}' --company-name '${f.company.name}' --agent-id '${f.agent.id}' --agent-name '${f.agent.name}'`);
    expect(pairing.setupInstruction).toContain(`/paperclip-muse-${pairing.bindingId}/SKILL.md`);
  });

  it("redeems Muse PKCE ticket into its exact agent/operator grant and keeps pre-token polling pending",async()=>{
    const f=await oauthFixture(),redirect=new URL(f.authorizationUrl!);expect(redirect.origin+redirect.pathname).toBe(oauthCallback);expect(redirect.searchParams.get("state")).toBe(f.input.state);expect(redirect.searchParams.get("iss")).toBe(oauthOrigin+"/api/muse/v1/oauth");
    const [grant]=await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,f.binding.grantId!));expect(grant).toMatchObject({companyId:f.company.id,agentId:f.agent.id,userId:f.operatorId,purpose:"agent",resource:oauthResource,scopes:["paperclip:agent","offline_access"]});
    expect(f.binding.ticketHash).toBeNull();expect(f.binding.pairedAt).toBeInstanceOf(Date);expect(await db.select().from(museCredentials).where(eq(museCredentials.bindingId,f.binding.id))).toHaveLength(0);
    expect(await inspectMuseConnectionCredential(db,f.binding,oauthResource)).toEqual({state:"pending",refreshExpiresAt:null});
    expect((await request(transport()).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id)).body).toEqual({version:1,signal:null});
    const tokens=await f.oauth.token(f.tokenInput()),subject=await f.identity.authenticateOAuthAccess(tokens.access_token,oauthOrigin);
    expect(subject).toMatchObject({credentialSource:"oauth",grantId:grant.id,provider:"muse",agentId:f.agent.id,authorizingUserId:f.operatorId});
    const [stored]=await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash,hashMcpSecret(tokens.access_token)));expect(subject.credentialId).toBe(stored.id);
    expect((await inspectMuseConnectionCredential(db,(await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0],oauthResource)).state).toBe("active");
    expect((await request(transport()).post("/api/muse/v1/queries").set("Authorization","Bearer "+tokens.access_token).send({version:1,query:"identify"})).body).toMatchObject({bindingId:f.binding.id,agentId:f.agent.id});
    await expect(f.oauth.authorize(f.input)).rejects.toThrow();await expect(f.oauth.token(f.tokenInput())).rejects.toThrow();
  });
  it("preserves the first successful worker release across maintenance and later idle evidence",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const start=new Date(Date.now()-60000),at=(ms:number)=>new Date(start.getTime()+ms),releasedAt=at(-5000),workAt=at(-30000);
      await db.update(assignments).set({status:"settled",acceptedResultAt:at(-10000),offeredAt:workAt,createdAt:workAt,claimedAt:workAt,nativeAcceptedAt:workAt,finalizedAt:at(-10000)}).where(eq(assignments.id,f.assignment.id));
      await db.update(heartbeatRuns).set({status:"succeeded",startedAt:workAt,finishedAt:at(-10000)}).where(eq(heartbeatRuns.id,f.runId));
      await db.update(externalAgentHolds).set({createdAt:workAt,releasedAt:null,workerUnknown:true,nativeEffectsUnknown:false}).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(releasedAt);
      await f.broker.reconcileTerminalAssignments(f.company.id,f.agent.id,f.binding.id);
      const [first]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(first).toMatchObject({workerUnknown:false,nativeEffectsUnknown:false,releasedAt});
      const qualificationId=randomUUID(),replicaId=randomUUID(),buckets=new Map<number,string[]>();
      await db.update(bindings).set({qualificationId,qualificationStartedAt:start,qualificationExpiresAt:at(86400000)}).where(eq(bindings.id,f.binding.id));
      for(let ms=0;ms<=50000;ms+=5000){const time=at(ms),bucket=Math.floor(time.getTime()/30000)*30000;const times=buckets.get(bucket)??[];times.push(time.toISOString());buckets.set(bucket,times);}
      await db.insert(museReceiverContactBuckets).values([...buckets].map(([bucket,timestamps])=>({companyId:f.company.id,bindingId:f.binding.id,bindingGeneration:1,replicaId,bucketAt:new Date(bucket),firstAt:new Date(timestamps[0]),lastAt:new Date(timestamps.at(-1)!),timestamps,contacts:timestamps.length,gapsAtMostSevenSeconds:timestamps.length-1,maxGapMs:5000,incomplete:false})));
      vi.setSystemTime(at(55000));
      await f.broker.reconcileTerminalAssignments(f.company.id,f.agent.id,f.binding.id);
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.id,first.id)))[0]).toEqual(first);
      const evidence=await f.broker.readQualificationEvidence(f.company.id,f.agent.id,f.binding.id,qualificationId);
      expect(evidence.idleWindows).toEqual([{startedAt:start.toISOString(),endedAt:at(50000).toISOString()}]);
    }finally{vi.useRealTimers();await f.detach();}
  });

  describe("Muse OAuth code exchange diagnostics",()=>{
    const prefix="muse.oauth_code_exchange_",generic={error:"invalid_grant",error_description:"Authorization is expired, revoked, or invalid."};
    async function events(f:Awaited<ReturnType<typeof oauthFixture>>,rejectionsOnly=true) {
      const rows=await db.select().from(activityLog).where(and(eq(activityLog.companyId,f.company.id),eq(activityLog.entityType,"agent"),eq(activityLog.entityId,f.agent.id)));
      return rows.filter(row=>row.action.startsWith(prefix+(rejectionsOnly?"rejected_":"")));
    }
    async function codeState(f:Awaited<ReturnType<typeof oauthFixture>>) {
      const [code]=await db.select().from(mcpOauthRequests).where(eq(mcpOauthRequests.grantId,f.binding.grantId!));return code;
    }
    it.each(["code_expired","redirect_mismatch","pkce_mismatch","client_mismatch","code_consumed"] as const)("records only scoped static %s evidence while preserving the public error",async(check)=>{
      const f=await oauthFixture(),input=f.tokenInput();
      if(check==="code_expired")await db.update(mcpOauthRequests).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthRequests.grantId,f.binding.grantId!));
      if(check==="redirect_mismatch")input.redirect_uri="https://other-authd.example/callback";
      if(check==="pkce_mismatch")input.code_verifier="a".repeat(43);
      if(check==="client_mismatch")input.client_id="pcmcp_client_wrong";
      if(check==="code_consumed")await f.oauth.token(f.tokenInput());
      const response=await request(transport()).post("/api/muse/v1/oauth/token").type("form").send(input);
      expect(response.status).toBe(400);expect(response.body).toEqual(generic);
      const rows=await events(f);expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({actorType:"system",actorId:"muse-oauth",responsibleUserId:f.operatorId,agentId:f.agent.id,action:prefix+"rejected_"+check});
      expect(rows[0].details).toMatchObject({schemaVersion:1,bindingId:f.binding.id,generation:f.binding.generation,grantId:f.binding.grantId,failedChecks:[check]});
      const details=rows[0].details!;
      for(const field of ["receivedAt","decisionAt","authorizationAt","deadlineAt"])expect(Number.isFinite(Date.parse(String(details[field])))).toBe(true);
      expect(details.decisionLatencyMs).toBeGreaterThanOrEqual(0);expect(details.codeAgeMs).toBeTypeOf("number");
      expect((await codeState(f)).consumedAt===null).toBe(check!=="code_consumed");
      expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(check==="code_consumed"?2:0);
    });
    it.each(["wrong_resource","missing_client","both"] as const)("records known-code early invalid_target evidence for %s without changing public errors",async(kind)=>{
      const f=await oauthFixture(),input=f.tokenInput(),resource="https://resource-canary.example/unsupported",claimedCompany=randomUUID();
      const submitted:Record<string,unknown>={...input},failedChecks:string[]=[];
      if(kind!=="wrong_resource"){delete submitted.client_id;failedChecks.push("client_mismatch");}
      if(kind!=="missing_client"){submitted.resource=resource;failedChecks.push("resource_mismatch");}
      const expected={error:"invalid_target",error_description:"Client and matching resource are required."};
      const unknown=await request(transport()).post("/api/muse/v1/oauth/token").type("form").send({...submitted,code:"pcmcp_code_unknown_resource_canary",company_id:claimedCompany});
      expect(unknown.status).toBe(400);expect(unknown.body).toEqual(expected);expect(await events(f)).toHaveLength(0);
      const response=await request(transport()).post("/api/muse/v1/oauth/token").type("form").set("X-Private-Canary","resource-header-canary")
        .send({...submitted,company_id:claimedCompany,reason:"resource-client-reason-canary"});
      expect(response.status).toBe(400);expect(response.body).toEqual(expected);
      const rows=await events(f);expect(rows).toHaveLength(failedChecks.length);expect(rows.map(row=>row.action).sort()).toEqual(failedChecks.map(check=>prefix+"rejected_"+check).sort());
      for(const row of rows){expect(row).toMatchObject({actorType:"system",actorId:"muse-oauth",responsibleUserId:f.operatorId,entityType:"agent",entityId:f.agent.id,agentId:f.agent.id});expect(row.details).toMatchObject({bindingId:f.binding.id,generation:f.binding.generation,grantId:f.binding.grantId,failedChecks});}
      const serialized=JSON.stringify(rows),code=await codeState(f);
      for(const value of [resource,claimedCompany,input.code,input.code_verifier,f.client.client_id,f.input.code_challenge,f.input.state,oauthCallback,code.id,code.codeHash,"resource-header-canary","resource-client-reason-canary"])expect(serialized).not.toContain(value);
      expect(code.consumedAt).toBeNull();expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(0);
      await expect(f.oauth.token(input)).resolves.toMatchObject({token_type:"Bearer"});
    });
    it.each(["operator_removed","operator_viewer","agent_removed"] as const)("normalizes expected %s code authority loss to the scoped invalid_grant error",async(kind)=>{
      const f=await oauthFixture();
      const user=and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,f.operatorId));
      if(kind==="operator_removed")await db.delete(companyMemberships).where(user);
      else if(kind==="operator_viewer")await db.update(companyMemberships).set({membershipRole:"viewer"}).where(user);
      else await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalType,"agent"),eq(companyMemberships.principalId,f.agent.id)));
      const response=await request(transport()).post("/api/muse/v1/oauth/token").type("form").send(f.tokenInput());
      expect(response.status).toBe(400);expect(response.body).toEqual(generic);
      const rows=await events(f);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({action:prefix+"rejected_current_authority_unavailable",responsibleUserId:f.operatorId,entityId:f.agent.id});
      expect((await codeState(f)).consumedAt).toBeNull();expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(0);
    });
    it("normalizes expected refresh authority loss without consuming its credential",async()=>{
      const f=await oauthFixture(true);
      await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalType,"agent"),eq(companyMemberships.principalId,f.agent.id)));
      const response=await request(transport()).post("/api/muse/v1/oauth/token").type("form").send({grant_type:"refresh_token",client_id:f.client.client_id,refresh_token:f.tokens!.refresh_token});
      expect(response.status).toBe(400);expect(response.body).toEqual(generic);
      const tokens=await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!));
      expect(tokens).toHaveLength(2);expect(tokens.find(token=>token.kind==="refresh")?.usedAt).toBeNull();
    });
    it("preserves unexpected authority storage failures without inventing a protocol denial",async()=>{
      const f=await oauthFixture(),fault=new Error("Synthetic authority storage failure");
      const spy=vi.spyOn(museIdentityModule,"assertMuseCurrentAuthority").mockRejectedValueOnce(fault);
      try{await expect(f.oauth.token(f.tokenInput())).rejects.toBe(fault);}finally{spy.mockRestore();}
      expect((await codeState(f)).consumedAt).toBeNull();expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(0);expect(await events(f)).toHaveLength(0);
    });
    it("retains overlapping failed checks without claiming a single cause",async()=>{
      const f=await oauthFixture();await db.update(mcpOauthRequests).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthRequests.grantId,f.binding.grantId!));
      await expect(f.oauth.token({...f.tokenInput(),redirect_uri:oauthCallback+"?changed=1",code_verifier:"z".repeat(43)})).rejects.toMatchObject({code:"invalid_grant",status:400});
      const rows=await events(f);expect(rows.map(row=>row.action).sort()).toEqual(["code_expired","pkce_mismatch","redirect_mismatch"].map(check=>prefix+"rejected_"+check).sort());
      for(const row of rows)expect(row.details?.failedChecks).toEqual(["redirect_mismatch","pkce_mismatch","code_expired"]);
    });
    it("attributes a malformed verifier only from a known code and excludes all private request material",async()=>{
      const f=await oauthFixture(),input=f.tokenInput(),code=await codeState(f);
      const response=await request(transport()).post("/api/muse/v1/oauth/token").type("form").set("X-Private-Canary","header-private-canary")
        .send({...input,code_verifier:"malformed-verifier-canary",reason:"client-chosen-reason-canary",client_secret:"body-private-canary"});
      expect(response.status).toBe(400);expect(response.body).toEqual(generic);
      const rows=await events(f);expect(rows).toHaveLength(1);expect(rows[0].action).toBe(prefix+"rejected_verifier_format");
      expect(Object.keys(rows[0].details!).sort()).toEqual(["schemaVersion","bindingId","generation","grantId","failedChecks","receivedAt","decisionAt","authorizationAt","deadlineAt","codeAgeMs","decisionLatencyMs"].sort());
      const serialized=JSON.stringify(rows);
      for(const value of [input.code,input.code_verifier,f.verifier,f.input.code_challenge,f.input.state,f.ticket,f.client.client_id,oauthCallback,code.id,code.codeHash,"header-private-canary","malformed-verifier-canary","client-chosen-reason-canary","body-private-canary"])expect(serialized).not.toContain(value);
      expect((await codeState(f)).consumedAt).toBeNull();
    });
    it("commits independent S256 proof success and its timing evidence with the credential family",async()=>{
      const f=await oauthFixture(false,false),verifier="dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const redirect=await f.oauth.authorize({...f.input,code_challenge:"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"});
      const code=new URL(redirect).searchParams.get("code")!;
      const response=await request(transport()).post("/api/muse/v1/oauth/token").set("Content-Type","application/x-www-form-urlencoded; charset=UTF-8")
        .send({grant_type:"authorization_code",client_id:f.client.client_id,redirect_uri:oauthCallback,code,code_verifier:verifier});
      expect(response.status).toBe(200);expect(response.body.token_type).toBe("Bearer");
      const [binding]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));
      const rows=await events(f,false);expect(rows).toHaveLength(1);expect(rows[0].action).toBe(prefix+"succeeded");expect(rows[0].responsibleUserId).toBe(f.operatorId);
      expect((await db.select().from(mcpOauthRequests).where(eq(mcpOauthRequests.grantId,binding.grantId!)))[0].consumedAt).toBeInstanceOf(Date);
      expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,binding.grantId!))).toHaveLength(2);
      expect((await inspectMuseConnectionCredential(db,binding,oauthResource)).state).toBe("active");
    });
    it("rolls back consumption and tokens if atomic success evidence cannot persist",async()=>{
      const f=await oauthFixture(),original=activityLogModule.logActivity,fault=new Error("synthetic diagnostic storage failure");
      const spy=vi.spyOn(activityLogModule,"logActivity").mockImplementation(async(...args)=>{if(args[1].action===prefix+"succeeded")throw fault;return original(...args);});
      try {await expect(f.oauth.token(f.tokenInput())).rejects.toBe(fault);}finally{spy.mockRestore();}
      expect((await codeState(f)).consumedAt).toBeNull();expect(await events(f,false)).toHaveLength(0);
      expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(0);
      await expect(f.oauth.token(f.tokenInput())).resolves.toMatchObject({token_type:"Bearer"});expect(await events(f,false)).toHaveLength(1);
    });
    it("keeps a committed exchange successful when postcommit publication fails",async()=>{
      const f=await oauthFixture(),original=activityLogModule.publishActivity;
      const spy=vi.spyOn(activityLogModule,"publishActivity").mockImplementation(publication=>{if(publication.payload.action===prefix+"succeeded")throw new Error("synthetic publication failure");return original(publication);});
      try {const response=await request(transport()).post("/api/muse/v1/oauth/token").type("form").send(f.tokenInput());expect(response.status).toBe(200);}finally{spy.mockRestore();}
      expect((await codeState(f)).consumedAt).toBeInstanceOf(Date);expect(await events(f,false)).toHaveLength(1);
      expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(2);
    });
    it("preserves the original public rejection and rolls back partial diagnostic writes on audit failure",async()=>{
      const f=await oauthFixture(),original=activityLogModule.logActivity;
      await db.update(mcpOauthRequests).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthRequests.grantId,f.binding.grantId!));
      const spy=vi.spyOn(activityLogModule,"logActivity").mockImplementation(async(...args)=>{if(args[1].action===prefix+"rejected_code_expired")throw new Error("synthetic private audit error");return original(...args);});
      try {const response=await request(transport()).post("/api/muse/v1/oauth/token").type("form").send({...f.tokenInput(),code_verifier:"z".repeat(43)});expect(response.status).toBe(400);expect(response.body).toEqual(generic);}finally{spy.mockRestore();}
      expect(await events(f)).toHaveLength(0);expect((await codeState(f)).consumedAt).toBeNull();
      expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(0);
      await expect(f.oauth.token({...f.tokenInput(),code_verifier:"z".repeat(43)})).rejects.toMatchObject({code:"invalid_grant"});expect(await events(f)).toHaveLength(2);
    });
    it("does not let a public Board activity forgery suppress trusted first-denial evidence",async()=>{
      const f=await oauthFixture(),app=express();app.use(express.json());
      app.use((req,_res,next)=>{req.actor={type:"board",source:"session",userId:f.operatorId,companyIds:[f.company.id],isInstanceAdmin:false};next();});
      app.use("/api",activityRoutes(db));app.use(errorHandler);
      const action=prefix+"rejected_pkce_mismatch",details={bindingId:f.binding.id,generation:f.binding.generation,grantId:f.binding.grantId};
      const forged=await request(app).post(`/api/companies/${f.company.id}/activity`).send({actorType:"system",actorId:"muse-oauth",action,entityType:"agent",entityId:f.agent.id,agentId:f.agent.id,responsibleUserId:f.operatorId,details});
      expect(forged.status).toBe(201);expect(forged.body.responsibleUserId).toBeNull();
      await expect(f.oauth.token({...f.tokenInput(),code_verifier:"z".repeat(43)})).rejects.toMatchObject({code:"invalid_grant"});
      const rows=await events(f);expect(rows).toHaveLength(2);expect(rows.filter(row=>row.responsibleUserId===f.operatorId)).toHaveLength(1);
    });
    it("caps concurrent repeated denials and preserves the first recorded timing",async()=>{
      const f=await oauthFixture(),input={...f.tokenInput(),code_verifier:"z".repeat(43)};
      const results=await Promise.allSettled(Array.from({length:4},()=>f.oauth.token(input)));expect(results.every(result=>result.status==="rejected")).toBe(true);
      const first=await events(f);expect(first).toHaveLength(1);
      await expect(f.oauth.token(input)).rejects.toMatchObject({code:"invalid_grant"});expect(await events(f)).toEqual(first);
      expect((await codeState(f)).consumedAt).toBeNull();
      await expect(f.oauth.token(f.tokenInput())).resolves.toMatchObject({token_type:"Bearer"});
    });
    it("does not attribute unknown or pruned codes from claimed client or company fields",async()=>{
      const f=await oauthFixture(),other=await oauthFixture();
      await expect(f.oauth.token({...f.tokenInput(),code:"pcmcp_code_unknown_canary",company_id:other.company.id,agent_id:other.agent.id,reason:"code_expired"})).rejects.toMatchObject({code:"invalid_grant"});
      expect(await events(f)).toHaveLength(0);expect(await events(other)).toHaveLength(0);
      await db.update(mcpOauthRequests).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthRequests.grantId,f.binding.grantId!));
      await f.oauth.register({client_name:"Prune control",redirect_uris:[oauthCallback]},randomUUID());
      expect(await codeState(f)).toBeUndefined();await expect(f.oauth.token(f.tokenInput())).rejects.toMatchObject({code:"invalid_grant"});
      expect(await events(f)).toHaveLength(0);
      await expect(other.oauth.token(other.tokenInput())).resolves.toMatchObject({token_type:"Bearer"});
    });
    it("retains historical scope when revocation and replacement occur during the admission wait",async()=>{
      const f=await oauthFixture();let operation:Promise<{error?:unknown}>|undefined;
      try {await db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,async()=>{
        await tx.select().from(bindings).where(eq(bindings.id,f.binding.id)).for("update");
        operation=f.oauth.token(f.tokenInput()).then(()=>({}),error=>({error}));
        await expect.poll(async()=>{const result=await db.execute(sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and lower(wait_event)='advisory'`);return Number(result[0]?.count??0);},{timeout:5000,interval:25}).toBeGreaterThan(0);
        await tx.update(bindings).set({revokedAt:new Date(),status:"revoked"}).where(eq(bindings.id,f.binding.id));
        const [replacement]=await tx.insert(bindings).values({companyId:f.company.id,agentId:f.agent.id,operatorId:f.operatorId,generation:f.binding.generation+1}).returning();
        await tx.update(agents).set({adapterConfig:{...f.agent.adapterConfig,museBindingId:replacement.id}}).where(eq(agents.id,f.agent.id));
      }));}finally{await operation;}
      expect((await operation!).error).toMatchObject({code:"invalid_grant"});const rows=await events(f);expect(rows).toHaveLength(1);
      expect(rows[0].details).toMatchObject({bindingId:f.binding.id,generation:f.binding.generation,grantId:f.binding.grantId,failedChecks:["binding_unavailable"]});
      expect((await codeState(f)).consumedAt).toBeNull();expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(0);
    });
    it("records simulated Date-only expiry after a proven admission wait without changing the deadline",async()=>{
      const f=await oauthFixture(),code=await codeState(f),enteredAt=Date.now();let operation:Promise<{error?:unknown}>|undefined;
      vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(enteredAt);
      try {
        await db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,async()=>{
          await tx.select().from(bindings).where(eq(bindings.id,f.binding.id)).for("update");operation=f.oauth.token(f.tokenInput()).then(()=>({}),error=>({error}));
          await expect.poll(async()=>{const result=await db.execute(sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and lower(wait_event)='advisory'`);return Number(result[0]?.count??0);},{timeout:5000,interval:25}).toBeGreaterThan(0);
          vi.setSystemTime(code.expiresAt.getTime()+1);
        }));
        expect((await operation!).error).toMatchObject({code:"invalid_grant"});
      } finally {await operation;vi.useRealTimers();}
      const rows=await events(f);expect(rows).toHaveLength(1);const details=rows[0].details!;
      expect(Date.parse(String(details.receivedAt))).toBeLessThan(code.expiresAt.getTime());expect(Date.parse(String(details.decisionAt))).toBeGreaterThan(code.expiresAt.getTime());
      expect(details.deadlineAt).toBe(code.expiresAt.toISOString());expect(details.failedChecks).toEqual(["code_expired"]);
      expect((await codeState(f)).consumedAt).toBeNull();expect(await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.grantId,f.binding.grantId!))).toHaveLength(0);
    });
  });
  it("enforces registered redirects,S256,current authority and ticket expiry before Muse redemption",async()=>{
    const f=await oauthFixture(false,false);
    for(const extra of [{redirect_uri:"https://attacker.example/callback"},{code_challenge_method:"plain"},{resource:oauthOrigin+"/mcp/paperclip"},{scope:"paperclip:agent"},{company_id:randomUUID()}])await expect(f.oauth.authorize({...f.input,...extra})).rejects.toThrow();
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].ticketHash).not.toBeNull();
    await db.update(companyMemberships).set({status:"inactive"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));await expect(f.oauth.authorize(f.input)).rejects.toThrow();
    await db.update(companyMemberships).set({status:"active"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    await db.update(bindings).set({ticketExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));await expect(f.oauth.authorize(f.input)).rejects.toThrow();
  });
  it("keeps only one Muse OAuth grant when ticket authorization races and rejects expired PKCE codes",async()=>{
    const f=await oauthFixture(false,false),results=await Promise.allSettled([f.oauth.authorize(f.input),f.oauth.authorize(f.input)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const [binding]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));expect(await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.agentId,f.agent.id))).toHaveLength(1);
    await db.update(mcpOauthRequests).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthRequests.grantId,binding.grantId!));
    expect((await request(transport()).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id)).status).toBe(410);
  });
  it("rotates finite Muse OAuth refresh,defaults absent resource only here,and fences replay without cleanup exception",async()=>{
    const f=await oauthFixture(true),original=f.tokens!;
    const [before]=await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash,hashMcpSecret(original.refresh_token!)));expect(before.expiresAt).toBeInstanceOf(Date);expect(before.expiresAt!.getTime()-Date.now()).toBeLessThanOrEqual(30*86400000);
    const rotated=await f.oauth.token({grant_type:"refresh_token",client_id:f.client.client_id,refresh_token:original.refresh_token});expect(rotated.refresh_token).not.toBe(original.refresh_token);
    await expect(f.oauth.token({grant_type:"refresh_token",client_id:f.client.client_id,refresh_token:rotated.refresh_token,resource:oauthOrigin+"/mcp/runner"})).rejects.toThrow();
    await expect(f.oauth.token({grant_type:"refresh_token",client_id:f.client.client_id,refresh_token:original.refresh_token})).rejects.toThrow();
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].revokedAt).toBeInstanceOf(Date);
    for(const path of ["queries","cleanup","detector-cleanup"]){const body=path==="queries"?{version:1,query:"identify"}:path==="cleanup"?{version:1,command:"control.inspect"}:{version:1,requestId:randomUUID(),bindingId:f.binding.id,generation:1,detectorRemoved:true};expect((await request(transport()).post("/api/muse/v1/"+path).set("Authorization","Bearer "+rotated.access_token).send(body)).status).toBe(401);}
  });
  it("keeps public OAuth contact from extending authenticated inactivity and denies wrong resource/offline scope",async()=>{
    const f=await oauthFixture(true),[refresh]=await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash,hashMcpSecret(f.tokens!.refresh_token!)));
    await museReceiver(db).signal(f.binding.id,oauthResource);await museReceiver(db).flush();expect((await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.id,refresh.id)))[0].expiresAt).toEqual(refresh.expiresAt);
    await db.update(mcpOauthGrants).set({resource:"https://another.example/api/muse/v1"}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
    expect((await inspectMuseConnectionCredential(db,f.binding,oauthResource)).state).toBe("revoked");await expect(assertMuseSubjectCredential(db,f.subject,oauthResource)).rejects.toThrow();
    await db.update(mcpOauthGrants).set({resource:oauthResource,scopes:["paperclip:agent"]}).where(eq(mcpOauthGrants.id,f.binding.grantId!));expect((await inspectMuseConnectionCredential(db,f.binding,oauthResource)).state).toBe("revoked");
    await db.update(mcpOauthGrants).set({scopes:["paperclip:agent","offline_access"]}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
    await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthTokens.id,refresh.id));expect((await inspectMuseConnectionCredential(db,f.binding,oauthResource)).state).toBe("expired");
    expect((await request(transport()).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id)).status).toBe(410);
  });
  it("serves PKCE OAuth ingress and disables raw HTTPlegacy pairing by default",async()=>{
    const f=await oauthFixture(false,false),app=transport();
    expect((await request(app).get("/api/muse/v1/oauth/metadata")).body).toMatchObject({issuer:oauthOrigin+"/api/muse/v1/oauth",token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"]});
    expect((await request(app).post("/api/muse/v1/pair").send({version:1,ticket:f.ticket,clientVersion:"2"})).status).toBe(404);
    expect((await request(app).post("/api/muse/v1/refresh").send({version:1,refreshToken:f.credentials.refreshToken})).status).toBe(404);
    const reply=await request(app).get("/api/muse/v1/oauth/authorize").query(f.input);expect(reply.status).toBe(303);expect(reply.headers["referrer-policy"]).toBe("no-referrer");
    const code=new URL(reply.headers.location).searchParams.get("code")!;
    const exchange=await request(app).post("/api/muse/v1/oauth/token").type("form").send({grant_type:"authorization_code",client_id:f.client.client_id,redirect_uri:oauthCallback,code,code_verifier:f.verifier});expect(exchange.status).toBe(200);expect(exchange.body.token_type).toBe("Bearer");
    expect((await request(app).post("/api/muse/v1/oauth/revoke").type("form").send({client_id:f.client.client_id,token:exchange.body.access_token})).status).toBe(200);
    expect((await request(app).get("/api/muse/v1/signal").set("X-Paperclip-Muse-Binding",f.binding.id)).status).toBe(410);
  });
  it.each(["access_expired","grant_revoked"])("rechecks idle OAuth authority after waiting for its transaction lock:%s",async(reason)=>{
    const f=await oauthFixture(true),requestId=randomUUID(),title="Must not create "+randomUUID();let outcome:Promise<{value?:unknown;error?:unknown}>|undefined;
    await db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,async()=>{
      await tx.select().from(bindings).where(eq(bindings.id,f.binding.id)).for("update");
      outcome=f.broker.act(f.subject,{version:1,command:"task.create",requestId,title}).then(value=>({value}),error=>({error}));
      await expect.poll(async()=>{const result=await db.execute(sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and lower(wait_event)='advisory'`);return Number(result[0]?.count??0);},{timeout:5000,interval:25}).toBeGreaterThan(0);
      if(reason==="access_expired")await tx.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(eq(mcpOauthTokens.id,f.subject.credentialId));
      else await tx.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
    }));
    expect((await outcome!).error).toBeDefined();expect(await db.select().from(issues).where(eq(issues.title,title))).toHaveLength(0);expect(await db.select().from(museIdleReceipts).where(eq(museIdleReceipts.requestId,requestId))).toHaveLength(0);
  });
  it.each(["code","refresh","revoke"])("serializes Muse OAuth%s behind the broker admission/binding prefix without grant/token lock inversion",async(kind)=>{
    const f=await oauthFixture(kind!=="code");let operation:Promise<{value?:unknown;error?:unknown}>|undefined;
    await db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,async()=>{
      await tx.select().from(bindings).where(eq(bindings.id,f.binding.id)).for("update");
      operation=(kind==="code"?f.oauth.token(f.tokenInput()):kind==="refresh"?f.oauth.token({grant_type:"refresh_token",client_id:f.client.client_id,refresh_token:f.tokens!.refresh_token}):f.oauth.revokeToken(f.tokens!.access_token,f.client.client_id)).then(value=>({value}),error=>({error}));
      await expect.poll(async()=>{const result=await db.execute(sql`select count(*)::int as count from pg_stat_activity where datname=current_database() and lower(wait_event)='advisory'`);return Number(result[0]?.count??0);},{timeout:5000,interval:25}).toBeGreaterThan(0);
      // Before the repair,token/code acquired this grant before waiting on binding.
      await tx.execute(sql`set local lock_timeout='1s'`);await tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,f.binding.grantId!)).for("update");
      await tx.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
    }));
    const result=await operation!;if(kind!=="revoke")expect(result.error).toBeDefined();else expect(result.error).toBeUndefined();
  });
  it("withholds fresh native dispatch when OAuthgrant is revoked before the binding fence or its refresh family expires",async()=>{
    const base=await oauthFixture(true),f=await active(base);try {
      await db.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,base.binding.grantId!));
      expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].revokedAt).toBeNull();
      await expect(f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).rejects.toThrow();expect(f.sent).toHaveLength(0);
      await expect(f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"assignment",binding:f.ref,tools:[],acceptByUnixMs:Date.now()+600000,expiresAtUnixMs:Date.now()+3600000}})).rejects.toThrow();
      await db.update(mcpOauthGrants).set({revokedAt:null}).where(eq(mcpOauthGrants.id,base.binding.grantId!));await db.update(mcpOauthTokens).set({expiresAt:new Date(Date.now()-1)}).where(and(eq(mcpOauthTokens.grantId,base.binding.grantId!),eq(mcpOauthTokens.kind,"refresh")));
      await expect(f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()})).rejects.toThrow();expect(f.sent).toHaveLength(0);
    }finally{await f.detach();}
  });
  it("revokes a persisted Muse grant through generic connection management after a public-origin change",async()=>{
    const f=await oauthFixture(true),otherOrigin="https://new.paperclip.example",management=createPublicMcpOAuth(db,{origin:otherOrigin,resource:otherOrigin+"/mcp/paperclip"});
    await instanceSettingsService(db).updateExperimental({enablePublicMcp:true});
    await management.revokeConnection(f.binding.grantId!,f.operatorId);
    expect((await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,f.binding.grantId!)))[0].revokedAt).toBeInstanceOf(Date);
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].revokedAt).toBeInstanceOf(Date);
    expect(await db.select().from(dotAgentBindings).where(eq(dotAgentBindings.agentId,f.agent.id))).toHaveLength(0);
  });
  it("reports installed client version only after a currently authenticated identify declaration",async()=>{
    const f=await oauthFixture();expect(f.binding.clientVersion).toBeNull();const tokens=await f.oauth.token(f.tokenInput()),app=transport();
    const identify=(clientVersion?:string)=>request(app).post("/api/muse/v1/queries").set("Authorization","Bearer "+tokens.access_token).send({version:1,query:"identify",...(clientVersion?{clientVersion}:{})});
    expect((await identify("3")).status).toBe(200);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].clientVersion).toBe("3");
    expect((await identify()).status).toBe(200);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].clientVersion).toBe("3");
    expect((await identify("4")).status).toBe(200);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].clientVersion).toBe("4");
    expect((await identify()).status).toBe(200);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].clientVersion).toBe("4");
    expect((await identify("5")).status).toBe(200);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].clientVersion).toBe("5");
    expect((await identify(MUSE_CLIENT_VERSION)).status).toBe(200);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].clientVersion).toBe(MUSE_CLIENT_VERSION);
    expect((await identify()).status).toBe(200);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].clientVersion).toBe(MUSE_CLIENT_VERSION);
    expect((await identify(String(Number(MUSE_CLIENT_VERSION)+1))).status).toBe(400);
    await db.update(bindings).set({clientVersion:"2"}).where(eq(bindings.id,f.binding.id));await db.update(mcpOauthGrants).set({revokedAt:new Date()}).where(eq(mcpOauthGrants.id,f.binding.grantId!));
    expect((await identify("4")).status).toBe(401);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].clientVersion).toBe("2");
    expect((await request(app).post("/api/muse/v1/queries").send({version:1,query:"identify",clientVersion:"3"})).status).toBe(401);
  });
  it("preserves personal and Dot default OAuth resources and their deployed refresh policy",async()=>{
    await instanceSettingsService(db).updateExperimental({enablePublicMcp:true,enableOpenAiDot:true});const f=await fixture();
    const personal=createPublicMcpOAuth(db,{origin:oauthOrigin,resource:oauthOrigin+"/mcp/paperclip"}),client=await personal.register({client_name:"Personal",redirect_uris:[oauthCallback]},randomUUID()),verifier=randomBytes(32).toString("base64url"),challenge=createHash("sha256").update(verifier).digest("base64url");
    await expect(personal.authorize({client_id:client.client_id,redirect_uri:oauthCallback,response_type:"code",code_challenge:challenge,code_challenge_method:"S256"})).rejects.toThrow();
    const personalId=(await personal.authorize({client_id:client.client_id,redirect_uri:oauthCallback,response_type:"code",resource:personal.config.resource,scope:"paperclip:read offline_access",code_challenge:challenge,code_challenge_method:"S256"})).split("/").at(-1)!;
    const consent=await personal.consent(personalId,{type:"board",source:"session",userId:f.operatorId},{decision:"approve",companyId:f.company.id,allowWrites:false}),tokens=await personal.token({grant_type:"authorization_code",client_id:client.client_id,redirect_uri:oauthCallback,resource:personal.config.resource,code:new URL(consent.redirectUrl).searchParams.get("code")!,code_verifier:verifier});
    expect((await personal.authenticate(tokens.access_token)).actor).toMatchObject({type:"board",userId:f.operatorId,isInstanceAdmin:false});
    const [personalRefresh]=await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash,hashMcpSecret(tokens.refresh_token!)));expect(personalRefresh.expiresAt).toBeInstanceOf(Date);
    const [agent]=await db.insert(agents).values({companyId:f.company.id,name:"Dot",status:"active",adapterType:"paperclip_runner",adapterConfig:{provider:"openai_dot"}}).returning();const dot=createPublicMcpOAuth(db,{origin:oauthOrigin,resource:oauthOrigin+"/mcp/runner"}),dotClient=await dot.register({client_name:"Dot",redirect_uris:[oauthCallback]},randomUUID()),pairing=await dotRunnerBroker(db).createPairing({companyId:f.company.id,agentId:agent.id,operatorId:f.operatorId});
    const dotId=(await dot.authorize({client_id:dotClient.client_id,redirect_uri:oauthCallback,response_type:"code",resource:dot.config.resource,scope:"paperclip:agent offline_access",code_challenge:challenge,code_challenge_method:"S256"})).split("/").at(-1)!;
    const linked=await dot.consentDotPairing(dotId,pairing.pairingCode),dotTokens=await dot.token({grant_type:"authorization_code",client_id:dotClient.client_id,redirect_uri:oauthCallback,resource:dot.config.resource,code:new URL(linked.redirectUrl).searchParams.get("code")!,code_verifier:verifier});
    expect((await dot.authenticate(dotTokens.access_token)).actor).toMatchObject({type:"agent",agentId:agent.id});const [dotRefresh]=await db.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash,hashMcpSecret(dotTokens.refresh_token!)));expect(dotRefresh.expiresAt).toBeNull();
  });

});
