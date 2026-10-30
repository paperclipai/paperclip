import { describe, expect, it } from "vitest";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import { TelegramAdapter } from "@chat-adapter/telegram";
import { Actions, Button, Card, CardText } from "chat";
import {
  createChatQuestionOptionActionToken,
  nativeChatQuestion,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramCallbackDataByteLength,
  telegramChatSdkCallbackData,
} from "./chat-interaction-publications.js";

function closedQuestion(allowOther?: boolean): AskUserQuestionsInteraction {
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
    payload: {
      version: 1,
      questions: [
        {
          id: "priority",
          prompt: "Which priority should we use?",
          selectionMode: "single",
          required: true,
          ...(allowOther === undefined ? {} : { allowOther }),
          options: [
            { id: "high", label: "High" },
            { id: "normal", label: "Normal" },
          ],
        },
      ],
    },
  };
}

describe("native chat question eligibility", () => {
  it("treats an omitted allowOther flag as a closed single-select question", () => {
    expect(nativeChatQuestion(closedQuestion())).toMatchObject({
      id: "priority",
      options: [{ id: "high" }, { id: "normal" }],
    });
  });

  it("keeps an explicitly open question on the Paperclip-only response path", () => {
    expect(nativeChatQuestion(closedQuestion(true))).toBeNull();
  });
});

class CapturingTelegramAdapter extends TelegramAdapter {
  readonly requests: Array<{
    method: string;
    payload?: Record<string, unknown> | FormData;
  }> = [];

  constructor() {
    super({
      botToken: "123:test-token",
      mode: "webhook",
      secretToken: "test-webhook-secret",
      userName: "paperclip_test_bot",
    });
  }

  protected override async telegramFetch<TResult>(
    method: string,
    payload?: Record<string, unknown> | FormData,
  ): Promise<TResult> {
    this.requests.push({ method, payload });
    return {
      message_id: 41,
      date: 1_700_000_000,
      chat: { id: 123, type: "private" },
      text: "Choose one",
    } as TResult;
  }
}

describe("Telegram question action payloads", () => {
  it("renders the exact pinned Chat SDK callback_data envelope within 64 bytes", async () => {
    const actionId = createChatQuestionOptionActionToken();
    expect(actionId).toMatch(/^pcq:[A-Za-z0-9_-]{22}$/);
    expect(telegramCallbackDataByteLength(actionId)).toBe(39);
    expect(telegramCallbackDataByteLength(actionId)).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );

    const adapter = new CapturingTelegramAdapter();
    await adapter.postMessage("telegram:123", {
      card: Card({
        title: "Choose one",
        children: [
          CardText("Select a canonical option"),
          Actions([Button({ id: actionId, label: "High", style: "primary" })]),
        ],
      }),
      fallbackText: "Choose one",
    });

    const send = adapter.requests.find(
      ({ method }) => method === "sendMessage",
    );
    expect(send?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "High",
              callback_data: telegramChatSdkCallbackData(actionId),
            },
          ],
        ],
      },
    });
    const callbackData = (
      send?.payload as {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        };
      }
    )?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(Buffer.byteLength(callbackData ?? "", "utf8")).toBe(39);
  });

  it("shows why the interaction UUID must not be repeated in Telegram value", () => {
    const actionId = createChatQuestionOptionActionToken();
    const interactionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(telegramCallbackDataByteLength(actionId, interactionId)).toBe(82);
    expect(
      telegramCallbackDataByteLength(actionId, interactionId),
    ).toBeGreaterThan(TELEGRAM_CALLBACK_DATA_LIMIT_BYTES);
  });
});
