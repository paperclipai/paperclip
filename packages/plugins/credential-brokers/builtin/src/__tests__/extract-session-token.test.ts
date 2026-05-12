import { describe, expect, it } from "vitest";

import { extractSessionTokenFromProxyAuth } from "../proxy-listener.js";

describe("extractSessionTokenFromProxyAuth", () => {
  it("pulls the token out of a Bearer header", () => {
    expect(extractSessionTokenFromProxyAuth("Bearer abc-123")).toBe("abc-123");
    expect(extractSessionTokenFromProxyAuth("bearer abc-123")).toBe("abc-123");
    expect(extractSessionTokenFromProxyAuth("  Bearer   xyz  ")).toBe("xyz");
  });

  it("pulls the password out of a Basic header (standard HTTP clients)", () => {
    // base64("session:tok-1") = "c2Vzc2lvbjp0b2stMQ=="
    const encoded = Buffer.from("session:tok-1", "utf8").toString("base64");
    expect(
      extractSessionTokenFromProxyAuth(`Basic ${encoded}`),
    ).toBe("tok-1");
  });

  it("URL-decodes Basic passwords (the materializer URI-encodes the token)", () => {
    // The runtime-env materializer percent-encodes the token before
    // splicing into the URL userInfo segment; the listener must reverse
    // it so the SessionStore lookup succeeds.
    const raw = "abc/def+ghi=jk:lm@n";
    const encoded = Buffer.from(
      `session:${encodeURIComponent(raw)}`,
      "utf8",
    ).toString("base64");
    expect(extractSessionTokenFromProxyAuth(`Basic ${encoded}`)).toBe(raw);
  });

  it("returns empty string for unrecognized schemes or malformed input", () => {
    expect(extractSessionTokenFromProxyAuth("Negotiate xyz")).toBe("");
    expect(extractSessionTokenFromProxyAuth("Basic !!!not-base64!!!")).toBe("");
    expect(extractSessionTokenFromProxyAuth("Bearer")).toBe("");
    expect(extractSessionTokenFromProxyAuth("")).toBe("");
  });

  it("returns empty string when the Basic blob has no colon separator", () => {
    const encoded = Buffer.from("just-the-token", "utf8").toString("base64");
    expect(extractSessionTokenFromProxyAuth(`Basic ${encoded}`)).toBe("");
  });
});
