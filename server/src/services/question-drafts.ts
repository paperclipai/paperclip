import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueQuestionDrafts, issueThreadInteractions } from "@paperclipai/db";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  PutQuestionDraftRequest,
  QuestionDraftResponse,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

/**
 * Normalize partial draft answers against the interaction's immutable
 * question set. Unlike the submit path, required-question completeness is
 * NOT enforced — drafts may be incomplete — but unknown question/option ids,
 * duplicate answers, and multi-select violations are rejected so a restored
 * draft can never reference options the form does not render.
 */
export function normalizeQuestionDraftAnswers(args: {
  questions: AskUserQuestionsInteraction["payload"]["questions"];
  answers: readonly AskUserQuestionsAnswer[];
}): AskUserQuestionsAnswer[] {
  const questionById = new Map(args.questions.map((question) => [question.id, question] as const));
  const seen = new Set<string>();
  const normalized: AskUserQuestionsAnswer[] = [];

  for (const answer of args.answers) {
    const question = questionById.get(answer.questionId);
    if (!question) {
      throw unprocessable(`Unknown questionId: ${answer.questionId}`);
    }
    if (seen.has(answer.questionId)) {
      throw unprocessable(`Duplicate answer for questionId: ${answer.questionId}`);
    }
    seen.add(answer.questionId);

    const uniqueOptionIds = [...new Set(answer.optionIds)];
    const validOptionIds = new Set(question.options.map((option) => option.id));
    for (const optionId of uniqueOptionIds) {
      if (!validOptionIds.has(optionId)) {
        throw unprocessable(`Unknown optionId for question ${answer.questionId}: ${optionId}`);
      }
    }

    if (question.selectionMode === "single" && uniqueOptionIds.length > 1) {
      throw unprocessable(`Question ${answer.questionId} only allows one answer`);
    }

    const otherText = answer.otherText;
    if (otherText && question.allowOther === false && !question.options.some(option => option.freeText)) {
      throw unprocessable(`Question ${answer.questionId} does not accept a text answer`);
    }
    normalized.push({
      questionId: answer.questionId,
      optionIds: uniqueOptionIds,
      ...(otherText == null ? {} : { otherText }),
    });
  }

  return normalized;
}

function toDraftResponse(row: {
  interactionId: string;
  issueId: string;
  revision: number;
  answers: AskUserQuestionsAnswer[];
  updatedAt: Date;
}): QuestionDraftResponse {
  return {
    interactionId: row.interactionId,
    issueId: row.issueId,
    revision: row.revision,
    answers: row.answers,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function questionDraftService(db: Db) {
  async function findRow(
    connection: Pick<Db, "select">,
    args: { companyId: string; interactionId: string; userId: string },
  ) {
    return connection.select().from(issueQuestionDrafts).where(and(
      eq(issueQuestionDrafts.companyId, args.companyId),
      eq(issueQuestionDrafts.interactionId, args.interactionId),
      eq(issueQuestionDrafts.userId, args.userId),
    )).then(rows => rows[0] ?? null);
  }

  return {
    get: async (args: { companyId: string; issueId: string; interactionId: string; userId: string }) => {
      const [row] = await db.select({ draft: issueQuestionDrafts }).from(issueQuestionDrafts)
        .innerJoin(issueThreadInteractions, eq(issueThreadInteractions.id, issueQuestionDrafts.interactionId))
        .where(and(
          eq(issueQuestionDrafts.companyId, args.companyId),
          eq(issueQuestionDrafts.issueId, args.issueId),
          eq(issueQuestionDrafts.interactionId, args.interactionId),
          eq(issueQuestionDrafts.userId, args.userId),
          eq(issueThreadInteractions.status, "pending"),
        ));
      return row ? toDraftResponse(row.draft) : null;
    },

    upsert: async (args: {
      companyId: string;
      issueId: string;
      interaction: Pick<AskUserQuestionsInteraction, "id" | "payload">;
      userId: string;
      input: PutQuestionDraftRequest;
    }) => db.transaction(async tx => {
      // Serialize draft writes with each other AND native submit/cancel. A
      // route-level pending check cannot protect a delayed database write.
      const [current] = await tx.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, args.interaction.id),
        eq(issueThreadInteractions.companyId, args.companyId),
        eq(issueThreadInteractions.issueId, args.issueId),
      )).for("update");
      if (!current || current.kind !== "ask_user_questions" || current.status !== "pending") {
        throw conflict("Question is no longer pending; drafts are closed", { code: "question_draft_terminal" });
      }
      const normalized = normalizeQuestionDraftAnswers({
        questions: args.interaction.payload.questions,
        answers: args.input.answers,
      });
      const existing = await findRow(tx, {
        companyId: args.companyId,
        interactionId: args.interaction.id,
        userId: args.userId,
      });
      const revision = existing?.revision ?? 0;
      if (args.input.expectedRevision !== revision) {
        throw conflict("Question draft was updated elsewhere; reload before saving", {
          code: "question_draft_revision_conflict",
          currentRevision: revision,
        });
      }
      const now = new Date();
      if (!existing) {
        const [row] = await tx.insert(issueQuestionDrafts).values({
          companyId: args.companyId,
          issueId: args.issueId,
          interactionId: args.interaction.id,
          userId: args.userId,
          answers: normalized,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }).returning();
        return toDraftResponse(row);
      }
      const [row] = await tx.update(issueQuestionDrafts)
        .set({ answers: normalized, revision: revision + 1, updatedAt: now })
        .where(eq(issueQuestionDrafts.id, existing.id)).returning();
      return toDraftResponse(row);
    }),

    remove: async (args: { companyId: string; issueId: string; interactionId: string; userId: string }) =>
      db.transaction(async tx => {
        await tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.id, args.interactionId),
          eq(issueThreadInteractions.companyId, args.companyId),
          eq(issueThreadInteractions.issueId, args.issueId),
        )).for("update");
        const deleted = await tx.delete(issueQuestionDrafts).where(and(
          eq(issueQuestionDrafts.companyId, args.companyId),
          eq(issueQuestionDrafts.issueId, args.issueId),
          eq(issueQuestionDrafts.interactionId, args.interactionId),
          eq(issueQuestionDrafts.userId, args.userId),
        )).returning({ id: issueQuestionDrafts.id });
        return deleted.length > 0;
      }),
  };
}
