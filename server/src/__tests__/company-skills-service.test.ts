import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySkills, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companySkillService.list", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let inventoryScanCount = 0;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skills-service-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db, {
      inventoryRefreshTtlMs: 60_000,
      onInventoryScan: () => {
        inventoryScanCount += 1;
      },
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
    inventoryScanCount = 0;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("lists skills without exposing markdown content", async () => {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-heavy-skill-"));
    cleanupDirs.add(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Heavy Skill\n", "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/heavy-skill`,
      slug: "heavy-skill",
      name: "Heavy Skill",
      description: "Large skill used for list projection regression coverage.",
      markdown: `# Heavy Skill\n\n${"x".repeat(250_000)}`,
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });

    const listed = await svc.list(companyId);
    const skill = listed.find((entry) => entry.id === skillId);

    expect(skill).toBeDefined();
    expect(skill).not.toHaveProperty("markdown");
    expect(skill).toMatchObject({
      id: skillId,
      key: `company/${companyId}/heavy-skill`,
      slug: "heavy-skill",
      name: "Heavy Skill",
      sourceType: "local_path",
      sourceLocator: skillDir,
      attachedAgentCount: 0,
      sourceBadge: "local",
      editable: true,
    });
  });

  it("rejects skill inventory refresh for a missing company", async () => {
    await expect(svc.list(randomUUID())).rejects.toMatchObject({
      status: 404,
      message: "Company not found",
    });
  });

  it("keeps unchanged bundled inventory rows stable and honors required: false", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await svc.list(companyId);
    const paperclipDev = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.key, "paperclipai/paperclip/paperclip-dev"))
      .then((rows) => rows.find((row) => row.companyId === companyId) ?? null);
    expect(paperclipDev?.metadata).toMatchObject({
      sourceKind: "paperclip_bundled",
      required: false,
    });

    const sentinelUpdatedAt = new Date("2000-01-01T00:00:00.000Z");
    await db
      .update(companySkills)
      .set({ updatedAt: sentinelUpdatedAt })
      .where(eq(companySkills.id, paperclipDev!.id));

    const runtimeEntries = await svc.listRuntimeSkillEntries(companyId, { materializeMissing: false });
    const refreshed = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.id, paperclipDev!.id))
      .then((rows) => rows[0] ?? null);

    expect(refreshed?.updatedAt.toISOString()).toBe(sentinelUpdatedAt.toISOString());
    expect(inventoryScanCount).toBe(1);
    expect(runtimeEntries.find((entry) => entry.key === paperclipDev!.key)).toMatchObject({
      required: false,
      requiredReason: null,
    });
    expect(runtimeEntries.find((entry) => entry.key === "paperclipai/paperclip/paperclip")).toMatchObject({
      required: true,
    });

    await svc.refreshInventory(companyId);
    expect(inventoryScanCount).toBe(2);
  });

  it("rejects duplicate canonical keys before partially writing an import batch", async () => {
    const companyId = randomUUID();
    const duplicateKey = `company/${companyId}/duplicate`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const skillMarkdown = (name: string) => [
      "---",
      `name: ${name}`,
      `key: \"${duplicateKey}\"`,
      "---",
      "",
      `# ${name}`,
    ].join("\n");
    const catalogRoot = path.resolve(resolvePaperclipInstanceRoot(), "skills", companyId, "__catalog__");
    await fs.rm(catalogRoot, { recursive: true, force: true });

    await expect(svc.importPackageFiles(companyId, {
      "first/SKILL.md": skillMarkdown("First Duplicate"),
      "second/SKILL.md": skillMarkdown("Second Duplicate"),
    })).rejects.toMatchObject({
      status: 422,
      message: `Duplicate company skill keys in import batch: ${duplicateKey}`,
      details: { duplicateKeys: [duplicateKey] },
    });

    const rows = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.key, duplicateKey));
    expect(rows).toHaveLength(0);
    await expect(fs.stat(catalogRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prevents deleting bundled Paperclip skills even when no agent uses them", async () => {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bundled-skill-"));
    cleanupDirs.add(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Paperclip Company Audit\n", "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "paperclipai/paperclip/paperclip-company-audit",
      slug: "paperclip-company-audit",
      name: "Paperclip Company Audit",
      description: "Root Paperclip audit skill.",
      markdown: "# Paperclip Company Audit\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "paperclip_bundled" },
    });

    await expect(svc.deleteSkill(companyId, skillId)).rejects.toMatchObject({
      status: 422,
      message: "Bundled Paperclip skills are managed by Paperclip and cannot be deleted.",
    });

    const remaining = await db.select().from(companySkills).where(eq(companySkills.id, skillId));
    expect(remaining).toHaveLength(1);
  });
});
