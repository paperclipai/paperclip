import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("closed-task interaction attention", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-closed-task-attention-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it("excludes unresolvable closed-task requests while retaining historical questions on done tasks", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Closed task attention", issuePrefix: "CLS" });
    await db.insert(agents).values({ id: workerId, companyId, name: "Worker", adapterType: "codex_local", status: "idle" });
    const expectedIds: string[] = [];
    const expectedQuestionIds: string[] = [];
    const expectedTaskIds: string[] = [];
    const issueIds: string[] = [];
    for (const status of ["in_progress", "done", "cancelled"]) {
      for (const historical of [false, true]) {
        const issueId = randomUUID();
        await db.insert(issues).values({ id: issueId,
          companyId, identifier: `CLS-${issueIds.length + 1}`, title: "Pending requests",
          status, assigneeAgentId: workerId,
        });
        issueIds.push(issueId);
        for (const kind of ["ask_user_questions", "request_confirmation"] as const) {
          const id = randomUUID();
          await db.insert(issueThreadInteractions).values({
            id, companyId, issueId, kind, status: "pending", createdByAgentId: workerId,
            payload: { version: 1, questions: [] },
            createdAt: new Date("2026-08-01T10:00:00Z"),
          });
          if (status === "in_progress" || (status === "done" && historical && kind === "ask_user_questions")) {
            expectedIds.push(id);
            expectedTaskIds.push(issueId);
            if (kind === "ask_user_questions") expectedQuestionIds.push(id);
          }
        }
        if (historical) await db.insert(issueComments).values({
          companyId, issueId, authorUserId: "board-user", authorType: "user", body: "Continue with the current plan.",
          createdAt: new Date("2026-08-01T11:00:00Z"),
        });
      }
    }
    const svc = attentionService(db);
    const options = { userId: "board-user" };
    const feed = await svc.list(companyId, options);
    expect(feed.items.filter(item => item.sourceKind === "issue_thread_interaction").map(item => item.subject.id).sort())
      .toEqual(expectedIds.sort());
    const summary = await svc.summary(companyId, options);
    expect(summary.countsBySourceKind.issue_thread_interaction).toBe(expectedIds.length);
    const index = await svc.taskIndex(companyId, options);
    expect(index.taskIds.sort()).toEqual([...new Set(expectedTaskIds)].sort());
    const questions = await svc.taskQuestions(companyId, issueIds, {
      ...options,
      actor: { type: "board", source: "local_implicit", userId: "board-user", companyIds: [companyId], isInstanceAdmin: false },
    });
    expect(questions.map(item => item.subject.id).sort()).toEqual(expectedQuestionIds.sort());
  });
});
