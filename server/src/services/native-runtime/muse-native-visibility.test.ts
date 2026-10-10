import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, authUsers, companies, companyMemberships, createDb, externalAgentHolds, heartbeatRuns, instanceUserRoles, issueAccessGrants, issues, projectAccessMembers, projects } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { approvalReadSqlCondition, authorizationService, canActorReadIssuePrivacy, issueReadSqlCondition, projectReadSqlCondition, type AuthorizationActor } from "../authorization.js";
import { claimQueuedNativeReviewRun } from "./native-review-dispatch.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

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
    for (const excluded of ["search_api", "call_api", "request_human_input", "connections_search", "workspace_command", "read_workspace_file", "register_deliverable"]) expect(names).not.toContain(excluded);
    await expect(authority.execute({ tool: "get_task_context", callId: "test", arguments: {} })).rejects.toThrow("authorizer");
  });
});
