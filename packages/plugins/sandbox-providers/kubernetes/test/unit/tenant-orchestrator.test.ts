import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  adapterCiliumPolicyName,
  clearTenantReconcileCache,
  ensureTenant,
  TenantNamespaceOwnershipError,
} from "../../src/tenant-orchestrator.js";

function makeMockClients(clusterId = "cluster-a") {
  const calls: { kind: string; name: string; namespace?: string; body?: unknown }[] = [];
  function track(kind: string) {
    return vi.fn(async (...args: unknown[]) => {
      const arg = (args[0] ?? {}) as { name?: string; namespace?: string; body?: unknown };
      calls.push({ kind, name: arg.name ?? "", namespace: arg.namespace, body: arg.body });
      return { body: arg.body };
    });
  }
  return {
    clusterId,
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
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
    },
  };
}

function makeSsaMockClients(options: { clusterId?: string; delayMs?: number } = {}) {
  const events: string[] = [];
  const applied: Array<{ manifest: Record<string, unknown>; fieldManager?: string }> = [];
  const delay = async () => {
    if (options.delayMs) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
  };
  return {
    clusterId: options.clusterId ?? "cluster-a",
    events,
    applied,
    core: {
      readNamespace: vi.fn().mockRejectedValue({ code: 404 }),
    },
    applyServerSide: vi.fn(async (manifest: Record<string, unknown>, fieldManager?: string) => {
      await delay();
      const kind = String(manifest.kind ?? "");
      const name = String((manifest.metadata as { name?: string } | undefined)?.name ?? "");
      events.push(`apply:${kind}:${name}`);
      applied.push({ manifest, fieldManager });
    }),
    networking: {
      deleteNamespacedNetworkPolicy: vi.fn(async (arg: { name: string }) => {
        await delay();
        events.push(`delete:NetworkPolicy:${arg.name}`);
      }),
    },
    custom: {
      listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedCustomObject: vi.fn(async (arg: { name: string }) => {
        await delay();
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

    // Within 5-minute TTL with identical config: cache hit -> 0 new API calls
    clock += 60_000;
    await ensureTenant(clients as never, { ...baseInput, now: () => clock });
    expect(clients.applyServerSide).toHaveBeenCalledTimes(8);

    // Config fingerprint changes (quota updated): immediate re-reconciliation
    await ensureTenant(clients as never, {
      ...baseInput,
      resourceQuota: { ...baseInput.resourceQuota, pods: "40" },
      now: () => clock,
    });
    expect(clients.applyServerSide).toHaveBeenCalledTimes(16);

    // Past 5-minute TTL: re-reconciles again
    clock += 5 * 60 * 1000 + 1;
    await ensureTenant(clients as never, {
      ...baseInput,
      resourceQuota: { ...baseInput.resourceQuota, pods: "40" },
      now: () => clock,
    });
    expect(clients.applyServerSide).toHaveBeenCalledTimes(24);
  });

  it("isolates reconciliation cache across different clusters sharing the same namespace", async () => {
    const clusterA = makeSsaMockClients({ clusterId: "cluster-a" });
    const clusterB = makeSsaMockClients({ clusterId: "cluster-b" });

    await ensureTenant(clusterA as never, baseInput);
    expect(clusterA.applyServerSide).toHaveBeenCalledTimes(8);

    // Second cluster with identical namespace & config must still reconcile.
    await ensureTenant(clusterB as never, baseInput);
    expect(clusterB.applyServerSide).toHaveBeenCalledTimes(8);
  });

  it("reconciles per-adapter CiliumNetworkPolicies independently without disconnecting other adapters", async () => {
    const clients = makeSsaMockClients();

    // First lease: claude_local
    await ensureTenant(clients as never, {
      ...baseInput,
      egressMode: "cilium",
      egressAllowFqdns: ["shared.example.com"],
      adapterEgress: { adapterType: "claude_local", allowFqdns: ["api.anthropic.com"] },
    });
    // 8 shared resources + 1 claude adapter policy
    expect(clients.applyServerSide).toHaveBeenCalledTimes(9);
    const sharedIdx = clients.events.indexOf("apply:CiliumNetworkPolicy:paperclip-egress-fqdn");
    const adapterIdx = clients.events.indexOf(
      `apply:CiliumNetworkPolicy:${adapterCiliumPolicyName("claude_local")}`,
    );
    const deleteStdIdx = clients.events.indexOf("delete:NetworkPolicy:paperclip-egress-allow");
    // Both shared and adapter Cilium policies MUST be applied BEFORE deleting stale standard policy.
    expect(adapterIdx).toBeGreaterThan(sharedIdx);
    expect(deleteStdIdx).toBeGreaterThan(adapterIdx);

    // Second lease in same namespace: codex_local
    await ensureTenant(clients as never, {
      ...baseInput,
      egressMode: "cilium",
      egressAllowFqdns: ["shared.example.com"],
      adapterEgress: { adapterType: "codex_local", allowFqdns: ["api.openai.com"] },
    });
    // Shared 8 resources hit cache; only 1 new codex adapter policy is applied.
    expect(clients.applyServerSide).toHaveBeenCalledTimes(10);
    const codexApply = clients.applied[9].manifest as {
      metadata: { name: string };
      spec: { endpointSelector: { matchLabels: Record<string, string> }; egress: unknown[] };
    };
    expect(codexApply.metadata.name).toBe(adapterCiliumPolicyName("codex_local"));
    expect(codexApply.spec.endpointSelector.matchLabels).toEqual({
      "paperclip.io/role": "agent",
      "paperclip.io/adapter": "codex_local",
    });
  });

  it("deletes the per-adapter CiliumNetworkPolicy when an adapter's allowFqdns becomes empty", async () => {
    const clients = makeSsaMockClients();

    await ensureTenant(clients as never, {
      ...baseInput,
      egressMode: "cilium",
      egressAllowFqdns: [],
      adapterEgress: { adapterType: "claude_local", allowFqdns: ["api.anthropic.com"] },
    });

    // Clearing allowFqdns must delete the stale adapter policy instead of leaving old domains allowed.
    await ensureTenant(clients as never, {
      ...baseInput,
      egressMode: "cilium",
      egressAllowFqdns: [],
      adapterEgress: { adapterType: "claude_local", allowFqdns: [] },
    });

    expect(clients.events).toContain(
      `delete:CiliumNetworkPolicy:${adapterCiliumPolicyName("claude_local")}`,
    );
  });

  it("discovers and deletes leftover per-adapter Cilium policies from Kubernetes when switching to standard after restart", async () => {
    const clients = makeSsaMockClients();
    // Simulate a fresh worker process (empty in-memory cache) where claude + codex Cilium policies exist in-cluster.
    clients.custom.listNamespacedCustomObject.mockResolvedValue({
      items: [
        { metadata: { name: "paperclip-egress-fqdn" } },
        { metadata: { name: adapterCiliumPolicyName("claude_local") } },
        { metadata: { name: adapterCiliumPolicyName("codex_local") } },
        // Per-run scoped policy must NOT be touched by tenant cleanup.
        { metadata: { name: "paperclip-run-egress-123" } },
      ],
    });

    await ensureTenant(clients as never, {
      ...baseInput,
      egressMode: "standard",
      adapterEgress: { adapterType: "codex_local", allowFqdns: ["api.openai.com"] },
    });

    expect(clients.events).toContain("delete:CiliumNetworkPolicy:paperclip-egress-fqdn");
    expect(clients.events).toContain(
      `delete:CiliumNetworkPolicy:${adapterCiliumPolicyName("claude_local")}`,
    );
    expect(clients.events).toContain(
      `delete:CiliumNetworkPolicy:${adapterCiliumPolicyName("codex_local")}`,
    );
    expect(clients.events).not.toContain("delete:CiliumNetworkPolicy:paperclip-run-egress-123");
  });

  it("ignores 403 Forbidden when listing or cleaning up CiliumNetworkPolicy on standard-only clusters", async () => {
    const clients = makeSsaMockClients();
    clients.custom.listNamespacedCustomObject.mockRejectedValue({ statusCode: 403 });
    clients.custom.deleteNamespacedCustomObject.mockRejectedValue({ statusCode: 403 });

    await expect(
      ensureTenant(clients as never, { ...baseInput, egressMode: "standard" }),
    ).resolves.not.toThrow();
    expect(clients.applyServerSide).toHaveBeenCalledTimes(8);
  });

  it("serializes concurrent egressMode switches so both egress policies are never deleted", async () => {
    const clients = makeSsaMockClients({ delayMs: 2 });

    await Promise.all([
      ensureTenant(clients as never, { ...baseInput, egressMode: "standard" }),
      ensureTenant(clients as never, { ...baseInput, egressMode: "cilium" }),
    ]);

    // The second (cilium) reconciliation must start after the first (standard) finishes deleting stale cilium policy.
    const stdDeleteCiliumIdx = clients.events.indexOf("delete:CiliumNetworkPolicy:paperclip-egress-fqdn");
    const ciliumApplyIdx = clients.events.indexOf("apply:CiliumNetworkPolicy:paperclip-egress-fqdn");
    const ciliumDeleteStdIdx = clients.events.indexOf("delete:NetworkPolicy:paperclip-egress-allow");
    expect(stdDeleteCiliumIdx).toBeGreaterThan(-1);
    expect(ciliumApplyIdx).toBeGreaterThan(stdDeleteCiliumIdx);
    expect(ciliumDeleteStdIdx).toBeGreaterThan(ciliumApplyIdx);
  });

  it("refuses SSA when an existing namespace is owned by a different companyId", async () => {
    const clients = makeSsaMockClients();
    clients.core.readNamespace.mockResolvedValue({
      metadata: {
        name: baseInput.namespace,
        labels: { "paperclip.io/company-id": "22222222-2222-2222-2222-222222222222" },
      },
    });

    await expect(ensureTenant(clients as never, baseInput)).rejects.toThrow(
      TenantNamespaceOwnershipError,
    );
    expect(clients.applyServerSide).not.toHaveBeenCalled();
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
