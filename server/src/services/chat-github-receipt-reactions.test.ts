import { generateKeyPairSync } from "node:crypto";
import { createGitHubAdapter } from "@chat-adapter/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyChatPublicationError } from "./chat-publication-errors.js";
import {
  applyGitHubReceiptReaction,
  GITHUB_RECEIPT_MAX_PAGES,
  GITHUB_RECEIPT_TIMEOUT_MS,
} from "./chat-github-receipt-reactions.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const appId = "4853886";
const botUserId = "9001";
const own = { id: 700, content: "eyes", user: { id: Number(botUserId) } };
function fixture() {
  // Actual pinned adapter and App-auth implementation; only provider HTTP is
  // simulated. Its deliberately wrong cached env-style ID is not authority.
  const adapter = createGitHubAdapter({
    appId,
    privateKey,
    installationId: 123,
    webhookSecret: "synthetic-webhook",
    botUserId: Number(appId),
  });
  const calls: Array<{ method: string; path: string; page: string | null }> =
    [];
  let handler:
    | ((
        url: URL,
        init: RequestInit,
      ) => Promise<Response> | Response | undefined)
    | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.github.com");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    calls.push({
      method: init.method ?? "GET",
      path: url.pathname,
      page: url.searchParams.get("page"),
    });
    const custom = await handler?.(url, init);
    if (custom) return custom;
    if (url.pathname === "/app/installations/123/access_tokens")
      return Response.json(
        { token: "synthetic-installation-token" },
        { status: 201 },
      );
    if (url.pathname === "/app")
      return Response.json({ id: Number(appId), slug: "fixture-app" });
    if (url.pathname === "/users/fixture-app%5Bbot%5D")
      return Response.json({
        id: Number(botUserId),
        login: "fixture-app[bot]",
        type: "Bot",
      });
    if (init.method === "POST") return Response.json(own, { status: 201 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json([
      { id: 701, content: "eyes", user: { id: 9002 } },
      own,
    ]);
  });
  const current = vi.fn(async () => undefined);
  const invoke = (
    operation: "add" | "remove" = "remove",
    threadId = "github:owner/repo:issue:5",
    githubReceipt?: { botUserId: string; reactionId: string | null },
  ) =>
    applyGitHubReceiptReaction(
      adapter,
      appId,
      123,
      {
        operation,
        threadId,
        messageId: "5603841952",
        reaction: "eyes",
        ...(githubReceipt ? { githubReceipt } : {}),
      },
      current,
      fetchImpl,
    );
  return {
    adapter,
    calls,
    current,
    invoke,
    fetchImpl,
    setHandler(next: typeof handler) {
      handler = next;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("GitHub exact receipt reactions through pinned App auth", () => {
  it.each(["stream_error", "oversized"])(
    "preserves received HTTP backoff when the bounded body read fails (%s)",
    async (kind) => {
      const test = fixture();
      test.setHandler((url) =>
        url.pathname.endsWith("/reactions")
          ? new Response(
              kind === "oversized"
                ? "x".repeat(524289)
                : new ReadableStream({
                    pull(controller) {
                      controller.error(new Error("private stream detail"));
                    },
                  }),
              { status: 429, headers: { "retry-after": "10" } },
            )
          : undefined,
      );
      const error = await test.invoke().catch((error: unknown) => error);
      expect(error).toMatchObject({
        status: 429,
        response: { headers: { "retry-after": "10" } },
      });
      expect(classifyChatPublicationError(error, 1)).toMatchObject({
        kind: "retry",
        retryAfterMs: 10000,
      });
      expect(test.calls.some((call) => call.method === "DELETE")).toBe(false);
    },
  );
  it.each([
    "github:owner/..:issue:5",
    "github:owner/repo:issue:0",
    "github:owner/repo:issue:5:rc:6",
    "https://elsewhere.example/owner/repo",
  ])("refuses invalid destinations before HTTP %s", async (thread) => {
    const test = fixture();
    await expect(test.invoke("remove", thread)).rejects.toThrow();
    expect(test.calls).toEqual([]);
  });
  it.each([
    [
      "github:owner/repo:issue:5",
      "/repos/owner/repo/issues/comments/5603841952/reactions",
    ],
    [
      "github:owner/repo:5",
      "/repos/owner/repo/issues/comments/5603841952/reactions",
    ],
    [
      "github:owner/repo:5:rc:456",
      "/repos/owner/repo/pulls/comments/5603841952/reactions",
    ],
  ])(
    "uses the exact own-user comment route for %s",
    async (threadId, route) => {
      const test = fixture();
      expect(await test.invoke("add", threadId)).toEqual({
        botUserId,
        reactionId: "700",
      });
      expect(
        await test.invoke("remove", threadId, { botUserId, reactionId: "700" }),
      ).toEqual({ botUserId, reactionId: "700" });
      expect(test.calls.filter((call) => call.method === "DELETE")).toEqual([
        { method: "DELETE", path: `${route}/700`, page: null },
      ]);
      expect(test.calls.filter((call) => call.path === "/app")).toHaveLength(1);
      expect(
        test.calls.some((call) => call.path.includes(`/issues/5/reactions`)),
      ).toBe(false);
    },
  );

  it("finds the exact own reaction on page two before deleting it", async () => {
    const test = fixture();
    test.setHandler((url, init) =>
      init.method === "GET" && url.pathname.endsWith("/reactions")
        ? Response.json(
            url.searchParams.get("page") === "1"
              ? Array.from({ length: 100 }, (_, i) => ({
                  id: 1000 + i,
                  content: "eyes",
                  user: { id: 2000 + i },
                }))
              : [own],
          )
        : undefined,
    );
    await test.invoke();
    expect(
      test.calls.filter((call) => call.page).map((call) => call.page),
    ).toEqual(["1", "2"]);
    expect(test.calls.at(-1)?.path).toMatch(/\/700$/);
  });

  it("treats complete absence as idempotent without deleting another actor's eyes", async () => {
    const test = fixture();
    test.setHandler((url, init) =>
      init.method === "GET" && url.pathname.endsWith("/reactions")
        ? Response.json([{ ...own, user: { id: 9002 } }])
        : undefined,
    );
    expect(await test.invoke()).toEqual({ botUserId, reactionId: null });
    expect(test.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it.each(["app", "bot_id", "bot_type", "bot_login"])(
    "fails closed for unknown or wrong %s identity",
    async (kind) => {
      const test = fixture();
      test.setHandler((url) =>
        kind === "app" && url.pathname === "/app"
          ? Response.json({ id: 123, slug: "fixture-app" })
          : url.pathname.startsWith("/users/")
            ? Response.json({
                id: kind === "bot_id" ? null : 9001,
                login:
                  kind === "bot_login" ? "someone-else" : "fixture-app[bot]",
                type: kind === "bot_type" ? "User" : "Bot",
              })
            : undefined,
      );
      await expect(test.invoke()).rejects.toThrow("could not be confirmed");
      expect(test.calls.some((call) => call.path.endsWith("/reactions"))).toBe(
        false,
      );
    },
  );

  it.each([
    null,
    [{ ...own, id: "invalid" }],
    [own, own],
    [{ ...own, content: "heart" }],
  ])("refuses malformed/incomplete reaction pages %j", async (page) => {
    const test = fixture();
    test.setHandler((url, init) =>
      init.method === "GET" && url.pathname.endsWith("/reactions")
        ? Response.json(page)
        : undefined,
    );
    await expect(test.invoke()).rejects.toThrow("could not be confirmed");
    expect(test.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses an exhausted pagination budget instead of claiming cleanup", async () => {
    const test = fixture();
    test.setHandler((url, init) =>
      init.method === "GET" && url.pathname.endsWith("/reactions")
        ? Response.json(
            Array.from({ length: 100 }, (_, i) => ({
              id: Number(url.searchParams.get("page")) * 1000 + i,
              content: "eyes",
              user: { id: 10000 + i },
            })),
          )
        : undefined,
    );
    await expect(test.invoke()).rejects.toThrow("could not be confirmed");
    expect(test.calls.filter((call) => call.page)).toHaveLength(
      GITHUB_RECEIPT_MAX_PAGES,
    );
    expect(test.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it.each([
    { botUserId: "9002", reactionId: "700" },
    { botUserId, reactionId: "699" },
  ])("does not replace durable reaction ownership %j", async (identity) => {
    const test = fixture();
    await expect(test.invoke("remove", undefined, identity)).rejects.toThrow(
      "could not be confirmed",
    );
    expect(test.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("checks current ownership again before delete after an otherwise complete read", async () => {
    const test = fixture();
    test.setHandler((url, init) => {
      if (init.method === "GET" && url.pathname.endsWith("/reactions"))
        test.current.mockRejectedValue(new Error("lost exact lease"));
      return undefined;
    });
    await expect(test.invoke()).rejects.toThrow("could not be confirmed");
    expect(test.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it.each(["token", "page", "delete"])(
    "awaits local %s abort and cannot report processed success",
    async (stage) => {
      vi.useFakeTimers();
      const test = fixture();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let settled = false;
      test.setHandler((url, init) => {
        const match =
          stage === "token"
            ? url.pathname.includes("access_tokens")
            : stage === "delete"
              ? init.method === "DELETE"
              : init.method === "GET" && url.pathname.endsWith("/reactions");
        if (!match) return undefined;
        started();
        return new Promise((_resolve, reject) =>
          init.signal!.addEventListener(
            "abort",
            () => {
              settled = true;
              reject(new Error("synthetic private provider details"));
            },
            { once: true },
          ),
        );
      });
      const result = test.invoke();
      const rejected = expect(result).rejects.toThrow("could not be confirmed");
      await ready;
      await vi.advanceTimersByTimeAsync(GITHUB_RECEIPT_TIMEOUT_MS);
      await rejected;
      expect(settled).toBe(true);
    },
  );

  it("redacts provider errors while retaining only HTTP retry information", async () => {
    const test = fixture();
    test.setHandler((url) =>
      url.pathname.endsWith("/reactions")
        ? Response.json(
            { secret: "PRIVATE-PROVIDER-BODY" },
            { status: 429, headers: { "retry-after": "60" } },
          )
        : undefined,
    );
    await expect(test.invoke()).rejects.toMatchObject({
      status: 429,
      response: { headers: { "retry-after": "60" } },
      message: "GitHub receipt reaction could not be confirmed (unconfirmed)",
    });
  });

  it("cannot confirm absence if the deadline expires during the final authority read", async () => {
    vi.useFakeTimers();
    const test = fixture();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    test.setHandler((url, init) => {
      if (init.method !== "GET" || !url.pathname.endsWith("/reactions"))
        return undefined;
      test.current.mockImplementationOnce(async () => {
        entered();
        await held;
      });
      return Response.json([]);
    });
    const result = test.invoke();
    const rejection = expect(result).rejects.toThrow("could not be confirmed");
    await ready;
    await vi.advanceTimersByTimeAsync(GITHUB_RECEIPT_TIMEOUT_MS);
    release();
    await rejection;
    expect(test.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it.each(["", "<html>rate limited</html>", "{"])(
    "preserves safe HTTP backoff despite a non-JSON error body %j",
    async (body) => {
      const test = fixture();
      test.setHandler((url) =>
        url.pathname.endsWith("/reactions")
          ? new Response(body, {
              status: 429,
              headers: { "retry-after": "10" },
            })
          : undefined,
      );
      const error = await test.invoke().catch((error: unknown) => error);
      expect(error).toMatchObject({
        status: 429,
        response: { headers: { "retry-after": "10" } },
      });
      expect(classifyChatPublicationError(error, 1)).toMatchObject({
        kind: "retry",
        retryAfterMs: 10000,
      });
      expect(test.calls.some((call) => call.method === "DELETE")).toBe(false);
    },
  );
});
