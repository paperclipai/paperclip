import { describe, expect, it } from "vitest";
import {
  evaluateEgressIntent,
  __testing as egressTesting,
} from "./egress-policy.js";
import {
  DEFAULT_SANDBOX_NETWORK_POLICY,
  parseSandboxNetworkPolicy,
} from "./network-policy.js";

describe("evaluateEgressIntent", () => {
  it("denies by default (mode=none) for any public-internet target", () => {
    const decision = evaluateEgressIntent(
      { method: "GET", url: "https://api.example.com/v1/things" },
      DEFAULT_SANDBOX_NETWORK_POLICY,
    );
    expect(decision.previewOnly).toBe(true);
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_NETWORK_MODE_NONE");
    expect(decision.classification).toBe("public_internet");
    expect(decision.protocol).toBe("https");
    expect(decision.matchedAllowlistEntry).toBeNull();
    expect(decision.truth).toBe("preview");
  });

  it("never opens a socket — pure evaluator", () => {
    // If we had real I/O, this DNS-shape host wouldn't resolve in tests.
    const decision = evaluateEgressIntent(
      { method: "GET", url: "https://does-not-exist.invalid/" },
      DEFAULT_SANDBOX_NETWORK_POLICY,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_NETWORK_MODE_NONE");
  });

  it("allows loopback when policy mode=host_loopback and allowLoopback=true", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "host_loopback",
      allowLoopback: true,
    });
    const decision = evaluateEgressIntent(
      { method: "POST", url: "http://127.0.0.1:8080/internal" },
      policy,
    );
    expect(decision.decision).toBe("allow");
    expect(decision.reasonCode).toBe("ALLOW_LOOPBACK");
    expect(decision.classification).toBe("loopback");
  });

  it("denies loopback when allowLoopback=false even under host_loopback mode", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "host_loopback",
      allowLoopback: false,
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "http://localhost/info" },
      policy,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_LOOPBACK_DISABLED");
  });

  it("denies non-loopback under host_loopback mode", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "host_loopback",
      allowLoopback: true,
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "https://api.example.com/things" },
      policy,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_HOST_NOT_ALLOWLISTED");
    expect(decision.classification).toBe("public_internet");
  });

  it("allows allowlisted host under egress_allowlist mode", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "egress_allowlist",
      egressAllowlist: ["api.example.com"],
      allowLoopback: false,
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "https://api.example.com/v1/things?x=1" },
      policy,
    );
    expect(decision.decision).toBe("allow");
    expect(decision.reasonCode).toBe("ALLOW_HOST_ALLOWLISTED");
    expect(decision.matchedAllowlistEntry).toBe("api.example.com");
  });

  it("allows subdomain match under egress_allowlist", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "egress_allowlist",
      egressAllowlist: ["example.com"],
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "https://docs.example.com/" },
      policy,
    );
    expect(decision.decision).toBe("allow");
    expect(decision.matchedAllowlistEntry).toBe("example.com");
  });

  it("denies non-allowlisted host under egress_allowlist mode", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "egress_allowlist",
      egressAllowlist: ["api.example.com"],
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "https://leak.example.org/" },
      policy,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_HOST_NOT_ALLOWLISTED");
  });

  it("ALWAYS denies cloud metadata endpoint, even if it appears in the allowlist", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "egress_allowlist",
      egressAllowlist: ["169.254.169.254", "metadata.google.internal"],
    });
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      const decision = evaluateEgressIntent({ method: "GET", url }, policy);
      expect(decision.decision).toBe("deny");
      expect(decision.reasonCode).toBe("DENY_METADATA_SERVICE");
      expect(decision.classification).toBe("metadata_service");
    }
  });

  it("ALWAYS denies AWS IPv6 IMDS literal [fd00:ec2::254] (LET-323 QA)", () => {
    // QA fixture LET-323: URL-bracketed IPv6 must still classify as
    // metadata_service, not public_internet/private_network. Prior bug:
    // Node's URL parser leaves brackets on hostname → METADATA_HOSTS miss
    // → host was reported as DENY_HOST_NOT_ALLOWLISTED instead of the
    // metadata-service invariant deny code.
    const policy = parseSandboxNetworkPolicy({
      mode: "egress_allowlist",
      egressAllowlist: ["example.com"],
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "http://[fd00:ec2::254]/latest/meta-data/" },
      policy,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_METADATA_SERVICE");
    expect(decision.classification).toBe("metadata_service");
  });

  it("denies invalid URLs with DENY_INVALID_TARGET", () => {
    const decision = evaluateEgressIntent(
      { method: "GET", url: "not a url at all" },
      DEFAULT_SANDBOX_NETWORK_POLICY,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_INVALID_TARGET");
    expect(decision.classification).toBe("invalid");
  });

  it("denies unsupported protocols (file://, ftp://)", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "egress_allowlist",
      egressAllowlist: ["files.example.com"],
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "file:///etc/passwd" },
      policy,
    );
    expect(decision.decision).toBe("deny");
    // file:// has empty hostname → invalid target
    expect(decision.reasonCode).toBe("DENY_INVALID_TARGET");

    const decisionFtp = evaluateEgressIntent(
      { method: "GET", url: "ftp://files.example.com/data" },
      policy,
    );
    expect(decisionFtp.decision).toBe("deny");
    expect(decisionFtp.reasonCode).toBe("DENY_PROTOCOL_UNSUPPORTED");
  });

  it("validates method shape and rejects garbage", () => {
    expect(() =>
      evaluateEgressIntent(
        { method: "GET WITH SPACES", url: "https://api.example.com/" },
        DEFAULT_SANDBOX_NETWORK_POLICY,
      ),
    ).toThrow(/method/);
  });

  it("classifies RFC1918 private addresses correctly", () => {
    expect(egressTesting.classifyHost("10.0.0.1")).toBe("private_network");
    expect(egressTesting.classifyHost("192.168.1.1")).toBe("private_network");
    expect(egressTesting.classifyHost("172.16.5.5")).toBe("private_network");
    expect(egressTesting.classifyHost("169.254.10.10")).toBe("private_network");
    expect(egressTesting.classifyHost("100.64.0.1")).toBe("private_network");
    // Metadata still trumps
    expect(egressTesting.classifyHost("169.254.169.254")).toBe("metadata_service");
  });

  it("denies DNS intent under mode=none even if dnsAllowlist matches", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "none",
      dnsAllowlist: ["dns.example.com"],
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "dns://dns.example.com/", targetKind: "dns" },
      policy,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_NETWORK_MODE_NONE");
    expect(decision.classification).toBe("dns");
  });

  it("denies DNS intent under mode=host_loopback even if dnsAllowlist matches", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "host_loopback",
      allowLoopback: true,
      dnsAllowlist: ["dns.example.com"],
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "dns://dns.example.com/", targetKind: "dns" },
      policy,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_HOST_NOT_ALLOWLISTED");
    expect(decision.classification).toBe("dns");
  });

  it("dns intent only allows dnsAllowlist hits", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "egress_allowlist",
      dnsAllowlist: ["dns.example.com"],
    });
    const allow = evaluateEgressIntent(
      { method: "GET", url: "dns://dns.example.com/", targetKind: "dns" },
      policy,
    );
    expect(allow.decision).toBe("allow");
    expect(allow.reasonCode).toBe("ALLOW_DNS_ALLOWLISTED");

    const deny = evaluateEgressIntent(
      { method: "GET", url: "dns://other.example.com/", targetKind: "dns" },
      policy,
    );
    expect(deny.decision).toBe("deny");
    expect(deny.reasonCode).toBe("DENY_HOST_NOT_ALLOWLISTED");
  });

  it("denies allowlisted host when policy mode is `none`", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "none",
      egressAllowlist: ["api.example.com"],
    });
    const decision = evaluateEgressIntent(
      { method: "GET", url: "https://api.example.com/v1/things" },
      policy,
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("DENY_NETWORK_MODE_NONE");
  });

  it("decision payload never includes the raw url, headers, or query string", () => {
    const policy = parseSandboxNetworkPolicy({
      mode: "egress_allowlist",
      egressAllowlist: ["api.example.com"],
    });
    const decision = evaluateEgressIntent(
      {
        method: "POST",
        url: "https://api.example.com/v1/secrets?token=leaktoken&id=42",
        headers: { Authorization: "Bearer secret-bearer-zzzz" },
      },
      policy,
    );
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain("leaktoken");
    expect(serialized).not.toContain("secret-bearer-zzzz");
    expect(serialized).not.toContain("/v1/secrets");
    expect(serialized).not.toContain("?token=");
  });
});
