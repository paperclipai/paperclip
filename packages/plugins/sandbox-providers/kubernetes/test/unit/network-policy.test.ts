import { describe, it, expect } from "vitest";
import { buildNetworkPolicyManifests } from "../../src/network-policy.js";

describe("buildNetworkPolicyManifests", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    paperclipServerNamespace: "paperclip",
    egressAllowFqdns: [] as string[],
    egressAllowCidrs: [] as Array<string | { cidr: string; ports?: number[] }>,
  };

  it("produces a deny-all + egress allow pair", () => {
    const manifests = buildNetworkPolicyManifests(baseInput);
    expect(manifests).toHaveLength(2);
    expect(manifests[0].metadata.name).toBe("paperclip-deny-all");
    expect(manifests[1].metadata.name).toBe("paperclip-egress-allow");
  });

  it("deny-all has no ingress/egress rules and applies to all pods", () => {
    const [denyAll] = buildNetworkPolicyManifests(baseInput);
    expect(denyAll.spec.podSelector).toEqual({});
    expect(denyAll.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(denyAll.spec.ingress).toBeUndefined();
    expect(denyAll.spec.egress).toBeUndefined();
  });

  it("egress allow includes kube-dns and paperclip-server callback", () => {
    const [, egress] = buildNetworkPolicyManifests(baseInput);
    const rules = egress.spec.egress;
    const dnsRule = rules.find((r: { ports?: { protocol: string; port: number }[] }) =>
      r.ports?.some((p) => p.port === 53),
    );
    expect(dnsRule).toBeDefined();
    const paperclipRule = rules.find((r: { to: { namespaceSelector?: { matchLabels?: Record<string, string> } }[] }) =>
      r.to.some((t) => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "paperclip"),
    );
    expect(paperclipRule).toBeDefined();
  });

  it("includes user-supplied CIDRs in egress allow", () => {
    const [, egress] = buildNetworkPolicyManifests({ ...baseInput, egressAllowCidrs: ["10.0.0.0/8"] });
    const cidrRule = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[]; ports?: { protocol: string; port: number }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "10.0.0.0/8"),
    );
    expect(cidrRule).toBeDefined();
    expect(cidrRule?.ports).toEqual([{ protocol: "TCP", port: 443 }]);
  });

  it("supports custom TCP ports for user-supplied CIDR entries", () => {
    const [, egress] = buildNetworkPolicyManifests({
      ...baseInput,
      egressAllowCidrs: [{ cidr: "10.10.0.5/32", ports: [8080, 8443] }],
    });
    const cidrRule = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "10.10.0.5/32"),
    );
    expect(cidrRule?.ports).toEqual([
      { protocol: "TCP", port: 8080 },
      { protocol: "TCP", port: 8443 },
    ]);
  });

  it("adds a public HTTPS fallback when standard mode receives FQDN allow-list entries", () => {
    const [, egress] = buildNetworkPolicyManifests({ ...baseInput, egressAllowFqdns: ["api.anthropic.com"] });
    const publicHttpsRule = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string; except?: string[] } }[]; ports?: { port: number }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "0.0.0.0/0") && r.ports?.some((p) => p.port === 443),
    );
    expect(publicHttpsRule).toBeDefined();
    expect(publicHttpsRule.to[0].ipBlock.except).toContain("10.0.0.0/8");
  });

  it("uses paperclip-server pod label selector for callback ingress to paperclip ns", () => {
    const [, egress] = buildNetworkPolicyManifests(baseInput);
    const callbackRule = egress.spec.egress.find((r: { to: { podSelector?: { matchLabels?: Record<string, string> } }[] }) =>
      r.to.some((t) => t.podSelector?.matchLabels?.app === "paperclip-server"),
    );
    expect(callbackRule).toBeDefined();
    expect(callbackRule.ports[0].port).toBe(3100);
  });
});
