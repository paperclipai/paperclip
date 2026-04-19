import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyRolloutEntityLinks,
  companyRolloutReleases,
  companyRolloutTargets,
  companySkills,
  createDb,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyRolloutService } from "../services/company-rollouts.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company rollout tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyRolloutService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companyRolloutService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-rollouts-");
    db = createDb(tempDb.connectionString);
    svc = companyRolloutService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyRolloutEntityLinks);
    await db.delete(companyRolloutTargets);
    await db.delete(companyRolloutReleases);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string, status: "active" | "paused" | "archived" = "active") {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      status,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("increments release versions and leaves earlier snapshot hashes immutable", async () => {
    const sourceCompanyId = await seedCompany("Source");

    const first = await svc.createRelease(sourceCompanyId, { title: "Operating model" }, "user-1");
    const second = await svc.createRelease(sourceCompanyId, { title: "Operating model" }, "user-1");

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.packageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.packageHash).toMatch(/^[a-f0-9]{64}$/);

    const [firstRow] = await db
      .select()
      .from(companyRolloutReleases)
      .where(eq(companyRolloutReleases.id, first.id));
    expect(firstRow?.packageHash).toBe(first.packageHash);

    const createdEvents = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "company_rollout.created"));
    expect(createdEvents).toHaveLength(2);
  });

  it("defaults to active targets, excludes source and archived, and permits explicit paused targets", async () => {
    const sourceCompanyId = await seedCompany("Source");
    const activeTargetId = await seedCompany("Active target");
    const pausedTargetId = await seedCompany("Paused target", "paused");
    const archivedTargetId = await seedCompany("Archived target", "archived");
    const release = await svc.createRelease(sourceCompanyId, { title: "Operating model" }, "user-1");

    const defaultPreview = await svc.previewRelease(release.id, undefined, "user-1");
    expect(defaultPreview.targets.map((target) => target.companyId)).toEqual([activeTargetId]);

    const explicitPreview = await svc.previewRelease(
      release.id,
      { targetCompanyIds: [sourceCompanyId, pausedTargetId, archivedTargetId] },
      "user-1",
    );
    expect(explicitPreview.targets.map((target) => target.companyId)).toEqual([pausedTargetId]);
  });

  it("surfaces unmanaged target project conflicts in preview", async () => {
    const sourceCompanyId = await seedCompany("Source");
    const targetCompanyId = await seedCompany("Target");
    await db.insert(projects).values({
      companyId: sourceCompanyId,
      name: "Roadmap",
      description: "Source package project",
      status: "planned",
    });
    await db.insert(projects).values({
      companyId: targetCompanyId,
      name: "Roadmap",
      description: "Unmanaged target project",
      status: "planned",
    });
    const release = await svc.createRelease(sourceCompanyId, { title: "Roadmap release" }, "user-1");

    const preview = await svc.previewRelease(release.id, { targetCompanyIds: [targetCompanyId] }, "user-1");
    const projectAction = preview.targets[0]?.entityActions.find((action) => action.kind === "project");

    expect(projectAction).toMatchObject({
      action: "skip_unmanaged_conflict",
      key: "roadmap",
    });
    expect(preview.targets[0]?.warnings).toContain("Unmanaged target content with matching names was skipped.");
  });

  it("uses managed links for later updates without overwriting target company identity", async () => {
    const sourceCompanyId = await seedCompany("Source");
    const targetCompanyId = await seedCompany("Target");
    const sourceProjectId = randomUUID();
    await db.insert(projects).values({
      id: sourceProjectId,
      companyId: sourceCompanyId,
      name: "Rollout Project",
      description: "First description",
      status: "planned",
    });
    const firstRelease = await svc.createRelease(sourceCompanyId, { title: "Project v1" }, "user-1");

    const applyResult = await svc.applyRelease(firstRelease.id, { targetCompanyIds: [targetCompanyId] }, "user-1");
    expect(applyResult.targets[0]?.applied).toBe(true);

    const [targetCompany] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, targetCompanyId));
    expect(targetCompany?.name).toBe("Target");

    await db
      .update(projects)
      .set({ description: "Second description" })
      .where(eq(projects.id, sourceProjectId));

    const secondRelease = await svc.createRelease(sourceCompanyId, { title: "Project v2" }, "user-1");
    const preview = await svc.previewRelease(secondRelease.id, { targetCompanyIds: [targetCompanyId] }, "user-1");
    const projectAction = preview.targets[0]?.entityActions.find((action) => action.kind === "project");

    expect(projectAction).toMatchObject({
      action: "update",
      key: "rollout-project",
    });
  });
});
