import { describe, it, expect } from "vitest";
import { createKubernetesApiClient } from "../../src/client.js";

describe("createKubernetesApiClient", () => {
  it("constructs a client from a kubeconfig blob", () => {
    const kubeconfig = `
apiVersion: v1
kind: Config
clusters:
  - name: kind
    cluster:
      server: https://127.0.0.1:6443
      insecure-skip-tls-verify: true
contexts:
  - name: kind
    context:
      cluster: kind
      user: kind
current-context: kind
users:
  - name: kind
    user:
      token: x
`;
    const client = createKubernetesApiClient({
      id: "c-1",
      label: "test",
      kind: "kubeconfig",
      kubeconfigYaml: kubeconfig,
      defaultNamespacePrefix: "paperclip-",
      allowAgentImageOverride: false,
      capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
    });
    expect(client.core).toBeDefined();
    expect(client.batch).toBeDefined();
    expect(client.networking).toBeDefined();
    expect(client.rbac).toBeDefined();
    expect(client.apiext).toBeDefined();
    expect(client.describe()).toContain("kind");
  });

  it("rejects an in-cluster connection when not running in a pod", () => {
    expect(() =>
      createKubernetesApiClient({
        id: "c-1",
        label: "test",
        kind: "in-cluster",
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      }),
    ).toThrow(/in-cluster/i);
  });

  it("rejects kubeconfig kind without yaml", () => {
    expect(() =>
      createKubernetesApiClient({
        id: "c-1",
        label: "test",
        kind: "kubeconfig",
        defaultNamespacePrefix: "paperclip-",
        allowAgentImageOverride: false,
        capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
      }),
    ).toThrow(/kubeconfig/i);
  });
});
