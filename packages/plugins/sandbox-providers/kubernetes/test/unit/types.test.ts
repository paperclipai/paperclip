import { describe, it, expect } from "vitest";
import { kubernetesProviderConfigSchema, parseKubernetesProviderConfig } from "../../src/types.js";

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with no kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
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

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: ["not-a-cidr"] }),
    ).toThrow(/CIDR/i);
  });

  it("defaults reuseLease to false so existing environments keep tearing down on release", () => {
    expect(parseKubernetesProviderConfig({ inCluster: true }).reuseLease).toBe(false);
  });

  it("keeps an operator-set reuseLease through normalization", () => {
    // The schema strips keys it does not declare, so an undeclared reuseLease
    // would be dropped before the plugin's release path could ever read it.
    expect(parseKubernetesProviderConfig({ inCluster: true, reuseLease: true }).reuseLease).toBe(true);
  });
});
