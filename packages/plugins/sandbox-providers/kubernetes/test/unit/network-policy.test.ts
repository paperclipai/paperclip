import { describe, it, expect } from "vitest";
import { buildNetworkPolicyManifests } from "../../src/network-policy.js";

describe("buildNetworkPolicyManifests", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    paperclipServerNamespace: "paperclip",
    egressAllowCidrs: [] as string[],
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
    const cidrRule = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "10.0.0.0/8"),
    );
    expect(cidrRule).toBeDefined();
  });

  it("uses paperclip-server pod label selector for callback ingress to paperclip ns", () => {
    const [, egress] = buildNetworkPolicyManifests(baseInput);
    const callbackRule = egress.spec.egress.find((r: { to: { podSelector?: { matchLabels?: Record<string, string> } }[] }) =>
      r.to.some((t) => t.podSelector?.matchLabels?.app === "paperclip-server"),
    );
    expect(callbackRule).toBeDefined();
    expect(callbackRule.ports[0].port).toBe(3100);
  });

  it("adds public-IPv4 fallback (with private/link-local excluded) when FQDNs are configured and no CIDRs are supplied", () => {
    const [, egress] = buildNetworkPolicyManifests({
      ...baseInput,
      egressAllowFqdns: ["api.anthropic.com"],
    });
    const fallback = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "0.0.0.0/0"),
    );
    expect(fallback).toBeDefined();
    expect(fallback.to[0].ipBlock.except).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8"]),
    );
    expect(fallback.ports).toEqual(
      expect.arrayContaining([
        { protocol: "TCP", port: 443 },
        { protocol: "TCP", port: 80 },
      ]),
    );
  });

  it("does NOT add the public-IPv4 fallback when operator supplied egressAllowCidrs", () => {
    const [, egress] = buildNetworkPolicyManifests({
      ...baseInput,
      egressAllowFqdns: ["api.anthropic.com"],
      egressAllowCidrs: ["203.0.113.0/24"],
    });
    const fallback = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "0.0.0.0/0"),
    );
    expect(fallback).toBeUndefined();
  });

  it("does NOT add the public-IPv4 fallback when no FQDNs are configured", () => {
    const [, egress] = buildNetworkPolicyManifests(baseInput);
    const fallback = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "0.0.0.0/0"),
    );
    expect(fallback).toBeUndefined();
  });
});
