import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  goals,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService } from "../services/dashboard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard orphan tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("dashboard orphanCandidates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-orphan-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("counts open issues whose parent has projectId/goalId but child does not", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Orphan Inc",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Orphan Project",
      shortName: "orphan",
    });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      projectId,
      title: "Orphan Goal",
    });

    const parentId = randomUUID();
    const projectOrphanId = randomUUID();
    const goalOrphanId = randomUUID();
    const bothOrphanId = randomUUID();
    const properChildId = randomUUID();
    const closedOrphanId = randomUUID();
    const hiddenOrphanId = randomUUID();
    const nullParentId = randomUUID();

    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        projectId,
        goalId,
        title: "Parent",
        status: "in_progress",
      },
      {
        id: projectOrphanId,
        companyId,
        parentId,
        projectId: null,
        goalId,
        title: "Project orphan",
        status: "todo",
      },
      {
        id: goalOrphanId,
        companyId,
        parentId,
        projectId,
        goalId: null,
        title: "Goal orphan",
        status: "in_progress",
      },
      {
        id: bothOrphanId,
        companyId,
        parentId,
        projectId: null,
        goalId: null,
        title: "Both orphan",
        status: "blocked",
      },
      {
        id: properChildId,
        companyId,
        parentId,
        projectId,
        goalId,
        title: "Proper child",
        status: "in_progress",
      },
      {
        id: closedOrphanId,
        companyId,
        parentId,
        projectId: null,
        goalId: null,
        title: "Closed orphan (excluded)",
        status: "done",
      },
      {
        id: hiddenOrphanId,
        companyId,
        parentId,
        projectId: null,
        goalId: null,
        title: "Hidden orphan (excluded)",
        status: "todo",
        hiddenAt: new Date(),
      },
      {
        id: nullParentId,
        companyId,
        projectId: null,
        goalId: null,
        title: "Top-level no-project (excluded — null parent)",
        status: "todo",
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.orphanCandidates).toEqual({
      projectOrphans: 2, // projectOrphan + bothOrphan
      goalOrphans: 2, // goalOrphan + bothOrphan
      total: 3, // projectOrphan + goalOrphan + bothOrphan (deduped)
    });
  });

  it("does not count children whose parentId resolves to a different company", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const otherProjectId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Tenant A",
        issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Tenant B",
        issuePrefix: `B${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(projects).values({
      id: otherProjectId,
      companyId: otherCompanyId,
      name: "Other Project",
      shortName: "other",
    });

    const otherParentId = randomUUID();
    const crossTenantChildId = randomUUID();

    await db.insert(issues).values([
      {
        id: otherParentId,
        companyId: otherCompanyId,
        projectId: otherProjectId,
        title: "Parent in other tenant",
        status: "in_progress",
      },
      {
        id: crossTenantChildId,
        companyId,
        // Data corruption case: parentId references an issue from a different company.
        parentId: otherParentId,
        projectId: null,
        goalId: null,
        title: "Cross-tenant orphan (must be excluded)",
        status: "todo",
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.orphanCandidates).toEqual({
      projectOrphans: 0,
      goalOrphans: 0,
      total: 0,
    });
  });

  it("returns zeroes when no orphans exist", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Clean Inc",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const summary = await dashboardService(db).summary(companyId);
    expect(summary.orphanCandidates).toEqual({
      projectOrphans: 0,
      goalOrphans: 0,
      total: 0,
    });
  });
});
