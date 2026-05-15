import { describe, expect, it } from "vitest";
import {
  MobileApiError,
  fetchMobileIssues,
  fetchMobileSummary,
  loginMobile,
  postMobileChatMessage,
  requestJson,
} from "./api";

type FetchCall = Parameters<typeof fetch>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("mobile API client", () => {
  it("fetchMobileSummary calls /api/mobile/summary with credentials include", async () => {
    const summary = {
      health: "healthy",
      counts: { running: 1, reviewNeeded: 2, blocked: 3, done: 4 },
      latestReport: "All green",
      telegramUrl: "https://t.me/example",
    };
    const calls: FetchCall[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return jsonResponse(summary);
    };

    await expect(fetchMobileSummary(recordingFetch)).resolves.toEqual(summary);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/api/mobile/summary");
    expect(calls[0][1]).toMatchObject({ credentials: "include" });
  });

  it("postMobileChatMessage sends JSON body and method POST", async () => {
    const message = {
      id: "msg-1",
      role: "user",
      text: "Ship it",
      status: "sent",
      createdAt: "2026-05-15T00:00:00.000Z",
      replyToId: null,
      error: null,
    };
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return jsonResponse(message);
    };

    await expect(postMobileChatMessage("Ship it", fetchImpl)).resolves.toEqual(message);

    expect(calls[0][0]).toBe("/api/mobile/chat/messages");
    expect(calls[0][1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(calls[0][1]?.body).toBe(JSON.stringify({ text: "Ship it" }));
    expect(new Headers(calls[0][1]?.headers).get("Content-Type")).toBe("application/json");
  });

  it("loginMobile posts token", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return jsonResponse({ ok: true });
    };

    await expect(loginMobile("mobile-token", fetchImpl)).resolves.toEqual({ ok: true });

    expect(calls[0][0]).toBe("/api/mobile/auth/login");
    expect(calls[0][1]).toMatchObject({ method: "POST", credentials: "include" });
    expect(calls[0][1]?.body).toBe(JSON.stringify({ token: "mobile-token" }));
  });

  it("fetchMobileIssues appends encoded status filter", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return jsonResponse([]);
    };

    await fetchMobileIssues("review needed", fetchImpl);

    expect(calls[0][0]).toBe("/api/mobile/issues?status=review+needed");
  });

  it("MobileApiError exposes status and parsed body on non-OK", async () => {
    const body = { error: "Nope", code: "bad_token" };
    const fetchImpl: typeof fetch = async () => jsonResponse(body, { status: 401 });

    await expect(requestJson("/summary", undefined, fetchImpl)).rejects.toMatchObject({
      name: "MobileApiError",
      message: "Nope",
      status: 401,
      body,
    });

    await expect(requestJson("/summary", undefined, fetchImpl)).rejects.toBeInstanceOf(MobileApiError);
  });

  it("requestJson handles 204 and empty responses", async () => {
    const noContentFetch: typeof fetch = async () => new Response(null, { status: 204 });
    await expect(requestJson("/auth/logout", undefined, noContentFetch)).resolves.toBeUndefined();

    const emptyFetch: typeof fetch = async () => new Response("", { status: 200 });
    await expect(requestJson("/empty", undefined, emptyFetch)).resolves.toBeUndefined();
  });
});
