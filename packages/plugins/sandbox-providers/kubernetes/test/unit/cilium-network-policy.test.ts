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

  it("targets a configured callback endpoint selector instead of the default", () => {
    const cnp = buildCiliumNetworkPolicyManifest({ ...baseInput, paperclipServerPodSelector: { app: "paperclip" } });
    const cb = cnp.spec.egress.find((e: { toEndpoints?: { matchLabels: Record<string, string> }[] }) =>
      e.toEndpoints?.some((ep) => ep.matchLabels.app === "paperclip"));
    expect(cb.toEndpoints[0].matchLabels).toEqual({ "k8s:io.kubernetes.pod.namespace": "paperclip", app: "paperclip" });
    expect(cb.toPorts[0].ports).toEqual([{ port: "3100", protocol: "TCP" }]);
  });

  it("does not let a callback selector override the server namespace", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      paperclipServerPodSelector: { app: "paperclip", "k8s:io.kubernetes.pod.namespace": "other" },
    });
    expect(cnp.spec.egress[2].toEndpoints[0].matchLabels["k8s:io.kubernetes.pod.namespace"]).toBe("paperclip");
  });

  it("includes user-supplied CIDRs in toCIDRSet rule", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      egressAllowCidrs: ["10.0.0.0/8"],
    });
    const cidrRule = cnp.spec.egress.find((e: { toCIDRSet?: { cidr: string }[] }) => e.toCIDRSet);
    expect(cidrRule.toCIDRSet[0].cidr).toBe("10.0.0.0/8");
  });

  it("targets only the granted run when building a scoped policy", () => {
    const cnp = buildCiliumNetworkPolicyManifest({
      ...baseInput,
      name: "pc-run-egress",
      endpointSelector: { "paperclip.io/run-id": "run-123" },
      includeBaseRules: false,
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "pc-run", uid: "uid-1" }],
      egressAllowFqdns: ["github.com", "pypi.org"],
    });

    expect(cnp.metadata.name).toBe("pc-run-egress");
    expect(cnp.metadata.ownerReferences).toHaveLength(1);
    expect(cnp.spec.endpointSelector.matchLabels).toEqual({ "paperclip.io/run-id": "run-123" });
    expect(cnp.spec.egress).toHaveLength(1);
  });
});
