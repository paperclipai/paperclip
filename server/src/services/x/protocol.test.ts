import { describe, expect, it, vi } from "vitest";
import {
  xChallenge,
  xControl,
  xEvents,
  xSignature,
  verifyXSignature,
  validateXReply,
} from "./protocol.js";
import { xAncestors } from "./client.js";
import { createXAdapter } from "@chat-adapter/x";

const event = {
  event_type: "post.mention.create",
  filter: { user_id: "100" },
  payload: {
    id: "200",
    author_id: "300",
    text: "@bot help",
    conversation_id: "1",
  },
};
describe("X public interaction protocol", () => {
  it("checks the exact UTF-8 bytes using the OAuth2 client secret", () => {
    const raw = Buffer.from('{ "text": "café ☕" }');
    const signature = xSignature(raw, "secret");
    expect(verifyXSignature(raw, signature, "secret")).toBe(true);
    expect(
      verifyXSignature(Buffer.from('{"text":"café ☕"}'), signature, "secret"),
    ).toBe(false);
    expect(verifyXSignature(raw, signature, "wrong")).toBe(false);
    expect(verifyXSignature(raw, "sha256=bad", "secret")).toBe(false);
  });
  it("answers valid CRC challenges without accepting invalid or oversized tokens", async () => {
    const token = "abcdefghijklmno+/=";
    const response = xChallenge(
      new Request(`https://app.test/?crc_token=${encodeURIComponent(token)}`),
      "secret",
    );
    expect(await response.json()).toEqual({
      response_token: xSignature(token, "secret"),
    });
    expect(
      xChallenge(new Request("https://app.test/?crc_token=%7B%7D"), "secret")
        .status,
    ).toBe(400);
    expect(
      xChallenge(
        new Request(`https://app.test/?crc_token=${"a".repeat(257)}`),
        "secret",
      ).status,
    ).toBe(400);
    expect(
      xChallenge(new Request("https://app.test/?crc_token=challenge"), "")
        .status,
    ).toBe(503);
  });
  it("validates batches, bot subscription identity and self messages", () => {
    expect(
      xEvents(
        {
          data: [
            event,
            { ...event, filter: { user_id: "999" } },
            { ...event, payload: { ...event.payload, author_id: "100" } },
            { ...event, event_type: "dm.received" },
          ],
        },
        "100",
      ),
    ).toEqual([event]);
    expect(xEvents({ data: event }, "100")).toEqual([event]);
  });
  it("recognizes only exact bot-addressed opt-out controls", () => {
    expect(xControl("@BOT stop", "bot")).toBe("stop");
    expect(xControl("@bot start", "bot")).toBe("start");
    expect(xControl("@other stop", "bot")).toBe(null);
    expect(xControl("@bot stop doing that", "bot")).toBe(null);
  });
  it("validates weighted characters instead of truncating text", () => {
    expect(() => validateXReply("a".repeat(280))).not.toThrow();
    expect(() => validateXReply("a".repeat(281))).toThrow("281/280");
    expect(() => validateXReply("漢".repeat(141))).toThrow("282/280");
    expect(() =>
      validateXReply(`Read https://example.com/${"a".repeat(500)}`),
    ).not.toThrow();
  });
  it("bounds ancestor fetching and labels missing posts", async () => {
    const get = vi.fn(async (url: string | URL | Request) => {
      const id = Number(String(url).split("/2/tweets/")[1].split("?")[0]);
      return Response.json({
        data: {
          id: String(id),
          author_id: "300",
          text: "reference",
          referenced_tweets: [{ type: "replied_to", id: String(id - 1) }],
        },
      });
    });
    const result = await xAncestors(
      {
        ...event,
        event_type: "post.mention.create",
        payload: { ...event.payload, in_reply_to_tweet_id: "199" },
      },
      async () => "token",
      get,
    );
    expect(result.ancestors).toHaveLength(10);
    expect(get).toHaveBeenCalledTimes(10);
    expect(result.missing).toContain("ten");
    const missing = await xAncestors(
      {
        ...event,
        event_type: "post.mention.create",
        payload: { ...event.payload, in_reply_to_tweet_id: "199" },
      },
      async () => "token",
      async () => new Response(null, { status: 404 }),
    );
    expect(missing.missing).toContain("199");
  });
  it("the pinned adapter dispatches direct replies to the durable branch and blocks automatic posts", async () => {
    const received = vi.fn();
    const adapter = createXAdapter({
      consumerSecret: "secret",
      userId: "100",
      userName: "bot",
      userAccessToken: async () => "vault-token",
      paperclipExplicitReplies: true,
      paperclipPostThreadId: async () => "x:post:200",
    });
    await adapter.initialize({
      getUserName: () => "bot",
      processMessage: received,
    } as never);
    const body = JSON.stringify({
      data: { ...event, event_type: "post.reply.create" },
    });
    const response = await adapter.handleWebhook(
      new Request("https://app.test/x", {
        method: "POST",
        headers: {
          "X-Twitter-Webhooks-Signature-OAuth2": xSignature(body, "secret"),
        },
        body,
      }),
    );
    expect(response.status).toBe(200);
    expect(received).toHaveBeenCalledWith(
      adapter,
      "x:post:200",
      expect.objectContaining({ id: "200" }),
      undefined,
    );
    await expect(
      adapter.postMessage("x:post:200", "Never automatically posted"),
    ).rejects.toThrow("x_reply");
  });
});
