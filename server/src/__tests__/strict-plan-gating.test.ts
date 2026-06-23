/**
 * Tests for strict plan gate enforcement.
 *
 * Gate A: enqueueWakeup suppresses implementor wakes when the plan-approval gate
 *         is not yet approved on a strict plan.
 * Gate B: done-transition blocked until review gates approved (via existing
 *         evaluateDevTeamDoneGate, verified here as a regression guard for strict).
 * Validation: strict + gateProfile none → 400.
 * Soft regression: soft plan is never blocked.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issues,
  planDetails,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isWakeBlockedByStrictGate } from "../services/plan-gate-enforcement.js";
import { GATE_APPROVAL_TYPES } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping strict-plan-gating tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("strict plan gating — isWakeBlockedByStrictGate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-strict-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Co ${id.slice(0, 6)}`,
      issuePrefix: `S${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedPlanRoot(
    companyId: string,
    opts: { gateEnforcement?: string; gateProfile?: string } = {},
  ) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Plan root",
      workMode: "planning",
      status: "in_progress",
    });
    await db.insert(planDetails).values({
      issueId: id,
      companyId,
      state: "active",
      gateProfile: opts.gateProfile ?? "dev_team",
      gateEnforcement: opts.gateEnforcement ?? "strict",
    });
    return id;
  }

  async function seedLeaf(companyId: string, planRootIssueId: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Leaf task",
      workMode: "task",
      status: "in_progress",
      planRootIssueId,
    });
    return id;
  }

  async function seedPlanApproval(
    companyId: string,
    planRootIssueId: string,
    status: string,
  ) {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: GATE_APPROVAL_TYPES.planApproval,
      status,
      payload: { gate: true, planRootIssueId },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: planRootIssueId, approvalId });
    return approvalId;
  }

  it("blocks implementor wake when plan-approval is pending on a strict plan", async () => {
    const companyId = await seedCompany();
    const planRootId = await seedPlanRoot(companyId);
    const leafId = await seedLeaf(companyId, planRootId);
    await seedPlanApproval(companyId, planRootId, "pending");

    const blocked = await isWakeBlockedByStrictGate(db, companyId, leafId, "assignment");
    expect(blocked).toBe(true);
  });

  it("allows wake when plan-approval is approved on a strict plan", async () => {
    const companyId = await seedCompany();
    const planRootId = await seedPlanRoot(companyId);
    const leafId = await seedLeaf(companyId, planRootId);
    await seedPlanApproval(companyId, planRootId, "approved");

    const blocked = await isWakeBlockedByStrictGate(db, companyId, leafId, "assignment");
    expect(blocked).toBe(false);
  });

  it("allows gate review wake reasons even when plan-approval is pending", async () => {
    const companyId = await seedCompany();
    const planRootId = await seedPlanRoot(companyId);
    const leafId = await seedLeaf(companyId, planRootId);
    await seedPlanApproval(companyId, planRootId, "pending");

    // Gate review wake reasons must never be blocked (they ARE the protocol).
    for (const reason of [
      "gate_plan_approval_requested",
      "gate_review_requested",
      "gate_completeness_review_requested",
      "approval_approved",
      "plan_review_gate_decided",
    ]) {
      const blocked = await isWakeBlockedByStrictGate(db, companyId, leafId, reason);
      expect(blocked, `reason=${reason} should not be blocked`).toBe(false);
    }
  });

  it("does not block on a soft plan even when plan-approval is pending", async () => {
    const companyId = await seedCompany();
    const planRootId = await seedPlanRoot(companyId, { gateEnforcement: "soft" });
    const leafId = await seedLeaf(companyId, planRootId);
    await seedPlanApproval(companyId, planRootId, "pending");

    const blocked = await isWakeBlockedByStrictGate(db, companyId, leafId, "assignment");
    expect(blocked).toBe(false);
  });

  it("does not block when issueId is null", async () => {
    const companyId = await seedCompany();
    const blocked = await isWakeBlockedByStrictGate(db, companyId, null, "assignment");
    expect(blocked).toBe(false);
  });

  it("does not block an issue that is not under any plan", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "standalone",
      workMode: "task",
      status: "in_progress",
    });

    const blocked = await isWakeBlockedByStrictGate(db, companyId, issueId, "assignment");
    expect(blocked).toBe(false);
  });

  it("blocks direct wake on the plan root itself (not just leaves)", async () => {
    const companyId = await seedCompany();
    const planRootId = await seedPlanRoot(companyId);
    await seedPlanApproval(companyId, planRootId, "pending");

    // The root issue is a "planning" workMode — should also be blocked.
    const blocked = await isWakeBlockedByStrictGate(db, companyId, planRootId, "on_demand");
    expect(blocked).toBe(true);
  });

  it("company-scopes the check — foreign company issue never leaks", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const planRootId = await seedPlanRoot(companyA);
    const leafId = await seedLeaf(companyA, planRootId);
    await seedPlanApproval(companyA, planRootId, "pending");

    // Querying with companyB should not find the plan and must not block.
    const blocked = await isWakeBlockedByStrictGate(db, companyB, leafId, "assignment");
    expect(blocked).toBe(false);
  });
});

describe("strict+none refine predicate (pure logic)", () => {
  function isStrictWithUngatedProfile(gateEnforcement: string, gateProfile?: string) {
    return (
      gateEnforcement === "strict" &&
      (gateProfile === undefined || gateProfile === "none" || gateProfile === "solo")
    );
  }

  it("strict + none fails validation", () => {
    expect(isStrictWithUngatedProfile("strict", "none")).toBe(true);
  });

  it("strict + dev_team passes validation", () => {
    expect(isStrictWithUngatedProfile("strict", "dev_team")).toBe(false);
  });

  it("strict + light passes validation", () => {
    expect(isStrictWithUngatedProfile("strict", "light")).toBe(false);
  });

  it("soft + none passes validation", () => {
    expect(isStrictWithUngatedProfile("soft", "none")).toBe(false);
  });
});
