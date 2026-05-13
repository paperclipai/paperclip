import { describe, expect, it } from "vitest";
import { buildKubernetesRunContext } from "./kubernetes-run-context.js";
import type { ResolvedClusterConnection } from "@paperclipai/execution-target-kubernetes";

const connection: ResolvedClusterConnection = {
  id: "cluster-1",
  label: "test",
  kind: "kubeconfig",
  kubeconfigYaml: "{}",
  defaultNamespacePrefix: "paperclip-",
  capabilities: {
    cilium: false,
    storageClass: "standard",
    architectures: ["amd64"],
  },
  allowAgentImageOverride: false,
};

describe("buildKubernetesRunContext", () => {
  it("forwards target env overrides and storage settings into the driver context", () => {
    const context = buildKubernetesRunContext({
      companyName: "Example Company",
      connection,
      paperclipApiUrl: "https://paperclip.test",
      target: {
        kind: "kubernetes",
        clusterConnectionId: "cluster-1",
        envOverrides: { NODE_ENV: "test", CUSTOM_FLAG: "1" },
        storage: { sizeGi: 42, storageClass: "fast" },
      },
    });

    expect(context.adapterEnv).toEqual({ NODE_ENV: "test", CUSTOM_FLAG: "1" });
    expect(context.storageSizeGi).toBe(42);
    expect(context.storageClassName).toBe("fast");
  });

  it("only applies image overrides when the cluster connection permits them", () => {
    const blocked = buildKubernetesRunContext({
      companyName: "Example Company",
      connection,
      target: {
        kind: "kubernetes",
        clusterConnectionId: "cluster-1",
        imageOverride: "registry.example/custom-agent:latest",
      },
    });

    const allowed = buildKubernetesRunContext({
      companyName: "Example Company",
      connection: { ...connection, allowAgentImageOverride: true },
      target: {
        kind: "kubernetes",
        clusterConnectionId: "cluster-1",
        imageOverride: "registry.example/custom-agent:latest",
      },
    });

    expect(blocked.image).toBe("ghcr.io/paperclipai/agent-runtime-claude:v1");
    expect(allowed.image).toBe("registry.example/custom-agent:latest");
  });
});
