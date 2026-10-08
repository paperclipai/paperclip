import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { askUserQuestionsPayloadSchema, createIssueThreadInteractionSchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const question = {
  id: "verify",
  prompt: "Commit with --no-verify, or fix the TS errors first?",
  selectionMode: "single" as const,
  required: true,
  options: [
    { id: "fix_first", label: "Fix TS errors first" },
    { id: "no_verify", label: "Commit with --no-verify" },
  ],
};

describe("ask_user_questions default response (#4022)", () => {
  describe("payload validation", () => {
    const base = { version: 1 as const, questions: [question] };

    it("accepts a default that answers every required question", () => {
      const parsed = askUserQuestionsPayloadSchema.safeParse({
        ...base,
        defaultResponse: { timeoutMinutes: 60, answers: [{ questionId: "verify", optionIds: ["fix_first"] }] },
      });
      expect(parsed.success).toBe(true);
    });

    it.each([
      ["unknown question", { timeoutMinutes: 60, answers: [{ questionId: "nope", optionIds: ["fix_first"] }] }],
      ["unknown option", { timeoutMinutes: 60, answers: [{ questionId: "verify", optionIds: ["nope"] }] }],
      ["two options on single-select", {
        timeoutMinutes: 60, answers: [{ questionId: "verify", optionIds: ["fix_first", "no_verify"] }],
      }],
      ["timeout below the minimum", { timeoutMinutes: 1, answers: [{ questionId: "verify", optionIds: ["fix_first"] }] }],
    ])("rejects a default with %s", (_label, defaultResponse) => {
      expect(askUserQuestionsPayloadSchema.safeParse({ ...base, defaultResponse }).success).toBe(false);
    });

    it("rejects a default that leaves a required question unanswered", () => {
      const parsed = askUserQuestionsPayloadSchema.safeParse({
        version: 1,
        questions: [question, { ...question, id: "second" }],
        defaultResponse: { timeoutMinutes: 60, answers: [{ questionId: "verify", optionIds: ["fix_first"] }] },
      });
      expect(parsed.success).toBe(false);
    });

    it("keeps defaultResponse through the create-interaction schema agents call", () => {
      const parsed = createIssueThreadInteractionSchema.parse({
        kind: "ask_user_questions",
        continuationPolicy: "wake_assignee",
        payload: {
          ...base,
          defaultResponse: { timeoutMinutes: 60, answers: [{ questionId: "verify", optionIds: ["fix_first"] }] },
        },
      });
      expect(parsed.kind === "ask_user_questions" && parsed.payload.defaultResponse).toEqual({
        timeoutMinutes: 60,
        answers: [{ questionId: "verify", optionIds: ["fix_first"] }],
      });
    });
  });

  describe("sweepExpiredQuestionDefaults", () => {
    let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      temporary = await startEmbeddedPostgresTestDatabase("question-default-response-");
      db = createDb(temporary.connectionString);
    }, 90_000);
    afterAll(async () => { await temporary?.cleanup(); });

    const createdAt = new Date("2026-01-01T12:00:00Z");
    const minutesAfter = (minutes: number) => new Date(createdAt.getTime() + minutes * 60_000);

    async function fixture(opts: { withDefault?: boolean; issueStatus?: string } = {}) {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Defaults", issuePrefix: `D${companyId.slice(0, 8)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process", status: "active" });
      await db.insert(issues).values({
        id: issueId, companyId, title: "Ship it", status: opts.issueStatus ?? "in_progress", assigneeAgentId: agentId,
      });
      const [row] = await db.insert(issueThreadInteractions).values({
        companyId, issueId, kind: "ask_user_questions", status: "pending", createdByAgentId: agentId,
        effectiveResolverPolicy: "human_only", createdAt,
        payload: {
          version: 1, questions: [question],
          ...(opts.withDefault === false ? {} : {
            defaultResponse: { timeoutMinutes: 60, answers: [{ questionId: "verify", optionIds: ["fix_first"] }] },
          }),
        },
      }).returning();
      return { companyId, issueId, interactionId: row!.id };
    }

    const status = async (id: string) =>
      (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0]!;
    const deliveries = async (interactionId: string) =>
      db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, interactionId));

    it("does nothing before the timeout", async () => {
      const f = await fixture();
      const result = await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(59));
      expect(result.applied).not.toContain(f.interactionId);
      expect((await status(f.interactionId)).status).toBe("pending");
      expect(await deliveries(f.interactionId)).toHaveLength(0);
    });

    it("answers with the declared default after the timeout and queues delivery to the agent", async () => {
      const f = await fixture();
      const result = await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(61));
      expect(result.applied).toContain(f.interactionId);
      const row = await status(f.interactionId);
      expect(row.status).toBe("answered");
      expect(row.result).toMatchObject({
        outcome: "default_applied",
        answers: [{ questionId: "verify", optionIds: ["fix_first"] }],
      });
      expect(row.resolvedByUserId).toBeNull();
      expect(await deliveries(f.interactionId)).toHaveLength(1);

      // Idempotent: a second sweep must not re-answer or queue a second delivery.
      const again = await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(120));
      expect(again.applied).not.toContain(f.interactionId);
      expect(await deliveries(f.interactionId)).toHaveLength(1);
    });

    it("never touches questions without a declared default", async () => {
      const f = await fixture({ withDefault: false });
      await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(60 * 24 * 365));
      expect((await status(f.interactionId)).status).toBe("pending");
    });

    it("skips questions on closed tasks", async () => {
      const f = await fixture({ issueStatus: "done" });
      await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(61));
      expect((await status(f.interactionId)).status).toBe("pending");
      expect(await deliveries(f.interactionId)).toHaveLength(0);
    });
  });
});
