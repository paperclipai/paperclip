import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySkills,
  createDb,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
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

  async function insertEditableFactoryPolicy(companyId: string, slug: string) {
    const defaultView = await svc.getAiFactoryPolicyView(companyId);
    const defaultPolicy = await svc.readFile(
      companyId,
      defaultView.overlaySkillId,
      "factory-policy.yaml",
    );
    const skillId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-${slug}-`));
    cleanupDirs.add(skillDir);
    const markdown = `---\nname: ${slug}\n---\n\n# ${slug}\n`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), markdown, "utf8");
    await fs.writeFile(path.join(skillDir, "factory-policy.yaml"), defaultPolicy!.content, "utf8");
    const key = `company/${companyId}/${slug}`;
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key,
      slug,
      name: slug,
      description: null,
      markdown,
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "factory-policy.yaml", kind: "other" },
      ],
      metadata: { sourceKind: "managed_local", skillKey: key },
    });
    return { id: skillId, key, dir: skillDir, policy: defaultPolicy!.content };
  }

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(projects);
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

  it("seeds, validates, selects, and force-syncs the editable AI Factory policy overlay", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Factory Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const view = await svc.getAiFactoryPolicyView(companyId);
    expect(view).toMatchObject({
      baseSkillKey: "paperclipai/paperclip/paperclip-ai-factory",
      overlaySkillKey: `company/${companyId}/ai-factory-policy`,
      differsFromDefault: false,
      compiled: {
        version: 1,
        policy: {
          topology: { noGrandchildren: true },
          roles: { controlOwnerRole: "ceo", laneCoordinatorRole: "cto" },
        },
      },
    });

    const runtimeEntries = await svc.listRuntimeSkillEntries(companyId, { materializeMissing: false });
    expect(runtimeEntries.find((entry) => entry.key === "paperclipai/paperclip/paperclip-ai-factory"))
      .toMatchObject({ required: true });
    expect(runtimeEntries.find((entry) => entry.key === view.overlaySkillKey)).toMatchObject({
      required: true,
      requiredReason: "Selected as the company AI Factory policy by Paperclip.",
    });

    const overlay = await svc.getById(companyId, view.overlaySkillId);
    expect(overlay?.fileInventory.map((entry) => entry.path)).toContain("factory-policy.yaml");
    await expect(svc.updateAiFactoryPolicyFile(
      companyId,
      view.overlaySkillId,
      "version: 1\nextends: paperclipai/paperclip/paperclip-ai-factory\ntopology:\n  noGrandchildren: false\n",
    )).rejects.toMatchObject({ status: 422, message: "AI Factory policy is invalid." });
  });

  it("rejects hostile collisions with every protected AI Factory skill key", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Protected Factory Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const defaultView = await svc.getAiFactoryPolicyView(companyId);
    const selected = await insertEditableFactoryPolicy(companyId, "selected-policy");
    await svc.selectAiFactoryPolicy(companyId, selected.id);

    const hostileMarkdown = (name: string, key: string) => [
      "---",
      `name: ${name}`,
      `key: "${key}"`,
      "---",
      "",
      `# ${name}`,
    ].join("\n");
    const protectedKeys = [
      "paperclipai/paperclip/paperclip-ai-factory",
      defaultView.overlaySkillKey,
      selected.key,
    ];

    for (const [index, key] of protectedKeys.entries()) {
      await expect(svc.importPackageFiles(companyId, {
        [`hostile-${index}/SKILL.md`]: hostileMarkdown(`Hostile ${index}`, key),
      }, { onConflict: "replace" })).rejects.toMatchObject({
        status: 422,
        details: {
          skillKey: key,
          action: "upsert",
          requiredRoute: "company_ai_factory_policy",
        },
      });
    }

    const hostileSource = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hostile-policy-"));
    cleanupDirs.add(hostileSource);
    await fs.writeFile(
      path.join(hostileSource, "SKILL.md"),
      hostileMarkdown("Hostile Selected Policy", selected.key),
      "utf8",
    );
    await expect(svc.importFromSource(companyId, hostileSource)).rejects.toMatchObject({
      status: 422,
      details: { skillKey: selected.key, action: "upsert" },
    });

    await expect(svc.createLocalSkill(companyId, {
      name: "Hostile Default Policy",
      slug: "ai-factory-policy",
      markdown: "# overwritten",
    })).rejects.toMatchObject({
      status: 422,
      details: { skillKey: defaultView.overlaySkillKey, action: "upsert" },
    });
    await expect(svc.updateFile(companyId, selected.id, "SKILL.md", "# overwritten"))
      .rejects.toMatchObject({
        status: 422,
        details: { skillKey: selected.key, action: "update" },
      });
    await expect(svc.installUpdate(companyId, selected.id)).rejects.toMatchObject({
      status: 422,
      details: { skillKey: selected.key, action: "install_update" },
    });
    await expect(svc.deleteSkill(companyId, selected.id)).rejects.toMatchObject({
      status: 422,
      details: { skillKey: selected.key, action: "delete" },
    });

    await expect(svc.updateAiFactoryPolicyFile(companyId, selected.id, selected.policy))
      .resolves.toMatchObject({ path: "factory-policy.yaml", content: selected.policy });
    await expect(svc.getAiFactoryPolicyView(companyId)).resolves.toMatchObject({
      overlaySkillId: selected.id,
      overlaySkillKey: selected.key,
    });
    await expect(fs.readFile(path.join(selected.dir, "SKILL.md"), "utf8"))
      .resolves.not.toContain("overwritten");

    await fs.rm(selected.dir, { recursive: true, force: true });
    await svc.refreshInventory(companyId);
    await expect(svc.getById(companyId, selected.id)).resolves.toMatchObject({
      id: selected.id,
      key: selected.key,
    });
  });

  it("reuses target control-plane skills during company-package restore without applying package bytes", async () => {
    const companyId = randomUUID();
    const sourceCompanyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Factory Restore Target",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const view = await svc.getAiFactoryPolicyView(companyId);
    const baseBefore = await svc.getByKey(companyId, "paperclipai/paperclip/paperclip-ai-factory");
    const policyBefore = await svc.readFile(
      companyId,
      view.overlaySkillId,
      "factory-policy.yaml",
    );
    expect(baseBefore).not.toBeNull();
    expect(policyBefore).not.toBeNull();

    const imported = await svc.importPackageFiles(companyId, {
      "skills/paperclip-ai-factory/SKILL.md": [
        "---",
        "name: paperclip-ai-factory",
        "slug: paperclip-ai-factory",
        "key: paperclipai/paperclip/paperclip-ai-factory",
        "metadata:",
        "  sources:",
        "    - kind: github-dir",
        "      repo: paperclipai/paperclip",
        "      path: skills/paperclip-ai-factory",
        "---",
        "",
        "# Untrusted replacement must never be applied",
      ].join("\n"),
      "skills/source-policy/SKILL.md": [
        "---",
        "name: Source AI Factory Policy",
        "slug: ai-factory-policy",
        `key: company/${sourceCompanyId}/ai-factory-policy`,
        "---",
        "",
        "# Untrusted source policy must never replace target policy",
      ].join("\n"),
      "skills/source-policy/factory-policy.yaml": [
        "version: 1",
        "extends: paperclipai/paperclip/paperclip-ai-factory",
        "topology:",
        "  noGrandchildren: false",
      ].join("\n"),
    }, {
      onConflict: "replace",
      protectedFactorySkills: "reuse_target",
    });

    expect(imported).toHaveLength(2);
    expect(imported).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "skipped",
        originalKey: "paperclipai/paperclip/paperclip-ai-factory",
        skill: expect.objectContaining({ id: baseBefore!.id, key: baseBefore!.key }),
      }),
      expect.objectContaining({
        action: "skipped",
        originalKey: `company/${sourceCompanyId}/ai-factory-policy`,
        skill: expect.objectContaining({
          id: view.overlaySkillId,
          key: view.overlaySkillKey,
        }),
      }),
    ]));

    await expect(svc.getByKey(companyId, baseBefore!.key)).resolves.toMatchObject({
      id: baseBefore!.id,
      markdown: baseBefore!.markdown,
    });
    await expect(svc.readFile(companyId, view.overlaySkillId, "factory-policy.yaml"))
      .resolves.toMatchObject({ content: policyBefore!.content });
    const companyRows = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    expect(companyRows.some((row) => row.key === `company/${sourceCompanyId}/ai-factory-policy`))
      .toBe(false);
  });

  it("serializes selecting a factory policy against deleting the same skill", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Factory Selection Race",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const defaultView = await svc.getAiFactoryPolicyView(companyId);
    const candidate = await insertEditableFactoryPolicy(companyId, "race-policy");

    const outcomes = await Promise.allSettled([
      svc.selectAiFactoryPolicy(companyId, candidate.id),
      svc.deleteSkill(companyId, candidate.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const view = await svc.getAiFactoryPolicyView(companyId);
    const selectedRow = await db
      .select({ id: companySkills.id })
      .from(companySkills)
      .where(eq(companySkills.key, view.overlaySkillKey));
    expect(selectedRow).toHaveLength(1);
    expect([defaultView.overlaySkillKey, candidate.key]).toContain(view.overlaySkillKey);
  });

  it("fails a project scan that advertises a protected policy key", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hostile Scan Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const selected = await insertEditableFactoryPolicy(companyId, "scan-selected-policy");
    await svc.selectAiFactoryPolicy(companyId, selected.id);

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hostile-scan-"));
    cleanupDirs.add(workspaceDir);
    const hostileSkillDir = path.join(workspaceDir, ".claude", "skills", "hostile-policy");
    await fs.mkdir(hostileSkillDir, { recursive: true });
    await fs.writeFile(path.join(hostileSkillDir, "SKILL.md"), [
      "---",
      "name: Hostile Scanned Policy",
      `key: "${selected.key}"`,
      "---",
      "",
      "# Hostile Scanned Policy",
    ].join("\n"), "utf8");
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Hostile Scan Project",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: workspaceDir,
      isPrimary: true,
    });

    await expect(svc.scanProjectWorkspaces(companyId, {
      projectIds: [projectId],
      workspaceIds: [workspaceId],
    })).rejects.toMatchObject({
      status: 422,
      details: { skillKey: selected.key, action: "upsert" },
    });
    await expect(svc.getById(companyId, selected.id)).resolves.toMatchObject({
      id: selected.id,
      key: selected.key,
    });
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
