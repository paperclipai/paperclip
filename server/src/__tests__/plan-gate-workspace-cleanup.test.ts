import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  createDb,
  executionWorkspaces,
  issueApprovals,
  issues,
  planDetails,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { planService } from "../services/plans.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-cleanup tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dev_team terminal-status worktree cleanup flag", () => {
  let db!: ReturnType<typeof createDb>;
  let plans!: ReturnType<typeof planService>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ws-cleanup-");
    db = createDb(tempDb.connectionString);
    plans = planService(db);
    issuesSvc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(executionWorkspaces);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(gateProfile: "none" | "dev_team") {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "WS Co",
      issuePrefix: "WSC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Repo" });

    const { issue } = await plans.createPlan(companyId, {
      title: "Plan",
      gateProfile,
      tiers: [
        {
          id: "tier-1",
          kind: "phase",
          name: "Phase 1",
          requestedChildren: [{ title: "Leaf task" }],
          childIssueIds: [],
        },
      ],
    });
    const { createdChildren } = await plans.activate(issue.id, { agentId: null, userId: "tester" });
    const child = createdChildren[0]!;

    return { companyId, projectId, child };
  }

  async function attachWorktree(
    companyId: string,
    projectId: string,
    issueId: string,
    ownerIssueId: string | null,
  ) {
    const wsId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: wsId,
      companyId,
      projectId,
      sourceIssueId: ownerIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "issue/WSC-1-leaf-task",
      status: "active",
      providerType: "git_worktree",
      branchName: "issue/WSC-1-leaf-task",
    });
    await db.update(issues).set({ executionWorkspaceId: wsId }).where(eq(issues.id, issueId));
    return wsId;
  }

  it("flags the owned worktree for cleanup when a dev_team issue is marked done", async () => {
    const { companyId, projectId, child } = await seed("dev_team");
    const wsId = await attachWorktree(companyId, projectId, child.id, child.id);

    await issuesSvc.update(child.id, { status: "done" });

    const [ws] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, wsId));
    expect(ws?.cleanupEligibleAt).not.toBeNull();
    expect(ws?.cleanupReason).toBe("issue_done");
  });

  it("uses issue_cancelled as the reason when cancelled", async () => {
    const { companyId, projectId, child } = await seed("dev_team");
    const wsId = await attachWorktree(companyId, projectId, child.id, child.id);

    await issuesSvc.update(child.id, { status: "cancelled" });

    const [ws] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, wsId));
    expect(ws?.cleanupReason).toBe("issue_cancelled");
  });

  it("does NOT flag when the plan is not dev_team-gated", async () => {
    const { companyId, projectId, child } = await seed("none");
    const wsId = await attachWorktree(companyId, projectId, child.id, child.id);

    await issuesSvc.update(child.id, { status: "done" });

    const [ws] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, wsId));
    expect(ws?.cleanupEligibleAt).toBeNull();
  });

  it("does NOT flag a workspace owned by a different issue (shared, not isolated)", async () => {
    const { companyId, projectId, child } = await seed("dev_team");
    // Workspace is not owned by this issue (sourceIssueId null) — child only
    // references it, e.g. a shared workspace. Must not be flagged.
    const wsId = await attachWorktree(companyId, projectId, child.id, null);

    await issuesSvc.update(child.id, { status: "done" });

    const [ws] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, wsId));
    expect(ws?.cleanupEligibleAt).toBeNull();
  });
});
