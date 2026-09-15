import { describe, expect, it } from "vitest";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import { modalToAdaptiveCard } from "@chat-adapter/teams/modals";
import { modalToDiscordPayload } from "@chat-adapter/discord";
import {
  buildChatQuestionFormModal,
  chatQuestionFormActionRecords,
  chatQuestionFormDenialResponse,
  chatQuestionFormValidationResponse,
  claimChatQuestionFormSubmission,
  completeChatQuestionFormSubmission,
  createChatQuestionFormDraft,
  isChatQuestionFormOpenActionId,
  isChatQuestionFormSubmitActionId,
  parseChatQuestionFormOpenTokenPayload,
  parseChatQuestionFormSubmitTokenPayload,
  validateChatQuestionFormSubmission,
} from "./chat-question-forms.js";

function interaction(
  overrides: Partial<AskUserQuestionsInteraction["payload"]> = {},
): AskUserQuestionsInteraction {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    issueId: "33333333-3333-4333-8333-333333333333",
    kind: "ask_user_questions",
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdAt: "2026-09-05T12:00:00.000Z",
    updatedAt: "2026-09-05T12:00:00.000Z",
    title: "Deployment details",
    payload: {
      version: 1,
      title: "Deployment details",
      submitLabel: "Continue",
      questions: [
        {
          id: "environment",
          prompt: "Where should I deploy?",
          selectionMode: "single",
          required: true,
          allowOther: false,
          options: [
            { id: "staging", label: "Staging", description: "Internal" },
            { id: "production", label: "Production" },
          ],
        },
        {
          id: "reason",
          prompt: "What should the release note say?",
          helpText: "Describe the user-facing change",
          selectionMode: "single",
          required: true,
          allowOther: true,
          options: [
            {
              id: "__paperclip_text__",
              label: "Type an answer",
              freeText: true,
            },
          ],
        },
      ],
      questionSet: {
        schema: "paperclip.question_set.v1",
        title: "Deployment details",
        submitLabel: "Continue",
        questions: [
          {
            id: "environment",
            prompt: "Where should I deploy?",
            required: true,
            answerMode: "single_select",
            options: [
              { id: "staging", label: "Staging", description: "Internal" },
              { id: "production", label: "Production" },
            ],
          },
          {
            id: "reason",
            prompt: "What should the release note say?",
            helpText: "Describe the user-facing change",
            required: true,
            answerMode: "text",
            textValidation: { minLength: 3, maxLength: 500 },
          },
        ],
      },
      ...overrides,
    },
  };
}

describe("chat question forms", () => {
  it("keeps Discord's 4000-character contract explicit without changing legacy provider limits", () => {
    const current = interaction();
    current.payload.questionSet!.questions[1]!.textValidation = {
      minLength: 1,
      maxLength: 4000,
    };
    const legacy = createChatQuestionFormDraft(current)!;
    expect(legacy.fields[1]).toMatchObject({ maxLength: 3000 });
    const native = createChatQuestionFormDraft(current, {
      nativeProvider: "discord",
    })!;
    expect(native.fields[1]).toMatchObject({ maxLength: 4000 });
    const record = chatQuestionFormActionRecords(native, {
      companyId: current.companyId,
      endpointId: "endpoint",
      conversationId: "conversation",
      publicationId: "publication",
    })[1]!;
    const payload = parseChatQuestionFormSubmitTokenPayload(record.payload)!;
    expect(payload.nativeProvider).toBe("discord");
    expect(
      parseChatQuestionFormSubmitTokenPayload({
        ...record.payload,
        nativeProvider: undefined,
      }),
    ).toBeNull();
    const modal = buildChatQuestionFormModal(
      current,
      native.submitActionId,
      payload,
    )!;
    expect(
      modalToDiscordPayload(modal, "11111111-1111-4111-8111-111111111111"),
    ).toMatchObject({
      components: [{ type: 18 }, { type: 18, component: { max_length: 4000 } }],
    });
  });

  it.each([25, 26])(
    "supports one Discord select with %i options only when it fits natively",
    (count) => {
      const current = interaction();
      current.payload.questions = [current.payload.questions[0]!];
      current.payload.questions[0]!.options = Array.from(
        { length: count },
        (_, index) => ({ id: `option-${index}`, label: `Option ${index}` }),
      );
      current.payload.questionSet!.questions = [
        {
          id: "environment",
          prompt: "Where should I deploy?",
          required: true,
          answerMode: "single_select",
          options: current.payload.questions[0]!.options.map(
            ({ id, label }) => ({ id, label }),
          ),
        },
      ];
      expect(createChatQuestionFormDraft(current)).toBeNull();
      const draft = createChatQuestionFormDraft(current, {
        nativeProvider: "discord",
      });
      if (count === 26) expect(draft).toBeNull();
      else expect(draft?.fields).toHaveLength(1);
    },
  );

  it.each([5, 6])(
    "preserves all %i questions or selects explicit non-modal fallback",
    (count) => {
      const current = interaction();
      current.payload.questions = Array.from({ length: count }, (_, index) => ({
        ...current.payload.questions[1]!,
        id: `note-${index}`,
      }));
      current.payload.questionSet!.questions = current.payload.questions.map(
        (question) => ({
          id: question.id,
          prompt: question.prompt,
          required: true,
          answerMode: "text" as const,
        }),
      );
      const draft = createChatQuestionFormDraft(current, {
        nativeProvider: "discord",
      });
      if (count === 6) expect(draft).toBeNull();
      else expect(draft?.fields).toHaveLength(5);
    },
  );

  function invalidFormFixture() {
    const current = interaction();
    const now = new Date();
    const draft = createChatQuestionFormDraft(current, { now })!;
    const payload = parseChatQuestionFormSubmitTokenPayload(
      chatQuestionFormActionRecords(draft, {
        companyId: current.companyId,
        endpointId: "44444444-4444-4444-8444-444444444444",
        conversationId: "55555555-5555-4555-8555-555555555555",
        publicationId: "66666666-6666-4666-8666-666666666666",
      })[1]!.payload,
    )!;
    const select = payload.fields[0]!;
    const text = payload.fields[1]!;
    if (select.kind !== "single_select" || text.kind !== "text")
      throw new Error("Unexpected fixture fields");
    return {
      select,
      text,
      args: {
        provider: "microsoft-teams" as const,
        callbackId: draft.submitActionId,
        interaction: current,
        payload,
        now,
        values: {
          [select.fieldId]: select.options[0]!.value,
          [text.fieldId]: "x",
        },
      },
    };
  }

  it("rebuilds only the current invalid Teams form with readable errors and retained draft values", () => {
    const { args, select, text } = invalidFormFixture();
    const before = structuredClone(args);
    const result = chatQuestionFormValidationResponse(args);
    expect(result.action).toBe("update");
    if (result.action !== "update")
      throw new Error("Expected editable Teams form");
    expect(result.modal).toMatchObject({
      callbackId: args.callbackId,
      privateMetadata: args.callbackId,
      children: expect.arrayContaining([
        expect.objectContaining({
          type: "select",
          id: select.fieldId,
          initialOption: select.options[0]!.value,
        }),
        expect.objectContaining({
          type: "text_input",
          id: text.fieldId,
          initialValue: "x",
        }),
        expect.objectContaining({
          type: "text",
          content:
            "What should the release note say?: Enter at least 3 characters",
        }),
      ]),
    });
    expect(args).toEqual(before);
    const visibleErrors = result.modal.children.filter(
      (child) => child.type === "text",
    );
    expect(JSON.stringify(visibleErrors)).not.toContain("pcff:");
    expect(JSON.stringify(visibleErrors)).not.toContain(args.interaction.id);
  });

  it("keeps Slack's original inline field error response unchanged", () => {
    const { args, text } = invalidFormFixture();
    expect(
      chatQuestionFormValidationResponse({ ...args, provider: "slack" }),
    ).toEqual({
      action: "errors",
      errors: { [text.fieldId]: "Enter at least 3 characters" },
    });
  });

  it.each([
    "callback",
    "private_metadata",
    "expired",
    "answered",
    "wrong_interaction",
    "valid",
  ] as const)(
    "never refreshes an unauthorized, stale or non-invalid form (%s)",
    (mode) => {
      const { args, text } = invalidFormFixture();
      const input = {
        ...args,
        ...(mode === "callback"
          ? { callbackId: `pcfs:${"A".repeat(22)}` }
          : {}),
        ...(mode === "private_metadata" ? { privateMetadata: "forged" } : {}),
        ...(mode === "expired"
          ? { now: new Date(Date.parse(args.payload.expiresAt)) }
          : {}),
        ...(mode === "answered"
          ? {
              interaction: { ...args.interaction, status: "answered" as const },
            }
          : {}),
        ...(mode === "wrong_interaction"
          ? { interaction: { ...args.interaction, id: "other-interaction" } }
          : {}),
        ...(mode === "valid"
          ? { values: { ...args.values, [text.fieldId]: "Corrected answer" } }
          : {}),
      };
      expect(chatQuestionFormValidationResponse(input)).toEqual({
        action: "clear",
      });
    },
  );

  it("omits unexpected fields and unrecognized options instead of reflecting provider tokens", () => {
    const { args, select, text } = invalidFormFixture();
    const result = chatQuestionFormValidationResponse({
      ...args,
      values: {
        [select.fieldId]: "unrecognized-provider-choice",
        [text.fieldId]: "x",
        "private-field-name": "private-extra-value",
      },
    });
    expect(result.action).toBe("update");
    if (result.action !== "update")
      throw new Error("Expected current form rebuild");
    expect(JSON.stringify(result)).not.toContain("private-field-name");
    expect(JSON.stringify(result)).not.toContain("private-extra-value");
    expect(JSON.stringify(result)).not.toContain(
      "unrecognized-provider-choice",
    );
    expect(
      result.modal.children.find((child) => child.type === "select"),
    ).toMatchObject({ initialOption: undefined });
  });

  it.each([600, 3001])(
    "bounds reflected text without silently truncating a %i-character draft",
    (length) => {
      const { args, text } = invalidFormFixture();
      const value = "x".repeat(length);
      const result = chatQuestionFormValidationResponse({
        ...args,
        values: { ...args.values, [text.fieldId]: value },
      });
      if (result.action !== "update")
        throw new Error("Expected editable over-limit draft");
      expect(
        result.modal.children.find((child) => child.type === "text_input"),
      ).toMatchObject({ initialValue: value.slice(0, 3000) });
      expect(JSON.stringify(result).includes("draft was shortened")).toBe(
        length > 3000,
      );
    },
  );

  it("issues opaque open, submit, field, and option tokens as durable action rows", () => {
    const now = new Date("2026-09-05T12:00:00.000Z");
    const draft = createChatQuestionFormDraft(interaction(), { now });
    expect(draft).not.toBeNull();
    expect(isChatQuestionFormOpenActionId(draft?.openActionId)).toBe(true);
    expect(isChatQuestionFormSubmitActionId(draft?.submitActionId)).toBe(true);
    expect(draft?.fields.map((field) => field.fieldId)).toEqual([
      expect.stringMatching(/^pcff:[A-Za-z0-9_-]{22}$/),
      expect.stringMatching(/^pcff:[A-Za-z0-9_-]{22}$/),
    ]);
    expect(draft?.expiresAt).toBe("2026-09-12T12:00:00.000Z");
    expect(draft?.fields[0]).toMatchObject({
      kind: "single_select",
      options: [
        { optionId: "staging", value: expect.stringMatching(/^pcfo:/) },
        { optionId: "production", value: expect.stringMatching(/^pcfo:/) },
      ],
    });

    const rows = chatQuestionFormActionRecords(draft!, {
      companyId: "22222222-2222-4222-8222-222222222222",
      endpointId: "44444444-4444-4444-8444-444444444444",
      conversationId: "55555555-5555-4555-8555-555555555555",
      publicationId: "66666666-6666-4666-8666-666666666666",
    });
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => [row.kind, row.providerActionId, row.status]),
    ).toEqual([
      ["question_form_open", draft?.openActionId, "issued"],
      ["question_form_submit", draft?.submitActionId, "issued"],
    ]);
    expect(parseChatQuestionFormOpenTokenPayload(rows[0]?.payload)).toEqual(
      rows[0]?.payload,
    );
    expect(parseChatQuestionFormSubmitTokenPayload(rows[1]?.payload)).toEqual(
      rows[1]?.payload,
    );
  });

  it("builds the Chat SDK TextInput and Select modal without provider-visible canonical ids", () => {
    const current = interaction();
    const draft = createChatQuestionFormDraft(current)!;
    const submitPayload = chatQuestionFormActionRecords(draft, {
      companyId: current.companyId,
      endpointId: "44444444-4444-4444-8444-444444444444",
      conversationId: "55555555-5555-4555-8555-555555555555",
      publicationId: "66666666-6666-4666-8666-666666666666",
    })[1]?.payload;
    const parsed = parseChatQuestionFormSubmitTokenPayload(submitPayload)!;
    const modal = buildChatQuestionFormModal(
      current,
      draft.submitActionId,
      parsed,
    );

    expect(modal).toMatchObject({
      type: "modal",
      callbackId: draft.submitActionId,
      privateMetadata: draft.submitActionId,
      title: "Deployment details",
      submitLabel: "Continue",
      children: [
        {
          type: "select",
          id: draft.fields[0]?.fieldId,
          label: "Where should I deploy?",
          options: [
            { label: "Staging", value: expect.stringMatching(/^pcfo:/) },
            { label: "Production", value: expect.stringMatching(/^pcfo:/) },
          ],
        },
        {
          type: "text_input",
          id: draft.fields[1]?.fieldId,
          label: "What should the release note say?",
          maxLength: 500,
          multiline: true,
        },
      ],
    });
    const wireJson = JSON.stringify(modal);
    expect(wireJson).not.toContain('"id":"environment"');
    expect(wireJson).not.toContain('"id":"reason"');
    expect(wireJson).not.toContain('"value":"production"');

    const teamsCard = modalToAdaptiveCard(
      modal! as unknown as Parameters<typeof modalToAdaptiveCard>[0],
    );
    expect(teamsCard).toMatchObject({
      actions: [
        {
          data: { __callbackId: draft.submitActionId },
          type: "Action.Submit",
        },
      ],
      body: [
        {
          type: "Input.ChoiceSet",
          id: draft.fields[0]?.fieldId,
          choices: [
            { title: "Staging", value: expect.stringMatching(/^pcfo:/) },
            { title: "Production", value: expect.stringMatching(/^pcfo:/) },
          ],
        },
        {
          type: "Input.Text",
          id: draft.fields[1]?.fieldId,
          isMultiline: true,
        },
      ],
    });
  });

  it("maps only opaque submitted values back to canonical answers", () => {
    const current = interaction();
    const draft = createChatQuestionFormDraft(current)!;
    const payload = parseChatQuestionFormSubmitTokenPayload(
      chatQuestionFormActionRecords(draft, {
        companyId: current.companyId,
        endpointId: "44444444-4444-4444-8444-444444444444",
        conversationId: "55555555-5555-4555-8555-555555555555",
        publicationId: "66666666-6666-4666-8666-666666666666",
      })[1]?.payload,
    )!;
    const select = payload.fields[0];
    const text = payload.fields[1];
    if (select?.kind !== "single_select" || text?.kind !== "text") {
      throw new Error("fixture produced the wrong form fields");
    }

    expect(
      validateChatQuestionFormSubmission({
        callbackId: draft.submitActionId,
        privateMetadata: draft.submitActionId,
        interaction: current,
        payload,
        values: {
          [select.fieldId]: select.options[1]!.value,
          [text.fieldId]: "  Add regional failover  ",
        },
      }),
    ).toEqual({
      ok: true,
      answers: [
        { questionId: "environment", optionIds: ["production"] },
        {
          questionId: "reason",
          optionIds: [],
          otherText: "Add regional failover",
        },
      ],
    });

    const forged = validateChatQuestionFormSubmission({
      callbackId: draft.submitActionId,
      privateMetadata: draft.submitActionId,
      interaction: current,
      payload,
      values: {
        [select.fieldId]: "production",
        [text.fieldId]: "Good release note",
      },
    });
    expect(forged).toEqual({
      ok: false,
      code: "invalid_form",
      fieldErrors: { [select.fieldId]: "Choose a valid option" },
    });

    // Chat SDK 4.39 Teams task modules do not preserve privateMetadata; the
    // independently opaque callback id is still the durable lookup key.
    expect(
      validateChatQuestionFormSubmission({
        callbackId: draft.submitActionId,
        interaction: current,
        payload,
        values: {
          [select.fieldId]: select.options[0]!.value,
          [text.fieldId]: "Teams response",
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("returns provider field errors for missing, malformed, and injected values", () => {
    const current = interaction();
    const draft = createChatQuestionFormDraft(current)!;
    const payload = parseChatQuestionFormSubmitTokenPayload(
      chatQuestionFormActionRecords(draft, {
        companyId: current.companyId,
        endpointId: "44444444-4444-4444-8444-444444444444",
        conversationId: "55555555-5555-4555-8555-555555555555",
        publicationId: "66666666-6666-4666-8666-666666666666",
      })[1]?.payload,
    )!;
    const [select, text] = payload.fields;

    expect(
      validateChatQuestionFormSubmission({
        callbackId: draft.submitActionId,
        privateMetadata: draft.submitActionId,
        interaction: current,
        payload,
        values: {},
      }),
    ).toEqual({
      ok: false,
      code: "invalid_form",
      fieldErrors: {
        [select!.fieldId]: "Choose an option",
        [text!.fieldId]: "Enter a response",
      },
    });
    expect(
      validateChatQuestionFormSubmission({
        callbackId: draft.submitActionId,
        privateMetadata: draft.submitActionId,
        interaction: current,
        payload,
        values: { canonicalQuestionId: "production" },
      }),
    ).toMatchObject({ ok: false, code: "invalid_form", fieldErrors: {} });
    expect(
      validateChatQuestionFormSubmission({
        callbackId: draft.submitActionId,
        privateMetadata: "forged",
        interaction: current,
        payload,
        values: {},
      }),
    ).toEqual({
      ok: false,
      code: "invalid_callback",
      fieldErrors: {},
    });
  });

  it("rejects expired, stale, tampered, and non-native form shapes", () => {
    const current = interaction();
    const draft = createChatQuestionFormDraft(current, {
      now: new Date("2026-09-05T12:00:00.000Z"),
    })!;
    const payload = parseChatQuestionFormSubmitTokenPayload(
      chatQuestionFormActionRecords(draft, {
        companyId: current.companyId,
        endpointId: "44444444-4444-4444-8444-444444444444",
        conversationId: "55555555-5555-4555-8555-555555555555",
        publicationId: "66666666-6666-4666-8666-666666666666",
      })[1]?.payload,
    )!;
    expect(
      validateChatQuestionFormSubmission({
        callbackId: draft.submitActionId,
        privateMetadata: draft.submitActionId,
        interaction: current,
        payload,
        now: new Date("2026-09-12T12:00:00.001Z"),
        values: {},
      }),
    ).toEqual({ ok: false, code: "expired", fieldErrors: {} });
    expect(
      validateChatQuestionFormSubmission({
        callbackId: draft.submitActionId,
        privateMetadata: draft.submitActionId,
        interaction: { ...current, status: "answered" },
        payload,
        values: {},
      }),
    ).toEqual({ ok: false, code: "stale_interaction", fieldErrors: {} });

    expect(
      parseChatQuestionFormSubmitTokenPayload({
        ...payload,
        formActionId: "pcfs:AAAAAAAAAAAAAAAAAAAAAA",
        fields: [{ ...payload.fields[0], fieldId: "environment" }],
      }),
    ).toBeNull();
    expect(
      validateChatQuestionFormSubmission({
        callbackId: "pcfs:AAAAAAAAAAAAAAAAAAAAAA",
        privateMetadata: "pcfs:AAAAAAAAAAAAAAAAAAAAAA",
        interaction: current,
        payload,
        values: {},
      }),
    ).toEqual({ ok: false, code: "invalid_callback", fieldErrors: {} });
    expect(
      parseChatQuestionFormSubmitTokenPayload({
        ...payload,
        fields: [{ ...payload.fields[0], fieldId: "environment" }],
      }),
    ).toBeNull();
    expect(
      createChatQuestionFormDraft(
        interaction({
          questions: [current.payload.questions[0]!],
          questionSet: {
            ...current.payload.questionSet!,
            questions: [current.payload.questionSet!.questions[0]!],
          },
        }),
      ),
    ).toBeNull();
    expect(
      createChatQuestionFormDraft(
        interaction({
          questionSet: {
            ...current.payload.questionSet!,
            questions: [
              current.payload.questionSet!.questions[0]!,
              {
                ...current.payload.questionSet!.questions[1]!,
                textValidation: { pattern: "^(a+)+$" },
              },
            ],
          },
        }),
      ),
    ).toBeNull();
  });

  it("acknowledges durable denials without reflecting untrusted callback data", () => {
    const draft = createChatQuestionFormDraft(interaction())!;
    const payload = parseChatQuestionFormSubmitTokenPayload(
      chatQuestionFormActionRecords(draft, {
        companyId: "22222222-2222-4222-8222-222222222222",
        endpointId: "44444444-4444-4444-8444-444444444444",
        conversationId: "55555555-5555-4555-8555-555555555555",
        publicationId: "66666666-6666-4666-8666-666666666666",
      })[1]?.payload,
    )!;

    expect(chatQuestionFormDenialResponse(payload)).toEqual({
      action: "errors",
      errors: {
        [payload.fields[0]!.fieldId]:
          "This form is no longer authorized. Close it and open the linked Paperclip task.",
      },
    });
    expect(chatQuestionFormDenialResponse()).toEqual({ action: "clear" });
  });

  it("claims a submit token atomically and stores no provider answer values", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const mutationDb = (returning: Array<{ id: string }>) =>
      ({
        update: () => ({
          set: (value: Record<string, unknown>) => {
            updates.push(value);
            return {
              where: () => ({
                returning: async () => returning,
              }),
            };
          },
        }),
      }) as unknown as Parameters<typeof claimChatQuestionFormSubmission>[0];

    await expect(
      claimChatQuestionFormSubmission(mutationDb([{ id: "action-1" }]), {
        actionRowId: "action-1",
        principalId: "principal-1",
      }),
    ).resolves.toBe(true);
    await expect(
      claimChatQuestionFormSubmission(mutationDb([]), {
        actionRowId: "action-1",
        principalId: "principal-2",
      }),
    ).resolves.toBe(false);
    await expect(
      completeChatQuestionFormSubmission(
        mutationDb([{ id: "action-1" }]) as Parameters<
          typeof completeChatQuestionFormSubmission
        >[0],
        {
          actionRowId: "action-1",
          interactionId: "11111111-1111-4111-8111-111111111111",
        },
      ),
    ).resolves.toBe(true);
    expect(JSON.stringify(updates)).not.toContain("regional failover");
    expect(updates[0]).toMatchObject({
      principalId: "principal-1",
      status: "processing",
    });
    expect(updates[2]).toMatchObject({
      status: "processed",
      result: { code: "question_form_answered" },
    });
  });
});
