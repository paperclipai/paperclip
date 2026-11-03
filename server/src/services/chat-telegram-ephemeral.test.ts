import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureTelegramCallbackProvenance,
  hasTelegramEphemeralInput,
  parseTelegramCallbackReceipt,
  readTelegramCallbackProvenance,
  sendTelegramCallbackNotice,
  TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
} from "./chat-telegram-ephemeral.js";

const scope = {
  companyId: "company",
  endpointId: "endpoint",
  botUserId: "123",
};
const source = () => ({
  update_id: 91,
  callback_query: {
    id: "callback-91",
    data: "pcq:missing",
    from: { id: 456, is_bot: false },
    message: {
      message_id: 71,
      date: 1_780_000_000,
      message_thread_id: 3,
      chat: { id: -100123, type: "supergroup" },
      from: { id: 123, is_bot: true },
    },
  },
});
const expected = {
  ...scope,
  threadId: "telegram:-100123:3",
  messageId: "-100123:71",
  userId: "456",
};
function captured() {
  const value = captureTelegramCallbackProvenance(scope, source(), Date.now())!;
  return {
    ...value,
    receipt: readTelegramCallbackProvenance(value.proof, expected)!,
  };
}
const accepted = () => ({
  ok: true,
  result: {
    message_id: 0,
    ephemeral_message_id: 7,
    message_thread_id: 3,
    chat: { id: -100123 },
    receiver_user: { id: 456 },
    from: { id: 123, is_bot: true },
  },
});
const send = (fetchImpl: typeof fetch, receipt = captured().receipt) =>
  sendTelegramCallbackNotice(
    {
      receipt,
      text: TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
      botToken: "123:synthetic",
    },
    fetchImpl,
  );

describe("Telegram callback-only ephemeral proof and transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps runtime provenance opaque and rejects JSON clones or cross-scope reads", () => {
    const value = captured();
    expect(Object.isFrozen(value.proof)).toBe(true);
    expect(JSON.stringify(value.proof)).toBe("{}");
    expect(
      parseTelegramCallbackReceipt(JSON.parse(JSON.stringify(value.receipt))),
    ).toEqual(value.receipt);
    expect(
      readTelegramCallbackProvenance(
        JSON.parse(JSON.stringify(value.proof)),
        expected,
      ),
    ).toBeNull();
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
      expect(
        readTelegramCallbackProvenance(value.proof, {
          ...expected,
          [key]: "other",
        }),
      ).toBeNull();
    }
    expect(
      parseTelegramCallbackReceipt({
        ...value.receipt,
        deadlineAtMs: value.receipt.deadlineAtMs + 1,
      }),
    ).toBeNull();
    expect(
      parseTelegramCallbackReceipt({ ...value.receipt, receiverUserId: "999" }),
    ).toBeNull();
    expect(
      parseTelegramCallbackReceipt({ ...value.receipt, token: "not-allowed" }),
    ).toBeNull();
  });

  it.each([
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "callback_query",
  ])("blocks unsupported ephemeral %s before ordinary parsing", (key) => {
    for (const field of [
      { message_id: 0 },
      { message_id: 71, receiver_user: {} },
      { message_id: 71, ephemeral_message_id: 4 },
    ]) {
      const update = {
        [key]: key === "callback_query" ? { message: field } : field,
      };
      expect(hasTelegramEphemeralInput(update)).toBe(true);
    }
    expect(hasTelegramEphemeralInput(source())).toBe(false);
  });

  it("does not mint a callback proof for foreign authors, bots, inaccessible or private source messages", () => {
    const mutations = [
      (value: ReturnType<typeof source>) => {
        value.callback_query.message.from.id = 999;
      },
      (value: ReturnType<typeof source>) => {
        value.callback_query.from.is_bot = true;
      },
      (value: ReturnType<typeof source>) => {
        value.callback_query.message.date = 0;
      },
      (value: ReturnType<typeof source>) => {
        value.callback_query.message.message_id = 0;
      },
      (value: ReturnType<typeof source>) => {
        value.callback_query.message.chat.type = "private";
      },
      (value: ReturnType<typeof source>) => {
        value.callback_query.data = "x".repeat(65);
      },
    ];
    for (const mutate of mutations) {
      const value = source();
      mutate(value);
      expect(
        captureTelegramCallbackProvenance(scope, value, Date.now()),
      ).toBeNull();
    }
  });

  it("serializes the actual HTTP request without reply/public fallback and requires recipient-scoped acceptance", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          path: request.url!,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(accepted()));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    try {
      const result = await send((input, init) =>
        fetch(
          `http://127.0.0.1:${address.port}${new URL(String(input)).pathname}`,
          init,
        ),
      );
      expect(result).toEqual({
        id: "telegram-ephemeral:-100123:456:91:7",
        threadId: "telegram:-100123:3",
      });
      expect(requests).toEqual([
        {
          path: "/bot123%3Asynthetic/sendMessage",
          body: {
            chat_id: "-100123",
            message_thread_id: 3,
            text: TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
            ephemeral_message_parameters: {
              receiver_user_id: 456,
              callback_query_id: "callback-91",
            },
          },
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });

  it.each(["missing", "actor", "chat", "topic", "bot", "ordinary"])(
    "does not claim acceptance for a %s receipt",
    async (kind) => {
      const body = accepted();
      if (kind === "actor") body.result.receiver_user.id = 999;
      if (kind === "chat") body.result.chat.id = -999;
      if (kind === "topic") body.result.message_thread_id = 4;
      if (kind === "bot") body.result.from.id = 999;
      if (kind === "ordinary") body.result.message_id = 1;
      const fetchImpl = vi.fn(async () =>
        Response.json(kind === "missing" ? { ok: true, result: true } : body),
      );
      await expect(send(fetchImpl)).rejects.toMatchObject({
        name: "NetworkError",
        adapter: "telegram",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 429, 503])(
    "classifies HTTP%s without hidden retry or public fallback",
    async (status) => {
      const fetchImpl = vi.fn(async () =>
        Response.json(
          { ok: false, error_code: status, parameters: { retry_after: 20 } },
          { status },
        ),
      );
      await expect(send(fetchImpl)).rejects.toMatchObject({
        name:
          status === 429
            ? "RateLimitError"
            : status === 401
              ? "AuthenticationError"
              : status === 403
                ? "PermissionError"
                : "NetworkError",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("never refreshes a retained deadline or sends after expiry/with another bot credential", async () => {
    const { receipt } = captured();
    const fetchImpl = vi.fn(async () => Response.json(accepted()));
    vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineAtMs);
    await expect(send(fetchImpl, receipt)).rejects.toMatchObject({
      code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED",
    });
    vi.restoreAllMocks();
    await expect(
      sendTelegramCallbackNotice(
        {
          receipt,
          text: TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
          botToken: "999:synthetic",
        },
        fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
