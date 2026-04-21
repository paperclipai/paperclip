import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("projectService hierarchy", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof projectService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-projects-service-");
    db = createDb(tempDb.connectionString);
    svc = projectService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name = "Paperclip") {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `P${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("creates, moves, and clears project parents", async () => {
    const companyId = await seedCompany();
    const root = await svc.create(companyId, { name: "Root" });
    const sibling = await svc.create(companyId, { name: "Sibling" });
    const child = await svc.create(companyId, { name: "Child", parentId: root.id });

    expect(child.parentId).toBe(root.id);

    const moved = await svc.update(child.id, { parentId: sibling.id });
    expect(moved?.parentId).toBe(sibling.id);

    const cleared = await svc.update(child.id, { parentId: null });
    expect(cleared?.parentId).toBeNull();
  });

  it("rejects parents from another company", async () => {
    const alphaId = await seedCompany("Alpha");
    const betaId = await seedCompany("Beta");
    const betaProject = await svc.create(betaId, { name: "Beta Root" });

    await expect(
      svc.create(alphaId, { name: "Alpha Child", parentId: betaProject.id }),
    ).rejects.toThrow(/same company/);
  });

  it("rejects self-parenting and descendant cycles", async () => {
    const companyId = await seedCompany();
    const root = await svc.create(companyId, { name: "Root" });
    const child = await svc.create(companyId, { name: "Child", parentId: root.id });
    const grandchild = await svc.create(companyId, { name: "Grandchild", parentId: child.id });

    await expect(svc.update(root.id, { parentId: root.id })).rejects.toThrow(/own parent/);
    await expect(svc.update(root.id, { parentId: grandchild.id })).rejects.toThrow(/descendants/);
  });

  it("normalizes, clears, and preserves null project codes", async () => {
    const companyId = await seedCompany();
    const coded = await svc.create(companyId, { name: "Coded", code: " pap42 " });
    const uncoded = await svc.create(companyId, { name: "Uncoded" });

    expect(coded.code).toBe("PAP42");
    expect(uncoded.code).toBeNull();

    const cleared = await svc.update(coded.id, { code: "" });
    expect(cleared?.code).toBeNull();

    const recoded = await svc.update(uncoded.id, { code: "ops7" });
    expect(recoded?.code).toBe("OPS7");
  });

  it("rejects duplicate project codes within a company", async () => {
    const companyId = await seedCompany();
    const alpha = await svc.create(companyId, { name: "Alpha", code: "PAP" });

    await expect(svc.create(companyId, { name: "Gamma", code: "pap" })).rejects.toThrow(/already used/);
    await expect(svc.update(alpha.id, { code: "PAP" })).resolves.toMatchObject({ code: "PAP" });
  });

  it("allows the same project code in different companies", async () => {
    const alphaId = await seedCompany("Alpha");
    const betaId = await seedCompany("Beta");

    await svc.create(alphaId, { name: "Alpha Project", code: "OPS" });
    const betaProject = await svc.create(betaId, { name: "Beta Project", code: "ops" });

    expect(betaProject.code).toBe("OPS");
  });

  it("duplicates project settings and workspaces without copying issues", async () => {
    const companyId = await seedCompany();
    const source = await svc.create(companyId, {
      name: "Launch",
      description: "Launch plan project",
      status: "in_progress",
      color: "#6366f1",
    });
    const workspace = await svc.createWorkspace(source.id, {
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      setupCommand: "pnpm install",
      isPrimary: true,
    });
    expect(workspace).not.toBeNull();
    await svc.update(source.id, {
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        defaultProjectWorkspaceId: workspace!.id,
      },
    });
    await db.insert(issues).values({
      companyId,
      projectId: source.id,
      title: "Do not copy this task",
    });

    const duplicated = await svc.duplicate(source.id);

    expect(duplicated).not.toBeNull();
    expect(duplicated?.name).toBe("Launch Copy");
    expect(duplicated?.description).toBe("Launch plan project");
    expect(duplicated?.status).toBe("planned");
    expect(duplicated?.workspaces).toHaveLength(1);
    expect(duplicated?.primaryWorkspace?.repoUrl).toBe("https://github.com/paperclipai/paperclip.git");
    expect(duplicated?.primaryWorkspace?.setupCommand).toBe("pnpm install");
    expect(duplicated?.executionWorkspacePolicy?.defaultProjectWorkspaceId).toBe(duplicated?.primaryWorkspace?.id);

    const copiedIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.projectId, duplicated!.id));
    expect(copiedIssues).toEqual([]);
  });
});
