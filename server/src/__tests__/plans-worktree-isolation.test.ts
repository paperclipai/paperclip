import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  feedbackVotes,
  financeEvents,
  instanceSettings,
  issueApprovals,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issues,
  planDetails,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { planService } from "../services/plans.js";
import { instanceSettingsService } from "../services/instance-settings.js";

/**
 * G/A4 — Worktree isolation for plan child issues.
 *
 * When enableIsolatedWorkspaces is on, activate() must stamp each created
 * child with executionWorkspaceSettings: { mode: "isolated_workspace",
 * workspaceStrategy: { type: "git_worktree" } }. When the flag is off, the
 * issueService.create() strip-path ensures the field is not persisted.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping worktree isolation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("planService.activate — worktree isolation (G/A4)", () => {
  let db!: ReturnType<typeof createDb>;
  let plans!: ReturnType<typeof planService>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let settingsSvc!: ReturnType<typeof instanceSettingsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-isolation-");
    db = createDb(tempDb.connectionString);
    plans = planService(db);
    issuesSvc = issueService(db);
    settingsSvc = instanceSettingsService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueReadStates);
    await db.delete(issueInboxArchives);
    await db.delete(feedbackVotes);
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pilot Co",
      issuePrefix: "PIL",
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId };
  }

  async function createAndActivatePlan(companyId: string) {
    const { issue } = await plans.createPlan(companyId, {
      title: "Test plan",
      gateProfile: "none",
      tiers: [
        {
          id: "tier-1",
          kind: "phase",
          name: "Phase 1",
          requestedChildren: [{ title: "Task A" }, { title: "Task B" }],
          childIssueIds: [],
        },
      ],
    });
    return plans.activate(issue.id, { agentId: null, userId: "tester" });
  }

  it("child issues carry worktree settings when enableIsolatedWorkspaces is on", async () => {
    const { companyId } = await seedCompany();
    await settingsSvc.updateExperimental({ enableIsolatedWorkspaces: true });

    const { createdChildren } = await createAndActivatePlan(companyId);
    expect(createdChildren).toHaveLength(2);

    for (const child of createdChildren) {
      const settings = child.executionWorkspaceSettings as Record<string, unknown> | null;
      expect(settings).not.toBeNull();
      expect(settings?.mode).toBe("isolated_workspace");
      expect((settings?.workspaceStrategy as Record<string, unknown>)?.type).toBe("git_worktree");
    }
  });

  it("child issues have no workspace settings when enableIsolatedWorkspaces is off", async () => {
    const { companyId } = await seedCompany();
    await settingsSvc.updateExperimental({ enableIsolatedWorkspaces: false });

    const { createdChildren } = await createAndActivatePlan(companyId);
    expect(createdChildren).toHaveLength(2);

    for (const child of createdChildren) {
      const settings = child.executionWorkspaceSettings as Record<string, unknown> | null;
      expect(settings == null || Object.keys(settings).length === 0).toBe(true);
    }
  });
});
