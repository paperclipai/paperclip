import { describe, expect, it } from "vitest";
import {
  checkMcpRemoteHeaderName,
  checkMcpRemoteHeaderValue,
  mcpRemoteHeaderNameFromConfigPath,
  mcpRemoteHeaderRejectionMessage,
} from "./mcp-remote-headers.js";

describe("checkMcpRemoteHeaderName", () => {
  it("accepts the header names real MCP servers ask for", () => {
    for (const name of [
      "Authorization",
      "authorization",
      "X-PostHog-Project-Id",
      "x-api-key",
      "Mcp-Session-Id",
      "X_Custom.Token",
    ]) {
      expect(checkMcpRemoteHeaderName(name), name).toEqual({ ok: true });
    }
  });

  it("rejects hop-by-hop, framing, routing and ambient-credential headers", () => {
    for (const name of [
      "Host",
      "host",
      "Connection",
      "Content-Length",
      "Transfer-Encoding",
      "TE",
      "Trailer",
      "Upgrade",
      "Keep-Alive",
      "Cookie",
      "Set-Cookie",
      "Proxy-Authorization",
      "Via",
      "Expect",
    ]) {
      expect(checkMcpRemoteHeaderName(name), name).toEqual({ ok: false, reason: "forbidden" });
    }
  });

  it("rejects reserved prefixes browsers and proxies own", () => {
    for (const name of ["Sec-Fetch-Mode", "sec-websocket-key", "Proxy-Foo", "HTTP2-Settings"]) {
      expect(checkMcpRemoteHeaderName(name), name).toEqual({ ok: false, reason: "forbidden" });
    }
  });

  it("rejects names that could smuggle a separator or a new header line", () => {
    for (const name of [
      "X-Bad\r\nX-Injected",
      "X-Bad\nX-Injected",
      "X Bad",
      "X-Bad:",
      "X-Bad;Other",
      "X-Bad,Other",
      'X-"Bad"',
      "X-Bad/Other",
      "X-Bad(Other)",
      "X-Bad@Other",
      "X-Bad\u0000",
    ]) {
      expect(checkMcpRemoteHeaderName(name), JSON.stringify(name)).toEqual({
        ok: false,
        reason: "invalid_characters",
      });
    }
  });

  it("rejects blank and over-long names", () => {
    expect(checkMcpRemoteHeaderName("")).toEqual({ ok: false, reason: "empty" });
    expect(checkMcpRemoteHeaderName("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkMcpRemoteHeaderName("x".repeat(129))).toEqual({ ok: false, reason: "too_long" });
    expect(checkMcpRemoteHeaderName("x".repeat(128))).toEqual({ ok: true });
  });
});

describe("checkMcpRemoteHeaderValue", () => {
  it("accepts ordinary credential values", () => {
    for (const value of ["Bearer phx_abc123", "phx_abc123", "12345", "a b c", ""]) {
      expect(checkMcpRemoteHeaderValue(value), JSON.stringify(value)).toEqual({ ok: true });
    }
  });

  it("rejects values that would split the request", () => {
    for (const value of [
      "abc\r\nX-Injected: 1",
      "abc\nX-Injected: 1",
      "abc\rdef",
      "abc\u0000def",
      "abc\tdef",
      "abc\u007fdef",
    ]) {
      expect(checkMcpRemoteHeaderValue(value), JSON.stringify(value)).toEqual({
        ok: false,
        reason: "value_control_characters",
      });
    }
  });

  it("rejects over-long values", () => {
    expect(checkMcpRemoteHeaderValue("x".repeat(8_193))).toEqual({ ok: false, reason: "value_too_long" });
    expect(checkMcpRemoteHeaderValue("x".repeat(8_192))).toEqual({ ok: true });
  });
});

describe("mcpRemoteHeaderNameFromConfigPath", () => {
  it("extracts a header name from a headers.* config path", () => {
    expect(mcpRemoteHeaderNameFromConfigPath("headers.X-Api-Key")).toBe("X-Api-Key");
    expect(mcpRemoteHeaderNameFromConfigPath("headers.  X-Api-Key  ")).toBe("X-Api-Key");
  });

  it("returns null for non-header and empty paths", () => {
    expect(mcpRemoteHeaderNameFromConfigPath("credentials.authorization")).toBeNull();
    expect(mcpRemoteHeaderNameFromConfigPath("headers.")).toBeNull();
    expect(mcpRemoteHeaderNameFromConfigPath("headers.   ")).toBeNull();
  });
});

describe("mcpRemoteHeaderRejectionMessage", () => {
  it("explains the problem without echoing the value", () => {
    expect(mcpRemoteHeaderRejectionMessage("Host", "forbidden")).toContain("Host");
    expect(mcpRemoteHeaderRejectionMessage("X-Api-Key", "value_control_characters"))
      .toBe('The value for "X-Api-Key" contains line breaks or control characters.');
  });
});
