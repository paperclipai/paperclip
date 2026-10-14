import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, executionWorkspaces, heartbeatRuns, issues, projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { issueService } from "../services/issues.js";
import { createRepositoryTrustFixture } from "./helpers/repository-trust-fixture.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("child task workspace trust", () => {
  const context = createRepositoryTrustFixture({ managedAuth: vi.fn(), materialize: vi.fn(), catalog: vi.fn() });
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { ({ db } = await context.setup()); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(context.cleanup);

  async function fixture() {
    const f = await context.fixture();
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Review source" }).returning();
    const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
      trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, projectIds: [project.id] } } };
    await db.update(projects).set({ executionWorkspacePolicy: policy }).where(eq(projects.id, project.id));
    await db.update(executionWorkspaces).set({ projectId: project.id }).where(eq(executionWorkspaces.id, f.workspace.id));
    await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: policy } }).where(eq(heartbeatRuns.id, f.runId));
    const input = { title: `Child ${randomUUID()}`, parentId: f.issueId, assigneeAgentId: f.agentId,
      executionPolicy: policy, createdByAgentId: f.agentId, workspaceSelectionActor: f.actor,
      workspaceSelection: { kind: "existing" as const, workspaceId: f.workspace.id } };
    return { ...f, project, policy, input };
  }

  it.each(["direct", "descendant", "omitted_policy"] as const)("creates a matching low-trust child with an explicit existing workspace (%s)", async scenario => {
    const f = await fixture();
    if (scenario === "descendant") {
      const [parent] = await db.insert(issues).values({ companyId: f.companyId, parentId: f.issueId,
        title: "Intermediate task", assigneeAgentId: f.agentId, executionPolicy: f.policy }).returning();
      f.input.parentId = parent.id;
    }
    const input = scenario === "omitted_policy" ? { ...f.input, executionPolicy: undefined } : f.input;
    await expect(issueService(db).create(f.companyId, input)).resolves.toMatchObject({
      parentId: f.input.parentId, executionWorkspaceId: f.workspace.id,
    });
  });
  it.each(["child_policy", "unrelated_parent", "missing_parent", "missing_run", "cross_company_run", "sponsor", "live_parent_policy", "absent_saved_policy", "child_agent_policy"] as const)(
    "rejects incompatible child creation (%s)", async scenario => {
      const f = await fixture();
      const different = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
        trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, rootIssueId: randomUUID() } } };
      if (scenario === "child_policy") f.input.executionPolicy = different;
      if (scenario === "unrelated_parent") {
        const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Other root" }).returning();
        f.input.parentId = parent.id;
      }
      if (scenario === "missing_parent") f.input.parentId = randomUUID();
      if (scenario === "missing_run") f.input.workspaceSelectionActor = { ...f.actor, runId: randomUUID() };
      if (scenario === "cross_company_run") f.input.workspaceSelectionActor = { ...f.actor, runId: (await fixture()).runId };
      if (scenario === "sponsor") {
        const id = randomUUID();
        await db.insert(authUsers).values({ id, name: "Other operator", email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
        await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: id, membershipRole: "operator", status: "active" });
        f.input.workspaceSelectionActor = { ...f.actor, onBehalfOfUserId: id };
      }
      if (scenario === "live_parent_policy") await db.update(issues).set({ executionPolicy: different }).where(eq(issues.id, f.issueId));
      if (scenario === "absent_saved_policy") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
      if (scenario === "child_agent_policy") {
        const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Other boundary", adapterType: "process", permissions: different }).returning();
        f.input.assigneeAgentId = agent.id;
      }
      const before = await db.select().from(issues).where(eq(issues.companyId, f.companyId));
      await expect(issueService(db).create(f.companyId, f.input)).rejects.toThrow();
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual(before);
    },
  );

  it("does not infer child creation from an arbitrary issue-less workspace selection", async () => {
    const f = await fixture();
    await expect(executionWorkspaceService(db).validateSelection({ companyId: f.companyId, actor: f.actor,
      selection: f.input.workspaceSelection, parentIssueId: f.issueId, executionPolicy: f.policy,
      assigneeAgentId: f.agentId })).rejects.toThrow(/Physical workspace source trust/);
  });
});
