import { describe, expect, it } from "vitest";
import { MCP_SESSION_HEADER } from "./session-keepalive.js";
import { buildInitializeReplayHeaders } from "./server.js";

describe("buildInitializeReplayHeaders", () => {
  it("preserves caller auth and identity headers for session replay", () => {
    const headers = buildInitializeReplayHeaders({
      authorization: "Bearer pcp_user_123",
      "x-paperclip-user-id": "user_123",
      "x-paperclip-company-id": "company_123",
      accept: "application/json",
      "content-type": "application/json-rpc",
      [MCP_SESSION_HEADER]: "client-session",
    });

    expect(headers.authorization).toBe("Bearer pcp_user_123");
    expect(headers["x-paperclip-user-id"]).toBe("user_123");
    expect(headers["x-paperclip-company-id"]).toBe("company_123");
    expect(headers.accept).toBe("application/json, text/event-stream");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[MCP_SESSION_HEADER]).toBeUndefined();
  });
});
