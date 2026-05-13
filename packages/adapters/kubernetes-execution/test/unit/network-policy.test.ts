import { describe, it, expect } from "vitest";
import { buildDefaultDenyPolicies, buildAgentEgressPolicy } from "../../src/orchestrator/network-policy.js";

describe("buildDefaultDenyPolicies", () => {
  it("emits two NetworkPolicies, one for ingress and one for egress, with empty podSelector", () => {
    const policies = buildDefaultDenyPolicies({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
    });
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      expect(p.spec?.podSelector).toEqual({});
      expect(p.metadata?.namespace).toBe("paperclip-acme");
      expect(p.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
    }
    expect(policies[0].spec?.policyTypes).toContain("Ingress");
    expect(policies[1].spec?.policyTypes).toContain("Egress");
  });
});

describe("buildAgentEgressPolicy", () => {
  it("denies RFC1918 + link-local + CGNAT in the IPv4 internet rule and IPv6 ULA in the IPv6 rule", () => {
    const p = buildAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      topology: "in-cluster",
      controlPlaneSelector: {
        namespaceLabel: { "paperclip.ai/role": "control-plane" },
        podLabel: { "app.kubernetes.io/name": "paperclip-server" },
      },
    });
    const internetRule = p.spec?.egress?.find(e => e.to?.some(t => t.ipBlock));
    expect(internetRule).toBeDefined();
    // IPv4 block: 0.0.0.0/0 with IPv4-only exceptions
    const ipv4Block = internetRule!.to!.find(t => t.ipBlock?.cidr === "0.0.0.0/0")!.ipBlock!;
    expect(ipv4Block.except).toEqual(expect.arrayContaining([
      "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
      "169.254.0.0/16", "100.64.0.0/10",
    ]));
    expect(ipv4Block.except).not.toContain("fd00::/8");
    // IPv6 block: ::/0 with IPv6 ULA exception
    const ipv6Block = internetRule!.to!.find(t => t.ipBlock?.cidr === "::/0")!.ipBlock!;
    expect(ipv6Block.except).toContain("fd00::/8");
  });

  it("includes a DNS egress rule on UDP and TCP port 53 to kube-dns", () => {
    const p = buildAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      topology: "cross-cluster", controlPlaneSelector: null,
    });
    const dnsRule = p.spec?.egress?.find(e =>
      e.to?.some(t => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "kube-system"),
    );
    expect(dnsRule).toBeDefined();
    expect(dnsRule!.ports).toEqual(expect.arrayContaining([
      { port: 53, protocol: "UDP" }, { port: 53, protocol: "TCP" },
    ]));
  });

  it("omits the in-cluster control plane rule for cross-cluster topology", () => {
    const p = buildAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      topology: "cross-cluster",
      controlPlaneSelector: null,
    });
    expect(p.spec?.egress?.some(e =>
      e.to?.some(t => t.namespaceSelector?.matchLabels?.["paperclip.ai/role"] === "control-plane"),
    )).toBe(false);
  });

  it("targets only pods labeled paperclip.ai/role=agent-runtime", () => {
    const p = buildAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      topology: "in-cluster",
      controlPlaneSelector: { namespaceLabel: {}, podLabel: {} },
    });
    expect(p.spec?.podSelector?.matchLabels?.["paperclip.ai/role"]).toBe("agent-runtime");
    expect(p.spec?.policyTypes).toEqual(["Egress"]);
  });
});
