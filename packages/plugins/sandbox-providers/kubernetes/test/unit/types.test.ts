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

  it("defaults the per-company quota to 20 pods and the pod-ready budget to 90 s", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.resourceQuota).toEqual({
      pods: "20",
      requestsCpu: "5",
      requestsMemory: "10Gi",
      limitsCpu: "40",
      limitsMemory: "80Gi",
    });
    expect(parsed.podReadyTimeoutSec).toBe(90);
  });

  it("lets a partial resourceQuota override individual fields", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      resourceQuota: { pods: "3", limitsCpu: "6" },
      podReadyTimeoutSec: 45,
    });
    expect(parsed.resourceQuota.pods).toBe("3");
    expect(parsed.resourceQuota.limitsCpu).toBe("6");
    // Unset fields are derived from pods (3 x 4Gi), not from the 20-pod default.
    expect(parsed.resourceQuota.limitsMemory).toBe("12Gi");
    expect(parsed.resourceQuota.requestsCpu).toBe("750m");
    expect(parsed.podReadyTimeoutSec).toBe(45);
  });

  it("treats the exact old default tuple saved by the first plugin version as unset", () => {
    const old = { pods: "20", requestsCpu: "10", requestsMemory: "20Gi", limitsCpu: "20", limitsMemory: "40Gi" };
    expect(parseKubernetesProviderConfig({ inCluster: true, resourceQuota: old }).resourceQuota).toEqual({
      pods: "20", requestsCpu: "5", requestsMemory: "10Gi", limitsCpu: "40", limitsMemory: "80Gi",
    });
    // Only `pods` raised under the old version: the stored old CPU/memory follow pods.
    expect(
      parseKubernetesProviderConfig({ inCluster: true, resourceQuota: { ...old, pods: "30" } }).resourceQuota,
    ).toMatchObject({ pods: "30", limitsCpu: "60", limitsMemory: "120Gi" });
    // A deliberate partial override of the old tuple is still honored.
    expect(
      parseKubernetesProviderConfig({ inCluster: true, resourceQuota: { ...old, limitsCpu: "30" } }).resourceQuota.limitsCpu,
    ).toBe("30");
  });

  it("derives every CPU and memory cap from the pod cap so every allowed pod fits", () => {
    const q = parseKubernetesProviderConfig({ inCluster: true, resourceQuota: { pods: "30" } }).resourceQuota;
    expect(q).toEqual({ pods: "30", requestsCpu: "7500m", requestsMemory: "15Gi", limitsCpu: "60", limitsMemory: "120Gi" });
  });

  it("rejects an invalid pod quota or quantity", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, resourceQuota: { pods: "0" } }),
    ).toThrow();
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, resourceQuota: { limitsMemory: "lots" } }),
    ).toThrow();
  });

  it("defaults the reusable pod idle TTL to 5 minutes and accepts the host's override", () => {
    expect(parseKubernetesProviderConfig({ inCluster: true }).runnerIdleTimeoutMs).toBe(300_000);
    expect(
      parseKubernetesProviderConfig({ inCluster: true, runnerIdleTimeoutMs: 120_000 }),
    ).toMatchObject({ runnerIdleTimeoutMs: 120_000 });
  });

  it("leaves conversationPodReuse unset by default, so unset means ON (only false disables)", () => {
    expect(parseKubernetesProviderConfig({ inCluster: true }).conversationPodReuse).toBeUndefined();
    expect(parseKubernetesProviderConfig({ inCluster: true, conversationPodReuse: false }).conversationPodReuse).toBe(false);
  });

  it("keeps the host-owned reuse flags through parsing (they would otherwise be stripped on save)", () => {
    expect(
      parseKubernetesProviderConfig({ inCluster: true, reuseLease: true, reuseLeaseScope: "conversations" }),
    ).toMatchObject({ reuseLease: true, reuseLeaseScope: "conversations" });
  });
});
