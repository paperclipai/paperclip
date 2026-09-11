import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

const mockCreateChild = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
  }),
}));

type SelectRow = Record<string, unknown>;

function createSelectChain(rows: SelectRow[]) {
  return {
    from() {
      return {
        where() {
          return {
            then(callback: (rows: SelectRow[]) => unknown) {
              return Promise.resolve(callback(rows));
            },
          };
        },
      };
    },
  };
}

function createFakeDb(args: {
  interactionRow: Record<string, unknown>;
  parentRows?: SelectRow[];
}) {
  let interactionRow = { ...args.interactionRow };
  const issueTouches: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  const toolActionRequestUpdates: Array<Record<string, unknown>> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  let selectCallCount = 0;

  const db: any = {
    select: vi.fn(() => {
      selectCallCount += 1;
      return createSelectChain(selectCallCount === 1 ? [interactionRow] : (args.parentRows ?? []));
    }),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where() {
            if (getTableName(table as never) === "tool_action_requests") {
              toolActionRequestUpdates.push(values);
              return Promise.resolve(undefined);
            }
            if ("status" in values || "result" in values || "resolvedAt" in values) {
              interactionUpdates.push(values);
              interactionRow = { ...interactionRow, ...values };
              return {
                returning: async () => [interactionRow],
              };
            }
            if ("updatedAt" in values) {
              issueTouches.push(values);
              return Promise.resolve(undefined);
            }
            throw new Error(`Unexpected update target: ${String(table)}`);
          },
        };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(table as never), values });
      },
    })),
    transaction: async (callback: (tx: typeof db) => Promise<void>) => callback(db),
  };

  return {
    db,
    getInteractionRow: () => interactionRow,
    issueTouches,
    interactionUpdates,
    toolActionRequestUpdates,
    inserts,
  };
}

describe("issueThreadInteractionService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each([
    ["ask_user_questions", undefined, {}, "anyone", "anyone", "inherited", "requested"],
    ["suggest_tasks", undefined, {}, "anyone", "anyone", "inherited", "requested"],
    ["request_confirmation", "board_or_agents", {}, "anyone", "anyone", "explicit", "requested"],
    ["request_confirmation", "board_only", {}, "human_only", "human_only", "explicit", "requested"],
    ["request_checkbox_confirmation", undefined, { request_checkbox_confirmation: { defaultPolicy: "not_creator" } }, "not_creator", "not_creator", "inherited", "requested"],
    ["request_item_verdicts", "anyone", { request_item_verdicts: { cap: "not_creator" } }, "anyone", "not_creator", "explicit", "company_cap"],
  ] as const)(
    "resolves %s requested/default/cap policy snapshots",
    async (kind, requested, governance, expectedRequested, expectedEffective, expectedProvenance, expectedSource) => {
      const { resolveInteractionPolicy } = await import("./issue-thread-interactions.js");
      expect(resolveInteractionPolicy({
        kind,
        requested,
        governance,
        hasToolAction: false,
      })).toEqual({
        requestedResolverPolicy: expectedRequested,
        effectiveResolverPolicy: expectedEffective,
        resolverPolicyProvenance: expectedProvenance,
        effectiveResolverPolicySource: expectedSource,
      });
    },
  );

  it("always clamps tool-action confirmations to human-only", async () => {
    const { resolveInteractionPolicy } = await import("./issue-thread-interactions.js");
    expect(resolveInteractionPolicy({
      kind: "request_confirmation",
      requested: "board_or_agents",
      governance: { request_confirmation: { defaultPolicy: "board_or_agents", cap: "board_or_agents" } },
      hasToolAction: true,
    })).toEqual({
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "governed_action",
    });
  });

  it("clamps decision questions to human-only even when a wider default is inherited", async () => {
    const { resolveInteractionPolicy } = await import("./issue-thread-interactions.js");
    expect(resolveInteractionPolicy({
      kind: "ask_user_questions",
      requested: undefined,
      governance: { ask_user_questions: { defaultPolicy: "anyone" } },
      hasToolAction: false,
      hasDecisionQuestion: true,
    })).toEqual({
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "inherited",
      effectiveResolverPolicySource: "decision_question",
    });
    expect(resolveInteractionPolicy({
      kind: "ask_user_questions",
      requested: "human_only",
      governance: {},
      hasToolAction: false,
      hasDecisionQuestion: true,
    })).toEqual({
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "decision_question",
    });
  });

  it("leaves information-only question audiences untouched", async () => {
    const { resolveInteractionPolicy } = await import("./issue-thread-interactions.js");
    expect(resolveInteractionPolicy({
      kind: "ask_user_questions",
      requested: undefined,
      governance: {},
      hasToolAction: false,
      hasDecisionQuestion: false,
    })).toEqual({
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "inherited",
      effectiveResolverPolicySource: "requested",
    });
  });

  const decisionPayload = {
    version: 1 as const,
    questions: [
      {
        id: "rollout",
        prompt: "Ship the change to all customers today?",
        selectionMode: "single" as const,
        required: true,
        intent: "decision" as const,
        recommendationRationale:
          "Staging is recommended because the migration is reversible there and the canary window is still open.",
        options: [
          { id: "staging", label: "Stage first", recommended: true },
          { id: "all-customers", label: "All customers now" },
        ],
      },
    ],
  };

  it("requires human_only for a decision question and accepts an omitted policy", async () => {
    const { resolveDecisionQuestionCreatePolicy } = await import("./issue-thread-interactions.js");
    expect(resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      payload: decisionPayload,
    })).toEqual({ hasDecisionQuestion: true, requestedResolverPolicy: "human_only" });
    expect(resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      resolverPolicy: "human_only",
      payload: decisionPayload,
    })).toEqual({ hasDecisionQuestion: true, requestedResolverPolicy: "human_only" });

    expect(() => resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      resolverPolicy: "anyone",
      payload: decisionPayload,
    })).toThrow(/human_only/);
    expect(() => resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      resolverPolicy: "not_creator",
      payload: decisionPayload,
    })).toThrow(/human_only/);

    // An information interview keeps whatever audience its author asked for.
    expect(resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      resolverPolicy: "not_creator",
      payload: {
        version: 1,
        questions: [
          {
            id: "notes",
            prompt: "Anything the reviewer should know?",
            selectionMode: "single",
            required: false,
            options: [{ id: "none", label: "Nothing to add" }],
          },
        ],
      },
    })).toEqual({ hasDecisionQuestion: false, requestedResolverPolicy: "not_creator" });
  });

  it("does not let a plain comment supersede a pending decision", async () => {
    const { normalizeCreateInteractionInput } = await import("./issue-thread-interactions.js");
    // `normalizeCreateInteractionInput` takes the parsed create shape, so these
    // fixtures carry the schema's `continuationPolicy` default explicitly.
    const normalized = normalizeCreateInteractionInput({
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: decisionPayload,
    });
    expect(normalized.kind).toBe("ask_user_questions");
    if (normalized.kind !== "ask_user_questions") return;
    expect(normalized.payload.supersedeOnUserComment).toBe(false);

    // Information forms keep the historical comment-supersede default.
    const information = normalizeCreateInteractionInput({
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questions: [
          {
            id: "notes",
            prompt: "Anything the reviewer should know?",
            selectionMode: "single",
            options: [{ id: "none", label: "Nothing to add" }],
          },
        ],
      },
    });
    if (information.kind !== "ask_user_questions") return;
    expect(information.payload.supersedeOnUserComment).toBe(true);
  });

  // The bypass this guards against: a payload that shows a decision in the
  // canonical presentation (which the cards prefer) while the mirror — the
  // shape the create guard used to read — stays silent, then asks for an open
  // audience and comment-supersede.
  const canonicalDecisionOnlyPayload = {
    version: 1 as const,
    supersedeOnUserComment: true,
    questions: [
      {
        id: "rollout",
        prompt: "Ship the migration to all customers today?",
        selectionMode: "single" as const,
        required: true,
        options: [
          { id: "staging", label: "Stage first" },
          { id: "all-customers", label: "All customers now" },
        ],
      },
    ],
    questionSet: {
      schema: "paperclip.question_set.v1" as const,
      questions: [
        {
          id: "rollout",
          prompt: "Ship the migration to all customers today?",
          required: true,
          answerMode: "single_select" as const,
          intent: "decision" as const,
          recommendationRationale: "Staging is safer while the canary window is open.",
          options: [
            { id: "staging", label: "Stage first", recommended: true },
            { id: "all-customers", label: "All customers now" },
          ],
        },
      ],
    },
  };

  it("reads a decision from either stored presentation and fails closed on a mismatch", async () => {
    const { askUserQuestionsHasDecisionQuestion, resolveDecisionQuestionCreatePolicy } =
      await import("./issue-thread-interactions.js");

    expect(askUserQuestionsHasDecisionQuestion({
      questions: [{ id: "rollout", intent: "information" }],
      questionSet: canonicalDecisionOnlyPayload.questionSet,
    })).toBe(true);

    // Canonical says decision, mirror stays silent, wider audience requested:
    // rejected on the mismatch, before the audience is even considered.
    expect(() => resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      resolverPolicy: "anyone",
      payload: canonicalDecisionOnlyPayload,
    })).toThrow(/must declare intent "decision"/);

    // A canonical decision with no mirrored question cannot be answered.
    expect(() => resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      payload: {
        ...canonicalDecisionOnlyPayload,
        questions: [{
          id: "other",
          prompt: "Something else",
          selectionMode: "single" as const,
          options: [{ id: "a", label: "A" }],
        }],
      },
    })).toThrow(/has no matching question/);

    // The recommended option must be one the responder can actually select.
    expect(() => resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      payload: {
        ...canonicalDecisionOnlyPayload,
        questions: [
          {
            id: "rollout",
            prompt: "Ship the migration to all customers today?",
            selectionMode: "single" as const,
            required: true,
            intent: "decision" as const,
            recommendationRationale: "Staging is safer while the canary window is open.",
            options: [
              { id: "all-customers", label: "All customers now" },
              { id: "later", label: "Later" },
            ],
          },
        ],
      },
    })).toThrow(/recommends option staging which is missing/);

    // The mirror may not offer a choice the card never displays: a decision
    // answer must name a displayed option id.
    expect(() => resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      payload: {
        ...canonicalDecisionOnlyPayload,
        questions: [
          {
            id: "rollout",
            prompt: "Ship the migration to all customers today?",
            selectionMode: "single" as const,
            required: true,
            intent: "decision" as const,
            recommendationRationale: "Staging is safer while the canary window is open.",
            options: [
              { id: "staging", label: "Stage first" },
              { id: "all-customers", label: "All customers now" },
              { id: "hidden", label: "Hidden choice" },
            ],
          },
        ],
      },
    })).toThrow(/must mirror exactly the options/);
  });

  it("rejects the reverse mismatch where only the mirror declares the decision", async () => {
    const { resolveDecisionQuestionCreatePolicy } = await import("./issue-thread-interactions.js");
    const informationCanonical = {
      schema: "paperclip.question_set.v1" as const,
      questions: [
        {
          id: "rollout",
          prompt: "Ship the migration to all customers today?",
          required: true,
          answerMode: "single_select" as const,
          options: [
            { id: "staging", label: "Stage first" },
            { id: "all-customers", label: "All customers now" },
          ],
        },
      ],
    };

    // Mirror says decision, canonical presents the same question as information:
    // the card would render an information form while the server enforced a
    // decision.
    expect(() => resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: decisionPayload.questions,
        questionSet: informationCanonical,
      },
    })).toThrow(/is a decision in questions but not in questionSet/);
  });

  it("accepts a mirror-only decision only when no canonical set is present", async () => {
    const { resolveDecisionQuestionCreatePolicy } = await import("./issue-thread-interactions.js");

    // The original API: no `questionSet` at all. The mirror is the only
    // presentation, and the task-chat card synthesizes its set from the mirror.
    expect(resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      payload: decisionPayload,
    })).toEqual({ hasDecisionQuestion: true, requestedResolverPolicy: "human_only" });

    // A present questionSet is authoritative for display (`questionSetForInteraction`
    // returns it wholesale), so a decision it omits would be invisible in the
    // task-chat card while the server still enforced it.
    expect(() => resolveDecisionQuestionCreatePolicy({
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: decisionPayload.questions,
        questionSet: {
          schema: "paperclip.question_set.v1" as const,
          questions: [
            {
              id: "notes",
              prompt: "Anything else the release captain should know?",
              required: false,
              answerMode: "single_select" as const,
              options: [{ id: "none", label: "Nothing to add" }],
            },
          ],
        },
      },
    })).toThrow(/is missing from questionSet/);
  });

  it("keeps a stored decision human-only even when its frozen policy is open", async () => {
    const { shouldSupersedeInteractionOnUserComment, normalizeQuestionAnswers } =
      await import("./issue-thread-interactions.js");

    // A row written before the contract: open policy, comment-supersede on,
    // decision only in the canonical presentation.
    expect(shouldSupersedeInteractionOnUserComment({
      kind: "ask_user_questions",
      payload: canonicalDecisionOnlyPayload,
    })).toBe(false);

    expect(() => normalizeQuestionAnswers({
      questions: canonicalDecisionOnlyPayload.questions,
      questionSet: canonicalDecisionOnlyPayload.questionSet,
      answers: [{
        questionId: "rollout",
        optionIds: [],
        otherText: "Go ahead, ship it everywhere",
      }],
    })).toThrow(/must select one of its options/);

    // The same row still accepts a prepared choice from the mirror.
    expect(normalizeQuestionAnswers({
      questions: canonicalDecisionOnlyPayload.questions,
      questionSet: canonicalDecisionOnlyPayload.questionSet,
      answers: [{ questionId: "rollout", optionIds: ["staging"] }],
    })).toEqual([{ questionId: "rollout", optionIds: ["staging"] }]);
  });

  it("refuses a decision choice the card never displayed on a legacy mismatched row", async () => {
    const { normalizeQuestionAnswers } = await import("./issue-thread-interactions.js");
    // A row written before the parity contract: the mirror still offers
    // "all-customers", but the canonical presentation the card renders only
    // offers "staging".
    const mirrorQuestions = decisionPayload.questions;
    const canonicalSet = {
      schema: "paperclip.question_set.v1" as const,
      questions: [
        {
          id: "rollout",
          prompt: "Ship the migration to all customers today?",
          required: true,
          answerMode: "single_select" as const,
          intent: "decision" as const,
          recommendationRationale: "Staging is safer while the canary window is open.",
          options: [{ id: "staging", label: "Stage first", recommended: true }],
        },
      ],
    };

    expect(() => normalizeQuestionAnswers({
      questions: mirrorQuestions,
      questionSet: canonicalSet,
      answers: [{ questionId: "rollout", optionIds: ["all-customers"] }],
    })).toThrow(/not one of the choices/);

    expect(normalizeQuestionAnswers({
      questions: mirrorQuestions,
      questionSet: canonicalSet,
      answers: [{ questionId: "rollout", optionIds: ["staging"] }],
    })).toEqual([{ questionId: "rollout", optionIds: ["staging"] }]);

    // An information question keeps the mirror as its contract: the canonical
    // presentation may omit an option without stranding a valid answer.
    expect(normalizeQuestionAnswers({
      questions: [{
        id: "notes",
        prompt: "Anything else the release captain should know?",
        selectionMode: "single",
        required: true,
        intent: "information",
        options: [
          { id: "none", label: "Nothing to add" },
          { id: "follow-up", label: "I'll follow up in a comment" },
        ],
      }],
      questionSet: {
        schema: "paperclip.question_set.v1" as const,
        questions: [{
          id: "notes",
          prompt: "Anything else the release captain should know?",
          required: true,
          answerMode: "single_select" as const,
          intent: "information" as const,
          options: [{ id: "none", label: "Nothing to add" }],
        }],
      },
      answers: [{ questionId: "notes", optionIds: ["follow-up"] }],
    })).toEqual([{ questionId: "notes", optionIds: ["follow-up"] }]);
  });

  it("records a decision only from a selected option, never from free text alone", async () => {
    const { normalizeQuestionAnswers } = await import("./issue-thread-interactions.js");
    const questions = decisionPayload.questions;

    expect(normalizeQuestionAnswers({
      questions,
      answers: [{ questionId: "rollout", optionIds: ["staging"] }],
    })).toEqual([{ questionId: "rollout", optionIds: ["staging"] }]);

    expect(normalizeQuestionAnswers({
      questions,
      answers: [{
        questionId: "rollout",
        optionIds: ["staging"],
        otherText: "Stage it, then watch the error rate for an hour.",
      }],
    })).toEqual([{
      questionId: "rollout",
      optionIds: ["staging"],
      otherText: "Stage it, then watch the error rate for an hour.",
    }]);

    expect(() => normalizeQuestionAnswers({
      questions,
      answers: [{
        questionId: "rollout",
        optionIds: [],
        otherText: "Go ahead, ship it everywhere",
      }],
    })).toThrow(/must select one of its options/);

    // A text-only information question still accepts a typed answer.
    expect(normalizeQuestionAnswers({
      questions: [{
        id: "environment",
        prompt: "Where should this deploy?",
        selectionMode: "single",
        required: true,
        intent: "information",
        options: [{ id: "staging", label: "Staging" }],
      }],
      answers: [{
        questionId: "environment",
        optionIds: [],
        otherText: "A region we have not listed yet",
      }],
    })).toEqual([{
      questionId: "environment",
      optionIds: [],
      otherText: "A region we have not listed yet",
    }]);
  });

  it("create reuses an existing interaction for the same idempotency key", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const existingRow = {
      id: "interaction-1",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      resolverPolicyProvenance: "inherited",
      effectiveResolverPolicySource: "requested",
      idempotencyKey: "run-1:suggest",
      sourceCommentId: null,
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };

    const db: any = {
      select: vi.fn(() => createSelectChain([existingRow])),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "suggest_tasks",
      idempotencyKey: "run-1:suggest",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    }, {
      agentId: "agent-1",
    });

    expect(created.id).toBe("interaction-1");
    expect(created.idempotencyKey).toBe("run-1:suggest");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("answerQuestions normalizes duplicate option ids and persists answered results", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const interactionRow = {
      id: "interaction-2",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      createdByAgentId: null,
      createdByUserId: "local-board",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Pick one scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Pick extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.answerQuestions({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, "interaction-2", {
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests", "docs"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(result.status).toBe("answered");
    expect(result.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    });
    expect(state.interactionUpdates).toHaveLength(1);
    expect(state.issueTouches).toHaveLength(1);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        table: "issue_question_response_deliveries",
        values: expect.objectContaining({
          interactionId: "interaction-2",
          correlationId: "question-response:interaction-2",
          payloadSha256: expect.any(String),
        }),
      }),
    ]);
  });

  it("withdraws a pending interaction with attribution and rejects repeats", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const interactionRow = {
      id: "interaction-withdraw", companyId: "company-1", issueId: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      sourceCommentId: null, sourceRunId: null, title: null, summary: null,
      createdByAgentId: "agent-1", createdByUserId: null, resolvedByAgentId: null, resolvedByUserId: null,
      payload: { version: 1, prompt: "Proceed?" }, result: null, resolvedAt: null,
      createdAt: new Date("2026-07-25T10:00:00.000Z"), updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);
    const withdrawn = await svc.withdrawInteraction({ id: interactionRow.issueId, companyId: "company-1" }, interactionRow.id, { reason: "Replanning" }, { agentId: "agent-1" });
    expect(withdrawn.status).toBe("cancelled");
    expect(withdrawn.result).toEqual({ version: 1, outcome: "withdrawn", reason: "Replanning" });
    expect(withdrawn.resolvedByAgentId).toBe("agent-1");
    expect(state.toolActionRequestUpdates).toHaveLength(1);
    expect(state.toolActionRequestUpdates[0]).toMatchObject({ status: "cancelled", resolvedByAgentId: "agent-1" });
    const resolvedState = createFakeDb({ interactionRow: { ...interactionRow, status: "accepted" } });
    const resolvedSvc = issueThreadInteractionService(resolvedState.db as never);
    await expect(resolvedSvc.withdrawInteraction(
      { id: interactionRow.issueId, companyId: "company-1" },
      interactionRow.id,
      {},
      { agentId: "agent-1" },
    )).rejects.toMatchObject({ status: 409 });
  });

  it("refuses withdrawal when the linked tool action is already executing", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const interactionRow = {
      id: "interaction-executing", companyId: "company-1", issueId: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      sourceCommentId: null, sourceRunId: null, title: null, summary: null,
      createdByAgentId: "agent-1", createdByUserId: null, resolvedByAgentId: null, resolvedByUserId: null,
      payload: { version: 1, prompt: "Proceed?" }, result: null, resolvedAt: null,
      createdAt: new Date("2026-07-25T10:00:00.000Z"), updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow, parentRows: [{ id: "action-request-1" }] });
    const svc = issueThreadInteractionService(state.db as never);
    await expect(svc.withdrawInteraction(
      { id: interactionRow.issueId, companyId: "company-1" },
      interactionRow.id,
      {},
      { agentId: "agent-1" },
    )).rejects.toMatchObject({ status: 409 });
    expect(state.interactionUpdates).toHaveLength(0);
  });

  it("expires pending interactions when the issue is terminal", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const interactionRow = {
      id: "interaction-close", companyId: "company-1", issueId: "11111111-1111-4111-8111-111111111111",
      kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee",
      sourceCommentId: null, sourceRunId: null, title: null, summary: null,
      createdByAgentId: "agent-1", createdByUserId: null, resolvedByAgentId: null, resolvedByUserId: null,
      payload: { version: 1, questions: [{ id: "q", prompt: "Q?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] },
      result: null, resolvedAt: null, createdAt: new Date("2026-07-25T10:00:00.000Z"), updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);
    const expired = await svc.expirePendingInteractionsForTerminalIssue({ id: interactionRow.issueId, companyId: "company-1", status: "done" });
    expect(expired).toHaveLength(1);
    expect(expired[0]?.status).toBe("expired");
    expect(expired[0]?.result).toMatchObject({ version: 1, outcome: "issue_closed", answers: [] });
    expect(state.toolActionRequestUpdates).toHaveLength(0);
  });

  it("expires the linked tool action request when a terminal issue closes a confirmation card", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const interactionRow = {
      id: "interaction-tool", companyId: "company-1", issueId: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      sourceCommentId: null, sourceRunId: null, title: null, summary: null,
      createdByAgentId: "agent-1", createdByUserId: null, resolvedByAgentId: null, resolvedByUserId: null,
      payload: {
        version: 1,
        prompt: "Run the parked tool call?",
        toolAction: {
          version: 1,
          actionRequestId: "33333333-3333-4333-8333-333333333333",
          invocationId: "44444444-4444-4444-8444-444444444444",
          toolName: "deploy",
          toolDisplayName: "Deploy",
          connectionId: null,
          applicationId: null,
          appDisplayName: null,
          risk: "write",
          previewMarkdown: "Deploy the current build.",
          argumentsSummaryJson: "{}",
          argumentsHash: "hash-1",
          expiresAt: "2026-07-25T11:00:00.000Z",
        },
      },
      result: null, resolvedAt: null, createdAt: new Date("2026-07-25T10:00:00.000Z"), updatedAt: new Date("2026-07-25T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);
    const expired = await svc.expirePendingInteractionsForTerminalIssue(
      { id: interactionRow.issueId, companyId: "company-1", status: "cancelled" },
      { userId: "local-board" },
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]?.result).toMatchObject({ version: 1, outcome: "issue_closed" });
    expect(state.toolActionRequestUpdates).toHaveLength(1);
    expect(state.toolActionRequestUpdates[0]).toMatchObject({ status: "expired", resolvedByUserId: "local-board" });
  });
});
