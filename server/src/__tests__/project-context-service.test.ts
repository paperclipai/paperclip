import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySkills,
  contextSourceChunks,
  contextSourceItems,
  contextSourceSyncRuns,
  contextSources,
  createDb,
  issueComments,
  issues,
  projectContextProfiles,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectContextService } from "../services/project-context.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project context tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("projectContextService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof projectContextService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-context-");
    db = createDb(tempDb.connectionString);
    svc = projectContextService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(contextSourceChunks);
    await db.delete(contextSourceItems);
    await db.delete(contextSourceSyncRuns);
    await db.delete(contextSources);
    await db.delete(projectContextProfiles);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companySkills);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Hermes AI",
      status: "in_progress",
    });
    return { companyId, projectId };
  }

  it("assembles instructions, inherited skills, and retrieved source provenance", async () => {
    const { companyId, projectId } = await seedProject();
    const issueId = randomUUID();
    await db.insert(companySkills).values({
      companyId,
      key: "shopping-research",
      slug: "shopping-research",
      name: "Shopping Research",
      markdown: "# Shopping Research\n",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Review Hermes config parser",
      description: "Use project context about ui parser sources.",
      status: "todo",
      priority: "high",
    });

    await svc.updateProfile(companyId, projectId, {
      goalMarkdown: "Ship a plugin-only Hermes adapter that is safe for fork users.",
      instructionsMarkdown: "Always cite project sources before changing Hermes config.",
      defaultSkillKeys: ["shopping-research"],
    });
    await svc.createSource(companyId, projectId, {
      sourceType: "manual",
      title: "Hermes adapter notes",
      bodyText: "Hermes adapter config schema uses ui parser metadata for source controls.",
    });

    const bundle = await svc.buildBundle({ companyId, projectId, issueId });

    expect(bundle).not.toBeNull();
    expect(bundle?.goalMarkdown).toContain("plugin-only Hermes adapter");
    expect(bundle?.instructionsMarkdown).toContain("Always cite project sources");
    expect(bundle?.defaultSkillKeys).toEqual(["shopping-research"]);
    expect(bundle?.sources[0]).toMatchObject({
      sourceTitle: "Hermes adapter notes",
      itemTitle: "Hermes adapter notes",
    });
    expect(bundle?.sources[0]?.excerpt).toContain("ui parser metadata");

    const profile = await svc.getProfileOrDefault(companyId, projectId);
    expect(profile.goalMarkdown).toContain("plugin-only Hermes adapter");
  });

  it("returns a runtime bundle for a goal-only project context profile", async () => {
    const { companyId, projectId } = await seedProject();
    await svc.updateProfile(companyId, projectId, {
      goalMarkdown: "Keep the onboarding project aligned to a working first-run demo.",
    });

    const bundle = await svc.buildBundle({ companyId, projectId });

    expect(bundle).not.toBeNull();
    expect(bundle?.goalMarkdown).toContain("working first-run demo");
    expect(bundle?.instructionsMarkdown).toBe("");
    expect(bundle?.defaultSkillKeys).toEqual([]);
    expect(bundle?.sources).toEqual([]);
  });

  it("keeps source writes and default skills company-scoped", async () => {
    const alpha = await seedProject();
    const beta = await seedProject();
    await db.insert(companySkills).values({
      companyId: beta.companyId,
      key: "external-skill",
      slug: "external-skill",
      name: "External Skill",
      markdown: "# External\n",
    });

    await expect(
      svc.updateProfile(alpha.companyId, alpha.projectId, { defaultSkillKeys: ["external-skill"] }),
    ).rejects.toThrow(/skills are not available/);

    const source = await svc.createSource(alpha.companyId, alpha.projectId, {
      sourceType: "manual",
      title: "Alpha source",
      bodyText: "Only alpha should see this context.",
    });

    await expect(
      svc.upsertSourceItem(beta.companyId, source.id, {
        title: "Cross company write",
        bodyText: "should fail",
      }),
    ).rejects.toThrow(/does not belong/);
    expect(await svc.search(beta.companyId, beta.projectId, "alpha context", 5)).toEqual([]);
  });
});
