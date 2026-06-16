import { afterEach, describe, expect, it } from "vitest";
import { resolveLogLevel, serializeHttpRequest } from "./log-config.js";

describe("resolveLogLevel", () => {
  const original = process.env.PAPERCLIP_LOG_LEVEL;
  afterEach(() => {
    if (original === undefined) delete process.env.PAPERCLIP_LOG_LEVEL;
    else process.env.PAPERCLIP_LOG_LEVEL = original;
  });

  it("defaults to info when nothing is set", () => {
    delete process.env.PAPERCLIP_LOG_LEVEL;
    expect(resolveLogLevel(undefined)).toBe("info");
  });

  it("uses the config level when env is unset", () => {
    delete process.env.PAPERCLIP_LOG_LEVEL;
    expect(resolveLogLevel("debug")).toBe("debug");
  });

  it("lets the env override win over config (documented re-enable switch)", () => {
    process.env.PAPERCLIP_LOG_LEVEL = "debug";
    expect(resolveLogLevel("info")).toBe("debug");
  });

  it("falls through a malformed env value to the config level", () => {
    process.env.PAPERCLIP_LOG_LEVEL = "loud";
    expect(resolveLogLevel("warn")).toBe("warn");
  });
});

describe("serializeHttpRequest", () => {
  it("logs only method, url, and remoteAddress", () => {
    expect(
      serializeHttpRequest({ method: "GET", url: "/api/x", remoteAddress: "127.0.0.1" }),
    ).toEqual({ method: "GET", url: "/api/x", remoteAddress: "127.0.0.1" });
  });

  it("never includes headers, cookie, or the cf-access JWT", () => {
    const serialized = serializeHttpRequest({
      method: "GET",
      url: "/api/heartbeat-runs/abc/log",
      remoteAddress: "127.0.0.1",
      // Fields the default pino-http serializer would have leaked:
      headers: {
        cookie: "session=secret-session-token",
        "cf-access-jwt-assertion": "eyJhbGciOiJ.leaked-jwt",
        authorization: "Bearer leaked",
      },
    } as Parameters<typeof serializeHttpRequest>[0]);

    const blob = JSON.stringify(serialized);
    expect(blob).not.toContain("headers");
    expect(blob).not.toContain("cookie");
    expect(blob).not.toContain("cf-access-jwt-assertion");
    expect(blob).not.toContain("secret-session-token");
    expect(blob).not.toContain("leaked-jwt");
  });
});
