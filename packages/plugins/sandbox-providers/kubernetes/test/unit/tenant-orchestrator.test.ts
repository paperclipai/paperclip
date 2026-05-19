import { describe, it, expect, vi } from "vitest";
import { ensureTenant } from "../../src/tenant-orchestrator.js";

function makeMockClients() {
  const calls: { kind: string; name: string; namespace?: string; body?: unknown }[] = [];
  function track(kind: string) {
    return vi.fn(async (...args: unknown[]) => {
      const arg = (args[0] ?? {}) as { name?: string; namespace?: string; body?: unknown };
      calls.push({ kind, name: arg.name ?? "", namespace: arg.namespace, body: arg.body });
      return { body: arg.body };
    });
  }
  return {
    calls,
    core: {
      createNamespace: track("Namespace"),
      readNamespacedServiceAccount: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedServiceAccount: track("ServiceAccount"),
      replaceNamespacedServiceAccount: track("ServiceAccountReplace"),
      readNamespacedResourceQuota: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedResourceQuota: track("ResourceQuota"),
      replaceNamespacedResourceQuota: track("ResourceQuotaReplace"),
      readNamespacedLimitRange: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedLimitRange: track("LimitRange"),
      replaceNamespacedLimitRange: track("LimitRangeReplace"),
      readNamespace: vi.fn().mockRejectedValue({ code: 404 }),
      replaceNamespace: track("NamespaceReplace"),
    },
    rbac: {
      readNamespacedRole: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedRole: track("Role"),
      replaceNamespacedRole: track("RoleReplace"),
      readNamespacedRoleBinding: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedRoleBinding: track("RoleBinding"),
      replaceNamespacedRoleBinding: track("RoleBindingReplace"),
    },
    networking: {
      readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedNetworkPolicy: track("NetworkPolicy"),
      replaceNamespacedNetworkPolicy: track("NetworkPolicyReplace"),
      deleteNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedCustomObject: track("CiliumNetworkPolicy"),
      replaceNamespacedCustomObject: track("CiliumNetworkPolicyReplace"),
      deleteNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    },
  };
}

describe("ensureTenant", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    companyId: "11111111-1111-1111-1111-111111111111",
    paperclipServerNamespace: "paperclip",
    serviceAccountAnnotations: {},
    egressMode: "standard" as const,
    egressAllowFqdns: ["api.anthropic.com"],
    egressAllowCidrs: [] as string[],
    resourceQuota: { pods: "20", requestsCpu: "5", requestsMemory: "20Gi", limitsCpu: "20", limitsMemory: "80Gi" },
  };

  it("creates all required resources in the correct order on a fresh tenant", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, baseInput);
    const order = clients.calls.map((c) => c.kind);
    expect(order).toEqual([
      "Namespace",
      "ServiceAccount",
      "Role",
      "RoleBinding",
      "ResourceQuota",
      "LimitRange",
      "NetworkPolicy",
      "NetworkPolicy",
    ]);
  });

  it("creates a CiliumNetworkPolicy instead of standard egress when egressMode=cilium", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, { ...baseInput, egressMode: "cilium" });
    const cnpCall = clients.calls.find((c) => c.kind === "CiliumNetworkPolicy");
    expect(cnpCall).toBeDefined();
    const npCalls = clients.calls.filter((c) => c.kind === "NetworkPolicy");
    expect(npCalls).toHaveLength(1);
    expect((npCalls[0].body as { metadata: { name: string } }).metadata.name).toBe("paperclip-deny-all");
  });

  it("applies serviceAccountAnnotations to the ServiceAccount", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, {
      ...baseInput,
      serviceAccountAnnotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123:role/paperclip" },
    });
    const saCall = clients.calls.find((c) => c.kind === "ServiceAccount");
    const sa = saCall!.body as { metadata: { annotations: Record<string, string> } };
    expect(sa.metadata.annotations["eks.amazonaws.com/role-arn"]).toBe("arn:aws:iam::123:role/paperclip");
  });

  it("reconciles a namespace that already exists", async () => {
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue({
      metadata: {
        name: baseInput.namespace,
        resourceVersion: "rv-namespace",
        labels: { "operator.example.com/team": "infra" },
      },
    });
    await ensureTenant(clients as never, baseInput);
    expect(clients.core.createNamespace).not.toHaveBeenCalled();
    expect(clients.core.replaceNamespace).toHaveBeenCalledWith({
      name: baseInput.namespace,
      body: expect.objectContaining({
        metadata: expect.objectContaining({
          resourceVersion: "rv-namespace",
          labels: expect.objectContaining({
            "operator.example.com/team": "infra",
            "paperclip.io/company-id": baseInput.companyId,
            "paperclip.io/managed-by": "paperclip-k8s-plugin",
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/audit": "restricted",
            "pod-security.kubernetes.io/warn": "restricted",
          }),
        }),
      }),
    });
  });

  it("reconciles existing managed resources with the latest desired manifests", async () => {
    const clients = makeMockClients();
    const existing = { metadata: { resourceVersion: "rv-1" } };
    clients.core.readNamespace.mockResolvedValue({ metadata: { name: baseInput.namespace, resourceVersion: "rv-ns" } });
    clients.core.readNamespacedServiceAccount.mockResolvedValue(existing);
    clients.rbac.readNamespacedRole.mockResolvedValue(existing);
    clients.rbac.readNamespacedRoleBinding.mockResolvedValue(existing);
    clients.core.readNamespacedResourceQuota.mockResolvedValue(existing);
    clients.core.readNamespacedLimitRange.mockResolvedValue(existing);
    clients.networking.readNamespacedNetworkPolicy.mockResolvedValue(existing);

    await ensureTenant(clients as never, {
      ...baseInput,
      serviceAccountAnnotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123:role/paperclip" },
      resourceQuota: { ...baseInput.resourceQuota, pods: "25" },
    });

    expect(clients.core.replaceNamespacedServiceAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            annotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::123:role/paperclip" },
            resourceVersion: "rv-1",
          }),
        }),
      }),
    );
    expect(clients.core.replaceNamespacedResourceQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: "rv-1" }),
          spec: expect.objectContaining({ hard: expect.objectContaining({ pods: "25" }) }),
        }),
      }),
    );
    expect(clients.networking.replaceNamespacedNetworkPolicy).toHaveBeenCalled();
    expect(clients.core.replaceNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            resourceVersion: "rv-ns",
            labels: expect.objectContaining({
              "pod-security.kubernetes.io/enforce": "restricted",
            }),
          }),
        }),
      }),
    );
  });

  it("removes stale standard egress NetworkPolicy when cilium mode is selected", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, { ...baseInput, egressMode: "cilium" });
    expect(clients.networking.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith({
      namespace: baseInput.namespace,
      name: "paperclip-egress-allow",
    });
  });

  it("handles concurrent first-run create conflicts by rereading and replacing managed resources", async () => {
    const clients = makeMockClients();
    const existing = { metadata: { resourceVersion: "rv-race" } };
    clients.core.createNamespace.mockRejectedValueOnce({ code: 409 });
    clients.core.readNamespace
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValue({ metadata: { resourceVersion: "rv-namespace-race" } });
    clients.core.readNamespacedServiceAccount
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValue(existing);
    clients.core.createNamespacedServiceAccount.mockRejectedValueOnce({ code: 409 });

    await ensureTenant(clients as never, baseInput);

    expect(clients.core.createNamespace).toHaveBeenCalled();
    expect(clients.core.replaceNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: "rv-namespace-race" }),
        }),
      }),
    );
    expect(clients.core.replaceNamespacedServiceAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: "rv-race" }),
        }),
      }),
    );
  });

  it("retries stale replace conflicts with a fresh resourceVersion", async () => {
    const clients = makeMockClients();
    clients.core.readNamespace
      .mockResolvedValueOnce({ metadata: { name: baseInput.namespace, resourceVersion: "rv-stale" } })
      .mockResolvedValueOnce({ metadata: { name: baseInput.namespace, resourceVersion: "rv-fresh" } });
    clients.core.replaceNamespace
      .mockRejectedValueOnce({ code: 409 })
      .mockResolvedValueOnce({ body: {} });

    await ensureTenant(clients as never, baseInput);

    expect(clients.core.replaceNamespace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: "rv-stale" }),
        }),
      }),
    );
    expect(clients.core.replaceNamespace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ resourceVersion: "rv-fresh" }),
        }),
      }),
    );
  });
});
