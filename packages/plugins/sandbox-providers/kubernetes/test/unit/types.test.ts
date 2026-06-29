import { describe, it, expect } from "vitest";
import { kubernetesProviderConfigSchema, parseKubernetesProviderConfig } from "../../src/types.js";

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with no kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
    expect(parsed.runtimeImages).toEqual({});
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

  it("accepts per-adapter runtime image overrides", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      runtimeImages: {
        claude_local: "ghcr.io/paperclipai/agent-runtime-claude:git-b18cbb0dd3d524d3d332f54143c84f00c694636c",
      },
    });
    expect(parsed.runtimeImages.claude_local).toBe(
      "ghcr.io/paperclipai/agent-runtime-claude:git-b18cbb0dd3d524d3d332f54143c84f00c694636c",
    );
  });

  it("accepts runtime image overrides for declared adapter registry entries", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      adapters: [
        {
          adapterType: "custom_local",
          runtimeImage: "registry.example/custom:v1",
        },
      ],
      runtimeImages: {
        custom_local: "registry.example/custom:git-b18cbb0",
      },
    });

    expect(parsed.runtimeImages.custom_local).toBe("registry.example/custom:git-b18cbb0");
  });

  it("rejects runtime image overrides for unknown adapter keys", () => {
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        runtimeImages: {
          claude_locall: "ghcr.io/paperclipai/agent-runtime-claude:git-b18cbb0",
        },
      }),
    ).toThrow(/runtimeImages keys must match a known adapter type/);
  });

  it("rejects blank runtime image override values", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, runtimeImages: { claude_local: "   " } }),
    ).toThrow();
  });
});
