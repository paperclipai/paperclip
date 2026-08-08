import { describe, it, expect } from "vitest";
import { parseKubernetesProviderConfig, parseRepositoryProxyUrl } from "../../src/types.js";

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

  it("accepts only a credential-free HTTP IPv4 repository proxy with an explicit port", () => {
    expect(parseRepositoryProxyUrl("http://192.168.0.63:3129")).toEqual({
      url: "http://192.168.0.63:3129/",
      cidr: "192.168.0.63/32",
      port: 3129,
    });
    expect(() => parseRepositoryProxyUrl("https://192.168.0.63:3129")).toThrow(/repositoryProxyUrl/);
    expect(() => parseRepositoryProxyUrl("http://user:pass@192.168.0.63:3129")).toThrow(/repositoryProxyUrl/);
    expect(() => parseRepositoryProxyUrl("http://proxy.example.test:3129")).toThrow(/repositoryProxyUrl/);
    expect(() => parseRepositoryProxyUrl("http://192.168.0.63")).toThrow(/repositoryProxyUrl/);
  });
});
