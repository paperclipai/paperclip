import { describe, it, expect } from "vitest";
import { buildCiliumNetworkPolicyManifest } from "../../src/cilium-network-policy.js";

describe("buildCiliumNetworkPolicyManifest", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    paperclipServerNamespace: "paperclip",
    egressAllowFqdns: ["api.anthropic.com"],
    egressAllowCidrs: [] as Array<string | { cidr: string; ports?: number[] }>,
  };

  it("returns a CiliumNetworkPolicy with the correct apiVersion and kind", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    expect(cnp.apiVersion).toBe("cilium.io/v2");
    expect(cnp.kind).toBe("CiliumNetworkPolicy");
  });

  it("targets agent pods by role label", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    expect(cnp.spec.endpointSelector.matchLabels["paperclip.io/role"]).toBe("agent");
  });

  it("includes an FQDN allow rule for each adapter FQDN", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowFqdns: ["api.anthropic.com", "api.openai.com"],
    });
    const fqdnRule = cnp.spec.egress.find((e: { toFQDNs?: { matchName: string }[] }) => e.toFQDNs);
    expect(fqdnRule).toBeDefined();
    expect(fqdnRule.toFQDNs.map((f: { matchName: string }) => f.matchName).sort()).toEqual([
      "api.anthropic.com",
      "api.openai.com",
    ]);
  });

  it("permits DNS to kube-dns explicitly so FQDN resolution can happen", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    const dnsRule = cnp.spec.egress.find((e: { toPorts?: { ports: { port: string }[] }[] }) =>
      e.toPorts?.some((tp) => tp.ports.some((p) => p.port === "53")),
    );
    expect(dnsRule).toBeDefined();
  });

  it("includes a rule for paperclip-server callback", () => {
    const cnp = buildCiliumNetworkPolicyManifest(baseInput);
    const cb = cnp.spec.egress.find((e: { toEndpoints?: { matchLabels: Record<string, string> }[] }) =>
      e.toEndpoints?.some((ep) => ep.matchLabels.app === "paperclip-server"),
    );
    expect(cb).toBeDefined();
  });

  it("includes user-supplied CIDRs in toCIDRSet rule", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowCidrs: ["10.0.0.0/8"],
    });
    const cidrRule = cnp.spec.egress.find((e: { toCIDRSet?: { cidr: string }[] }) => e.toCIDRSet);
    expect(cidrRule.toCIDRSet[0].cidr).toBe("10.0.0.0/8");
    expect(cidrRule.toPorts).toEqual([{ ports: [{ port: "443", protocol: "TCP" }] }]);
  });

  it("supports custom TCP ports for CIDR entries", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowCidrs: [{ cidr: "10.10.0.5/32", ports: [8080, 8443] }],
    });
    const cidrRule = cnp.spec.egress.find((e: { toCIDRSet?: { cidr: string }[] }) => e.toCIDRSet);
    expect(cidrRule.toCIDRSet[0].cidr).toBe("10.10.0.5/32");
    expect(cidrRule.toPorts).toEqual([
      { ports: [{ port: "8080", protocol: "TCP" }, { port: "8443", protocol: "TCP" }] },
    ]);
  });
});
