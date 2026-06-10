import { describe, expect, it } from "vitest";
import {
  SessionStore,
  isSessionNotFoundResponse,
  looksLikeInitializeRequest,
  extractUpstreamSessionId,
  MCP_SESSION_HEADER,
  DEFAULT_MCP_PROTOCOL_VERSION,
  buildDefaultInitializePayload,
  buildInitializedNotificationPayload,
} from "./session-keepalive.js";

describe("SessionStore", () => {
  it("creates and retrieves a session", () => {
    const store = new SessionStore();
    const record = store.createInitialized({
      upstreamSessionId: "upstream-1",
      initializePayload: Buffer.from('{"method":"initialize"}'),
    });
    expect(record.clientSessionId).toBeTruthy();
    expect(record.upstreamSessionId).toBe("upstream-1");

    const fetched = store.get(record.clientSessionId);
    expect(fetched?.upstreamSessionId).toBe("upstream-1");
  });

  it("respects a client-provided id when given", () => {
    const store = new SessionStore();
    const record = store.createInitialized({
      clientSessionId: "client-fixed",
      upstreamSessionId: "u1",
      initializePayload: Buffer.from(""),
    });
    expect(record.clientSessionId).toBe("client-fixed");
    expect(store.get("client-fixed")?.upstreamSessionId).toBe("u1");
  });

  it("rotates the upstream id without changing the client id", () => {
    const store = new SessionStore();
    const record = store.createInitialized({
      upstreamSessionId: "u1",
      initializePayload: Buffer.from(""),
    });
    const rotated = store.rotateUpstream(record.clientSessionId, "u2");
    expect(rotated?.upstreamSessionId).toBe("u2");
    expect(rotated?.clientSessionId).toBe(record.clientSessionId);
    expect(store.get(record.clientSessionId)?.upstreamSessionId).toBe("u2");
  });

  it("expires idle sessions past idleTtlMs", () => {
    const store = new SessionStore({ idleTtlMs: 50 });
    const record = store.createInitialized({
      upstreamSessionId: "u1",
      initializePayload: Buffer.from(""),
    });
    // Force lastSeen back so it's expired.
    const internal = Array.from(store.all())[0];
    internal.lastSeenMs = Date.now() - 10_000;
    expect(store.get(record.clientSessionId)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("evicts oldest when over maxSessions", () => {
    const store = new SessionStore({ maxSessions: 2 });
    const a = store.createInitialized({ upstreamSessionId: "a", initializePayload: Buffer.from("") });
    // Force a's lastSeen older than b's so a evicts when c arrives.
    const aRec = store.get(a.clientSessionId)!;
    aRec.lastSeenMs = Date.now() - 10_000;
    store.createInitialized({ upstreamSessionId: "b", initializePayload: Buffer.from("") });
    store.createInitialized({ upstreamSessionId: "c", initializePayload: Buffer.from("") });
    expect(store.size()).toBe(2);
    expect(store.get(a.clientSessionId)).toBeUndefined();
  });
});

describe("isSessionNotFoundResponse", () => {
  it("matches 404 with 'Session not found' body", () => {
    expect(isSessionNotFoundResponse(404, '{"error":"Session not found"}')).toBe(true);
    expect(isSessionNotFoundResponse(404, '{"error":"session not found"}')).toBe(true);
  });

  it("matches 410 Gone with same body", () => {
    expect(isSessionNotFoundResponse(410, '{"error":"Session expired"}')).toBe(true);
  });

  it("does not match unrelated 404s", () => {
    expect(isSessionNotFoundResponse(404, '{"error":"Method not found"}')).toBe(false);
    expect(isSessionNotFoundResponse(500, '{"error":"Session not found"}')).toBe(false);
  });
});

describe("looksLikeInitializeRequest", () => {
  it("matches a JSON-RPC initialize request", () => {
    expect(looksLikeInitializeRequest('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')).toBe(true);
  });

  it("does not match other methods", () => {
    expect(looksLikeInitializeRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}')).toBe(false);
  });

  it("does not match initialize strings outside the top-level method", () => {
    expect(
      looksLikeInitializeRequest(
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{"note":"initialize"}}}',
      ),
    ).toBe(false);
  });

  it("returns false for empty body", () => {
    expect(looksLikeInitializeRequest("")).toBe(false);
  });
});

describe("compatibility handshake payloads", () => {
  it("builds a default initialize payload", () => {
    const payload = JSON.parse(buildDefaultInitializePayload().toString("utf8"));
    expect(payload).toMatchObject({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "paperclip-mcp-gateway",
          version: "0",
        },
      },
    });
  });

  it("builds an initialized notification payload", () => {
    const payload = JSON.parse(buildInitializedNotificationPayload().toString("utf8"));
    expect(payload).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  });
});

describe("extractUpstreamSessionId", () => {
  it("prefers the Mcp-Session-Id header", () => {
    const headers = new Headers({ [MCP_SESSION_HEADER]: "from-header" });
    const id = extractUpstreamSessionId(headers, '{"result":{"sessionId":"from-body"}}');
    expect(id).toBe("from-header");
  });

  it("falls back to result.sessionId in the body when no header", () => {
    const headers = new Headers();
    const id = extractUpstreamSessionId(headers, '{"jsonrpc":"2.0","id":1,"result":{"sessionId":"body-id-xyz"}}');
    expect(id).toBe("body-id-xyz");
  });

  it("returns null when neither is present", () => {
    expect(extractUpstreamSessionId(new Headers(), "{}")).toBeNull();
  });
});
