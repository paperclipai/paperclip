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

  it("defaults podUnschedulableGraceSec to 120", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.podUnschedulableGraceSec).toBe(120);
  });

  it("accepts a custom podUnschedulableGraceSec", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      podUnschedulableGraceSec: 30,
    });
    expect(parsed.podUnschedulableGraceSec).toBe(30);
  });

  it("rejects a non-positive podUnschedulableGraceSec", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, podUnschedulableGraceSec: 0 }),
    ).toThrow();
  });

  it("defaults podReadyTimeoutSec to 300", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.podReadyTimeoutSec).toBe(300);
  });

  it("accepts a custom podReadyTimeoutSec", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      podReadyTimeoutSec: 60,
      podUnschedulableGraceSec: 30,
    });
    expect(parsed.podReadyTimeoutSec).toBe(60);
    expect(parsed.podUnschedulableGraceSec).toBe(30);
  });

  it("rejects a non-positive podReadyTimeoutSec", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, podReadyTimeoutSec: -5 }),
    ).toThrow();
  });

  it("rejects podUnschedulableGraceSec >= podReadyTimeoutSec (would silently disable unschedulable detection)", () => {
    // Grace raised above the ready timeout: the readiness wait would expire first.
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        podUnschedulableGraceSec: 400,
        podReadyTimeoutSec: 300,
      }),
    ).toThrow(/podUnschedulableGraceSec must be less than podReadyTimeoutSec/);
    // Equal values: grace can never elapse strictly before the deadline.
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        podUnschedulableGraceSec: 300,
        podReadyTimeoutSec: 300,
      }),
    ).toThrow(/podUnschedulableGraceSec must be less than podReadyTimeoutSec/);
    // Ready timeout lowered below the default grace without adjusting it.
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, podReadyTimeoutSec: 60 }),
    ).toThrow(/podUnschedulableGraceSec must be less than podReadyTimeoutSec/);
  });

  it("accepts a raised podUnschedulableGraceSec when podReadyTimeoutSec is raised with it", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      podUnschedulableGraceSec: 400,
      podReadyTimeoutSec: 900,
    });
    expect(parsed.podUnschedulableGraceSec).toBe(400);
    expect(parsed.podReadyTimeoutSec).toBe(900);
  });
});
