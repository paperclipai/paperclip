import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "authorized continuation context",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    const companyId = randomUUID(),
      agentId = randomUUID(),
      issueId = randomUUID(),
      runId = randomUUID();
    const gmailId = randomUUID(),
      notionId = randomUUID(),
      laterId = randomUUID(),
      interactionId = randomUUID();
    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-continuation-context-",
      );
      db = createDb(database.connectionString);
      await db
        .insert(companies)
        .values({ id: companyId, name: "Continuation", issuePrefix: "CTX" });
      await db
        .insert(agents)
        .values({
          id: agentId,
          companyId,
          name: "Executor",
          role: "engineer",
          adapterType: "paperclip_runner",
        });
      await db
        .insert(issues)
        .values({
          id: issueId,
          companyId,
          title: "Read Notion",
          status: "in_progress",
          assigneeAgentId: agentId,
        });
      await db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId,
          agentId,
          status: "failed",
          contextSnapshot: { issueId, commentId: gmailId },
        });
      await db.insert(issueComments).values([
        {
          id: notionId,
          companyId,
          issueId,
          authorType: "user",
          authorUserId: "local-board",
          body: "Read my Notion launch notes.",
          createdAt: new Date("2026-09-08T10:00:00Z"),
        },
        {
          id: gmailId,
          companyId,
          issueId,
          authorType: "user",
          authorUserId: "local-board",
          body: "Now summarize my recent Gmail emails.",
          createdAt: new Date("2026-09-08T10:01:00Z"),
        },
        {
          id: laterId,
          companyId,
          issueId,
          authorType: "user",
          authorUserId: "another-user",
          body: "Focus the Gmail summary on launch decisions.",
          createdAt: new Date("2026-09-08T10:02:00Z"),
        },
      ]);
      await db
        .insert(issueThreadInteractions)
        .values({
          id: interactionId,
          companyId,
          issueId,
          kind: "connection_intent",
          status: "accepted",
          sourceRunId: runId,
          originCommentIds: [gmailId],
          payload: {
            version: 1,
            serviceSlug: "gmail",
            serviceName: "Gmail",
            serviceLogoUrl: null,
            requestingAgentId: agentId,
            requestingAgentName: "Executor",
            phase: "requested",
          },
          result: {
            version: 1,
            outcome: "connected",
            connectionId: randomUUID(),
          },
        });
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
    });
    const build = () =>
      buildExecutionContinuation({
        db,
        companyId,
        issueId,
        agentId,
        context: { interactionId, wakeReason: "connection_intent.resolved" },
        summary: "Notion read completed.",
        exposeLowTrustRaw: false,
      });
    it("retains delivered Gmail origin and later direction after Notion completion", async () => {
      const context = await build();
      expect(context.originCommentIds).toContain(gmailId);
      expect(context.objective).toBe(
        "Focus the Gmail summary on launch decisions.",
      );
      expect(context.messages.map((row) => row.id)).toEqual([
        notionId,
        gmailId,
        laterId,
      ]);
      expect(context.messages.at(-1)?.authorId).toBe("another-user");
      for (const resumedSession of [false, true]) {
        const prompt = renderPaperclipWakePrompt(
          {
            issue: { id: issueId, title: "Read Notion" },
            executionContinuation: context,
          },
          { resumedSession },
        );
        expect(prompt).toContain("Now summarize my recent Gmail emails.");
        expect(prompt).toContain(
          "Focus the Gmail summary on launch decisions.",
        );
        expect(prompt).toContain("summaryThroughCommentId");
      }
    });
    it("re-reads edited and deleted source messages without reviving stale instructions", async () => {
      const delivered = await build();
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { issueId, executionContinuation: delivered } })
        .where(eq(heartbeatRuns.id, runId));
      await db
        .update(issueComments)
        .set({
          body: "Ignore launch notes; read today's Gmail inbox.",
          updatedAt: new Date(),
        })
        .where(eq(issueComments.id, gmailId));
      await db
        .update(issueComments)
        .set({ deletedAt: new Date() })
        .where(eq(issueComments.id, laterId));
      const context = await build();
      expect(context.objective).toBe(
        "Ignore launch notes; read today's Gmail inbox.",
      );
      expect(context.messages.at(-1)).toMatchObject({
        id: laterId,
        deleted: true,
        body: "",
      });
      const resumed = await buildExecutionContinuation({
        db,
        companyId,
        issueId,
        agentId,
        previousContextRunId: runId,
        context: { interactionId },
        summary: null,
        exposeLowTrustRaw: false,
      });
      expect(resumed.resumeDelta?.messages.map((row) => row.id)).toEqual([
        gmailId,
        laterId,
      ]);
      const deltaPrompt = renderPaperclipWakePrompt(
        { executionContinuation: resumed },
        { resumedSession: true },
      );
      expect(deltaPrompt).toContain("task_history_delta");
      expect(deltaPrompt).not.toContain("Read my Notion launch notes.");
      const freshPrompt = renderPaperclipWakePrompt(
        { executionContinuation: resumed },
        { resumedSession: false },
      );
      expect(freshPrompt).toContain("Read my Notion launch notes.");
      expect(freshPrompt).not.toContain('"resumeDelta"');
    });
    it("fails closed when required originating context is missing", async () => {
      await expect(
        buildExecutionContinuation({
          db,
          companyId,
          issueId,
          agentId,
          context: { commentId: randomUUID() },
          summary: null,
          exposeLowTrustRaw: false,
        }),
      ).rejects.toThrow("continuation_source_context_missing");
    });
    it("rejects another company and an invalidated task owner", async () => {
      await expect(
        buildExecutionContinuation({
          db,
          companyId: randomUUID(),
          issueId,
          agentId,
          context: {},
          summary: null,
          exposeLowTrustRaw: false,
        }),
      ).rejects.toThrow("continuation_task_ownership_changed");
      await expect(
        buildExecutionContinuation({
          db,
          companyId,
          issueId,
          agentId: randomUUID(),
          context: {},
          summary: null,
          exposeLowTrustRaw: false,
        }),
      ).rejects.toThrow("continuation_task_ownership_changed");
    });
  },
);
