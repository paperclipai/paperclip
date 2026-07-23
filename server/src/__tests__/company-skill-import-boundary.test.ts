import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySkills, createDb, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company skill local import boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-import-boundary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all([...cleanupDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows configured workspace imports and rejects out-of-tree and symlink escapes", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-approved-workspace-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-outside-skill-"));
    cleanupDirs.add(workspace);
    cleanupDirs.add(outside);
    await fs.writeFile(path.join(outside, "SKILL.md"), "---\nname: escaped\ndescription: escaped\n---\n# Escaped\n", "utf8");
    const allowedSkill = path.join(workspace, ".agents", "skills", "allowed");
    await fs.mkdir(allowedSkill, { recursive: true });
    await fs.writeFile(path.join(allowedSkill, "SKILL.md"), "---\nname: allowed\ndescription: allowed\n---\n# Allowed\n", "utf8");
    const symlink = path.join(workspace, "escaped-link");
    await fs.symlink(outside, symlink);

    await db.insert(companies).values({
      id: companyId,
      name: "Boundary Co",
      issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Approved project" });
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "Primary",
      cwd: workspace,
      isPrimary: true,
    });

    const service = companySkillService(db);
    await expect(service.importFromSource(companyId, allowedSkill)).resolves.toMatchObject({
      imported: [expect.objectContaining({ slug: "allowed" })],
    });
    await expect(service.importFromSource(companyId, outside)).rejects.toMatchObject({
      status: 403,
      details: { code: "skill_workspace_boundary_denied" },
    });
    await expect(service.importFromSource(companyId, symlink)).rejects.toMatchObject({
      status: 403,
      details: { code: "skill_workspace_boundary_denied" },
    });
    await expect(service.importFromSource(companyId, "ftp://example.com/skill")).rejects.toMatchObject({
      status: 422,
      details: { code: "skill_source_validation_failed" },
    });
    await expect(service.importFromSource(companyId, "http://example.com/skill")).rejects.toMatchObject({
      status: 422,
      details: { code: "skill_source_validation_failed" },
    });
  });
});
