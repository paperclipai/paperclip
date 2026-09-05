import { describe, expect, it } from "vitest";
import { TelegramAdapter } from "@chat-adapter/telegram";
import { Actions, Button, Card, CardText } from "chat";
import {
  createChatQuestionOptionActionToken,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramCallbackDataByteLength,
  telegramChatSdkCallbackData,
} from "./chat-interaction-publications.js";

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
          Actions([
            Button({ id: actionId, label: "High", style: "primary" }),
          ]),
        ],
      }),
      fallbackText: "Choose one",
    });

    const send = adapter.requests.find(({ method }) => method === "sendMessage");
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
