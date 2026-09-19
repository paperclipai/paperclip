import { describe, it, expect } from "vitest";
import {
  HOST_MAX_RPC_TIMEOUT_MS,
  kubernetesProviderConfigSchema,
  parseKubernetesProviderConfig,
} from "../../src/types.js";

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

  it("keeps timeoutMs, the RPC budget paperclip-server reads off the config", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true, timeoutMs: 180_000 });
    expect(parsed.timeoutMs).toBe(180_000);
  });

  it("leaves timeoutMs absent when it is not configured (server default applies)", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.timeoutMs).toBeUndefined();
  });

  it("rejects a non-positive or non-integer timeoutMs", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: true, timeoutMs: 0 })).toThrow();
    expect(() => parseKubernetesProviderConfig({ inCluster: true, timeoutMs: 1.5 })).toThrow();
  });

  // paperclip-server clamps every plugin RPC at 15 minutes, so a larger budget
  // cannot take effect. Reject it at save time instead of accepting a value the
  // host will silently shorten.
  it("accepts the largest timeoutMs the host can honor", () => {
    expect(
      parseKubernetesProviderConfig({ inCluster: true, timeoutMs: HOST_MAX_RPC_TIMEOUT_MS }).timeoutMs,
    ).toBe(900_000);
  });

  it("rejects a timeoutMs above the host RPC ceiling", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, timeoutMs: HOST_MAX_RPC_TIMEOUT_MS + 1 }),
    ).toThrow(/15 minutes/);
  });

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: ["not-a-cidr"] }),
    ).toThrow(/CIDR/i);
  });
});
