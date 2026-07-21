import { describe, it, expect } from "vitest";
import { buildCiliumNetworkPolicyManifest } from "../../src/cilium-network-policy.js";

describe("buildCiliumNetworkPolicyManifest", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    paperclipServerNamespace: "paperclip",
    egressAllowFqdns: ["api.anthropic.com"],
    egressAllowCidrs: [] as string[],
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
  });

  describe("egressPolicy open-internet", () => {
    it("emits a hardened public-internet rule on ports 443 and 80", () => {
      const cnp: any = buildCiliumNetworkPolicyManifest({ ...baseInput, egressPolicy: "open-internet" });
      const openRule = cnp.spec.egress.find(
        (rule: any) => rule.toCIDRSet?.some((entry: any) => entry.cidr === "0.0.0.0/0"),
      );
      expect(openRule).toBeDefined();
      const entry = openRule.toCIDRSet.find((candidate: any) => candidate.cidr === "0.0.0.0/0");
      for (const blocked of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8"]) {
        expect(entry.except).toContain(blocked);
      }
      const ports = openRule.toPorts[0].ports.map((p: any) => p.port).sort();
      expect(ports).toEqual(["443", "80"].sort());
    });

    it("keeps kube-dns and paperclip-server rules in open-internet mode", () => {
      const cnp: any = buildCiliumNetworkPolicyManifest({ ...baseInput, egressPolicy: "open-internet" });
      expect(cnp.spec.egress.some((rule: any) => rule.toPorts?.[0]?.rules?.dns)).toBe(true);
      expect(
        cnp.spec.egress.some((rule: any) =>
          rule.toEndpoints?.some((endpoint: any) => endpoint.matchLabels?.app === "paperclip-server"),
        ),
      ).toBe(true);
    });

    it("emits no public-internet rule by default (allowlist)", () => {
      const cnp: any = buildCiliumNetworkPolicyManifest({ ...baseInput });
      expect(
        cnp.spec.egress.some((rule: any) => rule.toCIDRSet?.some((entry: any) => entry.cidr === "0.0.0.0/0")),
      ).toBe(false);
    });
  });
});
