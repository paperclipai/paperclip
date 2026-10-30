import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";
import type { ChatSdkRuntimeCallbacks } from "./chat-sdk-runtime.js";
import type { ChatSdkStatePersistence } from "./chat-sdk-state.js";
import {
  readTelegramCallbackProvenance,
  sendTelegramCallbackNotice,
  TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
} from "./chat-telegram-ephemeral.js";

const persistence: ChatSdkStatePersistence = {
  async compareAndSet() {
    return true;
  },
  async deleteIfVersion() {
    return true;
  },
  async read() {
    return null;
  },
};

function request(payload: unknown, secret = "synthetic-webhook-secret") {
  return new Request(
    "https://paperclip.example/api/chat-webhooks/test/telegram",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
      },
      body: JSON.stringify(payload),
    },
  );
}

function runtime(callbacks: ChatSdkRuntimeCallbacks) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const method = new URL(String(input)).pathname.split("/").at(-1);
      if (method === "getMe")
        return Response.json({
          ok: true,
          result: {
            id: 123,
            is_bot: true,
            first_name: "Synthetic",
            username: "synthetic_bot",
          },
        });
      if (method === "answerCallbackQuery")
        return Response.json({ ok: true, result: true });
      throw new Error(`Unexpected synthetic provider method: ${method}`);
    }),
  );
  return createChatSdkEndpointRuntime({
    companyId: "company-ephemeral",
    endpointId: "endpoint-ephemeral",
    logger: "silent",
    persistence,
    callbacks,
    providerConfig: {
      provider: "telegram",
      userName: "synthetic_bot",
      credentials: {
        botToken: "123:synthetic",
        secretToken: "synthetic-webhook-secret",
      },
    },
  });
}

const originalMessage = {
  message_id: 71,
  date: 1_789_000_000,
  chat: { id: -100123, type: "supergroup", title: "Synthetic group" },
  from: {
    id: 123,
    is_bot: true,
    first_name: "Synthetic",
    username: "synthetic_bot",
  },
  text: "Choose an option",
};
const actor = { id: 456, is_bot: false, first_name: "Synthetic user" };

describe("Telegram native ephemeral authenticated boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("assigns closed callback provenance only after the actual webhook verifier accepts", async () => {
    const actions: unknown[] = [];
    const instance = runtime({
      onMessage() {},
      onAction(event) {
        actions.push(event);
      },
    });
    const payload = {
      update_id: 91,
      callback_query: {
        id: "synthetic-callback-91",
        from: actor,
        chat_instance: "synthetic-chat",
        message: originalMessage,
        data: "pcq:unknown",
      },
    };
    try {
      expect(
        (await instance.handleWebhook(request(payload, "wrong-secret"))).status,
      ).toBe(401);
      expect(actions).toHaveLength(0);
      expect((await instance.handleWebhook(request(payload))).status).toBe(200);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        telegramCallback: expect.any(Object),
      });
    } finally {
      await instance.shutdown();
    }
  });

  it.each(["message", "command"])(
    "does not admit an ephemeral %s through the ordinary chat:0 identity",
    async (kind) => {
      const onMessage = vi.fn();
      const onSlashCommand = vi.fn();
      const instance = runtime({ onMessage, onSlashCommand });
      try {
        const payload = {
          update_id: 92,
          message: {
            ...originalMessage,
            message_id: 0,
            ephemeral_message_id: 72,
            from: actor,
            receiver_user: { id: 123, is_bot: true, first_name: "Synthetic" },
            text:
              kind === "command" ? "/status" : "@synthetic_bot private text",
            entities: [
              {
                type: kind === "command" ? "bot_command" : "mention",
                offset: 0,
                length: kind === "command" ? 7 : 14,
              },
            ],
          },
        };
        expect((await instance.handleWebhook(request(payload))).status).toBe(
          200,
        );
        expect(onMessage).not.toHaveBeenCalled();
        expect(onSlashCommand).not.toHaveBeenCalled();
      } finally {
        await instance.shutdown();
      }
    },
  );

  it("starts the private-response deadline before the first awaited webhook body read", async () => {
    const enteredAt = Date.now();
    let now = enteredAt;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let receipt: ReturnType<typeof readTelegramCallbackProvenance> = null;
    const instance = runtime({
      onMessage() {},
      onAction(event) {
        receipt = readTelegramCallbackProvenance(event.telegramCallback, {
          companyId: "company-ephemeral",
          endpointId: "endpoint-ephemeral",
          botUserId: "123",
          threadId: event.event.threadId,
          messageId: event.event.messageId,
          userId: event.event.user.userId,
        });
      },
    });
    const payload = {
      update_id: 94,
      callback_query: {
        id: "body-delayed-callback",
        from: actor,
        chat_instance: "synthetic-chat",
        message: originalMessage,
        data: "pcq:unknown",
      },
    };
    const incoming = request(payload);
    vi.spyOn(incoming, "clone").mockImplementation(
      () =>
        ({
          json: async () => {
            now += 16_000;
            return payload;
          },
        }) as Request,
    );
    const send = vi.fn(async () => Response.json({ ok: true }));
    try {
      expect((await instance.handleWebhook(incoming)).status).toBe(200);
      expect(receipt).toMatchObject({
        receivedAtMs: enteredAt,
        deadlineAtMs: enteredAt + 15_000,
      });
      await expect(
        sendTelegramCallbackNotice(
          {
            receipt: receipt!,
            text: TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
            botToken: "123:synthetic",
          },
          send,
        ),
      ).rejects.toMatchObject({ code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" });
      expect(send).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      await instance.shutdown();
    }
  });
});
