import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvals, companies, createDb, issueApprovals, issues, planDetails } from "@paperclipai/db";
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
    `Skipping embedded Postgres plan-gate activation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("planService gate-profile (soft)", () => {
  let db!: ReturnType<typeof createDb>;
  let plans!: ReturnType<typeof planService>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-gate-");
    db = createDb(tempDb.connectionString);
    plans = planService(db);
    issuesSvc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(opts: { withGateAgents: boolean }, prefix = "GAT") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    const ids: Record<string, string> = {};
    if (opts.withGateAgents) {
      for (const [key, name, role] of [
        ["architect", "Architect", "engineer"],
        ["codeReviewer", "Code Reviewer", "qa"],
        ["wiringExpert", "Wiring Expert", "engineer"],
      ] as const) {
        const id = randomUUID();
        ids[key] = id;
        await db.insert(agents).values({ id, companyId, name, role, status: "idle" });
      }
    }
    return { companyId, ids };
  }

  async function createDevTeamPlan(companyId: string, gateProfile: "none" | "dev_team", titles: string[]) {
    return plans.createPlan(companyId, {
      title: "Gated plan",
      gateProfile,
      tiers: [
        {
          id: "tier-1",
          kind: "phase",
          name: "Phase 1",
          requestedChildren: titles.map((t) => ({ title: t })),
          childIssueIds: [],
        },
      ],
    });
  }

  it("dev_team activation creates one plan gate plus code+wiring per leaf, routed to designated agents", async () => {
    const { companyId, ids } = await seedCompany({ withGateAgents: true });
    const { issue } = await createDevTeamPlan(companyId, "dev_team", ["Task A", "Task B"]);

    const { createdChildren, gateApprovalIds } = await plans.activate(issue.id, {
      agentId: null,
      userId: "tester",
    });

    expect(createdChildren).toHaveLength(2);
    expect(gateApprovalIds).toHaveLength(5); // 1 plan + 2 leaves * 2

    const gateRows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    const byType = (t: string) => gateRows.filter((r) => r.type === t);
    expect(byType("gate_plan_approval")).toHaveLength(1);
    expect(byType("gate_code_review")).toHaveLength(2);
    expect(byType("gate_wiring_review")).toHaveLength(2);

    const planGate = byType("gate_plan_approval")[0]!;
    expect(planGate.status).toBe("pending");
    expect((planGate.payload as Record<string, unknown>).designatedAgentId).toBe(ids.architect);
    expect((byType("gate_code_review")[0]!.payload as Record<string, unknown>).designatedAgentId).toBe(
      ids.codeReviewer,
    );
    expect((byType("gate_wiring_review")[0]!.payload as Record<string, unknown>).designatedAgentId).toBe(
      ids.wiringExpert,
    );
  });

  it("surfaces gate attention with the designated agent as owner and plan>code precedence", async () => {
    const { companyId, ids } = await seedCompany({ withGateAgents: true });
    const { issue } = await createDevTeamPlan(companyId, "dev_team", ["Only task"]);
    const { createdChildren } = await plans.activate(issue.id, { agentId: null, userId: "tester" });

    const rootAttention = await issuesSvc.getBlockedInboxAttention(companyId, issue.id);
    expect(rootAttention?.reason).toBe("pending_plan_approval");
    expect(rootAttention?.owner.type).toBe("agent");
    expect(rootAttention?.owner.agentId).toBe(ids.architect);

    const leafAttention = await issuesSvc.getBlockedInboxAttention(companyId, createdChildren[0]!.id);
    // A leaf carries both code + wiring gates; precedence surfaces code review first.
    expect(leafAttention?.reason).toBe("pending_code_review");
    expect(leafAttention?.owner.agentId).toBe(ids.codeReviewer);
  });

  it("profile 'none' creates zero gates and surfaces no gate attention", async () => {
    const { companyId } = await seedCompany({ withGateAgents: true });
    const { issue } = await createDevTeamPlan(companyId, "none", ["Task"]);
    const { gateApprovalIds, createdChildren } = await plans.activate(issue.id, {
      agentId: null,
      userId: "tester",
    });

    expect(gateApprovalIds).toHaveLength(0);
    const gateRows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(gateRows).toHaveLength(0);
    expect(await issuesSvc.getBlockedInboxAttention(companyId, createdChildren[0]!.id)).toBeNull();
  });

  it("falls back to the board owner when a gate role is unstaffed", async () => {
    const { companyId } = await seedCompany({ withGateAgents: false });
    const { issue } = await createDevTeamPlan(companyId, "dev_team", ["Task"]);
    await plans.activate(issue.id, { agentId: null, userId: "tester" });

    const planGate = (await db.select().from(approvals).where(eq(approvals.companyId, companyId))).find(
      (r) => r.type === "gate_plan_approval",
    )!;
    expect((planGate.payload as Record<string, unknown>).designatedAgentId).toBeNull();

    const rootAttention = await issuesSvc.getBlockedInboxAttention(companyId, issue.id);
    expect(rootAttention?.reason).toBe("pending_plan_approval");
    expect(rootAttention?.owner.type).toBe("board");
  });

  it("is SOFT — activation succeeds with pending gates and deleting the plan purges them", async () => {
    const { companyId } = await seedCompany({ withGateAgents: true });
    const { issue } = await createDevTeamPlan(companyId, "dev_team", ["Task"]);
    const { planDetails: activated } = await plans.activate(issue.id, { agentId: null, userId: "tester" });

    // Nothing blocked activation: plan is active even though gates are pending.
    expect(activated.state).toBe("active");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).not.toHaveLength(0);

    await plans.deletePlanSubtree(issue.id);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(issueApprovals).where(eq(issueApprovals.companyId, companyId))).toHaveLength(0);
  });
});
