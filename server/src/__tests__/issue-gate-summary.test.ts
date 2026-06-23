/**
 * Tests for listGateSummariesForIssues — the grouped per-issue gate breakdown
 * that feeds the board card gate badge. Verifies ordering, latest-per-type dedup,
 * gated-only inclusion, and that non-gate approvals are ignored.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  companies,
  createDb,
  issueApprovals,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { listGateSummariesForIssues } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-gate-summary tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("listGateSummariesForIssues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-gate-summary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
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
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedIssue(companyId: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Task",
      workMode: "task",
      status: "in_progress",
    });
    return id;
  }

  async function linkGate(
    companyId: string,
    issueId: string,
    type: string,
    status: string,
    createdAt: Date,
  ) {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type,
      status,
      payload: {},
      createdAt,
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    return approvalId;
  }

  it("returns gates ordered plan → code → wiring → completeness", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const t = (m: number) => new Date(Date.now() - m * 60_000);
    // insert out of display order to prove ordering is enforced
    await linkGate(companyId, issueId, "gate_wiring_review", "pending", t(3));
    await linkGate(companyId, issueId, "gate_plan_approval", "approved", t(4));
    await linkGate(companyId, issueId, "gate_code_review", "pending", t(2));

    const map = await listGateSummariesForIssues(db, companyId, [issueId]);
    const summary = map.get(issueId);
    expect(summary).toBeDefined();
    expect(summary!.gates.map((g) => g.type)).toEqual([
      "gate_plan_approval",
      "gate_code_review",
      "gate_wiring_review",
    ]);
    expect(summary!.gates.find((g) => g.type === "gate_plan_approval")!.status).toBe("approved");
    expect(summary!.gates.find((g) => g.type === "gate_wiring_review")!.status).toBe("pending");
  });

  it("keeps the latest approval per gate type (re-review)", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    // older rejected, newer approved — newest wins
    await linkGate(companyId, issueId, "gate_code_review", "rejected", new Date(Date.now() - 10 * 60_000));
    await linkGate(companyId, issueId, "gate_code_review", "approved", new Date(Date.now() - 1 * 60_000));

    const map = await listGateSummariesForIssues(db, companyId, [issueId]);
    const gates = map.get(issueId)!.gates;
    expect(gates).toHaveLength(1);
    expect(gates[0]).toEqual({ type: "gate_code_review", status: "approved" });
  });

  it("omits issues with no gate approvals", async () => {
    const companyId = await seedCompany();
    const gated = await seedIssue(companyId);
    const ungated = await seedIssue(companyId);
    await linkGate(companyId, gated, "gate_plan_approval", "pending", new Date());

    const map = await listGateSummariesForIssues(db, companyId, [gated, ungated]);
    expect(map.has(gated)).toBe(true);
    expect(map.has(ungated)).toBe(false);
  });

  it("ignores non-gate approval types", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    await linkGate(companyId, issueId, "budget_increase", "pending", new Date());

    const map = await listGateSummariesForIssues(db, companyId, [issueId]);
    expect(map.has(issueId)).toBe(false);
  });

  it("returns an empty map for no issue ids", async () => {
    const companyId = await seedCompany();
    const map = await listGateSummariesForIssues(db, companyId, []);
    expect(map.size).toBe(0);
  });

  it("scopes by company — a foreign company's gates never leak", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const issueId = await seedIssue(companyA);
    await linkGate(companyA, issueId, "gate_plan_approval", "approved", new Date());

    // Query with companyB's id but companyA's issue id → no leak.
    const map = await listGateSummariesForIssues(db, companyB, [issueId]);
    expect(map.has(issueId)).toBe(false);
  });
});
