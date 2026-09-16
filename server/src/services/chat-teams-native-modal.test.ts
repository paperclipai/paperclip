import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import type { ModalResponse } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChatSdkEndpointRuntime,
  type ChatSdkEndpointRuntime,
  type ChatSdkRuntimeCallbacks,
} from "./chat-sdk-runtime.js";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
  ChatSdkStateScope,
} from "./chat-sdk-state.js";
import {
  buildChatQuestionFormModal,
  chatQuestionFormActionRecords,
  chatQuestionFormValidationResponse,
  createChatQuestionFormDraft,
  parseChatQuestionFormSubmitTokenPayload,
  validateChatQuestionFormSubmission,
} from "./chat-question-forms.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const companyId = "33333333-3333-4333-8333-333333333333";
const endpointId = "44444444-4444-4444-8444-444444444444";
const conversationId = "19:question-channel@thread.tacv2;messageid=1729";
const serviceUrl = "https://smba.trafficmanager.net/amer/";
const threadId = `teams:${Buffer.from(conversationId).toString("base64url")}`;
const userId = "29:synthetic-question-user";

type ActionCallback = NonNullable<ChatSdkRuntimeCallbacks["onAction"]>;
type SubmitCallback = NonNullable<ChatSdkRuntimeCallbacks["onModalSubmit"]>;
type TaskResponse = {
  task?: {
    type: string;
    value: {
      title: string;
      card: {
        contentType: string;
        content: {
          body: Array<Record<string, unknown>>;
          actions?: Array<{ type: string; data: Record<string, string> }>;
        };
      };
    };
  };
};

function memoryPersistence(): ChatSdkStatePersistence {
  const rows = new Map<string, ChatSdkStateRecord>();
  const keyFor = (scope: ChatSdkStateScope, key: string) =>
    JSON.stringify([scope.companyId, scope.endpointId, key]);
  return {
    async read(scope, key) {
      return rows.get(keyFor(scope, key)) ?? null;
    },
    async compareAndSet(input) {
      const key = keyFor(input, input.key);
      const previous = rows.get(key);
      if ((previous?.version ?? null) !== input.expectedVersion) return false;
      rows.set(key, {
        value: input.value,
        expiresAt: input.expiresAt,
        version: (previous?.version ?? 0) + 1,
      });
      return true;
    },
    async deleteIfVersion(input) {
      const key = keyFor(input, input.key);
      if (rows.get(key)?.version !== input.expectedVersion) return false;
      return rows.delete(key);
    },
  };
}

function questionForm() {
  const now = new Date().toISOString();
  const interaction: AskUserQuestionsInteraction = {
    id: "55555555-5555-4555-8555-555555555555",
    companyId,
    issueId: "66666666-6666-4666-8666-666666666666",
    kind: "ask_user_questions",
    status: "pending",
    title: "Release details",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdAt: now,
    updatedAt: now,
    payload: {
      version: 1,
      title: "Release details",
      submitLabel: "Continue",
      questions: [
        {
          id: "environment",
          prompt: "Which environment?",
          selectionMode: "single",
          required: true,
          allowOther: false,
          options: [
            { id: "staging", label: "Staging" },
            { id: "production", label: "Production" },
          ],
        },
        {
          id: "reason",
          prompt: "What should the note say?",
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
        title: "Release details",
        submitLabel: "Continue",
        questions: [
          {
            id: "environment",
            prompt: "Which environment?",
            required: true,
            answerMode: "single_select",
            options: [
              { id: "staging", label: "Staging" },
              { id: "production", label: "Production" },
            ],
          },
          {
            id: "reason",
            prompt: "What should the note say?",
            required: true,
            answerMode: "text",
            textValidation: { minLength: 3, maxLength: 500 },
          },
        ],
      },
    },
  };
  const draft = createChatQuestionFormDraft(interaction)!;
  const payload = parseChatQuestionFormSubmitTokenPayload(
    chatQuestionFormActionRecords(draft, {
      companyId,
      endpointId,
      conversationId: "77777777-7777-4777-8777-777777777777",
      publicationId: "88888888-8888-4888-8888-888888888888",
    })[1]!.payload,
  )!;
  const modal = buildChatQuestionFormModal(
    interaction,
    draft.submitActionId,
    payload,
  )!;
  const select = payload.fields[0]!;
  const text = payload.fields[1]!;
  if (select.kind !== "single_select" || text.kind !== "text")
    throw new Error("Invalid synthetic form");
  const values = {
    [select.fieldId]: select.options[0]!.value,
    [text.fieldId]: "Keep this original note",
  };
  return { interaction, draft, payload, modal, select, text, values };
}

function invoke(
  name: "task/fetch" | "task/submit",
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "invoke",
    name,
    id: `synthetic-${name}-${crypto.randomUUID()}`,
    channelId: "msteams",
    serviceUrl,
    from: {
      id: userId,
      name: "Synthetic User",
      aadObjectId: "99999999-9999-4999-8999-999999999999",
    },
    recipient: { id: `28:${appId}`, name: "Maya" },
    conversation: { id: conversationId, conversationType: "channel", tenantId },
    channelData: { tenant: { id: tenantId } },
    replyToId: "1729",
    value: { data },
    ...overrides,
  };
}

// This crosses the real pinned HTTP bridge, Teams event dispatch, adapter and
// Chat SDK into Paperclip's callbacks. Only the instance JWT check is replaced;
// this is not Microsoft tenant authentication, DB authorization or live proof.
describe("Teams native task module adapter-to-runtime boundary", () => {
  const runtimes: ChatSdkEndpointRuntime[] = [];
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetch = vi.fn(async () => {
      throw new Error("Synthetic Teams test must not use network");
    });
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(async () => {
    try {
      await Promise.all(
        runtimes.splice(0).map((runtime) => runtime.shutdown()),
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  async function harness(
    onAction: ActionCallback,
    onModalSubmit: SubmitCallback,
  ) {
    const onMessage = vi.fn();
    const runtime = createChatSdkEndpointRuntime({
      companyId,
      endpointId,
      callbacks: { onAction, onModalSubmit, onMessage },
      logger: "silent",
      persistence: memoryPersistence(),
      providerConfig: {
        provider: "microsoft-teams",
        userName: "Maya",
        credentials: {
          appId,
          appPassword: "synthetic-not-a-provider-secret",
          appTenantId: tenantId,
          appType: "SingleTenant",
        },
      },
    });
    runtimes.push(runtime);
    await runtime.initialize();
    const adapter = runtime.getProviderAdapter() as unknown as {
      app: {
        server: {
          serviceTokenValidator: {
            check(
              header: string,
              body: Record<string, unknown>,
            ): Promise<unknown>;
          };
        };
      };
    };
    const check = vi
      .spyOn(adapter.app.server.serviceTokenValidator, "check")
      .mockImplementation(async (header, body) => {
        if (header !== "Bearer synthetic-service-token")
          throw new Error("Synthetic auth refusal");
        return {
          appId,
          from: "azure",
          fromId: "synthetic-service",
          serviceUrl: body.serviceUrl,
          isExpired: () => false,
        };
      });
    const dispatch = async (
      activity: ReturnType<typeof invoke>,
      authorization = "Bearer synthetic-service-token",
    ) => {
      const response = await runtime.handleWebhook(
        new Request(
          "https://paperclip.test/api/chat-webhooks/synthetic/microsoft-teams",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authorization ? { authorization } : {}),
            },
            body: JSON.stringify(activity),
          },
        ),
      );
      const text = await response.text();
      return {
        status: response.status,
        text,
        body:
          text &&
          response.headers.get("content-type")?.includes("application/json")
            ? (JSON.parse(text) as TaskResponse)
            : undefined,
      };
    };
    return { runtime, check, dispatch, onMessage };
  }

  it("round-trips the Paperclip form through task/fetch and task/submit with exact opaque fields and source", async () => {
    const form = questionForm();
    const onAction = vi.fn<ActionCallback>(async ({ event }) => {
      await event.openModal(form.modal);
    });
    const onSubmit = vi.fn<SubmitCallback>(() => ({ action: "clear" }));
    const { dispatch, onMessage, check } = await harness(onAction, onSubmit);
    const opened = await dispatch(
      invoke("task/fetch", { actionId: form.draft.openActionId }),
    );
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      task: {
        type: "continue",
        value: {
          title: form.modal.title,
          card: { contentType: "application/vnd.microsoft.card.adaptive" },
        },
      },
    });
    const card = opened.body!.task!.value.card.content;
    expect(card.body).toMatchObject([
      {
        type: "Input.ChoiceSet",
        id: form.select.fieldId,
        choices: [
          { title: "Staging", value: form.select.options[0]!.value },
          { title: "Production", value: form.select.options[1]!.value },
        ],
      },
      {
        type: "Input.Text",
        id: form.text.fieldId,
        isMultiline: true,
        maxLength: 500,
      },
    ]);
    const submitData = card.actions![0]!.data;
    expect(submitData).toEqual({
      __callbackId: form.draft.submitActionId,
      __contextId: expect.any(String),
    });
    expect(JSON.stringify(card)).not.toContain(form.interaction.id);
    expect(JSON.stringify(card)).not.toContain(form.interaction.issueId);
    expect(JSON.stringify(card)).not.toContain("privateMetadata");
    const submitted = await dispatch(
      invoke("task/submit", { ...submitData, ...form.values }),
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body?.task).toBeUndefined();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]![0]).toMatchObject({
      endpointId,
      provider: "microsoft-teams",
      event: {
        actionId: form.draft.openActionId,
        threadId,
        messageId: "1729",
        user: { userId },
      },
    });
    const event = onSubmit.mock.calls[0]![0].event;
    expect(event).toMatchObject({
      callbackId: form.draft.submitActionId,
      values: form.values,
      user: { userId },
      relatedThread: { id: threadId },
      raw: { replyToId: "1729", conversation: { id: conversationId } },
    });
    // The pinned Teams adapter has no fetchMessage, so Chat retains the thread
    // but not a relatedMessage. The authenticated activity still names it.
    expect(event.relatedMessage).toBeUndefined();
    expect(event.privateMetadata).toBeUndefined();
    expect(
      validateChatQuestionFormSubmission({
        callbackId: event.callbackId,
        values: event.values,
        privateMetadata: event.privateMetadata,
        interaction: form.interaction,
        payload: form.payload,
      }),
    ).toEqual({
      ok: true,
      answers: [
        { questionId: "environment", optionIds: ["staging"] },
        {
          questionId: "reason",
          optionIds: [],
          otherText: "Keep this original note",
        },
      ],
    });
    expect(onMessage).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "foreign", "conflicting", "targeted"] as const)(
    "does not dispatch task/fetch or task/submit outside the configured tenant (%s)",
    async (mode) => {
      const form = questionForm();
      const onAction = vi.fn<ActionCallback>();
      const onSubmit = vi.fn<SubmitCallback>();
      const { dispatch, onMessage } = await harness(onAction, onSubmit);
      const wrong = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const overrides =
        mode === "targeted"
          ? { recipient: { id: `28:${appId}`, isTargeted: true } }
          : mode === "missing"
            ? {
                conversation: {
                  id: conversationId,
                  conversationType: "channel",
                },
                channelData: {},
              }
            : {
                conversation: {
                  id: conversationId,
                  conversationType: "channel",
                  tenantId: mode === "foreign" ? wrong : tenantId,
                },
                channelData: { tenant: { id: wrong } },
              };
      for (const name of ["task/fetch", "task/submit"] as const) {
        const response = await dispatch(
          invoke(
            name,
            {
              actionId: form.draft.openActionId,
              __callbackId: form.draft.submitActionId,
              ...form.values,
            },
            overrides,
          ),
        );
        expect(response.status).toBe(200);
        expect(response.body?.task).toBeUndefined();
      }
      expect(onAction).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["", "Bearer wrong-synthetic-token"])(
    "refuses missing/rejected service authentication before modal callbacks (%s)",
    async (authorization) => {
      const onAction = vi.fn<ActionCallback>();
      const onSubmit = vi.fn<SubmitCallback>();
      const { dispatch } = await harness(onAction, onSubmit);
      for (const name of ["task/fetch", "task/submit"] as const) {
        expect((await dispatch(invoke(name, {}), authorization)).status).toBe(
          401,
        );
      }
      expect(onAction).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it.each(["update", "push", "clear", "close"] as const)(
    "maps modal %s response through the actual task/submit envelope",
    async (action) => {
      const form = questionForm();
      const next = { ...form.modal, title: "Next question" };
      const result = (
        action === "update" || action === "push"
          ? { action, modal: next }
          : { action }
      ) as ModalResponse;
      const onSubmit = vi.fn<SubmitCallback>(() => result);
      const { dispatch } = await harness(async ({ event }) => {
        await event.openModal(form.modal);
      }, onSubmit);
      const opened = await dispatch(
        invoke("task/fetch", { actionId: form.draft.openActionId }),
      );
      const data = opened.body!.task!.value.card.content.actions![0]!.data;
      const submitted = await dispatch(
        invoke("task/submit", { ...data, ...form.values }),
      );
      expect(submitted.status).toBe(200);
      if (action === "update" || action === "push") {
        expect(submitted.body).toMatchObject({
          task: {
            type: "continue",
            value: {
              title: "Next question",
              card: {
                content: {
                  actions: [{ data }],
                  body: [
                    { id: form.select.fieldId },
                    { id: form.text.fieldId },
                  ],
                },
              },
            },
          },
        });
      } else expect(submitted.body?.task).toBeUndefined();
    },
  );

  it("returns retryable failure when the application modal callback throws instead of silently accepting it", async () => {
    const onSubmit = vi
      .fn<SubmitCallback>()
      .mockRejectedValueOnce(new Error("synthetic-private-input-error"))
      .mockResolvedValueOnce({ action: "clear" });
    const { dispatch } = await harness(vi.fn<ActionCallback>(), onSubmit);
    const activity = invoke("task/submit", {
      __callbackId: "pcfs:synthetic",
      answer: "synthetic-private-answer",
    });
    const failed = await dispatch(activity);
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed)).not.toContain("synthetic-private");
    expect((await dispatch(activity)).status).toBe(200);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps a rejected Teams question editable with its original fields, values and submit token", async () => {
    const form = questionForm();
    const acceptedAnswers: unknown[] = [];
    const onSubmit = vi.fn<SubmitCallback>(({ event }) => {
      const validation = validateChatQuestionFormSubmission({
        callbackId: event.callbackId,
        values: event.values,
        privateMetadata: event.privateMetadata,
        interaction: form.interaction,
        payload: form.payload,
      });
      if (validation.ok) {
        acceptedAnswers.push(validation.answers);
        return { action: "clear" };
      }
      expect(validation.code).toBe("invalid_form");
      // Use the same authorized invalid_form response helper as the service.
      return chatQuestionFormValidationResponse({
        provider: "microsoft-teams",
        callbackId: event.callbackId,
        values: event.values,
        privateMetadata: event.privateMetadata,
        interaction: form.interaction,
        payload: form.payload,
      });
    });
    const { dispatch } = await harness(async ({ event }) => {
      await event.openModal(form.modal);
    }, onSubmit);
    const opened = await dispatch(
      invoke("task/fetch", { actionId: form.draft.openActionId }),
    );
    const data = opened.body!.task!.value.card.content.actions![0]!.data;
    const values = { ...form.values, [form.text.fieldId]: "x" };
    const submitted = await dispatch(
      invoke("task/submit", { ...data, ...values }),
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body!.task!.type).toBe("continue");
    const card = submitted.body!.task!.value.card.content;
    expect(card.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "Input.ChoiceSet",
          id: form.select.fieldId,
          value: values[form.select.fieldId],
        }),
        expect.objectContaining({
          type: "Input.Text",
          id: form.text.fieldId,
          value: "x",
        }),
      ]),
    );
    expect(card.actions).toEqual([
      expect.objectContaining({ type: "Action.Submit", data }),
    ]);
    const visibleText = card.body
      .filter((element) => element.type === "TextBlock")
      .map((element) => element.text)
      .join("\n");
    expect(visibleText).toContain(
      "What should the note say?: Enter at least 3 characters",
    );
    expect(visibleText).not.toContain("pcff:");
    expect(acceptedAnswers).toEqual([]);
    const corrected = await dispatch(
      invoke("task/submit", {
        ...card.actions![0]!.data,
        ...form.values,
      }),
    );
    expect(corrected.status).toBe(200);
    expect(corrected.body?.task).toBeUndefined();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    // Chat consumes its context on the first submission. Teams still carries
    // the original activity source; the service's durable token lookup owns
    // authorization on this second submission, not absent SDK context.
    expect(onSubmit.mock.calls[1]![0].event.relatedThread).toBeUndefined();
    expect(onSubmit.mock.calls[1]![0].event).toMatchObject({
      callbackId: form.draft.submitActionId,
      raw: { replyToId: "1729", conversation: { id: conversationId } },
    });
    expect(acceptedAnswers).toEqual([
      [
        { questionId: "environment", optionIds: ["staging"] },
        {
          questionId: "reason",
          optionIds: [],
          otherText: "Keep this original note",
        },
      ],
    ]);
  });
});
