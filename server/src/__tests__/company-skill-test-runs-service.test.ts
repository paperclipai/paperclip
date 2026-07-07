import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySkillTestRuns,
  companySkills,
  createDb,
  documents,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill test run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companySkillService skill test runs", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skill-test-runs-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(companySkillTestRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await Promise.all(Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("snapshots output and keeps run history after harness issue retention", async () => {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const agentId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-test-run-"));
    cleanupDirs.add(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Review Skill\n", "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tester",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5.4",
        paperclipSkillSync: { desiredSkills: [`company/${companyId}/review`] },
        instructionsFilePath: "/tmp/AGENTS.md",
      },
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/review`,
      slug: "review",
      name: "Review Skill",
      description: null,
      markdown: "# Review Skill\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "managed_local" },
    });

    const input = await svc.createTestInput(companyId, skillId, {
      name: "cases/simple",
      content: "Try the review skill",
    }, { type: "user", userId: "local-board" });
    const run = await svc.createTestRun(companyId, skillId, {
      inputId: input.id,
      agentId,
    }, { type: "user", userId: "local-board" }, {
      createHarnessIssue: async (issue) => {
        await db.insert(issues).values({
          ...issue,
          companyId,
          priority: "medium",
        });
        return { id: issue.id };
      },
      wakeHarnessIssue: async () => null,
      retentionDays: 0,
    });

    expect(run.skillVersionId).toMatch(/[0-9a-f-]{36}/);
    expect(run.inputSnapshot).toBe("Try the review skill");
    expect(run.agentConfigSnapshot).toEqual(expect.objectContaining({
      adapterType: "codex_local",
      model: "gpt-5.4",
      instructionsRef: "/tmp/AGENTS.md",
    }));

    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Output",
      format: "markdown",
      latestBody: "## Result\n\nThe skill responded.",
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: run.issueId,
      documentId,
      key: "output",
    });

    const completed = await svc.completeTestRunForIssue({
      companyId,
      issueId: run.issueId,
      outcome: "succeeded",
    });
    expect(completed?.status).toBe("succeeded");
    expect(completed?.outputSnapshot).toBe("## Result\n\nThe skill responded.");

    await db
      .update(companySkillTestRuns)
      .set({ harnessIssueExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(companySkillTestRuns.id, run.id));

    const pruned = await svc.pruneExpiredTestHarnessIssues(companyId);
    expect(pruned.pruned).toBe(1);
    const detail = await svc.getTestRunDetail(companyId, skillId, run.id);
    expect(detail?.taskExpired).toBe(true);
    expect(detail?.harnessIssue).toBeNull();
    expect(detail?.outputSnapshot).toBe("## Result\n\nThe skill responded.");
  });
});
