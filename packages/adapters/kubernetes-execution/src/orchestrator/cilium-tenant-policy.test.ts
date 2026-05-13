import { describe, it, expect } from "vitest";
import { buildTenantCiliumPolicy } from "./cilium-tenant-policy.js";

describe("buildTenantCiliumPolicy", () => {
  it("returns null when both arrays are empty (no extra CNP)", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: [],
      egressCidrs: [],
    });
    expect(result).toBeNull();
  });

  it("emits an additional CNP with kube-dns + FQDNs when dnsAllowlist is set", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: ["api.anthropic.com", "github.com"],
      egressCidrs: [],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.metadata.name).toBe("paperclip-tenant-acme-restrict");
    expect(result.metadata.namespace).toBe("paperclip-acme");
    expect(result.spec.endpointSelector.matchLabels["paperclip.ai/managed-by"]).toBe("paperclip");
    // Always-on kube-dns rule preserves DNS resolution for the FQDNs themselves.
    const kubeDnsRule = result.spec.egress.find((r) =>
      r.toEndpoints?.some((e) => e.matchLabels["k8s:k8s-app"] === "kube-dns"),
    );
    expect(kubeDnsRule).toBeDefined();
    // FQDN rule contains the two allowlisted hosts and uses matchName for non-wildcard entries.
    const fqdnRule = result.spec.egress.find((r) => r.toFQDNs);
    expect(fqdnRule?.toFQDNs).toEqual([{ matchName: "api.anthropic.com" }, { matchName: "github.com" }]);
    // FQDN rule mirrors the M1 baseline by pinning to 443/TCP so the
    // tenant policy is self-documenting (no behaviour change because
    // Cilium AND-intersects it with the baseline).
    expect(fqdnRule?.toPorts).toEqual([{ ports: [{ port: "443", protocol: "TCP" }] }]);
  });

  it("uses matchPattern for wildcard FQDNs", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: ["*.linear.app"],
      egressCidrs: [],
    });
    expect(result).not.toBeNull();
    const fqdnRule = result!.spec.egress.find((r) => r.toFQDNs);
    expect(fqdnRule?.toFQDNs).toEqual([{ matchPattern: "*.linear.app" }]);
  });

  it("includes a toCIDR rule when egressCidrs is set", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: [],
      egressCidrs: ["10.42.0.0/16", "172.20.0.0/12"],
    });
    expect(result).not.toBeNull();
    const cidrRule = result!.spec.egress.find((r) => r.toCIDR);
    expect(cidrRule?.toCIDR).toEqual(["10.42.0.0/16", "172.20.0.0/12"]);
    expect(cidrRule?.toPorts).toEqual([{ ports: [{ port: "443", protocol: "TCP" }] }]);
  });

  it("emits both DNS and CIDR rules when both are set", () => {
    const result = buildTenantCiliumPolicy({
      namespace: "paperclip-acme",
      companySlug: "acme",
      dnsAllowlist: ["api.anthropic.com"],
      egressCidrs: ["10.42.0.0/16"],
    });
    expect(result).not.toBeNull();
    expect(result!.spec.egress.some((r) => r.toFQDNs)).toBe(true);
    expect(result!.spec.egress.some((r) => r.toCIDR)).toBe(true);
    expect(result!.spec.egress.some((r) =>
      r.toEndpoints?.some((e) => e.matchLabels["k8s:k8s-app"] === "kube-dns"),
    )).toBe(true);
  });
});
