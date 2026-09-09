import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies, createDb, issues, issueThreadInteractions,
  startEmbeddedPostgresTestDatabase,
  type Db, type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { normalizeQuestionDraftAnswers, questionDraftService } from "./question-drafts.js";

const QUESTIONS = [
  { id: "single", prompt: "Pick one", selectionMode: "single" as const, required: true, allowOther: false,
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  { id: "multi", prompt: "Pick many", selectionMode: "multi" as const, allowOther: true,
    options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
];

describe("draft answer validation", () => {
  it("preserves incomplete answers and exact in-progress text", () => {
    const answers = [
      { questionId: "single", optionIds: [] },
      { questionId: "multi", optionIds: ["x"], otherText: "  note\n  " },
    ];
    expect(normalizeQuestionDraftAnswers({ questions: QUESTIONS, answers })).toEqual(answers);
  });

  it.each([
    [{ questionId: "unknown", optionIds: [] }],
    [{ questionId: "single", optionIds: ["unknown"] }],
    [{ questionId: "single", optionIds: ["a", "b"] }],
    [{ questionId: "single", optionIds: ["a"], otherText: "not allowed" }],
    [{ questionId: "single", optionIds: ["a"] }, { questionId: "single", optionIds: ["b"] }],
  ].map(answers => [answers]))("rejects answers that the immutable form cannot represent: %j", answers => {
    expect(() => normalizeQuestionDraftAnswers({ questions: QUESTIONS, answers })).toThrow();
  });
});

describe("private questionnaire drafts against PostgreSQL", () => {
  let database: EmbeddedPostgresTestDatabase | undefined;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-question-drafts-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const interaction = { id: randomUUID(), payload: { version: 1 as const, questions: QUESTIONS } };
    await db.insert(companies).values({ id: companyId, name: "Draft test", issuePrefix: companyId.slice(0, 8) });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic questionnaire" });
    await db.insert(issueThreadInteractions).values({
      id: interaction.id, companyId, issueId, kind: "ask_user_questions", status: "pending",
      payload: interaction.payload,
    });
    return { companyId, issueId, interaction, userId: "human-a" };
  }

  it("admits only one concurrent writer at each revision, including first creation", async () => {
    const scope = await fixture();
    const service = questionDraftService(db);
    for (const expectedRevision of [0, 1]) {
      const results = await Promise.allSettled(["a", "b"].map(option => service.upsert({
        ...scope,
        input: { expectedRevision, answers: [{ questionId: "single", optionIds: [option] }] },
      })));
      const accepted = results.filter(result => result.status === "fulfilled");
      const rejected = results.filter(result => result.status === "rejected");
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ status: 409 });
      const saved = await service.get({ ...scope, interactionId: scope.interaction.id });
      expect(saved?.revision).toBe(expectedRevision + 1);
      expect(saved?.answers).toEqual(accepted[0].value.answers);
    }
  });

  it("isolates reads, writes and deletion by human, issue and company", async () => {
    const scope = await fixture();
    const service = questionDraftService(db);
    for (const [userId, option] of [["human-a", "a"], ["human-b", "b"]]) {
      await service.upsert({ ...scope, userId,
        input: { expectedRevision: 0, answers: [{ questionId: "single", optionIds: [option] }] },
      });
    }
    const identity = { ...scope, interactionId: scope.interaction.id };
    expect(await service.get({ ...identity, companyId: randomUUID() })).toBeNull();
    expect(await service.get({ ...identity, issueId: randomUUID() })).toBeNull();
    expect(await service.remove({ ...identity, companyId: randomUUID() })).toBe(false);
    await service.remove(identity);
    expect(await service.get(identity)).toBeNull();
    expect((await service.get({ ...identity, userId: "human-b" }))?.answers)
      .toEqual([{ questionId: "single", optionIds: ["b"] }]);
  });

  it("does not save after a native answer closes the interaction", async () => {
    const scope = await fixture();
    const service = questionDraftService(db);
    await db.update(issueThreadInteractions).set({ status: "answered" })
      .where(eq(issueThreadInteractions.id, scope.interaction.id));
    await expect(service.upsert({ ...scope, input: { expectedRevision: 0, answers: [] } }))
      .rejects.toMatchObject({ status: 409 });
    expect(await service.get({ ...scope, interactionId: scope.interaction.id })).toBeNull();
  });
});
