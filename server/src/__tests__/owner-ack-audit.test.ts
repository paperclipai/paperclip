import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  companies,
  createDb,
  issueApprovals,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ownerAckAuditService } from "../services/owner-ack-audit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres owner ACK audit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ownerAckAuditService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-ack-audit-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Permisoria Admin") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedIssue(companyId: string, input: {
    title: string;
    description?: string | null;
    hiddenAt?: Date | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: input.title,
      description: input.description ?? null,
      status: "in_progress",
      priority: "high",
      hiddenAt: input.hiddenAt ?? null,
    });
    return issueId;
  }

  async function seedWorkProductMarker(companyId: string, issueId: string, metadata: Record<string, unknown>) {
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Deploy plan artifact",
      status: "active",
      reviewState: "none",
      metadata,
    });
  }

  async function seedLinkedApproval(companyId: string, issueId: string, input: {
    status: string;
    payload: Record<string, unknown>;
    decidedAt?: Date | null;
  }) {
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: input.status,
      payload: input.payload,
      decidedByUserId: input.status === "approved" ? "operator" : null,
      decidedAt: input.decidedAt ?? (input.status === "approved" ? new Date("2026-05-02T12:00:00.000Z") : null),
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId,
      approvalId,
      linkedByUserId: "operator",
    });
    return approvalId;
  }

  function validAckPayload(overrides: Record<string, unknown> = {}) {
    return {
      approvalKind: "owner_ack",
      actionType: "deploy",
      title: "Approve production deploy",
      exactAckPhrase: "ACK DEPLOY PERA",
      expiresAt: "2026-05-03T00:00:00.000Z",
      planHash: "sha256:abc123",
      blastRadius: "Permisoria Quasar production",
      rollback: "Rollback owner: operator; command: deploy previous SHA",
      riskCost: "Low operator cost, production availability risk",
      ...overrides,
    };
  }

  it("audits marked dangerous-action issues against linked owner ACK approvals", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany("Other Company");
    const svc = ownerAckAuditService(db);

    const coveredDeployId = await seedIssue(companyId, {
      title: "Deploy Quasar recovery",
      description: "Deploy impact: production",
    });
    await seedLinkedApproval(companyId, coveredDeployId, {
      status: "approved",
      payload: validAckPayload(),
    });

    const pendingSchemaId = await seedIssue(companyId, {
      title: "Apply DB migration",
      description: "Dangerous action: schema_migration",
    });
    await seedLinkedApproval(companyId, pendingSchemaId, {
      status: "pending",
      payload: validAckPayload({ actionType: "schema_migration" }),
    });

    const expiredDeployId = await seedIssue(companyId, {
      title: "Deploy expired approval",
      description: "Deploy impact: production",
    });
    await seedLinkedApproval(companyId, expiredDeployId, {
      status: "approved",
      payload: validAckPayload({ expiresAt: "2026-05-01T00:00:00.000Z" }),
    });

    const incompleteExternalId = await seedIssue(companyId, {
      title: "Enable unrestricted network",
      description: "External capability: unrestricted network",
    });
    await seedLinkedApproval(companyId, incompleteExternalId, {
      status: "approved",
      payload: {
        actionType: "external_capability",
        exactAckPhrase: "ACK NETWORK",
        expiresAt: "2026-05-03T00:00:00.000Z",
      },
    });

    const missingAckId = await seedIssue(companyId, {
      title: "Deploy marker from work product",
    });
    await seedWorkProductMarker(companyId, missingAckId, {
      requiresOwnerAck: true,
      dangerousActionType: "deploy",
    });

    const hiddenIssueId = await seedIssue(companyId, {
      title: "Hidden deploy",
      description: "Deploy impact: production",
      hiddenAt: new Date("2026-05-02T12:00:00.000Z"),
    });
    await seedLinkedApproval(companyId, hiddenIssueId, {
      status: "approved",
      payload: validAckPayload(),
    });

    const otherCompanyIssueId = await seedIssue(otherCompanyId, {
      title: "Other deploy",
      description: "Deploy impact: production",
    });
    await seedLinkedApproval(otherCompanyId, otherCompanyIssueId, {
      status: "approved",
      payload: validAckPayload(),
    });

    const report = await svc.auditCompany(companyId, new Date("2026-05-02T18:00:00.000Z"));
    const byTitle = new Map(report.issues.map((issue) => [issue.issue.title, issue]));

    expect(report.mode).toBe("read_only");
    expect(report.summary).toMatchObject({
      totalMarkedIssues: 5,
      covered: 1,
      missingAck: 1,
      pendingAck: 1,
      expiredAck: 1,
      incompleteAck: 1,
      byActionType: {
        deploy: 3,
        schema_migration: 1,
        external_capability: 1,
      },
    });

    expect(byTitle.get("Deploy Quasar recovery")).toMatchObject({
      issue: { id: coveredDeployId },
      auditStatus: "covered",
      reasons: ["has_valid_owner_ack"],
      approvals: [expect.objectContaining({ status: "approved", exactAckPhrase: "ACK DEPLOY PERA" })],
      observeGate: {
        action: "allow",
        wouldBlock: false,
        observed: false,
        reasons: [],
      },
    });
    expect(byTitle.get("Apply DB migration")).toMatchObject({
      issue: { id: pendingSchemaId },
      auditStatus: "pending_ack",
      dangerousActions: [expect.objectContaining({ actionType: "schema_migration" })],
      reasons: ["owner_ack_pending"],
      observeGate: {
        action: "allow",
        wouldBlock: true,
        observed: true,
        reasons: ["owner_ack_pending"],
      },
    });
    expect(byTitle.get("Deploy expired approval")).toMatchObject({
      issue: { id: expiredDeployId },
      auditStatus: "expired_ack",
      reasons: ["owner_ack_expired"],
      approvals: [expect.objectContaining({ missingFields: expect.arrayContaining(["unexpired"]) })],
      observeGate: {
        action: "allow",
        wouldBlock: true,
        observed: true,
        reasons: ["owner_ack_expired"],
      },
    });
    expect(byTitle.get("Enable unrestricted network")).toMatchObject({
      issue: { id: incompleteExternalId },
      auditStatus: "incomplete_ack",
      approvals: [
        expect.objectContaining({
          missingFields: expect.arrayContaining(["planHashOrStablePlanText", "blastRadius", "rollback", "riskCost"]),
        }),
      ],
      observeGate: {
        action: "allow",
        wouldBlock: true,
        observed: true,
        reasons: ["owner_ack_incomplete"],
      },
    });
    expect(byTitle.get("Deploy marker from work product")).toMatchObject({
      issue: { id: missingAckId },
      auditStatus: "missing_ack",
      dangerousActions: [expect.objectContaining({ source: "work_product_metadata", actionType: "deploy" })],
      observeGate: {
        action: "allow",
        wouldBlock: true,
        observed: true,
        reasons: ["missing_linked_owner_ack_approval"],
      },
    });
    expect(byTitle.has("Hidden deploy")).toBe(false);
    expect(byTitle.has("Other deploy")).toBe(false);
  });

  it("does not flag external capability none, but flags external capability required", async () => {
    const companyId = await seedCompany();
    const svc = ownerAckAuditService(db);

    await seedIssue(companyId, {
      title: "No external capability needed",
      description: "External capability: none",
    });
    await seedIssue(companyId, {
      title: "External capability required",
      description: "External capability: required",
    });

    const report = await svc.auditCompany(companyId, new Date("2026-05-02T18:00:00.000Z"));
    const byTitle = new Map(report.issues.map((issue) => [issue.issue.title, issue]));

    expect(report.summary.totalMarkedIssues).toBe(1);
    expect(byTitle.has("No external capability needed")).toBe(false);
    expect(byTitle.get("External capability required")).toMatchObject({
      dangerousActions: [expect.objectContaining({ actionType: "external_capability" })],
    });
  });

  it("does not flag deploy impact none, but flags deploy impact production", async () => {
    const companyId = await seedCompany();
    const svc = ownerAckAuditService(db);

    await seedIssue(companyId, {
      title: "No deploy impact",
      description: "Deploy impact: none",
    });
    await seedIssue(companyId, {
      title: "Production deploy impact",
      description: "Deploy impact: production",
    });

    const report = await svc.auditCompany(companyId, new Date("2026-05-02T18:00:00.000Z"));
    const byTitle = new Map(report.issues.map((issue) => [issue.issue.title, issue]));

    expect(report.summary.totalMarkedIssues).toBe(1);
    expect(byTitle.has("No deploy impact")).toBe(false);
    expect(byTitle.get("Production deploy impact")).toMatchObject({
      dangerousActions: [expect.objectContaining({ actionType: "deploy" })],
    });
  });

  it("does not flag schema migration none, but flags schema migration required", async () => {
    const companyId = await seedCompany();
    const svc = ownerAckAuditService(db);

    await seedIssue(companyId, {
      title: "No schema migration",
      description: "Schema migration: none",
    });
    await seedIssue(companyId, {
      title: "Schema migration required",
      description: "Schema migration: required",
    });

    const report = await svc.auditCompany(companyId, new Date("2026-05-02T18:00:00.000Z"));
    const byTitle = new Map(report.issues.map((issue) => [issue.issue.title, issue]));

    expect(report.summary.totalMarkedIssues).toBe(1);
    expect(byTitle.has("No schema migration")).toBe(false);
    expect(byTitle.get("Schema migration required")).toMatchObject({
      dangerousActions: [expect.objectContaining({ actionType: "schema_migration" })],
    });
  });

  it("does not flag external capability n.a", async () => {
    const companyId = await seedCompany();
    const svc = ownerAckAuditService(db);

    await seedIssue(companyId, {
      title: "External capability n.a",
      description: "External capability: n.a",
    });

    const report = await svc.auditCompany(companyId, new Date("2026-05-02T18:00:00.000Z"));
    expect(report.summary.totalMarkedIssues).toBe(0);
  });

  it("does not infer deploy marker from work-product deployImpact none", async () => {
    const companyId = await seedCompany();
    const svc = ownerAckAuditService(db);
    const issueId = await seedIssue(companyId, { title: "Artifact with deployImpact none" });

    await seedWorkProductMarker(companyId, issueId, {
      deployImpact: "none",
    });

    const report = await svc.auditCompany(companyId, new Date("2026-05-02T18:00:00.000Z"));
    const byTitle = new Map(report.issues.map((issue) => [issue.issue.title, issue]));
    expect(report.summary.totalMarkedIssues).toBe(0);
    expect(byTitle.has("Artifact with deployImpact none")).toBe(false);
  });
});
