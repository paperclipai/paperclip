import { GOOGLE_WORKSPACE_TOOL_TRANSPORT, googleWorkspaceServiceToolNames } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import {
  callGoogleWorkspaceRest,
  googleWorkspaceRestToolDefinition,
  googleWorkspaceCatalogToolTitle,
  googleWorkspaceRestTransportGaps,
  listGoogleWorkspaceRest,
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

describe("googleWorkspaceRestToolDefinition", () => {
  it("returns this folder's definition for a tool of a service on paperclip_rest, and nothing otherwise", () => {
    const rest = listGoogleWorkspaceRest("docs").find((tool) => tool.name === "update_doc")!;
    expect(googleWorkspaceRestToolDefinition("docs__update_doc")).toEqual({ name: rest.name, title: "Docs: Edit a document", description: rest.description,
      inputSchema: rest.inputSchema, outputSchema: rest.outputSchema, annotations: rest.annotations });
    expect(googleWorkspaceRestToolDefinition("docs__update_doc")?.inputSchema.required).toContain("writeControl");
    expect(googleWorkspaceRestToolDefinition("chat__list_messages")).toBeNull();
    expect(googleWorkspaceRestToolDefinition("gmail__send_message")).toBeNull();
    expect(googleWorkspaceRestToolDefinition("update_doc")).toBeNull();
    const saved = GOOGLE_WORKSPACE_TOOL_TRANSPORT.docs;
    GOOGLE_WORKSPACE_TOOL_TRANSPORT.docs = "google_mcp";
    try {
      expect(googleWorkspaceRestToolDefinition("docs__update_doc")).toBeNull();
    } finally {
      GOOGLE_WORKSPACE_TOOL_TRANSPORT.docs = saved;
    }
  });
});

describe("googleWorkspaceCatalogToolTitle", () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  it("names every allowlisted tool for a person, whichever transport lists it", () => {
    for (const service of Object.keys(GOOGLE_WORKSPACE_TOOL_TRANSPORT) as Array<keyof typeof GOOGLE_WORKSPACE_TOOL_TRANSPORT>) {
      for (const leaf of googleWorkspaceServiceToolNames(service)) {
        const name = `${service}__${leaf}`;
        const title = googleWorkspaceCatalogToolTitle("google-workspace", name, null);
        expect(title, name).toMatch(/^[A-Z][A-Za-z ]+: [A-Z][a-z]+( [a-z]+)*$/);
        expect(title, name).not.toMatch(UUID);
      }
    }
  });

  it("uses the Paperclip tool title for services with REST tools, for both transports", () => {
    expect(googleWorkspaceCatalogToolTitle("google-workspace", "gmail__get_message", null)).toBe("Gmail: Read a message");
    expect(googleWorkspaceCatalogToolTitle("google-workspace", "gmail__get_message", "Get Message")).toBe("Gmail: Read a message");
    expect(googleWorkspaceCatalogToolTitle("google-workspace", "calendar__list_events", null)).toBe("Calendar: List events");
    expect(googleWorkspaceCatalogToolTitle("google-workspace", "chat__send_message", "Send a message")).toBe("Chat: Send a message");
    expect(googleWorkspaceCatalogToolTitle("google-workspace", "chat__send_message", "Chat: Send a message")).toBe("Chat: Send a message");
    expect(googleWorkspaceCatalogToolTitle("google-workspace", "chat__send_message", null)).toBe("Chat: Send message");
  });

  it("leaves other connections' titles alone", () => {
    expect(googleWorkspaceCatalogToolTitle("github", "gmail__get_message", null)).toBeNull();
    expect(googleWorkspaceCatalogToolTitle(undefined, "create_issue", "Create issue")).toBe("Create issue");
  });
});

describe("callGoogleWorkspaceRest", () => {
  it("sends only the bearer token to Google and passes the gateway's fetch and signal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: "draft1", message: { id: "m", threadId: "t" } }));
    const outcome = await callGoogleWorkspaceRest({
      service: "gmail", toolName: "create_draft", arguments: { subject: "Hi", body: "Hello" }, maxResultBytes: 1_000_000,
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
      callGoogleWorkspaceRest({ service: "gmail", toolName: "get_message", arguments: { messageId: "m1" }, maxResultBytes: 1_000_000, credentialHeaders, fetch });
    await expect(call(answer(401, {}))).resolves.toEqual({ ok: false, authFailure: "unauthenticated" });
    await expect(call(answer(200, {}), {})).resolves.toEqual({ ok: false, authFailure: "unauthenticated" });
    await expect(call(answer(403, { error: { errors: [{ reason: "insufficientPermissions" }] } })))
      .resolves.toEqual({ ok: false, authFailure: "insufficient_scope" });
    await expect(call(answer(404, { error: { code: 404 } }))).resolves.toMatchObject({ ok: true, result: { isError: true } });
  });

  it("passes the gateway's result budget to the REST tools, which enforce exactly that number", async () => {
    const body = "a".repeat(30_000);
    const message = { id: "m1", threadId: "t1", internalDate: "1763337600000",
      payload: { mimeType: "text/plain", headers: [], body: { size: body.length, data: Buffer.from(body).toString("base64url") } } };
    const call = (maxResultBytes: number) => callGoogleWorkspaceRest({
      service: "gmail", toolName: "get_message", arguments: { messageId: "m1" }, maxResultBytes,
      credentialHeaders: { Authorization: "Bearer t" }, fetch: vi.fn(async () => Response.json(message)),
    });
    const fits = await call(1_000_000);
    expect(fits).toMatchObject({ ok: true, result: { structuredContent: { plaintextBody: body } } });
    const bytes = Buffer.byteLength(JSON.stringify(fits.ok && fits.result), "utf8");
    await expect(call(bytes)).resolves.toMatchObject({ ok: true, result: { structuredContent: { plaintextBody: body } } });
    const over = await call(bytes - 1);
    expect(over).toMatchObject({ ok: true, result: { isError: true } });
    expect(JSON.stringify(over)).toContain(`more than the ${(bytes - 1).toLocaleString("en-US")} bytes this tool can return`);
  });

  it("refuses a service the REST tools do not implement", async () => {
    await expect(callGoogleWorkspaceRest({ service: "chat", toolName: "send_message", arguments: {}, maxResultBytes: 1_000_000, credentialHeaders: {}, fetch: vi.fn() }))
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
