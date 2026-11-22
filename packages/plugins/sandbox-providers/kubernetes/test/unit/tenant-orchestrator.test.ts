import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearTenantReconcileCache, ensureTenant } from "../../src/tenant-orchestrator.js";

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
      readNamespacedResourceQuota: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedResourceQuota: track("ResourceQuota"),
      readNamespacedLimitRange: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedLimitRange: track("LimitRange"),
      readNamespace: vi.fn().mockRejectedValue({ code: 404 }),
    },
    rbac: {
      readNamespacedRole: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedRole: track("Role"),
      readNamespacedRoleBinding: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedRoleBinding: track("RoleBinding"),
    },
    networking: {
      readNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedNetworkPolicy: track("NetworkPolicy"),
      deleteNamespacedNetworkPolicy: vi.fn().mockRejectedValue({ code: 404 }),
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedCustomObject: track("CiliumNetworkPolicy"),
      deleteNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    },
  };
}

function makeSsaMockClients() {
  const events: string[] = [];
  const applied: Array<{ manifest: Record<string, unknown>; fieldManager?: string }> = [];
  return {
    events,
    applied,
    applyServerSide: vi.fn(async (manifest: Record<string, unknown>, fieldManager?: string) => {
      const kind = String(manifest.kind ?? "");
      const name = String((manifest.metadata as { name?: string } | undefined)?.name ?? "");
      events.push(`apply:${kind}:${name}`);
      applied.push({ manifest, fieldManager });
    }),
    networking: {
      deleteNamespacedNetworkPolicy: vi.fn(async (arg: { name: string }) => {
        events.push(`delete:NetworkPolicy:${arg.name}`);
      }),
    },
    custom: {
      deleteNamespacedCustomObject: vi.fn(async (arg: { name: string }) => {
        events.push(`delete:CiliumNetworkPolicy:${arg.name}`);
      }),
    },
  };
}

beforeEach(() => {
  clearTenantReconcileCache();
});

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

  it("skips creates that already exist (idempotency)", async () => {
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue({ body: { metadata: { name: baseInput.namespace } } });
    await ensureTenant(clients as never, baseInput);
    expect(clients.core.createNamespace).not.toHaveBeenCalled();
  });

  it("tolerates a 409 AlreadyExists from a concurrent ensure for the same tenant", async () => {
    const clients = makeMockClients();
    clients.core.createNamespace.mockRejectedValue({ statusCode: 409 });
    clients.core.createNamespacedServiceAccount.mockRejectedValue({ code: 409 });
    await expect(ensureTenant(clients as never, baseInput)).resolves.not.toThrow();
  });

  it("reconciles all tenant resources via Server-Side Apply and preserves canonical names", async () => {
    const clients = makeSsaMockClients();
    await ensureTenant(clients as never, baseInput);
    expect(clients.applied).toHaveLength(8);
    expect(clients.applied.every((a) => a.fieldManager === "paperclip-k8s-plugin")).toBe(true);
    expect(clients.events).toEqual([
      "apply:Namespace:paperclip-acme",
      "apply:ServiceAccount:paperclip-tenant-sa",
      "apply:Role:paperclip-tenant-role",
      "apply:RoleBinding:paperclip-tenant-rb",
      "apply:ResourceQuota:paperclip-quota",
      "apply:LimitRange:paperclip-limits",
      "apply:NetworkPolicy:paperclip-deny-all",
      "apply:NetworkPolicy:paperclip-egress-allow",
      "delete:CiliumNetworkPolicy:paperclip-egress-fqdn",
    ]);
  });

  it("caches tenant reconciliation for 5 minutes and invalidates on config change or TTL expiry", async () => {
    let clock = 1_000_000;
    const clients = makeSsaMockClients();

    await ensureTenant(clients as never, { ...baseInput, now: () => clock });
    expect(clients.applyServerSide).toHaveBeenCalledTimes(8);

    clock += 60_000;
    await ensureTenant(clients as never, { ...baseInput, now: () => clock });
    expect(clients.applyServerSide).toHaveBeenCalledTimes(8);

    await ensureTenant(clients as never, {
      ...baseInput,
      resourceQuota: { ...baseInput.resourceQuota, pods: "40" },
      now: () => clock,
    });
    expect(clients.applyServerSide).toHaveBeenCalledTimes(16);

    clock += 5 * 60 * 1000 + 1;
    await ensureTenant(clients as never, {
      ...baseInput,
      resourceQuota: { ...baseInput.resourceQuota, pods: "40" },
      now: () => clock,
    });
    expect(clients.applyServerSide).toHaveBeenCalledTimes(24);
  });

  it("applies CiliumNetworkPolicy BEFORE deleting stale standard NetworkPolicy when switching to cilium", async () => {
    const clients = makeSsaMockClients();
    await ensureTenant(clients as never, { ...baseInput, egressMode: "cilium" });
    const applyIdx = clients.events.indexOf("apply:CiliumNetworkPolicy:paperclip-egress-fqdn");
    const deleteIdx = clients.events.indexOf("delete:NetworkPolicy:paperclip-egress-allow");
    expect(applyIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(applyIdx);
  });

  it("applies standard NetworkPolicy BEFORE deleting stale CiliumNetworkPolicy when switching to standard", async () => {
    const clients = makeSsaMockClients();
    await ensureTenant(clients as never, { ...baseInput, egressMode: "standard" });
    const applyIdx = clients.events.indexOf("apply:NetworkPolicy:paperclip-egress-allow");
    const deleteIdx = clients.events.indexOf("delete:CiliumNetworkPolicy:paperclip-egress-fqdn");
    expect(applyIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(applyIdx);
  });
});
