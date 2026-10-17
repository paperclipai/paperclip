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

  it("accepts podAntiAffinity configuration", () => {
    const parsedWithDefault = parseKubernetesProviderConfig({
      inCluster: true,
      podAntiAffinity: { enabled: true },
    });
    expect(parsedWithDefault.podAntiAffinity).toEqual({
      enabled: true,
      topologyKey: undefined,
    });

    const parsedWithCustomTopology = parseKubernetesProviderConfig({
      inCluster: true,
      podAntiAffinity: {
        enabled: true,
        topologyKey: "topology.kubernetes.io/zone",
      },
    });
    expect(parsedWithCustomTopology.podAntiAffinity).toEqual({
      enabled: true,
      topologyKey: "topology.kubernetes.io/zone",
    });
  });

  it("rejects invalid topologyKey in podAntiAffinity", () => {
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        podAntiAffinity: {
          enabled: true,
          topologyKey: "",
        },
      }),
    ).toThrow(/Invalid Kubernetes label key/i);

    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        podAntiAffinity: {
          enabled: true,
          topologyKey: "invalid_prefix//hostname",
        },
      }),
    ).toThrow(/Invalid Kubernetes label key/i);

    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        podAntiAffinity: {
          enabled: true,
          topologyKey: "a".repeat(64),
        },
      }),
    ).toThrow(/cannot exceed 63 characters/i);

    // Multi-segment DNS prefix where each segment is <= 63 chars (valid for k8sLabelKeyRegex)
    // 4 segments of 63 chars + 3 dots = 252 + 3 = 255 chars (> 253 chars max prefix)
    const prefixExceedingLimit = `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(60)}/hostname`; // 63*3 + 3 + 60 = 252 prefix chars (wait: 63+1+63+1+63+1+60 = 252)
    // Let's make exact 253 and 254 chars prefixes:
    // 63*3 + 3 = 192. 253 - 192 = 61. So 63.63.63.61 is 63+1+63+1+63+1+61 = 253 chars.
    const valid253Prefix = `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(61)}`;
    const parsedAtLimit = parseKubernetesProviderConfig({
      inCluster: true,
      podAntiAffinity: {
        enabled: true,
        topologyKey: `${valid253Prefix}/hostname`,
      },
    });
    expect(parsedAtLimit.podAntiAffinity?.topologyKey).toBe(`${valid253Prefix}/hostname`);

    // 254 chars prefix: 63+1+63+1+63+1+62 = 254 chars (> 253 chars)
    const invalid254Prefix = `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(62)}`;
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        podAntiAffinity: {
          enabled: true,
          topologyKey: `${invalid254Prefix}/hostname`,
        },
      }),
    ).toThrow(/prefix cannot exceed 253 characters/i);
  });
});
