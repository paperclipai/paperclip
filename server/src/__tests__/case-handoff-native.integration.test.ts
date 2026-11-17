import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, agentWakeupRequests, authUsers, caseDocuments, caseEvents, caseHandoffs, cases, companies, companyMemberships, createDb, documents, heartbeatRuns, issueDocuments, issues } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { caseRoutes } from "../routes/cases.js";
import { caseHandoffRoutes } from "../routes/case-handoffs.js";
import { issueRoutes } from "../routes/issues.js";
import { setupRunnerPrpWebSocketServer, runnerPrpWebSocketInternals } from "../realtime/runner-prp-ws.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { defaultCapabilityRunnerdBinary } from "../vendor/paperclip-runner/index.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const supported = await getEmbeddedPostgresTestSupport();
const suite = supported.supported && existsSync(defaultCapabilityRunnerdBinary()) ? describe : describe.skip;

/** The provider alone is scripted. Tool discovery, calls, auto-yield, retirement,
 * run finalization, queue admission and recipient context use production code. */
suite("case handoff through the assembled native runner", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let server: Server;
  let root: string;
  const restore = new Map<string, string | undefined>();
  let restoreCodex: (() => void) | undefined;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "case-native-integration-"));
    for (const key of ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_API_URL", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_RUNNER_STATE_DIR"]) restore.set(key, process.env[key]);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "case-native-integration-secret";
    process.env.PAPERCLIP_HOME = join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "case-native-integration";
    process.env.PAPERCLIP_RUNNER_STATE_DIR = join(root, "runner-state");
    await mkdir(process.env.PAPERCLIP_HOME, { recursive: true });
    temporary = await startEmbeddedPostgresTestDatabase("case-native-integration-db-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const app = express(); app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    const storage = { provider: "local_disk", putFile: async () => { throw new Error("unused"); }, getObject: async () => { throw new Error("unused"); },
      headObject: async () => ({ exists: false }), deleteObject: async () => {} } satisfies StorageService;
    app.use("/api", caseRoutes(db, storage)); app.use("/api", caseHandoffRoutes(db)); app.use("/api", issueRoutes(db, storage)); app.use(errorHandler);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.PAPERCLIP_API_URL = apiUrl;
    setupRunnerPrpWebSocketServer(server, { apiUrl });
  }, 30_000);
  afterAll(async () => {
    if (db) {
      const live = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"));
      for (const run of live) await heartbeat.cancelRun(run.id).catch(() => undefined);
      await heartbeat.drainActiveRunExecutions();
    }
    restoreCodex?.();
    if (server) { runnerPrpWebSocketInternals.resetForTests(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve())); }
    await temporary?.cleanup();
    async function writable(directory: string) {
      await chmod(directory, 0o700).catch(() => undefined);
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await writable(file);
      }
    }
    await writable(root);
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of restore) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });

  it("yields through A→B→A, resumes each agent's own session, then closes only after accepted task completion", async () => {
    const companyId = randomUUID(), triage = randomUUID(), engineer = randomUUID(), userId = randomUUID();
    const sourceHome = join(root, "provider-home"), workspace = join(root, "workspace"), bin = join(root, "bin");
    await Promise.all([sourceHome, workspace, bin].map(path => mkdir(path, { recursive: true })));
    await db.insert(authUsers).values({ id: userId, name: "Factory operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Native factory proof", issuePrefix: `N${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" });
    for (const [id, role] of [[triage, "ceo"], [engineer, "engineer"]] as const) await db.insert(agents).values({ id, companyId, name: role,
      role, ...(id === engineer ? { reportsTo: triage } : {}), status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-5.6-sol", cwd: workspace, lifecycleMode: "per_turn", codexPermissionMode: "never", timeoutSec: 30,
        env: { CODEX_HOME: sourceHome, OPENAI_API_KEY: "", CODEX_API_KEY: "" } }, runtimeConfig: { heartbeat: { enabled: false } } });
    const initial = await caseHandoffService(db).handoff(companyId, { type: "board", source: "local_implicit", userId }, {
      idempotencyKey: "native-factory-start", case: { create: { caseType: "work", title: "Native factory proof", fields: { specification: "persisted native specification canary" } } },
      workflow_document_text: "Workflow routing canary: triage reads the brief, implementation saves evidence, verification checks it, and finalization closes this same task.",
      toAgentId: triage, phase: "triage", instructions: "Research then hand this same task to implementation",
      initialDocuments: [{ key: "brief", title: "Factory brief", body: "Seeded native task brief canary" }],
    });
    const provider = join(root, "scripted-codex.mjs"), command = join(bin, "codex");
    const config = { caseId: initial.caseId, taskId: initial.taskId, triage, engineer,
      errors: join(root, "provider-error.json"), exposed: join(root, "exposed.json"), accepted: join(root, "accepted.json"),
      observed: join(root, "observed.json"), returned: join(root, "returned.json"), finalTurn: join(root, "final-turn.json"), terminal: join(root, "terminal.json") };
    await writeFile(provider, `
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
const config=${JSON.stringify(config)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let turn='native-case-turn-'+randomUUID(), thread='native-case-thread-'+randomUUID(), step=0, context, prompt='', active=false, contract, returning=false, finishing=false, threadMethod;
process.on('uncaughtException', error=>{writeFileSync(config.errors,JSON.stringify({message:error.message}));process.exit(1);});
const call=(tool,args)=>{step++;send({id:'call-'+step,method:'item/tool/call',params:{threadId:thread,turnId:turn,callId:'tool-'+step,tool,arguments:args}});};
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line), p=m.params??{};
  if (!m.method) {
    if (!String(m.id).startsWith('call-')) continue;
    if(m.error||m.result?.success!==true) throw new Error('fixture native tool rejected');
    const content=m.result.contentItems??m.result.content??[];
    const value=JSON.parse(content.find(item=>typeof item.text==='string')?.text??'{}');
    if(step===1) {
      context=value.result?.activeTask?value.result:value;
      if(context.activeTask?.id!==config.taskId) throw new Error('fixture task identity mismatch');
      if(context.actor.id===config.triage&&existsSync(config.accepted)) {
        returning=true;
        finishing=existsSync(config.returned);
        writeFileSync(finishing?config.finalTurn:config.returned,JSON.stringify({actorId:context.actor.id,taskId:context.activeTask.id,prompt,threadMethod,pid:process.pid}));
        if(finishing) call('handoff_case',{idempotencyKey:'native-case-done',case:{id:config.caseId},to:'done',instructions:'The native handoff observation document is persisted; finish the task normally.',expectedHandoffVersion:4,expectedIssueStatusVersion:context.activeTask.statusVersion});
        else call('handoff_case',{idempotencyKey:'native-verification-handoff',case:{id:config.caseId},toAgentId:config.triage,phase:'finalization',instructions:'Finish the verified native handoff case',expectedHandoffVersion:3,expectedIssueStatusVersion:context.activeTask.statusVersion});
      } else if(context.actor.id===config.triage) {
        if(prompt.includes('Workflow routing canary:')) throw new Error('workflow body was duplicated into bootstrap prompt');
        call('read_document',{key:'workflow'});
      }
      else call('read_case',{});
    } else if(context.actor.id===config.triage&&!returning&&step===2) {
      const document=(value.result??value).document;
      if(document?.issueId!==config.taskId||!document.body?.startsWith('Workflow routing canary:')) throw new Error('required workflow document not readable before handoff');
      call('read_document',{key:'brief'});
    } else if(context.actor.id===config.triage&&!returning&&step===3) {
      const document=(value.result??value).document;
      if(document?.issueId!==config.taskId||(document.body??document.latestBody)!=='Seeded native task brief canary') throw new Error('initial task brief not readable before handoff');
      call('handoff_case',{idempotencyKey:'native-triage-handoff',case:{id:config.caseId},toAgentId:config.engineer,phase:'implementation',instructions:'Implement the persisted native specification canary',expectedHandoffVersion:1,expectedIssueStatusVersion:context.activeTask.statusVersion});
    } else if(context.actor.id===config.triage&&!returning) writeFileSync(config.accepted,JSON.stringify({value,pid:process.pid}));
    else if(returning&&!finishing) {}
    else if(finishing&&step===2) {
      writeFileSync(config.terminal,JSON.stringify(value));
      if(!contract) throw new Error('fixture did not receive the current completion contract');
      call('paperclip_finish',{reportedWorkDisposition:'done',summary:'Saved the native handoff observation document and completed this same task.',completionClaim:{contractRevision:contract.revision,objectiveSatisfied:true,criteria:contract.criteria.map(c=>({criterionId:c.id,status:'satisfied',evidenceRefs:[]})),remainingWork:[]},evidence:[],verification:[],attentionRequests:[],artifacts:[]});
    } else if(returning) {active=false;send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});}
    else if(step===2) {
      const response=value.result??value;
      if(response.ok!==true||response.data?.id!==config.caseId) throw new Error('native read_case did not resolve the primary case');
      call('update_case',{idempotencyKey:'successor-case-facts',fields:{...response.data.fields,verified:true}});
    } else if(step===3) {
      const response=value.result??value;
      if(response.ok!==true||response.data?.fields?.verified!==true) throw new Error('native update_case did not persist facts');
      call('write_document',{idempotencyKey:'successor-observation',key:'native-handoff-observed',title:'Native handoff observation',baseRevisionId:null,body:JSON.stringify({taskId:config.taskId,caseId:config.caseId,freshPrompt:prompt.includes('persisted native specification canary')&&prompt.includes('implementation')&&prompt.includes('handoffVersion')})});
    } else if(step===4) {
      const response=value.result??value;
      if(response.document?.latestRevisionNumber!==1) throw new Error('native write_document did not save revision 1');
      call('read_document',{key:'native-handoff-observed'});
    } else if(step===5) {
      const response=value.result??value;
      if(JSON.parse(response.document?.body??response.document?.latestBody??'{}').taskId!==config.taskId) throw new Error('native read_document did not load the saved body');
      writeFileSync(config.observed,JSON.stringify({actorId:context.actor.id,taskId:context.activeTask.id,pid:process.pid}));
      call('handoff_case',{idempotencyKey:'native-implementation-handoff',case:{id:config.caseId},toAgentId:config.triage,phase:'verification',instructions:'Verify the saved native handoff observation and finish this case',expectedHandoffVersion:2,expectedIssueStatusVersion:context.activeTask.statusVersion});
    }
    continue;
  }
  if(m.id===undefined) continue;
  if(m.method==='initialize') send({id:m.id,result:{user:{sessionId:'native-case-provider'}}});
  else if(['thread/start','thread/resume','thread/read'].includes(m.method)) {
    if(m.method!=='thread/read') threadMethod=m.method;
    if(m.method!=='thread/start'&&typeof p.threadId==='string') thread=p.threadId;
    const names=(p.dynamicTools??[]).map(t=>t.name);
    if(m.method!=='thread/read') {
      if(names.includes('read_case_document')||names.includes('write_case_document')) throw new Error('retired case document tool still exposed');
      for(const name of ['create_case','handoff_case','read_case','update_case','read_document','write_document']) if(!names.includes(name)) throw new Error(name+' not exposed by production');
      const creation=p.dynamicTools.find(tool=>tool.name==='create_case');
      if(!creation.inputSchema?.required?.includes('kickoff')) throw new Error('create_case must require kickoff in provider tool discovery');
      writeFileSync(config.exposed,JSON.stringify({names,creationSchema:creation.inputSchema}));
    }
    send({id:m.id,result:{model:'gpt-5.6-sol',thread:{id:thread,sessionId:thread,status:{type:active?'active':'idle'},turns:active?[{id:turn,status:'inProgress'}]:[]}}});
  } else if(m.method==='thread/turns/list') send({id:m.id,result:{data:active?[{id:turn,status:'inProgress',items:[],itemsView:'notLoaded'}]:[],nextCursor:null}});
  else if(m.method==='turn/start') {active=true;prompt=JSON.stringify(p);const envelope=JSON.parse(p.input.find(i=>i.type==='text').text);contract=envelope.completionContract??(envelope.completion?{revision:envelope.completion.revision,criteria:envelope.completion.criterionIds.map(id=>({id}))}:null);send({id:m.id,result:{turn:{id:turn,status:'inProgress'}}});send({method:'turn/started',params:{threadId:thread,turn:{id:turn,status:'inProgress'}}});call('get_task_context',{});}
  else if(m.method==='turn/interrupt') {active=false;send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:thread,turn:{id:p.turnId??turn,status:'interrupted'}}});}
  else send({id:m.id,result:{}});
}
`, { mode: 0o600 });
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(provider)}\n`, { mode: 0o700 });
    await chmod(command, 0o700);
    const resolver = await vi.importActual<{ resolveCodexCommand: () => string }>("../../../packages/paperclip-runner/src/drivers/codex/codex-command.js");
    const spy = vi.spyOn(resolver, "resolveCodexCommand").mockReturnValue(command); restoreCodex = () => spy.mockRestore();
    const wait = async (predicate: () => Promise<boolean>, label: string, bound = 35_000) => {
      const deadline = Date.now() + bound;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      const state = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, error: heartbeatRuns.error, result: heartbeatRuns.resultJson }).from(heartbeatRuns);
      const ledger = await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, initial.caseId));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      throw new Error(`${label}: runs=${JSON.stringify(state)}; handoffs=${JSON.stringify(ledger)}; wakes=${JSON.stringify(wakes)}; provider=${await readFile(config.errors, "utf8").catch(() => "no scripted-provider error")}`);
    };
    const delivery = caseHandoffDeliveryService(db, { heartbeat });
    const seeded = await db.select({ issueId: issueDocuments.issueId, key: issueDocuments.key, body: documents.latestBody })
      .from(issueDocuments).innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(eq(issueDocuments.issueId, initial.taskId)).orderBy(issueDocuments.key);
    expect(seeded).toEqual([
      { issueId: initial.taskId, key: "brief", body: "Seeded native task brief canary" },
      { issueId: initial.taskId, key: "workflow", body: "Workflow routing canary: triage reads the brief, implementation saves evidence, verification checks it, and finalization closes this same task." },
    ]);
    expect(await db.select().from(caseDocuments).where(eq(caseDocuments.caseId, initial.caseId))).toHaveLength(0);
    await delivery.sweepPending();
    await wait(async () => existsSync(config.accepted), "scripted provider did not receive a successful native handoff response");
    const accepted = JSON.parse(await readFile(config.accepted, "utf8"));
    const receipt = accepted.value.result?.handoffId ? accepted.value.result : accepted.value;
    expect(receipt).toMatchObject({ taskId: initial.taskId, state: "awaiting_release", callerMustYield: true });
    expect(JSON.parse(await readFile(config.exposed, "utf8")).names).toContain("create_case");
    expect(JSON.parse(await readFile(config.exposed, "utf8")).creationSchema.required).toContain("kickoff");
    expect(await db.select().from(cases).where(eq(cases.companyId, companyId))).toHaveLength(1);
    // No provider finish call exists in the script. Only the production native
    // governed-wait observer can settle this run successfully.
    await heartbeat.drainActiveRunExecutions();
    const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, triage)));
    expect(source).toMatchObject({ runtimeMode: "native", status: "succeeded" });
    expect(source!.resultJson).toMatchObject({ caseHandoffExecutionReleased: { issueId: initial.taskId },
      nativeResult: { reportedWorkDisposition: "yielded", continuation: { kind: "case_handoff", handoffId: receipt.handoffId } } });
    const [sourceSession] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.agentId, triage), eq(agentTaskSessions.taskKey, initial.taskId)));
    expect(sourceSession).toMatchObject({ lastRunId: source!.id, sessionParamsJson: {
      __paperclipConfigFingerprint: expect.any(String), __paperclipConfigFingerprintVersion: expect.any(Number),
    } });
    expect(sourceSession!.sessionDisplayId).toBeTruthy();
    expect(() => process.kill(accepted.pid, 0)).toThrow();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, engineer))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, initial.taskId)))[0]!.status).not.toBe("done");
    await caseHandoffDeliveryService(db, { heartbeat }).sweepPending();
    await wait(async () => existsSync(config.observed), "native successor did not read and save its admitted context");
    const observed = JSON.parse(await readFile(config.observed, "utf8"));
    expect(observed).toMatchObject({ actorId: engineer, taskId: initial.taskId });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, engineer));
    expect(successor).toMatchObject({ runtimeMode: "native", nativeIssueId: initial.taskId });
    expect(successor!.contextSnapshot?.paperclipCase).toMatchObject({ phase: "implementation", handoffVersion: 2, taskId: initial.taskId,
      incomingHandoff: { instructions: expect.stringContaining("Implement the persisted native specification canary") } });
    const [document] = await db.select({ body: documents.latestBody }).from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(and(eq(issueDocuments.issueId, initial.taskId), eq(issueDocuments.key, "native-handoff-observed")));
    expect(JSON.parse(document!.body)).toMatchObject({ taskId: initial.taskId, caseId: initial.caseId, freshPrompt: true });
    expect((await db.select().from(cases).where(eq(cases.id, initial.caseId)))[0]?.fields).toMatchObject({ verified: true });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    await heartbeat.drainActiveRunExecutions();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor!.id)))[0]).toMatchObject({
      status: "succeeded", resultJson: { nativeResult: { reportedWorkDisposition: "yielded" } },
    });
    await delivery.sweepPending();
    await wait(async () => existsSync(config.returned), "returning native agent did not resume its own task session");
    const returned = JSON.parse(await readFile(config.returned, "utf8"));
    expect(returned).toMatchObject({ actorId: triage, taskId: initial.taskId, threadMethod: "thread/resume" });
    expect(returned.prompt).toContain("Verify the saved native handoff observation and finish this case");
    expect(returned.prompt.split("Verify the saved native handoff observation and finish this case")).toHaveLength(2);
    expect(returned.prompt).toContain("verification");
    const returningEnvelope = JSON.parse(JSON.parse(returned.prompt).input.find((item: { type: string }) => item.type === "text").text);
    expect(returningEnvelope.schema).toBe("paperclip.native-continuation.v1");
    await heartbeat.drainActiveRunExecutions();
    await delivery.sweepPending();
    await wait(async () => existsSync(config.finalTurn), "verified native agent did not resume the unchanged case");
    const finalTurn = JSON.parse(await readFile(config.finalTurn, "utf8"));
    expect(finalTurn.threadMethod).toBe("thread/resume");
    const finalEnvelope = JSON.parse(JSON.parse(finalTurn.prompt).input.find((item: { type: string }) => item.type === "text").text);
    expect(finalEnvelope.schema).toBe("paperclip.native-continuation.v1");
    const finalEvents = JSON.parse(finalEnvelope.events);
    expect(finalEvents.workflowCase).toMatchObject({ phase: "finalization", factsUnchanged: true,
      incomingHandoff: { instructions: "Handoff to finalization\n\nFinish the verified native handoff case" } });
    expect(finalEvents.workflowCase).not.toHaveProperty("data");
    expect(finalTurn.prompt).not.toContain("persisted native specification canary");
    expect(finalTurn.prompt.split("Finish the verified native handoff case")).toHaveLength(2);
    await heartbeat.drainActiveRunExecutions();
    const terminalValue = JSON.parse(await readFile(config.terminal, "utf8"));
    const terminalReceipt = terminalValue.result?.handoffId ? terminalValue.result : terminalValue;
    expect(terminalReceipt).toMatchObject({ taskId: initial.taskId, state: "awaiting_completion", callerMustYield: false });
    const finished = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, triage)))).find(run => run.resultJson?.nativeResult && (run.resultJson.nativeResult as { reportedWorkDisposition?: string }).reportedWorkDisposition === "done");
    expect(finished).toMatchObject({ status: "succeeded", sessionIdBefore: sourceSession!.sessionDisplayId,
      usageJson: { sessionReused: true, taskSessionReused: true, freshSession: false },
      resultJson: { nativeResult: { reportedWorkDisposition: "done" }, configFreshness: { session: { reset: false, storedFingerprintPresent: true } } } });
    expect((await db.select().from(issues).where(eq(issues.id, initial.taskId)))[0]).toMatchObject({ status: "done" });
    expect((await db.select().from(cases).where(eq(cases.id, initial.caseId)))[0]).toMatchObject({ status: "done", phase: "done", completedAt: expect.any(Date) });
    const ledger = await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, initial.caseId));
    expect(ledger).toHaveLength(5);
    expect(ledger.map(row => row.issueId)).toEqual([initial.taskId, initial.taskId, initial.taskId, initial.taskId, initial.taskId]);
    expect(ledger.find(row => row.destinationKind === "done")).toMatchObject({ state: "completed", deliveredAt: null, completedAt: expect.any(Date) });
    expect(await db.select().from(caseEvents).where(and(eq(caseEvents.caseId, initial.caseId), eq(caseEvents.kind, "handoff_completed")))).toHaveLength(1);
  }, 90_000);
});
