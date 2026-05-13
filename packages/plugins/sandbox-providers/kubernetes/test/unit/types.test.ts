import { describe, it, expect } from "vitest";
import { kubernetesProviderConfigSchema, parseKubernetesProviderConfig } from "../../src/types.js";

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with no kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
    expect(parsed.paperclipServerNamespace).toBe("paperclip");
    expect(parsed.imageAllowList).toEqual([]);
    expect(parsed.egressMode).toBe("standard");
    expect(parsed.jobTtlSecondsAfterFinished).toBe(900);
  });

  it("accepts inline kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: false,
      kubeconfig: "apiVersion: v1\nkind: Config\n",
    });
    expect(parsed.kubeconfig).toContain("apiVersion");
  });

  it("rejects when neither inCluster nor any kubeconfig source is set", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: false })).toThrow(
      /requires one of `inCluster` or `kubeconfig`/,
    );
  });

  it("rejects invalid companySlug", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, companySlug: "INVALID UPPER" }),
    ).toThrow();
  });

  it("bounds namespacePrefix and companySlug so their combination fits a Kubernetes namespace", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, namespacePrefix: "a".repeat(21) }),
    ).toThrow();
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, companySlug: "a".repeat(44) }),
    ).toThrow();
  });

  it("accepts a custom paperclip-server namespace", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      paperclipServerNamespace: "paperclip-prod",
    });
    expect(parsed.paperclipServerNamespace).toBe("paperclip-prod");
  });

  it("rejects invalid paperclip-server namespace values", () => {
    for (const namespace of ["Paperclip", "paperclip_", "-paperclip", "paperclip-"]) {
      expect(() =>
        parseKubernetesProviderConfig({
          inCluster: true,
          paperclipServerNamespace: namespace,
        }),
      ).toThrow();
    }
  });

  it("rejects whitespace-only kubeconfig", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: false, kubeconfig: "   " }),
    ).toThrow(/requires one of `inCluster` or `kubeconfig`/);
  });

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: ["not-a-cidr"] }),
    ).toThrow(/CIDR/i);
  });

  it("rejects CIDRs with invalid octets or prefixes", () => {
    for (const cidr of ["999.0.0.0/8", "10.0.0.0/99", "10.0.0/24"]) {
      expect(() =>
        parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: [cidr] }),
      ).toThrow(/CIDR/i);
    }
  });
});
