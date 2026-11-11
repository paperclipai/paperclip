import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySkills, createDb, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";

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

  // Regression for LOOA-850: a `managed_checkout` project (no registered workspace row) exposes
  // only a server-derived `codebase.managedFolder`; before the fix that folder was never an
  // approved root, so every managed_checkout project's in-place skill re-import was denied.
  it("allows managed_checkout project managedFolder imports and rejects prefix-adjacent siblings", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    // Redirect the instance root at temp so the server-derived managedFolder is under our control.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-home-"));
    cleanupDirs.add(home);
    const previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Managed Co",
        issuePrefix: `M${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      // No projectWorkspaces row => origin "managed_checkout", primaryWorkspace null,
      // managedFolder = resolveManagedProjectWorkspaceDir({ companyId, projectId }) (server-derived).
      await db.insert(projects).values({ id: projectId, companyId, name: "Managed project" });

      const managedFolder = resolveManagedProjectWorkspaceDir({ companyId, projectId });
      const allowedSkill = path.join(managedFolder, ".agents", "skills", "managed-allowed");
      await fs.mkdir(allowedSkill, { recursive: true });
      await fs.writeFile(
        path.join(allowedSkill, "SKILL.md"),
        "---\nname: managed-allowed\ndescription: managed-allowed\n---\n# Managed Allowed\n",
        "utf8",
      );

      // Prefix-adjacent sibling: its path is a string-prefix match of managedFolder but it is NOT
      // inside the subtree. Confirms the boundary uses `${root}${sep}`-anchored matching, not a bare
      // startsWith, so the added root cannot be widened by an adjacent directory name.
      const prefixAdjacent = `${managedFolder}-evil`;
      await fs.mkdir(prefixAdjacent, { recursive: true });
      await fs.writeFile(
        path.join(prefixAdjacent, "SKILL.md"),
        "---\nname: managed-evil\ndescription: managed-evil\n---\n# Managed Evil\n",
        "utf8",
      );

      const service = companySkillService(db);
      await expect(service.importFromSource(companyId, allowedSkill)).resolves.toMatchObject({
        imported: [expect.objectContaining({ slug: "managed-allowed" })],
      });
      await expect(service.importFromSource(companyId, prefixAdjacent)).rejects.toMatchObject({
        status: 403,
        details: { code: "skill_workspace_boundary_denied" },
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.PAPERCLIP_HOME;
      } else {
        process.env.PAPERCLIP_HOME = previousHome;
      }
    }
  });
});
