import { GOOGLE_WORKSPACE_TOOL_TRANSPORT, googleWorkspaceServiceToolNames } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import {
  callGoogleWorkspaceRest,
  googleWorkspaceRestTransportGaps,
  probeGoogleWorkspaceRest,
} from "./google-workspace-rest-dispatch.js";

describe("Google Workspace REST transport eligibility", () => {
  it("switches no service to paperclip_rest unless the REST tools cover its whole allowlist", () => {
    expect(googleWorkspaceRestTransportGaps()).toEqual([]);
  });

  it("finds Gmail and Calendar fully implemented and Chat not", () => {
    expect(googleWorkspaceRestTransportGaps({ ...GOOGLE_WORKSPACE_TOOL_TRANSPORT, gmail: "paperclip_rest", calendar: "paperclip_rest" })).toEqual([]);
    expect(googleWorkspaceRestTransportGaps({ ...GOOGLE_WORKSPACE_TOOL_TRANSPORT, chat: "paperclip_rest" }).map((gap) => gap.service)).toEqual(["chat"]);
  });

  it("names every missing tool of a service with no REST tools", () => {
    expect(googleWorkspaceRestTransportGaps({ ...GOOGLE_WORKSPACE_TOOL_TRANSPORT, chat: "paperclip_rest" }))
      .toEqual([{ service: "chat", missing: googleWorkspaceServiceToolNames("chat") }]);
  });
});

describe("callGoogleWorkspaceRest", () => {
  it("sends only the bearer token to Google and passes the gateway's fetch and signal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: "draft1", message: { id: "m", threadId: "t" } }));
    const outcome = await callGoogleWorkspaceRest({
      service: "gmail", toolName: "create_draft", arguments: { subject: "Hi", body: "Hello" },
      credentialHeaders: { authorization: "Bearer token-1", "x-paperclip-run": "run-1" }, fetch, signal: controller.signal,
    });
    expect(outcome).toMatchObject({ ok: true, result: { structuredContent: { id: "draft1", subject: "Hi" } } });
    const init = fetch.mock.calls[0]![1];
    expect(Object.fromEntries(new Headers(init.headers))).toMatchObject({ authorization: "Bearer token-1" });
    expect(new Headers(init.headers).has("x-paperclip-run")).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  it("returns token problems as outcomes and leaves other failures as tool errors", async () => {
    const answer = (status: number, body: unknown) => vi.fn(async () => Response.json(body, { status }));
    const call = (fetch: ReturnType<typeof answer>, credentialHeaders: Record<string, string> = { Authorization: "Bearer t" }) =>
      callGoogleWorkspaceRest({ service: "gmail", toolName: "get_message", arguments: { messageId: "m1" }, credentialHeaders, fetch });
    await expect(call(answer(401, {}))).resolves.toEqual({ ok: false, authFailure: "unauthenticated" });
    await expect(call(answer(200, {}), {})).resolves.toEqual({ ok: false, authFailure: "unauthenticated" });
    await expect(call(answer(403, { error: { errors: [{ reason: "insufficientPermissions" }] } })))
      .resolves.toEqual({ ok: false, authFailure: "insufficient_scope" });
    await expect(call(answer(404, { error: { code: 404 } }))).resolves.toMatchObject({ ok: true, result: { isError: true } });
  });

  it("refuses a service the REST tools do not implement", async () => {
    await expect(callGoogleWorkspaceRest({ service: "drive", toolName: "search_files", arguments: {}, credentialHeaders: {}, fetch: vi.fn() }))
      .rejects.toThrow("no Paperclip REST tools");
  });
});

describe("probeGoogleWorkspaceRest", () => {
  it("reports a token problem separately from an unavailable service", async () => {
    const probe = (status: number, body: unknown) => probeGoogleWorkspaceRest({
      service: "gmail", credentialHeaders: { Authorization: "Bearer t" }, grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      fetch: vi.fn(async () => Response.json(body, { status })),
    });
    await expect(probe(200, { emailAddress: "a@example.test" })).resolves.toEqual({ ok: true });
    await expect(probe(401, {})).resolves.toMatchObject({ ok: false, authFailure: "unauthenticated" });
    await expect(probe(403, { error: { errors: [{ reason: "accessNotConfigured" }] } })).resolves.toMatchObject({ ok: false, authFailure: null });
  });
});
