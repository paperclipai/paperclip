import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  companies,
  companySkillTestRunTemplates,
  companySkillTestRuns,
  companySkills,
  createDb,
  documents,
  issueAttachments,
  issueDocuments,
  issueWorkProducts,
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
    await db.delete(issueAttachments);
    await db.delete(issueWorkProducts);
    await db.delete(assets);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(companySkillTestRuns);
    await db.delete(companySkillTestRunTemplates);
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

  async function seedSkillAndAgent() {
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
      adapterConfig: { model: "gpt-5.4" },
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
    return { companyId, skillId, agentId };
  }

  const runDeps = (companyId: string) => ({
    createHarnessIssue: async (issue: Parameters<Parameters<typeof svc.createTestRun>[4]["createHarnessIssue"]>[0]) => {
      await db.insert(issues).values({ ...issue, companyId, priority: "medium" });
      return { id: issue.id };
    },
    wakeHarnessIssue: async () => null,
    retentionDays: 7,
  });

  it("cleans up the harness issue if persisting the test run fails", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const cleanedIssueIds: string[] = [];
    let createdIssueId: string | null = null;
    let wakeCalls = 0;

    await expect(
      svc.createTestRun(
        companyId,
        skillId,
        { content: "test this skill", agentId },
        { type: "user", userId: "local-board" },
        {
          createHarnessIssue: async (issue) => {
            createdIssueId = issue.id;
            await db.insert(issues).values({ ...issue, companyId, priority: "medium" });
            return { id: issue.id };
          },
          wakeHarnessIssue: async () => {
            wakeCalls += 1;
          },
          cleanupHarnessIssue: async (issueId) => {
            cleanedIssueIds.push(issueId);
            await db
              .update(issues)
              .set({ status: "cancelled", hiddenAt: new Date() })
              .where(eq(issues.id, issueId));
          },
          retentionDays: Number.NaN,
        },
      ),
    ).rejects.toThrow();

    expect(createdIssueId).toBeTruthy();
    expect(cleanedIssueIds).toEqual([createdIssueId]);
    expect(wakeCalls).toBe(0);
    const issue = await db
      .select({ status: issues.status, hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(eq(issues.id, createdIssueId!))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("cancelled");
    expect(issue?.hiddenAt).toBeInstanceOf(Date);
  });

  it("appends the built-in default template while keeping the input snapshot clean", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const run = await svc.createTestRun(
      companyId,
      skillId,
      { content: "test this skill", agentId },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );

    expect(run.inputSnapshot).toBe("test this skill");
    expect(run.templateId).toBe("built-in:default-test-template");
    expect(run.templateName).toBe("Default test template");
    expect(run.templateBody).toContain("{{skillName}}");
    expect(run.renderedTemplateBody).toContain("Skills Studio test for `Review Skill`");
    expect(run.renderedTemplateBody).toContain(`company/${companyId}/review`);
    expect(run.renderedTemplateBody).toContain("issue document `output`");
    expect(run.harnessIssueDescription).toBe(`test this skill\n\n---\n\n${run.renderedTemplateBody}`);

    const issue = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.description).toBe(run.harnessIssueDescription);
  });

  it("honors No template without weakening the clean run snapshot", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const run = await svc.createTestRun(
      companyId,
      skillId,
      { content: "test this skill", agentId, templateId: null },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );

    expect(run.inputSnapshot).toBe("test this skill");
    expect(run.templateId).toBeNull();
    expect(run.templateName).toBeNull();
    expect(run.templateBody).toBeNull();
    expect(run.renderedTemplateBody).toBeNull();
    expect(run.harnessIssueDescription).toBe("test this skill");

    const issue = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.description).toBe("test this skill");
  });

  it("manages custom templates and renders only explicit placeholders", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const template = await svc.createTestRunTemplate(companyId, {
      name: "Focused smoke",
      description: "Short run",
      body: "Run {{skillName}} v{{skillVersion}} for {{runId}} on {{issueId}} into {{outputDocumentKey}}.",
    }, { type: "user", userId: "local-board" });

    const listed = await svc.listTestRunTemplates(companyId);
    expect(listed.map((entry) => entry.id)).toEqual(["built-in:default-test-template", template.id]);
    expect(listed[0]?.builtIn).toBe(true);

    const run = await svc.createTestRun(
      companyId,
      skillId,
      { content: "custom template run", agentId, templateId: template.id },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );
    expect(run.templateId).toBe(template.id);
    expect(run.templateName).toBe("Focused smoke");
    expect(run.renderedTemplateBody).toContain("Run Review Skill v1");
    expect(run.renderedTemplateBody).toContain(run.id);
    expect(run.renderedTemplateBody).toContain(run.issueId);
    expect(run.renderedTemplateBody).toContain("into output");

    await expect(
      svc.createTestRunTemplate(companyId, {
        name: "Bad template",
        body: "Use {{unknownPlaceholder}}.",
      }, { type: "user", userId: "local-board" }),
    ).rejects.toThrow(/unknown template placeholder/i);

    const updated = await svc.updateTestRunTemplate(companyId, template.id, {
      name: "Focused smoke v2",
      body: "Use {{skillKey}}.",
    }, { type: "user", userId: "local-board" });
    expect(updated?.name).toBe("Focused smoke v2");
    expect(updated?.body).toBe("Use {{skillKey}}.");

    await expect(
      svc.updateTestRunTemplate(companyId, "built-in:default-test-template", { name: "Changed" }),
    ).rejects.toThrow(/read-only/i);

    const deleted = await svc.deleteTestRunTemplate(companyId, template.id);
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
    expect((await svc.listTestRunTemplates(companyId)).map((entry) => entry.id)).toEqual([
      "built-in:default-test-template",
    ]);
  });

  it("rejects unknown or cross-company template ids", async () => {
    const first = await seedSkillAndAgent();
    const second = await seedSkillAndAgent();
    const otherTemplate = await svc.createTestRunTemplate(second.companyId, {
      name: "Other company",
      body: "Other {{skillName}}.",
    }, { type: "user", userId: "local-board" });

    await expect(
      svc.createTestRun(
        first.companyId,
        first.skillId,
        { content: "test", agentId: first.agentId, templateId: randomUUID() },
        { type: "user", userId: "local-board" },
        runDeps(first.companyId),
      ),
    ).rejects.toThrow(/test run template not found/i);

    await expect(
      svc.createTestRun(
        first.companyId,
        first.skillId,
        { content: "test", agentId: first.agentId, templateId: otherTemplate.id },
        { type: "user", userId: "local-board" },
        runDeps(first.companyId),
      ),
    ).rejects.toThrow(/test run template not found/i);
  });

  it("re-run can use the viewed template body snapshot after source template edits", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const template = await svc.createTestRunTemplate(companyId, {
      name: "Snapshot me",
      body: "Original {{skillName}}.",
    }, { type: "user", userId: "local-board" });
    const first = await svc.createTestRun(
      companyId,
      skillId,
      { content: "repeatable", agentId, templateId: template.id },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );

    await svc.updateTestRunTemplate(companyId, template.id, {
      body: "Edited {{skillName}}.",
    }, { type: "user", userId: "local-board" });

    const reRun = await svc.createTestRun(
      companyId,
      skillId,
      {
        content: first.inputSnapshot,
        agentId: first.agentId,
        skillVersionId: first.skillVersionId,
        templateSnapshot: {
          templateId: first.templateId,
          templateName: first.templateName,
          templateBody: first.templateBody,
        },
      },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );
    expect(reRun.skillVersionId).toBe(first.skillVersionId);
    expect(reRun.templateId).toBe(template.id);
    expect(reRun.templateBody).toBe("Original {{skillName}}.");
    expect(reRun.renderedTemplateBody).toBe("Original Review Skill.");
    expect(reRun.harnessIssueDescription).toContain("Original Review Skill.");
    expect(reRun.harnessIssueDescription).not.toContain("Edited Review Skill.");
  });

  it("only deletes terminal runs and soft-deletes them out of history", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const run = await svc.createTestRun(
      companyId,
      skillId,
      { content: "test this skill", agentId },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );

    // In-flight run must be cancelled first.
    await expect(
      svc.deleteTestRun(companyId, skillId, run.id, { hideHarnessIssue: async () => null }),
    ).rejects.toThrow(/cancel the run/i);

    await svc.completeTestRunForIssue({ companyId, issueId: run.issueId, outcome: "succeeded" });

    const hidden: string[] = [];
    const deleted = await svc.deleteTestRun(companyId, skillId, run.id, {
      hideHarnessIssue: async (issueId) => {
        hidden.push(issueId);
      },
    });
    expect(deleted?.id).toBe(run.id);
    expect(deleted?.harnessIssueDeletedAt).toBeInstanceOf(Date);
    expect(deleted?.taskExpired).toBe(true);
    expect(hidden).toEqual([run.issueId]);

    // Gone from listings and detail.
    expect(await svc.listTestRuns(companyId, skillId)).toHaveLength(0);
    expect(await svc.getTestRunDetail(companyId, skillId, run.id)).toBeNull();

    // Deleting again is a no-op 404 (returns null).
    expect(
      await svc.deleteTestRun(companyId, skillId, run.id, { hideHarnessIssue: async () => null }),
    ).toBeNull();
  });

  it("re-run pins an explicit skill version instead of the live head", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const first = await svc.createTestRun(
      companyId,
      skillId,
      { content: "first run", agentId },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );
    const pinnedVersionId = first.skillVersionId;

    const reRun = await svc.createTestRun(
      companyId,
      skillId,
      { content: "first run", agentId, skillVersionId: pinnedVersionId },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );
    expect(reRun.skillVersionId).toBe(pinnedVersionId);

    // A bogus version id is rejected rather than silently falling back to head.
    await expect(
      svc.createTestRun(
        companyId,
        skillId,
        { content: "first run", agentId, skillVersionId: randomUUID() },
        { type: "user", userId: "local-board" },
        runDeps(companyId),
      ),
    ).rejects.toThrow(/skill version not found/i);
  });

  it("ignores superseded test harness issue transitions", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const first = await svc.createTestRun(
      companyId,
      skillId,
      { content: "first run", agentId },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );
    const replacement = await svc.createTestRun(
      companyId,
      skillId,
      { content: "replacement run", agentId },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );

    const listed = await svc.listTestRuns(companyId, skillId);
    expect(listed.map((run) => run.id)).toEqual([replacement.id, first.id]);
    expect(listed.find((run) => run.id === first.id)?.supersededAt).toBeInstanceOf(Date);
    expect(await svc.getTestRunDetail(companyId, skillId, first.id)).not.toBeNull();
    expect(await svc.markTestRunRunning(companyId, first.issueId)).toBeNull();
    expect(await svc.completeTestRunForIssue({
      companyId,
      issueId: first.issueId,
      outcome: "succeeded",
    })).toBeNull();
    const cancelledIssueIds: string[] = [];
    expect(await svc.cancelTestRun(companyId, skillId, first.id, {
      cancelHarnessIssue: async (issueId) => {
        cancelledIssueIds.push(issueId);
      },
    })).toBeNull();
    expect(cancelledIssueIds).toEqual([]);

    const firstRow = await db
      .select({
        status: companySkillTestRuns.status,
        error: companySkillTestRuns.error,
        supersededAt: companySkillTestRuns.supersededAt,
        outputSnapshot: companySkillTestRuns.outputSnapshot,
      })
      .from(companySkillTestRuns)
      .where(eq(companySkillTestRuns.id, first.id))
      .then((rows) => rows[0] ?? null);
    expect(firstRow?.status).toBe("cancelled");
    expect(firstRow?.error).toBe("Superseded by newer run");
    expect(firstRow?.supersededAt).toBeInstanceOf(Date);
    expect(firstRow?.outputSnapshot).toBe("");

    const hiddenIssueIds: string[] = [];
    const deletedFirst = await svc.deleteTestRun(companyId, skillId, first.id, {
      hideHarnessIssue: async (issueId) => {
        hiddenIssueIds.push(issueId);
      },
    });
    expect(deletedFirst?.id).toBe(first.id);
    expect(hiddenIssueIds).toEqual([first.issueId]);
    expect((await svc.listTestRuns(companyId, skillId)).map((run) => run.id)).toEqual([replacement.id]);

    const runningReplacement = await svc.markTestRunRunning(companyId, replacement.issueId);
    expect(runningReplacement?.status).toBe("running");
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
    expect(detail?.outputBody).toBe("## Result\n\nThe skill responded.");
    expect(detail?.harnessContent).toEqual({
      available: false,
      unavailableReason: "expired",
      documents: [],
      attachments: [],
      workProducts: [],
    });
  });

  it("hydrates rich documents, attachments, and work products scoped to the run's harness issue", async () => {
    const { companyId, skillId, agentId } = await seedSkillAndAgent();
    const run = await svc.createTestRun(
      companyId,
      skillId,
      { content: "produce rich output", agentId },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );
    // Sibling run in the same company whose content must not leak into `run`'s detail.
    const otherRun = await svc.createTestRun(
      companyId,
      skillId,
      { content: "unrelated run", agentId },
      { type: "user", userId: "local-board" },
      runDeps(companyId),
    );

    async function seedIssueContent(issueId: string, marker: string) {
      const documentId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: `Output ${marker}`,
        format: "markdown",
        latestBody: `## Result ${marker}`,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "output" });
      const assetId = randomUUID();
      await db.insert(assets).values({
        id: assetId,
        companyId,
        provider: "local",
        objectKey: `skill-tests/${marker}.png`,
        contentType: "image/png",
        byteSize: 2048,
        sha256: marker.repeat(8).slice(0, 64).padEnd(64, "0"),
        originalFilename: `${marker}.png`,
        createdByAgentId: agentId,
      });
      const attachmentId = randomUUID();
      await db.insert(issueAttachments).values({ id: attachmentId, companyId, issueId, assetId });
      const workProductId = randomUUID();
      await db.insert(issueWorkProducts).values({
        id: workProductId,
        companyId,
        issueId,
        type: "artifact",
        provider: "paperclip",
        title: `Artifact ${marker}`,
        status: "active",
        summary: `Generated ${marker}`,
        metadata: {
          attachmentId,
          contentType: "image/png",
          byteSize: 2048,
          contentPath: `/api/attachments/${attachmentId}/content`,
          originalFilename: `${marker}.png`,
        },
      });
      return { documentId, attachmentId, workProductId };
    }

    const mine = await seedIssueContent(run.issueId, "mine");
    await seedIssueContent(otherRun.issueId, "other");

    const detail = await svc.getTestRunDetail(companyId, skillId, run.id);
    expect(detail).not.toBeNull();
    expect(detail?.harnessContent.available).toBe(true);
    expect(detail?.harnessContent.unavailableReason).toBeNull();

    expect(detail?.harnessContent.documents).toHaveLength(1);
    const doc = detail!.harnessContent.documents[0]!;
    expect(doc).toEqual(expect.objectContaining({
      id: mine.documentId,
      companyId,
      issueId: run.issueId,
      key: "output",
      title: "Output mine",
      format: "markdown",
      body: "## Result mine",
      createdByAgentId: agentId,
    }));
    expect(typeof doc.latestRevisionNumber).toBe("number");
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
    expect("sourceTrust" in doc).toBe(true);

    expect(detail?.harnessContent.attachments).toHaveLength(1);
    const attachment = detail!.harnessContent.attachments[0]!;
    expect(attachment).toEqual(expect.objectContaining({
      id: mine.attachmentId,
      companyId,
      issueId: run.issueId,
      contentType: "image/png",
      byteSize: 2048,
      originalFilename: "mine.png",
      contentPath: `/api/attachments/${mine.attachmentId}/content`,
      openPath: `/api/attachments/${mine.attachmentId}/content`,
      downloadPath: `/api/attachments/${mine.attachmentId}/content?download=1`,
    }));

    expect(detail?.harnessContent.workProducts).toHaveLength(1);
    const workProduct = detail!.harnessContent.workProducts[0]!;
    expect(workProduct).toEqual(expect.objectContaining({
      id: mine.workProductId,
      companyId,
      issueId: run.issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Artifact mine",
      summary: "Generated mine",
    }));
    expect(workProduct.metadata).toEqual(expect.objectContaining({
      attachmentId: mine.attachmentId,
      contentType: "image/png",
      byteSize: 2048,
      originalFilename: "mine.png",
    }));

    // Compatibility summaries stay in sync with the rich collections.
    expect(detail?.documents).toEqual([
      expect.objectContaining({ key: "output", title: "Output mine", body: "## Result mine" }),
    ]);
    expect(detail?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mine.attachmentId, kind: "attachment", title: "mine.png" }),
      expect.objectContaining({ id: mine.workProductId, kind: "work_product", title: "Artifact mine" }),
    ]));
    expect(detail?.artifacts).toHaveLength(2);
  });

  it("keeps hydration company-scoped and reports a deleted harness issue", async () => {
    const first = await seedSkillAndAgent();
    const second = await seedSkillAndAgent();
    const run = await svc.createTestRun(
      first.companyId,
      first.skillId,
      { content: "scoped run", agentId: first.agentId },
      { type: "user", userId: "local-board" },
      runDeps(first.companyId),
    );

    // Cross-company access never resolves another company's run.
    expect(await svc.getTestRunDetail(second.companyId, first.skillId, run.id)).toBeNull();
    expect(await svc.getTestRunDetail(second.companyId, second.skillId, run.id)).toBeNull();

    // Harness issue marked deleted outside the retention path -> clear "deleted"
    // state, while stored run snapshots stay usable.
    await db
      .update(companySkillTestRuns)
      .set({ harnessIssueDeletedAt: new Date() })
      .where(eq(companySkillTestRuns.id, run.id));
    const detail = await svc.getTestRunDetail(first.companyId, first.skillId, run.id);
    expect(detail).not.toBeNull();
    expect(detail?.harnessIssue).toBeNull();
    expect(detail?.inputSnapshot).toBe("scoped run");
    expect(detail?.harnessContent).toEqual({
      available: false,
      unavailableReason: "deleted",
      documents: [],
      attachments: [],
      workProducts: [],
    });
  });
});
