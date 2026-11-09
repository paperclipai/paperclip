import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueLabels, issueRelations, issues, labels } from "@paperclipai/db";

import { buildExportFidelityReport, collectExportFidelityCounts } from "../services/export-fidelity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres export fidelity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("export fidelity counts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-export-fidelity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(issueRelations);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("counts labels, label references, blocker relations, and monitors scoped to the company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await seedCompany(companyId);
    await seedCompany(otherCompanyId);

    const issueA = randomUUID();
    const issueB = randomUUID();
    const otherIssue = randomUUID();
    await db.insert(issues).values([
      issueRow({ id: issueA, companyId, identifier: "LOCAL-1" }),
      issueRow({ id: issueB, companyId, identifier: "LOCAL-2", monitorScheduledBy: "agent" }),
      issueRow({ id: otherIssue, companyId: otherCompanyId, identifier: "OTHER-1", monitorScheduledBy: "agent" }),
    ]);

    const labelId = randomUUID();
    const otherLabelId = randomUUID();
    await db.insert(labels).values([
      { id: labelId, companyId, name: "bug", color: "#ff0000" },
      { id: otherLabelId, companyId: otherCompanyId, name: "bug", color: "#00ff00" },
    ]);
    await db.insert(issueLabels).values([
      { issueId: issueA, labelId, companyId },
      { issueId: otherIssue, labelId: otherLabelId, companyId: otherCompanyId },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: issueA, relatedIssueId: issueB, type: "blocks" as const },
    ]);

    const counts = await collectExportFidelityCounts(db, companyId);
    expect(counts).toEqual({
      labelDefinitions: 1,
      issueLabelReferences: 1,
      issueBlockerRelations: 1,
      issueDocuments: 0,
      issueWorkProducts: 0,
      issueAttachments: 0,
      approvals: 0,
      costEvents: 0,
      activityLogEntries: 0,
      issueMonitors: 1,
    });

    const otherCounts = await collectExportFidelityCounts(db, otherCompanyId);
    expect(otherCounts.labelDefinitions).toBe(1);
    expect(otherCounts.issueBlockerRelations).toBe(0);
    expect(otherCounts.issueMonitors).toBe(1);
  });

  it("builds a report whose warnings reflect the collected counts", async () => {
    const companyId = randomUUID();
    await seedCompany(companyId);
    const issueId = randomUUID();
    await db.insert(issues).values([issueRow({ id: issueId, companyId, identifier: "LOCAL-1" })]);
    const labelId = randomUUID();
    await db.insert(labels).values([{ id: labelId, companyId, name: "bug", color: "#ff0000" }]);
    await db.insert(issueLabels).values([{ issueId, labelId, companyId }]);

    const report = buildExportFidelityReport(companyId, await collectExportFidelityCounts(db, companyId));
    expect(report.schema).toBe("paperclip-export-fidelity-v1");
    expect(report.companyId).toBe(companyId);
    // Labels travel in the bundle now, so their counts stay informational.
    expect(report.counts.labelDefinitions).toBe(1);
    expect(report.counts.issueLabelReferences).toBe(1);
    expect(report.warnings).toEqual([]);
    expect(Date.parse(report.generatedAt)).not.toBeNaN();
  });

  async function seedCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  function issueRow(overrides: { id: string; companyId: string; identifier: string; monitorScheduledBy?: string }) {
    return {
      description: "",
      status: "todo",
      priority: "medium",
      title: overrides.identifier,
      ...overrides,
    };
  }
});
