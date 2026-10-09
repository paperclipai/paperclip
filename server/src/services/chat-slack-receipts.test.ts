import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { classifyChatPublicationError } from "./chat-publication-errors.js";
import {
  applySlackReceiptReaction,
  SLACK_RECEIPT_TIMEOUT_MS,
  type SlackReceiptMutation,
} from "./chat-slack-receipts.js";

const mutation: SlackReceiptMutation = {
  operation: "add",
  threadId: "slack:C123:1740000001.1",
  messageId: "1740000002.2",
  reaction: "eyes",
};
const token = "xoxb-synthetic-never-live";

describe("bounded Slack receipt transport", () => {
  it.each(["add", "remove"] as const)(
    "sends only the exact %s receipt and validates API success",
    async (operation) => {
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      await applySlackReceiptReaction(
        { ...mutation, operation, botToken: token },
        fetch,
      );
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(`https://slack.com/api/reactions.${operation}`);
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(JSON.parse(String(init.body))).toEqual({
        channel: "C123",
        timestamp: mutation.messageId,
        name: "eyes",
      });
    },
  );

  it.each([
    ["add", "already_reacted", "rejected"],
    ["remove", "no_reaction", "fulfilled"],
    ["add", "no_reaction", "rejected"],
    ["remove", "already_reacted", "rejected"],
  ] as const)(
    "limits idempotent %s/%s acknowledgement",
    async (operation, error, status) => {
      const [result] = await Promise.allSettled([
        applySlackReceiptReaction(
          { ...mutation, operation, botToken: token },
          async () => Response.json({ ok: false, error }),
        ),
      ]);
      expect(result.status).toBe(status);
      if (result.status === "rejected")
        expect(result.reason.data.error).toBe(error);
    },
  );

  it.each([undefined, "3600", "private-untrusted-value"])(
    "retains only safe Retry-After (%s) without an internal retry",
    async (hint) => {
      const fetch = vi.fn(async () =>
        Response.json(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: hint ? { "retry-after": hint } : {} },
        ),
      );
      const error = await applySlackReceiptReaction(
        { ...mutation, botToken: token },
        fetch,
      ).catch((error: unknown) => error);
      expect(classifyChatPublicationError(error, 1)).toMatchObject({
        kind: "retry",
        ...(hint === "3600" ? { retryAfterMs: 3_600_000 } : {}),
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(JSON.stringify(error)).not.toContain("private-untrusted-value");
      expect(JSON.stringify(error)).not.toContain(token);
    },
  );

  it.each([429, 503])(
    "does not turn contradictory HTTP%s already_reacted into acceptance",
    async (status) => {
      const error = await applySlackReceiptReaction(
        { ...mutation, botToken: token },
        async () =>
          Response.json(
            { ok: false, error: "already_reacted" },
            { status, headers: { "retry-after": "60" } },
          ),
      ).catch((error: unknown) => error);
      expect(error).toMatchObject({
        status,
        data: { error: "unrecognized_error" },
      });
      expect(classifyChatPublicationError(error, 1).kind).not.toBe("failed");
    },
  );

  it.each([
    { threadId: "slack:C123:1740000001.1:extra" },
    { threadId: "slack:evil.example:1740000001.1" },
    { messageId: "1740000002.2&token=secret" },
    { reaction: "not-eyes" },
    { operation: "delete" },
  ])("rejects malformed receipt before HTTP (%j)", async (change) => {
    const fetch = vi.fn();
    await expect(
      applySlackReceiptReaction(
        { ...mutation, ...change, botToken: token } as never,
        fetch,
      ),
    ).rejects.toMatchObject({ code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    () => Response.json({ ok: false, error: "private server traceback" }),
    () => Response.json({ message: "private server traceback" }),
    () => new Response("private server traceback"),
    () => new Response("x".repeat(8_193)),
    () => {
      throw new Error(`private server traceback ${token}`);
    },
  ])(
    "never exposes untrusted errors or acknowledges an unproved response",
    async (reply) => {
      const error = await applySlackReceiptReaction(
        { ...mutation, botToken: token },
        async () => reply(),
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("private");
      expect(String(error)).not.toContain(token);
    },
  );

  it("does not return on abort until the owned transport has settled", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let aborted = false;
    let settled = false;
    const result = applySlackReceiptReaction(
      { ...mutation, botToken: token },
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => {
            aborted = true;
          });
          finish = () =>
            reject(new Error("synthetic transport cleanup finished"));
        }),
    ).catch(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(SLACK_RECEIPT_TIMEOUT_MS + 1);
      expect(aborted).toBe(true);
      expect(settled).toBe(false);
      finish();
      await result;
      expect(settled).toBe(true);
    } finally {
      finish?.();
      await result;
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "aborts real local HTTP including held response body (%s)",
    async (sendHeaders) => {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let closed = false;
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.on("close", () => {
          closed = true;
        });
        if (sendHeaders) {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"ok":');
        }
        started();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No local fixture listener");
      try {
        const result = applySlackReceiptReaction(
          { ...mutation, botToken: token },
          async (url, init) => {
            expect(String(url)).toBe("https://slack.com/api/reactions.add");
            return await fetch(
              `http://127.0.0.1:${address.port}/receipt`,
              init,
            );
          },
        ).catch((error: unknown) => error);
        await ready;
        expect(await result).toMatchObject({
          code: "chat_slack_receipt_transport_failed",
        });
        await vi.waitFor(() => expect(closed).toBe(true));
        expect(requests).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
