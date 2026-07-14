import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  summarySlots,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { summarySlotService } from "../services/summary-slots.ts";
import { withBuiltInAgentMarker } from "../services/built-in-agent-metadata.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres summary-slot tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("summary slot service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-summary-slots-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(summarySlots);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedProject(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Paperclip App" });
    return projectId;
  }

  async function seedSummarizer(companyId: string, ready = true) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: ready ? { model: "gpt-5.4" } : {},
      metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }),
    });
    return agentId;
  }

  async function seedPlainAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    return runId;
  }

  function projectSelector(companyId: string, projectId: string) {
    return { companyId, scopeKind: "project", slotKey: "header", scopeId: projectId };
  }

  describe("reads and target visibility", () => {
    it("returns an empty slot state before any generation", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const svc = summarySlotService(db);
      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result).toEqual({ slot: null, document: null, generatingIssue: null });
    });

    it("rejects targets that do not exist in the company", async () => {
      const companyId = await seedCompany();
      const svc = summarySlotService(db);
      await expect(svc.getSlot(projectSelector(companyId, randomUUID()))).rejects.toMatchObject({
        status: 404,
      });
    });

    it("rejects a project owned by another company (company scoping)", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const foreignProjectId = await seedProject(otherCompanyId);
      const svc = summarySlotService(db);
      await expect(svc.getSlot(projectSelector(companyId, foreignProjectId))).rejects.toMatchObject({
        status: 404,
      });
    });

    it("rejects a workspaces_overview selector that carries a scopeId", async () => {
      const companyId = await seedCompany();
      const svc = summarySlotService(db);
      await expect(
        svc.getSlot({ companyId, scopeKind: "workspaces_overview", slotKey: "header", scopeId: randomUUID() }),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("generate", () => {
    it("fails when the Summarizer built-in is not configured", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const svc = summarySlotService(db);
      await expect(
        svc.generate(projectSelector(companyId, projectId), { userId: "board-user" }),
      ).rejects.toMatchObject({ status: 422, details: { code: "summarizer_not_configured" } });
    });

    it("creates a summarizer task, links it, and marks the slot generating", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const result = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });

      expect(result.alreadyGenerating).toBe(false);
      expect(result.slot.status).toBe("generating");
      expect(result.slot.generatingIssueId).toBe(result.generatingIssue.id);

      const issueRow = await db
        .select()
        .from(issues)
        .where(eq(issues.id, result.generatingIssue.id))
        .then((rows) => rows[0]!);
      expect(issueRow.assigneeAgentId).toBe(summarizerAgentId);
      expect(issueRow.companyId).toBe(companyId);
      expect(issueRow.description).toContain(
        '"generationIssueId": "' + result.generatingIssue.id + '"',
      );
      expect(issueRow.description).toContain("`## Needs you`, `## Next`, and `## Since last summary`");
    });

    it("dedupes duplicate generate clicks while a generation is active", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const first = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      const second = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });

      expect(first.alreadyGenerating).toBe(false);
      expect(second.alreadyGenerating).toBe(true);
      expect(second.generatingIssue.id).toBe(first.generatingIssue.id);

      const issueRows = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(issueRows).toHaveLength(1);
    });

    it("creates a fresh task once the previous generation task is terminal", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const first = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.generatingIssue.id));

      const second = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      expect(second.alreadyGenerating).toBe(false);
      expect(second.generatingIssue.id).not.toBe(first.generatingIssue.id);

      const issueRows = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(issueRows).toHaveLength(2);
    });
  });

  describe("summarizer writes", () => {
    async function startGeneration(companyId: string, projectId: string, summarizerAgentId: string) {
      const svc = summarySlotService(db);
      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      const runId = await seedRun(companyId, summarizerAgentId);
      // Simulate the summarizer run checking out its linked generation task.
      await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, generated.generatingIssue.id));
      return { svc, generationIssueId: generated.generatingIssue.id, runId };
    }

    it("writes a board-readable revision, preserves the previous revision, and clears the generating state", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { svc, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      const initial = await svc.write(
        {
          ...projectSelector(companyId, projectId),
          markdown:
            "## Needs you\nNothing is waiting on you right now.\n\n## Next\nNothing is next.\n\n## Since last summary\nFirst summary for this scope.",
          model: "cheap-model",
        },
        { agentId: summarizerAgentId, runId },
      );

      const nextGeneration = await svc.generate(projectSelector(companyId, projectId), {
        userId: "board-user",
      });
      const nextRunId = await seedRun(companyId, summarizerAgentId);
      await db
        .update(issues)
        .set({ checkoutRunId: nextRunId })
        .where(eq(issues.id, nextGeneration.generatingIssue.id));
      const written = await svc.write(
        {
          ...projectSelector(companyId, projectId),
          markdown:
            "## Needs you\n- Review [T-123](/T/issues/T-123).\n\n## Next\n- Merge the approved change.\n\n## Since last summary\n- [T-123](/T/issues/T-123) entered review.",
          baseRevisionId: initial.revision.id,
          generationIssueId: nextGeneration.generatingIssue.id,
          model: "cheap-model",
        },
        { agentId: summarizerAgentId, runId: nextRunId },
      );

      expect(written.revision.revisionNumber).toBe(2);
      expect(written.document.body).toMatch(/^## Needs you\n[\s\S]*## Next\n[\s\S]*## Since last summary/m);
      expect(written.slot.status).toBe("idle");
      expect(written.slot.generatingIssueId).toBeNull();
      expect(written.slot.documentId).toBe(written.document.id);
      expect(written.slot.lastGeneratedByAgentId).toBe(summarizerAgentId);
      expect(written.slot.lastModel).toBe("cheap-model");

      const revisions = await svc.listRevisions(projectSelector(companyId, projectId));
      expect(revisions.revisions).toHaveLength(2);
      expect(revisions.revisions[0]!.id).toBe(written.revision.id);
      expect(revisions.revisions[1]!.id).toBe(initial.revision.id);
      expect(revisions.revisions[1]!.body).toContain("First summary for this scope.");
    });

    it("appends further revisions and enforces optimistic baseRevisionId", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { svc, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      const first = await svc.write(
        { ...projectSelector(companyId, projectId), markdown: "# Summary v1", generationIssueId: undefined },
        { agentId: summarizerAgentId, runId },
      );

      // A stale baseRevisionId must be rejected.
      const second = await summarySlotService(db).generate(projectSelector(companyId, projectId), {
        userId: "board-user",
      });
      const runId2 = await seedRun(companyId, summarizerAgentId);
      await db.update(issues).set({ checkoutRunId: runId2 }).where(eq(issues.id, second.generatingIssue.id));

      await expect(
        svc.write(
          {
            ...projectSelector(companyId, projectId),
            markdown: "# Summary v2",
            baseRevisionId: randomUUID(),
          },
          { agentId: summarizerAgentId, runId: runId2 },
        ),
      ).rejects.toMatchObject({ status: 409 });

      const ok = await svc.write(
        {
          ...projectSelector(companyId, projectId),
          markdown: "# Summary v2",
          baseRevisionId: first.revision.id,
        },
        { agentId: summarizerAgentId, runId: runId2 },
      );
      expect(ok.revision.revisionNumber).toBe(2);
    });

    it("rejects writes from a non-Summarizer agent", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const plainAgentId = await seedPlainAgent(companyId);
      const { svc, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      await expect(
        svc.write(
          { ...projectSelector(companyId, projectId), markdown: "# Sneaky" },
          { agentId: plainAgentId, runId },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("rejects Summarizer writes that do not run from the linked generation task", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      await startGeneration(companyId, projectId, summarizerAgentId);
      const svc = summarySlotService(db);

      await expect(
        svc.write(
          { ...projectSelector(companyId, projectId), markdown: "# Wrong run" },
          { agentId: summarizerAgentId, runId: randomUUID() },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("rejects writes when there is no active generation", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      await expect(
        svc.write(
          { ...projectSelector(companyId, projectId), markdown: "# No generation" },
          { agentId: summarizerAgentId, runId: randomUUID() },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
