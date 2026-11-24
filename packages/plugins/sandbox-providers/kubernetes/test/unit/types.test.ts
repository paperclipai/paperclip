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
});

describe("extraVolumes, extraVolumeMounts and extraEnv", () => {
  const mirror = { name: "git-mirror", persistentVolumeClaim: { claimName: "git-mirror", readOnly: true } };
  const mirrorMount = { name: "git-mirror", mountPath: "/mnt/git-mirror", readOnly: true };
  const parse = (extra: Record<string, unknown>) => parseKubernetesProviderConfig({ inCluster: true, ...extra });

  it("defaults to none", () => {
    const parsed = parse({});
    expect(parsed.extraVolumes).toEqual([]);
    expect(parsed.extraVolumeMounts).toEqual([]);
    expect(parsed.extraEnv).toEqual([]);
  });

  it("passes a volume, its mount and env through unchanged", () => {
    const parsed = parse({
      extraVolumes: [mirror],
      extraVolumeMounts: [mirrorMount],
      extraEnv: [{ name: "GIT_MIRROR", value: "/mnt/git-mirror" }],
    });
    expect(parsed.extraVolumes).toEqual([mirror]);
    expect(parsed.extraVolumeMounts).toEqual([mirrorMount]);
    expect(parsed.extraEnv).toEqual([{ name: "GIT_MIRROR", value: "/mnt/git-mirror" }]);
  });

  it.each([
    ["a source the restricted profile refuses", { extraVolumes: [{ name: "host", hostPath: { path: "/" } }] }, /hostPath/],
    ["no source", { extraVolumes: [{ name: "empty" }] }, /exactly one volume source/],
    ["two sources", { extraVolumes: [{ name: "two", emptyDir: {}, configMap: { name: "x" } }] }, /exactly one/],
    ["a built-in volume name", { extraVolumes: [{ name: "tmp", emptyDir: {} }] }, /built-in volume name/],
    ["a volume declared twice", { extraVolumes: [mirror, mirror] }, /declared twice/],
    ["a mount of an undeclared volume", { extraVolumeMounts: [mirrorMount] }, /does not name an extra volume/],
    [
      "a mount over a built-in path",
      { extraVolumes: [mirror], extraVolumeMounts: [{ name: "git-mirror", mountPath: "/workspace/" }] },
      /is reserved/,
    ],
    [
      "a mount over the root",
      { extraVolumes: [mirror], extraVolumeMounts: [{ name: "git-mirror", mountPath: "//" }] },
      /is reserved/,
    ],
    [
      "a relative mount path",
      { extraVolumes: [mirror], extraVolumeMounts: [{ name: "git-mirror", mountPath: "mnt" }] },
      /absolute/,
    ],
    [
      "an unknown mount field",
      { extraVolumes: [mirror], extraVolumeMounts: [{ ...mirrorMount, mountPropagation: "Bidirectional" }] },
      /mountPropagation/,
    ],
    ["HOME in extraEnv", { extraEnv: [{ name: "HOME", value: "/x" }] }, /HOME/],
    ["env set twice", { extraEnv: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }, /set twice/],
    ["env from a secret (valueFrom)", { extraEnv: [{ name: "A", valueFrom: {} }] }, /./],
  ])("rejects %s", (_why, extra, message) => {
    expect(() => parse(extra)).toThrow(message);
  });
});
