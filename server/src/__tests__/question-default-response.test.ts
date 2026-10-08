import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
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

    async function fixture(opts: {
      withDefault?: boolean;
      issueStatus?: string;
      policy?: "anyone" | "human_only" | "not_creator";
      timeoutMinutes?: number;
      createdAt?: Date;
      addresseeUserId?: string;
      companyId?: string;
    } = {}) {
      const companyId = opts.companyId ?? randomUUID(), agentId = randomUUID(), issueId = randomUUID();
      if (!opts.companyId) {
        await db.insert(companies).values({ id: companyId, name: "Defaults", issuePrefix: `D${companyId.slice(0, 8)}` });
      }
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process", status: "active" });
      await db.insert(issues).values({
        id: issueId, companyId, title: "Ship it", status: opts.issueStatus ?? "in_progress", assigneeAgentId: agentId,
      });
      const [row] = await db.insert(issueThreadInteractions).values({
        companyId, issueId, kind: "ask_user_questions", status: "pending", createdByAgentId: agentId,
        effectiveResolverPolicy: opts.policy ?? "anyone", createdAt: opts.createdAt ?? createdAt,
        addresseeUserId: opts.addresseeUserId ?? null,
        payload: {
          version: 1, questions: [question],
          ...(opts.withDefault === false ? {} : {
            defaultResponse: {
              timeoutMinutes: opts.timeoutMinutes ?? 60,
              answers: [{ questionId: "verify", optionIds: ["fix_first"] }],
            },
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

    // Review finding 1: never auto-answer a question that must be resolved by a human
    // (including a company cap) or by a specific addressee.
    it.each(["human_only", "not_creator"] as const)("never applies a default to a %s question", async (policy) => {
      const f = await fixture({ policy });
      await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(61));
      expect((await status(f.interactionId)).status).toBe("pending");
      expect(await deliveries(f.interactionId)).toHaveLength(0);
    });

    it("never applies a default to a question addressed to a specific user", async () => {
      const f = await fixture({ addresseeUserId: "board-user" });
      await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(61));
      expect((await status(f.interactionId)).status).toBe("pending");
    });

    it("rejects creating a default under a company human_only cap", async () => {
      const companyId = randomUUID(), issueId = randomUUID();
      await db.insert(companies).values({
        id: companyId, name: "Capped", issuePrefix: `C${companyId.slice(0, 8)}`,
        interactionResolverGovernance: { ask_user_questions: { cap: "human_only" } },
      });
      await db.insert(issues).values({ id: issueId, companyId, title: "Capped task", status: "in_progress" });
      await expect(issueThreadInteractionService(db).create(
        { id: issueId, companyId },
        {
          kind: "ask_user_questions",
          payload: {
            version: 1, questions: [question],
            defaultResponse: { timeoutMinutes: 60, answers: [{ questionId: "verify", optionIds: ["fix_first"] }] },
          },
        },
        { userId: "board-user" },
      )).rejects.toMatchObject({ status: 422 });
    });

    // Review finding 2: long-timeout rows must not crowd a due short-timeout row out of the batch.
    it("applies a due short-timeout default even when 100+ older long-timeout defaults are pending", async () => {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Busy", issuePrefix: `B${companyId.slice(0, 8)}` });
      for (let i = 0; i < 105; i += 1) {
        await fixture({ companyId, timeoutMinutes: 30 * 24 * 60, createdAt: minutesAfter(-60 - i) });
      }
      const short = await fixture({ companyId, timeoutMinutes: 5, createdAt });
      const result = await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(6));
      expect(result.applied).toContain(short.interactionId);
      expect((await status(short.interactionId)).status).toBe("answered");
    });

    // Review finding 3: an empty answer to a required question is rejected up front.
    it("rejects a default with an empty answer for a required question", () => {
      const parsed = askUserQuestionsPayloadSchema.safeParse({
        version: 1, questions: [question],
        defaultResponse: { timeoutMinutes: 60, answers: [{ questionId: "verify", optionIds: [] }] },
      });
      expect(parsed.success).toBe(false);
    });

    // Review finding 4: a human reply after the question supersedes the agent's default.
    it("does not apply a default after a newer human reply on the task", async () => {
      const f = await fixture();
      const control = await fixture();
      await db.insert(issueComments).values({
        companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "board-user",
        body: "Fix the errors first, don't skip verification.", createdAt: minutesAfter(10),
      });
      const result = await issueThreadInteractionService(db).sweepExpiredQuestionDefaults(minutesAfter(61));
      // Control proves the sweep reached this batch; only the replied-to question is held back.
      expect(result.applied).toContain(control.interactionId);
      expect(result.applied).not.toContain(f.interactionId);
      expect((await status(f.interactionId)).status).toBe("pending");
      expect(await deliveries(f.interactionId)).toHaveLength(0);
    });
  });
});
