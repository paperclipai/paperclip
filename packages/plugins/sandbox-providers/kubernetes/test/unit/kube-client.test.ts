import { describe, it, expect, vi } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";
import { createKubeConfig } from "../../src/kube-client.js";

describe("createKubeConfig", () => {
  it("loads from inline kubeconfig string", () => {
    const yaml = `apiVersion: v1
kind: Config
clusters:
  - name: test
    cluster:
      server: https://fake.example.com
contexts:
  - name: test
    context:
      cluster: test
      user: test
current-context: test
users:
  - name: test
    user:
      token: fake-token
`;
    const kc = createKubeConfig({ inCluster: false, kubeconfig: yaml });
    expect(kc.getCurrentContext()).toBe("test");
    expect(kc.getCurrentCluster()?.server).toBe("https://fake.example.com");
  });

  it("loads from-cluster config when inCluster=true", () => {
    const spy = vi.spyOn(KubeConfig.prototype, "loadFromCluster").mockImplementation(function (this: KubeConfig) {
      this.loadFromString(`apiVersion: v1
kind: Config
clusters: [{name: in-cluster, cluster: {server: 'https://kubernetes.default.svc'}}]
contexts: [{name: in-cluster, context: {cluster: in-cluster, user: in-cluster}}]
current-context: in-cluster
users: [{name: in-cluster, user: {token: tok}}]`);
    });
    const kc = createKubeConfig({ inCluster: true });
    expect(spy).toHaveBeenCalledOnce();
    expect(kc.getCurrentContext()).toBe("in-cluster");
    spy.mockRestore();
  });

  it("throws when neither inCluster nor kubeconfig string is provided", () => {
    expect(() => createKubeConfig({ inCluster: false })).toThrow(/requires/i);
  });
});
