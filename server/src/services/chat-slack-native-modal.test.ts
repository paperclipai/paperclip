import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChatQuestionFormModal,
  chatQuestionFormActionRecords,
  chatQuestionFormDenialResponse,
  createChatQuestionFormDraft,
  parseChatQuestionFormSubmitTokenPayload,
  validateChatQuestionFormSubmission,
} from "./chat-question-forms.js";
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

const signingSecret = "synthetic-slack-modal-signing-secret";
const channelId = "C-MODAL";
const threadTs = "1788.100";
const messageTs = "1788.200";
const userId = "U-OPERATOR";
const botUserId = "U-PAPERCLIP-BOT";
type SubmitCallback = NonNullable<ChatSdkRuntimeCallbacks["onModalSubmit"]>;
type SubmitEvent = Parameters<SubmitCallback>[0];

function formFixture() {
  const interaction: AskUserQuestionsInteraction = {
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
            { id: "staging", label: "Staging" },
            { id: "production", label: "Production" },
          ],
        },
        {
          id: "reason",
          prompt: "What should the release note say?",
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
              { id: "staging", label: "Staging" },
              { id: "production", label: "Production" },
            ],
          },
          {
            id: "reason",
            prompt: "What should the release note say?",
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
      companyId: interaction.companyId,
      endpointId: "endpoint-slack-modal",
      conversationId: "conversation-slack-modal",
      publicationId: "publication-slack-modal",
    })[1]!.payload,
  )!;
  const modal = buildChatQuestionFormModal(
    interaction,
    draft.submitActionId,
    payload,
  )!;
  return { interaction, draft, payload, modal };
}

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

function signedRequest(payload: unknown, secret = signingSecret) {
  const body = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://paperclip.test/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

interface SlackView {
  callback_id: string;
  private_metadata: string;
  blocks: Array<{
    type: string;
    block_id: string;
    element: {
      type: string;
      action_id: string;
      options?: Array<{ text: { text: string }; value: string }>;
    };
  }>;
}

function submission(view: SlackView) {
  const select = view.blocks.find(
    (block) => block.element.type === "static_select",
  )!;
  const text = view.blocks.find(
    (block) => block.element.type === "plain_text_input",
  )!;
  const selected = select.element.options!.find(
    (option) => option.text.text === "Production",
  )!;
  return {
    type: "view_submission",
    team: { id: "T-PAPERCLIP" },
    user: { id: userId, username: "operator", name: "Operator Name" },
    view: {
      id: "V-MODAL",
      callback_id: view.callback_id,
      private_metadata: view.private_metadata,
      state: {
        values: {
          [select.block_id]: {
            [select.element.action_id]: {
              type: "static_select",
              selected_option: selected,
            },
          },
          [text.block_id]: {
            [text.element.action_id]: {
              type: "plain_text_input",
              value: "  Add regional failover  ",
            },
          },
        },
      },
    },
  };
}

describe("Slack native multi-question modal adapter-to-runtime boundary", () => {
  const runtimes: ChatSdkEndpointRuntime[] = [];
  const servers: Server[] = [];
  const unexpectedRequests: string[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
    expect(unexpectedRequests.splice(0)).toEqual([]);
  });

  async function harness(
    options: {
      onSubmit?: SubmitCallback;
      persistence?: ChatSdkStatePersistence;
      endpointId?: string;
      companyId?: string;
    } = {},
  ) {
    const form = formFixture();
    const views: SlackView[] = [];
    const openTriggers: Array<string | null> = [];
    const apiMethods: string[] = [];
    // Only the provider HTTP boundary is substituted. The installed adapter,
    // signed-envelope verification, Chat SDK, modal state and runtime stay real.
    // Application callbacks observe input/use the real pure form validator;
    // they do not stand in for DB authorization or native continuation proof.
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const method = request.url?.split("/").at(-1) ?? "";
      const params = new URLSearchParams(body);
      apiMethods.push(method);
      let result: unknown;
      if (method === "conversations.replies") {
        result = {
          ok: true,
          messages: [
            {
              type: "message",
              ts: messageTs,
              thread_ts: threadTs,
              channel: channelId,
              user: botUserId,
              text: "Deployment details",
            },
          ],
        };
      } else if (method === "users.info") {
        result = {
          ok: true,
          user: {
            id: params.get("user"),
            name: "paperclip-agent",
            real_name: "Paperclip Agent",
            is_bot: true,
            profile: { display_name: "Paperclip Agent" },
          },
        };
      } else if (method === "views.open") {
        views.push(JSON.parse(params.get("view")!) as SlackView);
        openTriggers.push(params.get("trigger_id"));
        result = { ok: true, view: { id: "V-MODAL" } };
      } else {
        unexpectedRequests.push(method);
        result = { ok: false, error: "unexpected_test_provider_method" };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
    const validations: ReturnType<typeof validateChatQuestionFormSubmission>[] =
      [];
    const validate = (event: SubmitEvent) =>
      validateChatQuestionFormSubmission({
        callbackId: event.event.callbackId,
        privateMetadata: event.event.privateMetadata,
        values: event.event.values,
        interaction: form.interaction,
        payload: form.payload,
      });
    const onSubmit = vi.fn<SubmitCallback>(
      options.onSubmit ??
        ((event) => {
          const result = validate(event);
          validations.push(result);
          return result.ok
            ? { action: "clear" }
            : result.code === "invalid_form"
              ? { action: "errors", errors: result.fieldErrors }
              : chatQuestionFormDenialResponse();
        }),
    );
    const onAction = vi.fn<NonNullable<ChatSdkRuntimeCallbacks["onAction"]>>(
      async (event) => {
        expect(event.event.actionId).toBe(form.draft.openActionId);
        await event.event.openModal(form.modal);
      },
    );
    const runtime = createChatSdkEndpointRuntime({
      companyId: options.companyId ?? form.interaction.companyId,
      endpointId: options.endpointId ?? "endpoint-slack-modal",
      callbacks: { onMessage() {}, onAction, onModalSubmit: onSubmit },
      logger: "silent",
      persistence: options.persistence ?? memoryPersistence(),
      providerConfig: {
        provider: "slack",
        userName: "paperclip-agent",
        credentials: {
          apiUrl,
          botToken: "xoxb-synthetic",
          botUserId,
          signingSecret,
        },
      },
    });
    runtimes.push(runtime);
    await runtime.initialize();
    const open = async () => {
      const response = await runtime.handleWebhook(
        signedRequest({
          type: "block_actions",
          team: { id: "T-PAPERCLIP" },
          user: { id: userId, username: "operator", name: "Operator Name" },
          channel: { id: channelId },
          container: {
            type: "message",
            channel_id: channelId,
            message_ts: messageTs,
            thread_ts: threadTs,
          },
          message: { ts: messageTs, thread_ts: threadTs },
          actions: [
            { action_id: form.draft.openActionId, value: form.interaction.id },
          ],
          trigger_id: "synthetic-trigger",
        }),
      );
      expect(response.status).toBe(200);
      expect(views).toHaveLength(1);
      return views[0]!;
    };
    return {
      form,
      runtime,
      onAction,
      onSubmit,
      validations,
      views,
      openTriggers,
      apiMethods,
      open,
      validate,
    };
  }

  it("round-trips the actual Paperclip modal, opaque metadata and Slack state into canonical answers", async () => {
    const test = await harness();
    const view = await test.open();
    expect(view.callback_id).toBe(test.form.draft.submitActionId);
    expect(test.openTriggers).toEqual(["synthetic-trigger"]);
    expect(view).toMatchObject({
      type: "modal",
      title: { type: "plain_text", text: "Deployment details" },
      submit: { type: "plain_text", text: "Continue" },
    });
    const metadata = JSON.parse(view.private_metadata);
    expect(metadata).toEqual({
      c: expect.any(String),
      m: test.form.draft.submitActionId,
    });
    expect(metadata.c).not.toBe(metadata.m);
    expect(view.blocks.map((block) => block.block_id)).toEqual(
      test.form.draft.fields.map((field) => field.fieldId),
    );
    expect(
      view.blocks.every((block) => block.block_id === block.element.action_id),
    ).toBe(true);
    const wire = JSON.stringify(view);
    for (const canonical of [
      test.form.interaction.id,
      test.form.interaction.companyId,
      '"environment"',
      '"reason"',
      '"production"',
    ]) {
      expect(wire).not.toContain(canonical);
    }
    const response = await test.runtime.handleWebhook(
      signedRequest(submission(view)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });
    expect(test.onSubmit).toHaveBeenCalledOnce();
    const event = test.onSubmit.mock.calls[0]![0];
    expect(event).toMatchObject({
      endpointId: "endpoint-slack-modal",
      provider: "slack",
      event: {
        callbackId: test.form.draft.submitActionId,
        privateMetadata: test.form.draft.submitActionId,
        viewId: "V-MODAL",
        user: { userId, userName: "operator", fullName: "Operator Name" },
        relatedThread: { id: `slack:${channelId}:${threadTs}` },
        relatedMessage: { id: messageTs },
      },
    });
    expect(event).not.toHaveProperty("transport");
    expect(test.validations).toEqual([
      {
        ok: true,
        answers: [
          { questionId: "environment", optionIds: ["production"] },
          {
            questionId: "reason",
            optionIds: [],
            otherText: "Add regional failover",
          },
        ],
      },
    ]);
    expect(test.apiMethods).toEqual([
      "conversations.replies",
      "users.info",
      "views.open",
    ]);
  });

  it("maps field errors to actual Slack block IDs and retains the private token after context consumption", async () => {
    const test = await harness();
    const view = await test.open();
    const submitted = submission(view);
    const field = view.blocks.find(
      (block) => block.element.type === "plain_text_input",
    )!;
    submitted.view.state.values[field.block_id]![field.element.action_id] = {
      type: "plain_text_input",
      value: "x",
    };
    const invalid = await test.runtime.handleWebhook(signedRequest(submitted));
    expect(await invalid.json()).toEqual({
      response_action: "errors",
      errors: { [field.block_id]: "Enter at least 3 characters" },
    });
    const corrected = await test.runtime.handleWebhook(
      signedRequest(submission(view)),
    );
    expect(await corrected.json()).toEqual({ response_action: "clear" });
    expect(test.onSubmit).toHaveBeenCalledTimes(2);
    expect(test.onSubmit.mock.calls[0]![0].event.relatedThread?.id).toBe(
      `slack:${channelId}:${threadTs}`,
    );
    expect(test.onSubmit.mock.calls[1]![0].event.relatedThread).toBeUndefined();
    expect(test.onSubmit.mock.calls[1]![0].event.privateMetadata).toBe(
      test.form.draft.submitActionId,
    );
    expect(test.validations[1]?.ok).toBe(true);
    expect(test.apiMethods).toEqual([
      "conversations.replies",
      "users.info",
      "views.open",
    ]);
  });

  it.each([
    "callback",
    "private_metadata",
    "extra_field",
    "canonical_option",
  ] as const)(
    "does not promote a %s substitution into canonical answers",
    async (mode) => {
      const test = await harness();
      const view = await test.open();
      const submitted = submission(view);
      if (mode === "callback")
        submitted.view.callback_id = `pcfs:${"A".repeat(22)}`;
      if (mode === "private_metadata")
        submitted.view.private_metadata = JSON.stringify({
          ...JSON.parse(view.private_metadata),
          m: `pcfs:${"B".repeat(22)}`,
        });
      if (mode === "extra_field")
        submitted.view.state.values.extra = {
          extra: { type: "plain_text_input", value: "injected" },
        };
      if (mode === "canonical_option") {
        const field = view.blocks.find(
          (block) => block.element.type === "static_select",
        )!;
        submitted.view.state.values[field.block_id]![field.element.action_id] =
          {
            type: "static_select",
            selected_option: {
              text: { text: "Production" },
              value: "production",
            },
          };
      }
      const response = await test.runtime.handleWebhook(
        signedRequest(submitted),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { response_action: string };
      expect(body.response_action).toBe(
        mode === "canonical_option" || mode === "extra_field"
          ? "errors"
          : "clear",
      );
      expect(test.validations).toHaveLength(1);
      expect(test.validations[0]?.ok).toBe(false);
    },
  );

  it("returns 503 after a swallowed callback failure and delivers the exact retry without SDK dedupe", async () => {
    const onSubmit = vi
      .fn<SubmitCallback>()
      .mockRejectedValueOnce(new Error("synthetic durable callback failed"))
      .mockResolvedValue({ action: "clear" });
    const test = await harness({ onSubmit });
    const view = await test.open();
    const submitted = submission(view);
    const failed = await test.runtime.handleWebhook(signedRequest(submitted));
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("1");
    expect(await failed.text()).not.toContain(
      "synthetic durable callback failed",
    );
    const retry = await test.runtime.handleWebhook(signedRequest(submitted));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ response_action: "clear" });
    expect(test.onSubmit).toHaveBeenCalledTimes(2);
    const first = test.onSubmit.mock.calls[0]![0].event;
    const second = test.onSubmit.mock.calls[1]![0].event;
    expect(first.relatedThread).toBeDefined();
    expect(second.relatedThread).toBeUndefined();
    expect(second.values).toEqual(first.values);
    expect(second.privateMetadata).toBe(first.privateMetadata);
    expect(second.callbackId).toBe(first.callbackId);
    expect(second.user).toEqual(first.user);
    expect(test.validate(test.onSubmit.mock.calls[1]![0]).ok).toBe(true);
  });

  it("does not return a success response before a held modal callback settles", async () => {
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = await harness({
      onSubmit: async () => {
        entered();
        await held;
        return { action: "clear" };
      },
    });
    const view = await test.open();
    let returned = false;
    const pending = test.runtime
      .handleWebhook(signedRequest(submission(view)))
      .then((response) => {
        returned = true;
        return response;
      });
    try {
      await observed;
      expect(returned).toBe(false);
    } finally {
      release();
      expect((await pending).status).toBe(200);
    }
  });

  it("rejects an invalid signature without consuming context or calling the form handler", async () => {
    const test = await harness();
    const view = await test.open();
    expect(
      (
        await test.runtime.handleWebhook(
          signedRequest(submission(view), "wrong-secret"),
        )
      ).status,
    ).toBe(401);
    expect(test.onSubmit).not.toHaveBeenCalled();
    expect(
      (await test.runtime.handleWebhook(signedRequest(submission(view))))
        .status,
    ).toBe(200);
    expect(test.onSubmit.mock.calls[0]![0].event.relatedThread).toBeDefined();
  });

  it("does not borrow another endpoint's modal context or replace the signed submitter with the opener", async () => {
    const persistence = memoryPersistence();
    const first = await harness({ persistence });
    const view = await first.open();
    const second = await harness({
      persistence,
      endpointId: "endpoint-other",
      companyId: "company-other",
      onSubmit: () => chatQuestionFormDenialResponse(),
    });
    const submitted = submission(view);
    submitted.user.id = "U-DIFFERENT-SUBMITTER";
    expect(
      (await second.runtime.handleWebhook(signedRequest(submitted))).status,
    ).toBe(200);
    expect(first.onSubmit).not.toHaveBeenCalled();
    expect(second.onSubmit.mock.calls[0]![0]).toMatchObject({
      endpointId: "endpoint-other",
      event: { user: { userId: "U-DIFFERENT-SUBMITTER" } },
    });
    expect(
      second.onSubmit.mock.calls[0]![0].event.relatedThread,
    ).toBeUndefined();
    expect(second.apiMethods).toEqual([]);
    await first.runtime.handleWebhook(signedRequest(submitted));
    expect(first.onSubmit.mock.calls[0]![0].event.relatedThread?.id).toBe(
      `slack:${channelId}:${threadTs}`,
    );
    expect(first.onSubmit.mock.calls[0]![0].event.user.userId).toBe(
      "U-DIFFERENT-SUBMITTER",
    );
    // Actual DB link/token authorization remains the downstream service's
    // responsibility; a private token or SDK thread context is not that grant.
  });
});
