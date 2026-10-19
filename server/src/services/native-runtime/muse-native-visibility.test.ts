import { randomUUID } from "node:crypto";
import { LOW_TRUST_REVIEW_PRESET, DEFAULT_TRUST_PRESET } from "@paperclipai/shared";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, authUsers, companies, companyMemberships, createDb, completionContracts, nativeRunResults, workAssessments, statusDecisions, issueApprovals, documents, documentRevisions, externalAgentHolds, heartbeatRuns, instanceUserRoles, issueAccessGrants, issues, issueDocuments, issueThreadInteractions, principalPermissionGrants, projectAccessMembers, projects } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { approvalReadSqlCondition, authorizationService, canActorReadIssuePrivacy, issueReadSqlCondition, projectReadSqlCondition, type AuthorizationActor } from "../authorization.js";
import { claimQueuedNativeReviewRun } from "./native-review-dispatch.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { documentService } from "../documents.js";
import { buildLowTrustSourceTrust, buildPromotedSourceTrust, LOW_TRUST_QUARANTINED_BODY } from "../source-trust.js";

describe("Muse native visibility intersection", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("muse-native-visibility-"); db = createDb(temporary.connectionString); }, 30000);
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(() => vi.unstubAllEnvs());
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), responsible = randomUUID(), authorizer = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Muse visibility", issuePrefix: `V${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values([responsible, authorizer].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companyMemberships).values([responsible, authorizer].map(principalId => ({ companyId, principalType: "user", principalId, status: "active", membershipRole: "operator" })));
    await db.insert(agents).values({ id: agentId, companyId, name: "Muse", role: "engineer", status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "muse" }, runtimeConfig: {}, permissions: {} });
    const [issue] = await db.insert(issues).values({ companyId, title: "Private task", visibility: "private", assigneeAgentId: agentId, responsibleUserId: responsible }).returning();
    const actor: AuthorizationActor = { type: "agent", agentId, companyId, source: "agent_jwt", onBehalfOfUserId: responsible, authorizingUserId: authorizer };
    return { companyId, agentId, responsible, authorizer, issue, actor };
  }
  async function documentFixture(lowTrustReader = false) {
    const f = await fixture(), runId = randomUUID();
    const executionPolicy = lowTrustReader ? { authorizationPolicy: { trustBoundary: {
      mode: LOW_TRUST_REVIEW_PRESET, companyId: f.companyId, rootIssueId: f.issue.id,
    } } } : null;
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issue.id, responsibleUserId: f.responsible, status: "running", runtimeMode: "native",
      invocationSource: "assignment", contextSnapshot: { issueId: f.issue.id, executionPolicy } });
    await db.update(issues).set({ status: "in_progress", executionRunId: runId, executionPolicy: null }).where(eq(issues.id, f.issue.id));
    await db.insert(issueAccessGrants).values({ issueId: f.issue.id, subjectType: "user", subjectId: f.authorizer, source: "explicit" });
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId,
      issueId: f.issue.id, runId, museRuntime: true, externalAuthorizingUserId: f.authorizer,
      assertBridgeAuthority: async () => {} });
    return { ...f, runId, authority };
  }

  async function taskReadBoundaryFixture(restricted:boolean) {
    const f=await documentFixture();
    const [allowedProject,outsideProject]=await db.insert(projects).values([
      {companyId:f.companyId,name:"Native allowed project"},{companyId:f.companyId,name:"Native outside project"},
    ]).returning();
    await db.update(issues).set({projectId:allowedProject.id}).where(eq(issues.id,f.issue.id));
    if(restricted)await db.update(heartbeatRuns).set({contextSnapshot:{issueId:f.issue.id,executionPolicy:{authorizationPolicy:{trustPreset:LOW_TRUST_REVIEW_PRESET,trustBoundary:{mode:LOW_TRUST_REVIEW_PRESET,companyId:f.companyId,projectIds:[allowedProject.id]}}}}}).where(eq(heartbeatRuns.id,f.runId));
    const [allowed,outside]=await db.insert(issues).values([
      {companyId:f.companyId,parentId:f.issue.id,projectId:allowedProject.id,title:"MUSE_READ_SCOPE_ALLOWED",description:"MUSE_READ_ALLOWED_BODY",visibility:"open",status:"done"},
      {companyId:f.companyId,parentId:f.issue.id,projectId:outsideProject.id,title:"MUSE_READ_SCOPE_OUTSIDE",description:"MUSE_READ_OUTSIDE_BODY",visibility:"open",status:"done"},
    ]).returning();
    const actor={...f.actor,runId:f.runId};
    expect(await canActorReadIssuePrivacy(db,actor,outside)).toBe(true);
    const decisions=await authorizationService(db).decideReads(actor,[allowed,outside].map(issue=>({type:"issue" as const,companyId:f.companyId,issueId:issue.id})));
    expect(decisions.map(decision=>decision.allowed)).toEqual([true,!restricted]);
    return {...f,allowed,outside};
  }
  async function recordedChildReview(f:Awaited<ReturnType<typeof taskReadBoundaryFixture>>,issueId:string) {
    const contractId=randomUUID(),sourceRunId=randomUUID(),resultId=randomUUID(),assessmentId=randomUUID(),decisionId=randomUUID(),interactionId=randomUUID();
    await db.insert(completionContracts).values({id:contractId,companyId:f.companyId,issueId,revision:1,schemaVersion:"paperclip.completion-contract.v1",policyVersion:"native-read-fixture",risk:"standard",completionAuthority:"server_arbiter",incompleteCriteriaPolicy:"preserve_non_terminal",contractJson:{objective:"Review child"},canonicalSha256:contractId,createdByActorType:"system",createdByActorId:"test"});
    await db.insert(heartbeatRuns).values({id:sourceRunId,companyId:f.companyId,agentId:f.agentId,nativeIssueId:issueId,status:"succeeded",runtimeMode:"native",completionContractId:contractId});
    await db.insert(nativeRunResults).values({id:resultId,companyId:f.companyId,issueId,runId:sourceRunId,completionContractId:contractId,serverFingerprint:resultId,schemaStatus:"accepted",resultJson:{},canonicalSha256:resultId});
    await db.insert(workAssessments).values({id:assessmentId,companyId:f.companyId,issueId,runId:sourceRunId,contractId,resultId,triggerKind:"native_result",triggerActorCompanyId:f.companyId,priorIssueStatus:"in_progress",priorStatusVersion:0,policyVersion:"native-read-fixture",assessmentJson:{},inputDigest:assessmentId});
    await db.insert(statusDecisions).values({id:decisionId,companyId:f.companyId,issueId,runId:sourceRunId,assessmentId,decisionVersion:1,policyVersion:"native-read-fixture",fromStatus:"in_progress",toStatus:"done",reasonCode:"explicit_review",decisionJson:{},decisionDigest:decisionId,applicationState:"applied"});
    await db.insert(issueThreadInteractions).values({id:interactionId,companyId:f.companyId,issueId,kind:"request_confirmation",status:"accepted",sourceRunId,createdByAgentId:f.agentId,resolvedByUserId:f.authorizer,resolvedAt:new Date(),payload:{version:1,prompt:"Review child",target:{type:"custom",key:"native_completion_review",revisionId:decisionId}}});
    return interactionId;
  }
  it.each([true,false].flatMap(restricted=>["search_tasks","child_tasks","child_review_outcomes","approval_tasks"].map(shape=>({restricted,shape}))))("applies ordinary per-task decisions to native Muse result collections ($shape; restricted: $restricted)",async({restricted,shape})=>{
    const f=await taskReadBoundaryFixture(restricted);
    let approvalId:string|undefined;
    if(shape==="child_review_outcomes"){
      await recordedChildReview(f,f.allowed.id);await recordedChildReview(f,f.outside.id);
    }
    if(shape==="approval_tasks"){
      const [approval]=await db.insert(approvals).values({companyId:f.companyId,type:"hire_agent",status:"pending",payload:{issueId:f.issue.id}}).returning();approvalId=approval.id;
      await db.insert(issueApprovals).values([f.allowed,f.outside].map(issue=>({companyId:f.companyId,issueId:issue.id,approvalId:approval.id,linkedByAgentId:f.agentId})));
    }
    const result=await f.authority.execute({tool:shape==="search_tasks"?"search_tasks":shape==="approval_tasks"?"get_approval_context":"get_task_context",callId:"per-task-"+shape,arguments:shape==="search_tasks"?{query:"MUSE_READ_SCOPE",limit:10}:shape==="approval_tasks"?{approvalId}:{}});
    const ids=shape==="child_review_outcomes"
      ?(result as {childReviewOutcomes:Array<{result:{childTaskId:string}}>}).childReviewOutcomes.map(row=>row.result.childTaskId)
      :shape==="child_tasks"?(result as {childTasks:Array<{id:string}>}).childTasks.map(row=>row.id)
      :(result as {tasks:Array<{id:string}>}).tasks.map(row=>row.id);
    expect(ids).toContain(f.allowed.id);
    if(restricted){expect(ids).not.toContain(f.outside.id);for(const value of [f.outside.id,f.outside.title,f.outside.description])expect(JSON.stringify(result)).not.toContain(value);}
    else expect(ids).toContain(f.outside.id);
    if(shape==="search_tasks"){
      const outsideOnly=await f.authority.execute({tool:"search_tasks",callId:"outside-only",arguments:{query:"MUSE_READ_SCOPE_OUTSIDE",limit:1}});
      expect(outsideOnly).toMatchObject({tasks:restricted?[]:[{id:f.outside.id}]});
    }
  });
  it("retains the child search fallback when the authorized child follows a capped denied prefix",async()=>{
    const f=await taskReadBoundaryFixture(true),older=new Date("2026-01-01T00:00:00.000Z"),newer=new Date("2026-01-01T01:00:00.000Z");
    await db.update(issues).set({createdAt:older}).where(eq(issues.id,f.allowed.id));
    await db.update(issues).set({createdAt:newer}).where(eq(issues.id,f.outside.id));
    const denied=await db.insert(issues).values(Array.from({length:100},(_,index)=>({
      id:f.companyId.slice(0,24)+index.toString(16).padStart(12,"0"),companyId:f.companyId,parentId:f.issue.id,
      projectId:f.outside.projectId,title:"MUSE_DENIED_PREFIX_"+index,description:"MUSE_DENIED_PREFIX_BODY_"+index,
      visibility:"open",status:"done",createdAt:newer,
    }))).returning();
    const actor={...f.actor,runId:f.runId};
    const candidates=await db.select({id:issues.id}).from(issues).where(and(eq(issues.companyId,f.companyId),eq(issues.parentId,f.issue.id),await issueReadSqlCondition(db,actor)))
      .orderBy(desc(issues.createdAt),desc(issues.id)).limit(101);
    expect(candidates.map(row=>row.id)).toEqual([f.outside.id,...denied.map(row=>row.id)].sort().reverse());
    expect(candidates.map(row=>row.id)).not.toContain(f.allowed.id);
    const result=await f.authority.execute({tool:"get_task_context",callId:"capped-denied-prefix",arguments:{}}) as {childTasksTruncated:boolean;childTasks:Array<{id:string}>};
    expect(result.childTasksTruncated).toBe(true);
    expect(result.childTasks).toEqual([]);
    for(const row of [f.outside,...denied])for(const value of [row.id,row.title,row.description])expect(JSON.stringify(result)).not.toContain(value);
    expect(await f.authority.execute({tool:"search_tasks",callId:"older-authorized-search",arguments:{query:"MUSE_READ_SCOPE_ALLOWED",limit:1}}))
      .toMatchObject({tasks:[{id:f.allowed.id,title:f.allowed.title,description:f.allowed.description}]});
  });
  it("preserves ordinary unrestricted native task search results",async()=>{
    const f=await taskReadBoundaryFixture(false);
    await db.update(agents).set({adapterConfig:{provider:"codex"}}).where(eq(agents.id,f.agentId));
    const authority=new PaperclipRunnerToolAuthority(db,{companyId:f.companyId,agentId:f.agentId,issueId:f.issue.id,runId:f.runId});
    expect(await authority.execute({tool:"search_tasks",callId:"ordinary-search",arguments:{query:"MUSE_READ_SCOPE",limit:10}})).toMatchObject({tasks:expect.arrayContaining([{...f.allowed},{...f.outside}].map(task=>expect.objectContaining({id:task.id,title:task.title,description:task.description})))});
  });

  it("tags actual Muse native document writes with the retained low-trust run before storing or replaying them", async () => {
    const f = await documentFixture(true);
    const sourceTrust = buildLowTrustSourceTrust({ issueId: f.issue.id, runId: f.runId, agentId: f.agentId });
    const call = { tool: "write_document", callId: "low-trust-write", arguments: {
      idempotencyKey: "low-trust-write", key: "report", title: "Report", body: "LOW_TRUST_NATIVE_WRITE_CANARY", baseRevisionId: null,
    } };
    const written = await f.authority.execute(call);
    expect(written).toMatchObject({ disposition: "applied", document: { body: "LOW_TRUST_NATIVE_WRITE_CANARY", sourceTrust } });
    expect(await documentService(db).getIssueDocumentByKey(f.issue.id, "report"))
      .toMatchObject({ body: "LOW_TRUST_NATIVE_WRITE_CANARY", sourceTrust });
    expect(await f.authority.execute({ ...call, callId: "low-trust-write-replay" })).toEqual(written);
    const current = await documentService(db).getIssueDocumentByKey(f.issue.id, "report");
    expect(await f.authority.execute({ ...call, callId: "low-trust-update", arguments: { ...call.arguments,
      idempotencyKey: "low-trust-update", body: "LOW_TRUST_NATIVE_UPDATE_CANARY", baseRevisionId: current!.latestRevisionId,
    } })).toMatchObject({ disposition: "applied", document: { body: "LOW_TRUST_NATIVE_UPDATE_CANARY", sourceTrust } });
    expect(await documentService(db).getIssueDocumentByKey(f.issue.id, "report"))
      .toMatchObject({ body: "LOW_TRUST_NATIVE_UPDATE_CANARY", sourceTrust });
    expect(await documentService(db).listIssueDocumentRevisions(f.issue.id, "report")).toHaveLength(2);
  });

  it.each([false, true])("projects Muse current documents, old revisions and exact accepted plans for the named reader (low trust: %s)", async lowTrustReader => {
    const f = await documentFixture(lowTrustReader), writerRunId = randomUUID();
    const lowPolicy = { authorizationPolicy: { trustBoundary: {
      mode: LOW_TRUST_REVIEW_PRESET, companyId: f.companyId, rootIssueId: f.issue.id,
    } } };
    await db.insert(heartbeatRuns).values({ id: writerRunId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issue.id, status: "succeeded", contextSnapshot: { issueId: f.issue.id, executionPolicy: lowPolicy } });
    const quarantine = buildLowTrustSourceTrust({ issueId: f.issue.id, runId: writerRunId, agentId: f.agentId });
    const service = documentService(db);
    const first = await service.upsertIssueDocument({ issueId: f.issue.id, key: "plan", title: "Plan", format: "markdown",
      body: "LOW_TRUST_REVISION_CANARY", changeSummary: "LOW_TRUST_SUMMARY_CANARY", createdByAgentId: f.agentId,
      createdByRunId: writerRunId, sourceTrust: quarantine });
    const currentBody = lowTrustReader ? "LOW_TRUST_REVISION_CANARY" : LOW_TRUST_QUARANTINED_BODY;
    expect(await f.authority.execute({ tool: "read_document", callId: "read-quarantined", arguments: { key: "plan" } }))
      .toMatchObject({ document: { id: first.document.id, body: currentBody, sourceTrust: quarantine } });
    expect(await f.authority.execute({ tool: "list_documents", callId: "list-quarantined", arguments: {} }))
      .toMatchObject({ documents: [{ id: first.document.id, body: currentBody, sourceTrust: quarantine }] });
    const promotedFirst = buildPromotedSourceTrust({ sourceIssueId: f.issue.id, sourceArtifactKind: "document",
      sourceArtifactId: first.document.id, promotedByActorType: "user", promotedByActorId: f.authorizer });
    await db.update(documents).set({ sourceTrust: promotedFirst }).where(eq(documents.id, first.document.id));
    expect(await f.authority.execute({ tool: "read_document", callId: "read-explicitly-promoted", arguments: { key: "plan" } }))
      .toMatchObject({ document: { body: "LOW_TRUST_REVISION_CANARY", sourceTrust: promotedFirst } });
    const second = await service.upsertIssueDocument({ issueId: f.issue.id, key: "plan", title: "Plan", format: "markdown",
      body: "Trusted Board replacement", baseRevisionId: first.document.latestRevisionId, createdByUserId: f.authorizer });
    const promotion = buildPromotedSourceTrust({ sourceIssueId: f.issue.id, sourceArtifactKind: "document",
      sourceArtifactId: second.document.id, promotedByActorType: "user", promotedByActorId: f.authorizer });
    await db.update(documents).set({ sourceTrust: promotion }).where(eq(documents.id, first.document.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: {
      issueId: f.issue.id, ...(lowTrustReader ? { executionPolicy: lowPolicy } : {}),
      planReviewInteraction: { acceptedTargetRevision: { issueId: f.issue.id, documentId: first.document.id,
        key: "plan", revisionId: first.document.latestRevisionId, revisionNumber: first.document.latestRevisionNumber } },
    } }).where(eq(heartbeatRuns.id, f.runId));
    const storedBefore = await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, first.document.id));
    const history = await f.authority.execute({ tool: "list_document_revisions", callId: "history-after-rewrite", arguments: { key: "plan" } });
    expect(history).toMatchObject({ revisions: [
      { id: second.document.latestRevisionId, body: "Trusted Board replacement" },
      { id: first.document.latestRevisionId, body: currentBody,
        changeSummary: lowTrustReader ? "LOW_TRUST_SUMMARY_CANARY" : null },
    ] });
    const context = await f.authority.execute({ tool: "get_task_context", callId: "accepted-old-revision", arguments: {} });
    expect(context).toMatchObject({ acceptedPlan: { documentId: first.document.id, revisionId: first.document.latestRevisionId,
      revisionNumber: first.document.latestRevisionNumber, markdown: currentBody } });
    expect(await f.authority.execute({ tool: "read_document", callId: "read-promoted-current", arguments: { key: "plan" } }))
      .toMatchObject({ document: { id: first.document.id, body: "Trusted Board replacement", sourceTrust: promotion } });
    if (!lowTrustReader) {
      expect(JSON.stringify(history)).not.toContain("LOW_TRUST_REVISION_CANARY");
      expect(JSON.stringify(history)).not.toContain("LOW_TRUST_SUMMARY_CANARY");
      expect(JSON.stringify(context)).not.toContain("LOW_TRUST_REVISION_CANARY");
    }
    expect(await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, first.document.id))).toEqual(storedBefore);
    expect(await service.getIssueDocumentByKey(f.issue.id, "plan"))
      .toMatchObject({ body: "Trusted Board replacement", sourceTrust: promotion });
  });

  it("quarantines legacy untagged current Muse output using its original retained run without mutable writer permissions", async () => {
    const f = await documentFixture(), writerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: writerRunId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issue.id, status: "succeeded", contextSnapshot: { issueId: f.issue.id, executionPolicy: {
        trustPreset: LOW_TRUST_REVIEW_PRESET, authorizationPolicy: { trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET, companyId: f.companyId, rootIssueId: f.issue.id,
        } },
      } } });
    const written = await documentService(db).upsertIssueDocument({ issueId: f.issue.id, key: "legacy", title: "Legacy",
      format: "markdown", body: "UNTAGGED_LOW_TRUST_CANARY", createdByAgentId: f.agentId, createdByRunId: writerRunId });
    expect(written.document.sourceTrust).toBeNull();
    expect(await f.authority.execute({ tool: "read_document", callId: "legacy-current", arguments: { key: "legacy" } }))
      .toMatchObject({ document: { body: LOW_TRUST_QUARANTINED_BODY, sourceTrust: null } });
    expect(await f.authority.execute({ tool: "list_documents", callId: "legacy-list", arguments: {} }))
      .toMatchObject({ documents: [{ body: LOW_TRUST_QUARANTINED_BODY }] });
    expect(await documentService(db).getIssueDocumentByKey(f.issue.id, "legacy"))
      .toMatchObject({ body: "UNTAGGED_LOW_TRUST_CANARY", sourceTrust: null });
  });

  it.each(["missing_run", "foreign_company", "wrong_writer", "wrong_task", "missing_policy", "missing_user"])(
    "withholds unknown Muse revision provenance without claiming quarantine (%s)", async kind => {
      const f = await documentFixture(), writerRunId = randomUUID();
      let writerCompanyId = f.companyId, writerAgentId = f.agentId;
      if (kind === "foreign_company") {
        writerCompanyId = randomUUID();
        await db.insert(companies).values({ id: writerCompanyId, name: "Other writer", issuePrefix: `F${writerCompanyId.slice(0, 6)}` });
      }
      if (kind === "wrong_writer" || kind === "foreign_company") {
        writerAgentId = randomUUID();
        await db.insert(agents).values({ id: writerAgentId, companyId: writerCompanyId, name: "Other writer", adapterType: "paperclip_runner" });
      }
      if (kind !== "missing_run" && kind !== "missing_user") await db.insert(heartbeatRuns).values({ id: writerRunId,
        companyId: writerCompanyId, agentId: writerAgentId, nativeIssueId: kind === "wrong_task" ? null : f.issue.id,
        status: "succeeded", contextSnapshot: { issueId: kind === "wrong_task" ? randomUUID() : f.issue.id,
          ...(kind === "missing_policy" ? {} : { executionPolicy: { trustPreset: DEFAULT_TRUST_PRESET } }) } });
      const service = documentService(db);
      const first = await service.upsertIssueDocument({ issueId: f.issue.id, key: "plan", title: "Plan", format: "markdown",
        body: "UNKNOWN_REVISION_CANARY", changeSummary: "UNKNOWN_SUMMARY_CANARY",
        ...(kind === "missing_user" ? { createdByUserId: "not-an-authenticated-user" }
          : { createdByAgentId: f.agentId, createdByRunId: kind === "missing_run" ? null : writerRunId }) });
      const second = await service.upsertIssueDocument({ issueId: f.issue.id, key: "plan", title: "Plan", format: "markdown",
        body: "Trusted current Board text", baseRevisionId: first.document.latestRevisionId, createdByUserId: f.authorizer });
      const storedBefore = await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, first.document.id));
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, planReviewInteraction: {
        acceptedTargetRevision: { key: "plan", revisionId: first.document.latestRevisionId },
      } } }).where(eq(heartbeatRuns.id, f.runId));
      const unknownBody = "[Document revision content omitted: historical source trust could not be established.]";
      const history = await f.authority.execute({ tool: "list_document_revisions", callId: "unknown-history", arguments: { key: "plan" } });
      expect(history).toMatchObject({ revisions: [
        { id: second.document.latestRevisionId, body: "Trusted current Board text" },
        { id: first.document.latestRevisionId, body: unknownBody, changeSummary: null },
      ] });
      expect(JSON.stringify(history)).not.toContain("UNKNOWN_REVISION_CANARY");
      expect(JSON.stringify(history)).not.toContain("UNKNOWN_SUMMARY_CANARY");
      expect(JSON.stringify(history)).not.toContain(LOW_TRUST_QUARANTINED_BODY);
      expect(await f.authority.execute({ tool: "get_task_context", callId: "unknown-accepted", arguments: {} }))
        .toMatchObject({ acceptedPlan: { revisionId: first.document.latestRevisionId, markdown: unknownBody } });
      expect(await f.authority.execute({ tool: "read_document", callId: "known-current", arguments: { key: "plan" } }))
        .toMatchObject({ document: { body: "Trusted current Board text" } });
      expect(await db.select().from(documentRevisions).where(eq(documentRevisions.documentId, first.document.id))).toEqual(storedBefore);
    },
  );

  it("preserves verified standard-run and authenticated Board revision bodies for higher-trust Muse readers", async () => {
    const f = await documentFixture(), writerRunId = randomUUID(), service = documentService(db);
    await db.insert(heartbeatRuns).values({ id: writerRunId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issue.id, status: "succeeded", contextSnapshot: { issueId: f.issue.id,
        executionPolicy: { trustPreset: DEFAULT_TRUST_PRESET } } });
    const first = await service.upsertIssueDocument({ issueId: f.issue.id, key: "report", title: "Report", format: "markdown",
      body: "Trusted standard-run revision", createdByAgentId: f.agentId, createdByRunId: writerRunId });
    const second = await service.upsertIssueDocument({ issueId: f.issue.id, key: "report", title: "Report", format: "markdown",
      body: "Trusted Board revision", baseRevisionId: first.document.latestRevisionId, createdByUserId: f.authorizer });
    await service.upsertIssueDocument({ issueId: f.issue.id, key: "report", title: "Report", format: "markdown",
      body: "Trusted current native revision", baseRevisionId: second.document.latestRevisionId,
      createdByAgentId: f.agentId, createdByRunId: f.runId });
    expect(await f.authority.execute({ tool: "list_document_revisions", callId: "trusted-history", arguments: { key: "report" } }))
      .toMatchObject({ revisions: [ { body: "Trusted current native revision" }, { body: "Trusted Board revision" },
        { body: "Trusted standard-run revision" } ] });
    expect(await f.authority.execute({ tool: "read_document", callId: "trusted-current", arguments: { key: "report" } }))
      .toMatchObject({ document: { body: "Trusted current native revision", sourceTrust: null } });
  });

  it("projects the exact accepted source-conversation plan before exposing it to a Muse child task", async () => {
    const f = await documentFixture(), sourceRunId = randomUUID();
    const [source] = await db.insert(issues).values({ companyId: f.companyId, title: "Source conversation", visibility: "open",
      conversationAgentId: f.agentId, assigneeAgentId: f.agentId, conversationUserId: f.responsible, conversationState: "active" }).returning();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: source.id,
      status: "succeeded", contextSnapshot: { issueId: source.id, executionPolicy: { authorizationPolicy: { trustBoundary: {
        mode: LOW_TRUST_REVIEW_PRESET, companyId: f.companyId, rootIssueId: source.id,
      } } } } });
    const service = documentService(db);
    const first = await service.upsertIssueDocument({ issueId: source.id, key: "plan", title: "Plan", format: "markdown",
      body: "LOW_TRUST_SOURCE_PLAN_CANARY", createdByAgentId: f.agentId, createdByRunId: sourceRunId,
      sourceTrust: buildLowTrustSourceTrust({ issueId: source.id, runId: sourceRunId, agentId: f.agentId }) });
    await service.upsertIssueDocument({ issueId: source.id, key: "plan", title: "Plan", format: "markdown",
      body: "Trusted newer source text", baseRevisionId: first.document.latestRevisionId, createdByUserId: f.authorizer });
    const [accepted] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: source.id,
      kind: "request_confirmation", status: "accepted", resolvedAt: new Date(f.issue.createdAt.getTime() - 1),
      payload: { version: 1, prompt: "Approve plan", target: { type: "issue_document", issueId: source.id,
        key: "plan", revisionId: first.document.latestRevisionId } } }).returning();
    await db.update(issues).set({ originRunId: sourceRunId }).where(eq(issues.id, f.issue.id));
    const context = await f.authority.execute({ tool: "get_task_context", callId: "source-plan-context", arguments: {} });
    expect(context).toMatchObject({ sourcePlanApproval: { sourceIssueId: source.id, interactionId: accepted.id,
      revisionId: first.document.latestRevisionId, markdown: LOW_TRUST_QUARANTINED_BODY } });
    expect(JSON.stringify(context)).not.toContain("LOW_TRUST_SOURCE_PLAN_CANARY");
    expect((await service.listIssueDocumentRevisions(source.id, "plan"))[1])
      .toMatchObject({ id: first.document.latestRevisionId, body: "LOW_TRUST_SOURCE_PLAN_CANARY" });
  });

  it("rechecks current Muse authorizer and company authority before all native document projections", async () => {
    const f = await documentFixture();
    await documentService(db).upsertIssueDocument({ issueId: f.issue.id, key: "report", title: "Report", format: "markdown",
      body: "Trusted scoped document", createdByUserId: f.authorizer });
    await db.update(companyMemberships).set({ status: "inactive" })
      .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.authorizer)));
    for (const tool of ["read_document", "list_documents", "list_document_revisions", "get_task_context"]) {
      await expect(f.authority.execute({ tool, callId: tool, arguments: { key: "report" } })).rejects.toThrow("no longer available");
    }
    const foreign = new PaperclipRunnerToolAuthority(db, { companyId: randomUUID(), agentId: f.agentId,
      issueId: f.issue.id, runId: f.runId, museRuntime: true, externalAuthorizingUserId: f.authorizer,
      assertBridgeAuthority: async () => {} });
    await expect(foreign.execute({ tool: "read_document", callId: "foreign", arguments: { key: "report" } }))
      .rejects.toThrow("binding_not_authorized");
  });

  it.each(["enforce", "shadow", "off"])("filters direct and paginated reads before data leaves the DB in %s mode", async mode => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", mode);
    const f = await fixture();
    await db.insert(instanceUserRoles).values({ userId: f.authorizer, role: "instance_admin" });
    expect(await canActorReadIssuePrivacy(db, f.actor, f.issue)).toBe(false);
    expect(await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, f.companyId), await issueReadSqlCondition(db, f.actor))).limit(1)).toEqual([]);
    expect((await authorizationService(db).decide({ actor: f.actor, action: "issue:read", resource: { type: "issue", companyId: f.companyId, issueId: f.issue.id } })).allowed).toBe(false);
    const [grant] = await db.insert(issueAccessGrants).values({ issueId: f.issue.id, subjectType: "user", subjectId: f.authorizer, source: "explicit" }).returning();
    expect(await canActorReadIssuePrivacy(db, f.actor, f.issue)).toBe(true);
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
    expect(await canActorReadIssuePrivacy(db, f.actor, f.issue)).toBe(false);
  });
  it("intersects project and approval reads with current authorizer membership", async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Private project", visibility: "private" }).returning();
    await db.insert(projectAccessMembers).values([{ subjectType: "agent", subjectId: f.agentId }, { subjectType: "user", subjectId: f.responsible }].map(subject => ({ ...subject, companyId: f.companyId, projectId: project.id })));
    expect(await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, f.companyId), await projectReadSqlCondition(db, f.actor)))).toEqual([]);
    await db.insert(projectAccessMembers).values({ companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.authorizer });
    expect(await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, project.id), await projectReadSqlCondition(db, f.actor)))).toHaveLength(1);
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "hire_agent", status: "pending", payload: { issueId: f.issue.id } }).returning();
    expect(await db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.id, approval.id), await approvalReadSqlCondition(db, f.actor)))).toEqual([]);
    await db.insert(issueAccessGrants).values({ issueId: f.issue.id, subjectType: "user", subjectId: f.authorizer, source: "explicit" });
    expect(await db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.id, approval.id), await approvalReadSqlCondition(db, f.actor)))).toHaveLength(1);
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.authorizer)));
    expect(await canActorReadIssuePrivacy(db, f.actor, f.issue)).toBe(false);
  });
  it("filters native task search with the same authorizer and responsible-user predicates", async () => {
    const f = await fixture(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issue.id,
      responsibleUserId: f.responsible, status: "running", runtimeMode: "native", invocationSource: "assignment" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issue.id));
    await db.insert(issueAccessGrants).values({ issueId: f.issue.id, subjectType: "user", subjectId: f.authorizer, source: "explicit" });
    const [hidden] = await db.insert(issues).values({ companyId: f.companyId, title: "Another private task", visibility: "private",
      assigneeAgentId: f.agentId, responsibleUserId: f.responsible }).returning();
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issue.id, runId,
      museRuntime: true, externalAuthorizingUserId: f.authorizer, assertBridgeAuthority: async () => {} });
    const result = await authority.execute({ tool: "search_tasks", callId: "search", arguments: { limit: 10 } });
    expect(result).toMatchObject({ tasks: [{ id: f.issue.id }] });
    expect(JSON.stringify(result)).not.toContain(hidden.id);
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.authorizer)));
    await expect(authority.execute({ tool: "search_tasks", callId: "search-again", arguments: {} })).rejects.toThrow("no longer available");
  });

  it.each(["create_task", "reassign_task"])("intersects native %s with current authorizer assignment scope before writes or wakes", async tool => {
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "shadow");
    const f = await fixture(), runId = randomUUID();
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Assignment scope" }).returning();
    const [protectedAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Protected target", status: "active", role: "engineer",
      adapterType: "process", adapterConfig: {}, permissions: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    const [target] = await db.insert(issues).values({ companyId: f.companyId, projectId: project.id, title: "Reassignment target", status: "todo" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issue.id,
      responsibleUserId: f.responsible, status: "running", runtimeMode: "native", invocationSource: "assignment" });
    await db.update(issues).set({ status: "in_progress", projectId: project.id, executionRunId: runId }).where(eq(issues.id, f.issue.id));
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values([
      { companyId: f.companyId, principalType: "agent", principalId: f.agentId, permissionKey: "tasks:assign" },
      { companyId: f.companyId, principalType: "user", principalId: f.responsible, permissionKey: "tasks:assign" },
    ]);
    await db.insert(issueAccessGrants).values({ issueId: f.issue.id, subjectType: "user", subjectId: f.authorizer, source: "explicit" });
    // Instance-wide elevation must not become permission granted to Muse.
    await db.insert(instanceUserRoles).values({ userId: f.authorizer, role: "instance_admin" });
    const enqueueWakeup = vi.fn(async () => null);
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issue.id, runId,
      museRuntime: true, externalAuthorizingUserId: f.authorizer, assertBridgeAuthority: async () => {}, enqueueWakeup });
    const call = { tool, callId: "authorizer-scope", arguments: tool === "create_task"
      ? { idempotencyKey: "scope", title: "Protected child", assigneeActorId: protectedAgent.id }
      : { idempotencyKey: "scope", taskId: target.id, assigneeActorId: protectedAgent.id,
          expectedAssigneeActorId: null, expectedStatusVersion: target.statusVersion, reason: "Scoped reassignment" } };
    const assertUnchanged = async () => {
      expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, f.issue.id))).toEqual([]);
      expect(await db.select({ owner: issues.assigneeAgentId, version: issues.statusVersion }).from(issues).where(eq(issues.id, target.id)))
        .toEqual([{ owner: null, version: target.statusVersion }]);
      expect(enqueueWakeup).not.toHaveBeenCalled();
    };
    await expect(authority.execute(call)).rejects.toThrow("Authorizing user is not authorized for tasks:assign");
    await assertUnchanged();
    const [grant] = await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.authorizer,
      permissionKey: "tasks:assign_scope", scope: { agentIds: [protectedAgent.id], projectIds: [randomUUID()] } }).returning();
    await expect(authority.execute(call)).rejects.toThrow("Authorizing user is not authorized for tasks:assign");
    await assertUnchanged();
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [randomUUID()], projectIds: [project.id] } }).where(eq(principalPermissionGrants.id, grant.id));
    await expect(authority.execute(call)).rejects.toThrow("Authorizing user is not authorized for tasks:assign");
    await assertUnchanged();
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [protectedAgent.id], projectIds: [project.id] } }).where(eq(principalPermissionGrants.id, grant.id));
    await expect(authority.execute(call)).resolves.toMatchObject({ disposition: "applied" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, grant.id));
    await expect(authority.execute(call)).rejects.toThrow("Authorizing user is not authorized for tasks:assign");
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["enforce", "shadow"])("denies native document writes for a viewer authorizer in responsible-user %s mode", async mode => {
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", mode);
    const f = await fixture(), runId = randomUUID();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.authorizer)));
    await db.insert(issueAccessGrants).values({ issueId: f.issue.id, subjectType: "user", subjectId: f.authorizer, source: "explicit" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issue.id,
      responsibleUserId: f.responsible, status: "running", runtimeMode: "native", invocationSource: "assignment" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issue.id));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issue.id, runId,
      museRuntime: true, externalAuthorizingUserId: f.authorizer, assertBridgeAuthority: async () => {} });
    const call = { tool: "write_document", callId: "viewer-write", arguments: { key: "report", title: "Report", body: "Must not be written", baseRevisionId: null, idempotencyKey: "viewer-write" } };
    await expect(authority.execute(call)).rejects.toThrow("Authorizing user is not authorized for issue:mutate");
    expect(await db.select({ id: issueDocuments.id }).from(issueDocuments).where(eq(issueDocuments.issueId, f.issue.id))).toEqual([]);
    await db.update(companyMemberships).set({ membershipRole: "operator" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.authorizer)));
    await expect(authority.execute(call)).resolves.toMatchObject({ disposition: "applied" });
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.authorizer)));
    await expect(authorizationService(db).decide({ actor: f.actor, action: "tasks:assign",
      resource: { type: "issue", companyId: f.companyId, assigneeAgentId: f.agentId }, scope: { assigneeAgentId: f.agentId } }))
      .resolves.toMatchObject({ allowed: false, reason: "deny_missing_membership" });
  });

  it("applies external admission before a native reviewer changes the issue execution owner", async () => {
    const f = await fixture(), runId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "queued", runtimeMode: "native",
      invocationSource: "assignment", contextSnapshot: { issueId: f.issue.id, nativeReviewInteractionId: randomUUID(), nativeReviewDecisionId: randomUUID() } }).returning();
    await db.insert(externalAgentHolds).values({ companyId: f.companyId, agentId: f.agentId, provider: "muse", assignmentId: randomUUID(), bindingId: randomUUID(),
      bindingGeneration: 1, runId: randomUUID(), workerUnknown: false, nativeEffectsUnknown: true });
    await expect(claimQueuedNativeReviewRun(db, { run, claimedAt: new Date(), agentNameKey: "muse", claimValues: { status: "running" } }))
      .rejects.toMatchObject({ status: 409, details: { code: "external_agent_overlap" } });
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).toEqual([{ status: "queued" }]);
    expect(await db.select({ owner: issues.executionRunId }).from(issues).where(eq(issues.id, f.issue.id))).toEqual([{ owner: null }]);
  });

  it("advertises only first-party tools for Muse and rejects missing authorizer authority", async () => {
    const f = await fixture();
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issue.id, runId: randomUUID(), museRuntime: true, apiToolsEnabled: true, workspaceBridge: true });
    const names = authority.definitions().map(tool => tool.name);
    expect(names).toContain("get_identity"); expect(names).toContain("get_task_context"); expect(names).toContain("write_document");
    for (const excluded of ["search_api", "call_api", "request_human_input", "connections_search", "workspace_command", "read_workspace_file", "register_deliverable", "get_workspace", "list_workspaces", "select_workspace", "prepare_repository"]) expect(names).not.toContain(excluded);
    for (const tool of ["get_workspace", "list_workspaces", "select_workspace", "prepare_repository"]) {
      await expect(authority.execute({ tool, callId: tool, arguments: {} })).rejects.toThrow("first-party runtime profile");
    }
    await expect(authority.execute({ tool: "get_task_context", callId: "test", arguments: {} })).rejects.toThrow("authorizer");
  });
});
