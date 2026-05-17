import { describe, expect, it } from "vitest";
import {
  redactEgressIntent,
  summarizeEgressAudit,
  __testing as redactionTesting,
} from "./egress-redaction.js";
import { evaluateEgressIntent } from "./egress-policy.js";
import {
  DEFAULT_SANDBOX_NETWORK_POLICY,
  parseSandboxNetworkPolicy,
} from "./network-policy.js";

describe("redactEgressIntent", () => {
  it("digests path, drops query string, classifies host", () => {
    const redacted = redactEgressIntent({
      method: "POST",
      url: "https://api.example.com/v1/secrets/abc123?token=leakme&n=2",
      headers: { "User-Agent": "test" },
    });
    expect(redacted.host).toBe("api.example.com");
    expect(redacted.method).toBe("POST");
    expect(redacted.protocol).toBe("https");
    expect(redacted.queryParamCount).toBe(2);
    expect(redacted.pathDigest).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(redacted.headerNames).toEqual(["user-agent"]);
    expect(redacted.redactedHeaderCount).toBe(0);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("/v1/secrets/abc123");
    expect(serialized).not.toContain("leakme");
    expect(serialized).not.toContain("token=");
  });

  it("drops authorization / cookie / x-api-key header VALUES and names", () => {
    const redacted = redactEgressIntent({
      method: "GET",
      url: "https://api.example.com/",
      headers: {
        Authorization: "Bearer secret-token-yyyy",
        Cookie: "session=abc",
        "X-Api-Key": "topsecret",
        "Proxy-Authorization": "Basic dXNlcjpwYXNz",
        "X-Amz-Security-Token": "sigv4-leak",
        "User-Agent": "test-agent",
        Accept: "*/*",
      },
    });
    expect(redacted.headerNames).toEqual(["accept", "user-agent"]);
    expect(redacted.redactedHeaderCount).toBe(5);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("secret-token-yyyy");
    expect(serialized).not.toContain("topsecret");
    expect(serialized).not.toContain("sigv4-leak");
    expect(serialized).not.toContain("session=abc");
    expect(serialized).not.toContain("dXNlcjpwYXNz");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("x-api-key");
    expect(serialized).not.toContain("proxy-authorization");
  });

  it("handles malformed URLs without throwing", () => {
    const redacted = redactEgressIntent({ method: "GET", url: "not://a real url" });
    expect(redacted.host).toBe("invalid");
    expect(redacted.pathDigest).toBeNull();
    expect(redacted.queryParamCount).toBe(0);
  });

  it("normalizes host casing", () => {
    const redacted = redactEgressIntent({
      method: "GET",
      url: "https://API.EXAMPLE.COM/x",
    });
    expect(redacted.host).toBe("api.example.com");
  });

  it("identifies sensitive header names case-insensitively", () => {
    expect(redactionTesting.isSensitiveHeaderName("Authorization")).toBe(true);
    expect(redactionTesting.isSensitiveHeaderName("authorization")).toBe(true);
    expect(redactionTesting.isSensitiveHeaderName("X-AUTH-TOKEN")).toBe(true);
    expect(redactionTesting.isSensitiveHeaderName("api-key")).toBe(true);
    expect(redactionTesting.isSensitiveHeaderName("api_key")).toBe(true);
    expect(redactionTesting.isSensitiveHeaderName("Custom-Token-Hdr")).toBe(true);
    expect(redactionTesting.isSensitiveHeaderName("Content-Type")).toBe(false);
    expect(redactionTesting.isSensitiveHeaderName("Accept")).toBe(false);
  });
});

describe("summarizeEgressAudit", () => {
  it("produces a fully redacted audit record for a deny decision", () => {
    const intent = {
      method: "POST",
      url: "https://leak.example.org/v1/upload?token=stealme",
      headers: { Authorization: "Bearer 12345" },
    };
    const decision = evaluateEgressIntent(intent, DEFAULT_SANDBOX_NETWORK_POLICY);
    const audit = summarizeEgressAudit({ intent, decision });
    expect(audit.previewOnly).toBe(true);
    expect(audit.decision).toBe(decision);
    expect(audit.redactedIntent.host).toBe("leak.example.org");
    expect(audit.redactedIntent.queryParamCount).toBe(1);
    expect(audit.redactedIntent.headerNames).toEqual([]);

    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("stealme");
    expect(serialized).not.toContain("Bearer 12345");
    expect(serialized).not.toContain("12345");
    expect(serialized).not.toContain("/v1/upload");
    expect(audit.message).toContain("DENY_NETWORK_MODE_NONE");
  });

  it("scrubs accidentally-leaked secret patterns in message via redactLearningEvidence", () => {
    const intent = { method: "GET", url: "https://api.example.com/" };
    const decision = evaluateEgressIntent(
      intent,
      parseSandboxNetworkPolicy({ mode: "egress_allowlist", egressAllowlist: ["api.example.com"] }),
    );
    const audit = summarizeEgressAudit({
      intent,
      decision,
      message: "egress allow: Bearer top-secret-token api_key=apsecret",
    });
    expect(audit.message).toContain("[REDACTED]");
    expect(audit.message).not.toContain("top-secret-token");
    expect(audit.message).not.toContain("apsecret");
  });
});
