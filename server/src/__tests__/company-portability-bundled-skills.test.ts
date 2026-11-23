import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres bundled skill portability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const bundledSkillKey = "paperclipai/paperclip/paperclip";
const bundledSkillPath = "skills/paperclipai/paperclip/paperclip/SKILL.md";

describeEmbeddedPostgres("company portability bundled skills without a git checkout", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let connectionString = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("portability-bundled-skills");
    stopDb = started.cleanup;
    connectionString = started.connectionString;
  }, 30_000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function exportAndImport(buildCommit: string) {
    vi.stubEnv("GIT_DIR", path.join(os.tmpdir(), `paperclip-missing-git-dir-${randomUUID()}`));
    vi.stubEnv("PAPERCLIP_BUILD_COMMIT", buildCommit);
    vi.resetModules();
    const { agents, companies, createDb } = await import("@paperclipai/db");
    const { eq } = await import("drizzle-orm");
    const { createAgentLifecycle } = await import("../services/agent-lifecycle.js");
    const { companyPortabilityService } = await import("../services/company-portability.js");
    const { companySkillService } = await import("../services/company-skills.js");
    const db = createDb(connectionString);

    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Bundled Skill Source",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const sourceSkills = await companySkillService(db).list(companyId);
    expect(sourceSkills.map((skill) => skill.key)).toContain(bundledSkillKey);
    await createAgentLifecycle(db).requestHire(companyId, {
      name: "Skill User",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        paperclipSkillSync: { desiredSkills: [bundledSkillKey] },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const portability = companyPortabilityService(db);
    const exported = await portability.exportBundle(companyId, {
      include: { company: true, agents: true, projects: false, issues: false, skills: true },
    });
    const imported = await portability.importBundle(
      {
        source: { type: "inline", rootPath: exported.rootPath, files: exported.files },
        include: { company: true, agents: true, projects: false, issues: false, skills: true },
        target: { mode: "new_company", newCompanyName: `Bundled Skill Target ${randomUUID()}` },
        collisionStrategy: "rename",
      },
      "user-1",
    );
    const importedAgents = await db.select().from(agents).where(eq(agents.companyId, imported.company.id));
    const targetSkills = await companySkillService(db).list(imported.company.id);
    return { exported, importedAgents, targetSkills };
  }

  it("pins exported bundled skills to the build commit and imports the unchanged export", async () => {
    const buildCommit = "0123456789abcdef0123456789abcdef01234567";

    const { exported, importedAgents } = await exportAndImport(buildCommit);

    expect(String(exported.files[bundledSkillPath])).toContain(`commit: "${buildCommit}"`);
    expect(exported.manifest.skills.length).toBeGreaterThan(0);
    for (const skill of exported.manifest.skills) {
      expect(skill.sourceRef).toBe(buildCommit);
    }
    expect(importedAgents.map((agent) => agent.name)).toEqual(["Skill User"]);
  }, 60_000);

  it("omits bundled skills when the build has no commit and imports the unchanged export", async () => {
    const { exported, importedAgents, targetSkills } = await exportAndImport("");

    expect(Object.keys(exported.files).filter((file) => file.startsWith("skills/"))).toEqual([]);
    expect(exported.manifest.skills).toEqual([]);
    expect(exported.warnings).toContainEqual(
      expect.stringContaining("Bundled Paperclip skills were omitted from export"),
    );
    expect(importedAgents.map((agent) => agent.name)).toEqual(["Skill User"]);
    expect(targetSkills.map((skill) => skill.key)).toContain(bundledSkillKey);
  }, 60_000);
});
