import { describe, it, expect, vi } from "vitest";
import { podQuotaNeed } from "../../src/quota-math.js";
import {
  assertPodCapacity,
  ensureTenant,
  ensureTenantCached,
  invalidateTenantCache,
  isQuotaExceededMessage,
  OverCapacityError,
  TenantNamespaceError,
} from "../../src/tenant-orchestrator.js";

// An existing tenant namespace, labelled for the company that owns it.
function ownedBy(companyId: string) {
  return { metadata: { name: "paperclip-test", labels: { "paperclip.io/company-id": companyId } } };
}

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
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 404 }),
      createNamespacedCustomObject: track("CiliumNetworkPolicy"),
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

  it("skips creates that already exist (idempotency)", async () => {
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue(ownedBy(baseInput.companyId));
    await ensureTenant(clients as never, baseInput);
    expect(clients.core.createNamespace).not.toHaveBeenCalled();
  });

  it("tolerates a 409 AlreadyExists from a concurrent ensure for the same tenant", async () => {
    const clients = makeMockClients();
    // Both racers saw the 404 read; the loser's create returns 409, which means
    // the desired state exists and must not fail the lease acquisition.
    clients.core.createNamespace.mockRejectedValue({ statusCode: 409 });
    clients.core.createNamespacedServiceAccount.mockRejectedValue({ code: 409 });
    await expect(ensureTenant(clients as never, baseInput)).resolves.not.toThrow();
  });
});

describe("ResourceQuota reconciliation", () => {
  const input = {
    namespace: "paperclip-acme",
    companyId: "c",
    paperclipServerNamespace: "paperclip",
    serviceAccountAnnotations: {},
    egressMode: "standard" as const,
    egressAllowFqdns: [] as string[],
    egressAllowCidrs: [] as string[],
    resourceQuota: { pods: "5", requestsCpu: "2", requestsMemory: "4Gi", limitsCpu: "4", limitsMemory: "8Gi" },
  };
  const desiredHard = {
    pods: "5",
    "requests.cpu": "2",
    "requests.memory": "4Gi",
    "limits.cpu": "4",
    "limits.memory": "8Gi",
  };

  function clientsWithQuota(hard: Record<string, string>) {
    const replace = vi.fn().mockResolvedValue({});
    const exists = vi.fn().mockResolvedValue({});
    const clients = {
      core: {
        readNamespace: vi.fn().mockResolvedValue(ownedBy(input.companyId)),
        readNamespacedServiceAccount: exists,
        readNamespacedLimitRange: exists,
        readNamespacedResourceQuota: vi.fn().mockResolvedValue({
          metadata: { name: "paperclip-quota", resourceVersion: "42" },
          spec: { hard },
        }),
        replaceNamespacedResourceQuota: replace,
      },
      rbac: { readNamespacedRole: exists, readNamespacedRoleBinding: exists },
      networking: { readNamespacedNetworkPolicy: exists },
      custom: { getNamespacedCustomObject: exists },
    };
    return { clients, replace };
  }

  it("updates an existing quota whose limits differ from the configured values", async () => {
    const { clients, replace } = clientsWithQuota({ ...desiredHard, pods: "20" });
    await ensureTenant(clients as never, input);
    expect(replace).toHaveBeenCalledTimes(1);
    const arg = replace.mock.calls[0][0];
    expect(arg.name).toBe("paperclip-quota");
    expect(arg.body.spec.hard.pods).toBe("5");
    expect(arg.body.metadata.resourceVersion).toBe("42");
    // Minimal body: no status or other server-managed fields echoed back.
    expect(Object.keys(arg.body).sort()).toEqual(["apiVersion", "kind", "metadata", "spec"]);
  });

  it("moves an existing namespace from the old 20 CPU / 40Gi default to the derived default on the next ensure", async () => {
    const { parseKubernetesProviderConfig } = await import("../../src/types.js");
    const resourceQuota = parseKubernetesProviderConfig({ inCluster: true }).resourceQuota;
    const { clients, replace } = clientsWithQuota({
      pods: "20", "requests.cpu": "10", "requests.memory": "20Gi", "limits.cpu": "20", "limits.memory": "40Gi",
    });
    await ensureTenant(clients as never, { ...input, resourceQuota });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0].body.spec.hard).toEqual({
      pods: "20", "requests.cpu": "5", "requests.memory": "10Gi", "limits.cpu": "40", "limits.memory": "80Gi",
    });
  });

  it("leaves an already matching quota alone", async () => {
    const { clients, replace } = clientsWithQuota(desiredHard);
    await ensureTenant(clients as never, input);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not fail the run when the quota update is forbidden", async () => {
    const { clients, replace } = clientsWithQuota({ ...desiredHard, pods: "20" });
    replace.mockRejectedValue({ code: 403, message: "forbidden" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(ensureTenant(clients as never, input)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ensureTenantCached skips repeat ensures, but re-runs on a config change or TTL expiry", async () => {
    invalidateTenantCache();
    const { clients } = clientsWithQuota(desiredHard);
    let now = 1_000;
    await ensureTenantCached(clients as never, input, () => now);
    await ensureTenantCached(clients as never, input, () => now);
    expect(clients.core.readNamespace).toHaveBeenCalledTimes(1);

    await ensureTenantCached(
      clients as never,
      { ...input, resourceQuota: { ...input.resourceQuota, pods: "6" } },
      () => now,
    );
    expect(clients.core.readNamespace).toHaveBeenCalledTimes(2);

    now += 10 * 60_000;
    await ensureTenantCached(
      clients as never,
      { ...input, resourceQuota: { ...input.resourceQuota, pods: "6" } },
      () => now,
    );
    expect(clients.core.readNamespace).toHaveBeenCalledTimes(3);

    invalidateTenantCache("paperclip-acme");
    await ensureTenantCached(clients as never, input, () => now);
    expect(clients.core.readNamespace).toHaveBeenCalledTimes(4);
  });
});

describe("ensureTenantCached concurrency and keying", () => {
  const input = {
    namespace: "paperclip-conc",
    companyId: "c",
    paperclipServerNamespace: "paperclip",
    serviceAccountAnnotations: {},
    egressMode: "standard" as const,
    egressAllowFqdns: ["a.example.com"] as string[],
    egressAllowCidrs: [] as string[],
    resourceQuota: { pods: "5", requestsCpu: "2", requestsMemory: "4Gi", limitsCpu: "4", limitsMemory: "8Gi" },
  };

  it("shares one in-flight ensure between concurrent acquires and ignores key order", async () => {
    invalidateTenantCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exists = vi.fn().mockResolvedValue({});
    const readNamespace = vi.fn(async () => { await gate; return ownedBy(input.companyId); });
    const clients = {
      core: {
        readNamespace,
        readNamespacedServiceAccount: exists,
        readNamespacedLimitRange: exists,
        readNamespacedResourceQuota: vi.fn().mockResolvedValue({
          spec: { hard: { pods: "5", "requests.cpu": "2", "requests.memory": "4Gi", "limits.cpu": "4", "limits.memory": "8Gi" } },
        }),
      },
      rbac: { readNamespacedRole: exists, readNamespacedRoleBinding: exists },
      networking: { readNamespacedNetworkPolicy: exists },
      custom: { getNamespacedCustomObject: exists },
    };
    const reordered = { resourceQuota: input.resourceQuota, egressAllowCidrs: [], egressAllowFqdns: ["a.example.com"],
      egressMode: input.egressMode, serviceAccountAnnotations: {}, paperclipServerNamespace: "paperclip",
      companyId: "c", namespace: "paperclip-conc" };
    const a = ensureTenantCached(clients as never, input);
    const b = ensureTenantCached(clients as never, reordered as never);
    release();
    await Promise.all([a, b]);
    expect(readNamespace).toHaveBeenCalledTimes(1);
    await ensureTenantCached(clients as never, reordered as never);
    expect(readNamespace).toHaveBeenCalledTimes(1);
  });
});

describe("tenant namespace ownership check", () => {
  const input = {
    namespace: "paperclip-owned",
    companyId: "11111111-1111-1111-1111-111111111111",
    paperclipServerNamespace: "paperclip",
    serviceAccountAnnotations: {},
    egressMode: "standard" as const,
    egressAllowFqdns: [] as string[],
    egressAllowCidrs: [] as string[],
    resourceQuota: { pods: "5", requestsCpu: "2", requestsMemory: "4Gi", limitsCpu: "4", limitsMemory: "8Gi" },
  };
  const OTHER_COMPANY = "22222222-2222-2222-2222-222222222222";

  // Every create/update call a tenant ensure could make; none may run on a refusal.
  function mutations(clients: ReturnType<typeof makeMockClients>) {
    return [
      clients.core.createNamespace,
      clients.core.createNamespacedServiceAccount,
      clients.core.createNamespacedResourceQuota,
      clients.core.createNamespacedLimitRange,
      clients.rbac.createNamespacedRole,
      clients.rbac.createNamespacedRoleBinding,
      clients.networking.createNamespacedNetworkPolicy,
      clients.custom.createNamespacedCustomObject,
    ];
  }

  it("uses an existing namespace labelled for the company (case-insensitively) and creates nothing", async () => {
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue(ownedBy(input.companyId.toUpperCase()));
    await ensureTenant(clients as never, input);
    expect(clients.core.createNamespace).not.toHaveBeenCalled();
  });

  it("refuses a namespace labelled for another company, names the run's company, and creates nothing", async () => {
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue(ownedBy(OTHER_COMPANY));
    const error = await ensureTenant(clients as never, input).catch((e) => e);
    expect(error).toBeInstanceOf(TenantNamespaceError);
    expect(error.reason).toBe("company_mismatch");
    expect(error.message).toContain("paperclip-owned");
    expect(error.message).toContain(input.companyId);
    // The other tenant's id must not leak into an error an org's users can see.
    expect(error.message).not.toContain(OTHER_COMPANY);
    for (const create of mutations(clients)) expect(create).not.toHaveBeenCalled();
    // Refused before any later ensure step even looked at the namespace.
    expect(clients.core.readNamespacedServiceAccount).not.toHaveBeenCalled();
  });

  it("refuses an existing namespace with no company label, and with no labels at all", async () => {
    for (const body of [
      { metadata: { name: "paperclip-owned", labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" } } },
      { metadata: { name: "paperclip-owned" } },
      {},
    ]) {
      const clients = makeMockClients();
      clients.core.readNamespace.mockResolvedValue(body);
      const error = await ensureTenant(clients as never, input).catch((e) => e);
      expect(error).toBeInstanceOf(TenantNamespaceError);
      expect(error.reason).toBe("label_missing");
      expect(error.message).toContain(`kubectl label namespace paperclip-owned paperclip.io/company-id=${input.companyId}`);
      for (const create of mutations(clients)) expect(create).not.toHaveBeenCalled();
    }
  });

  it("fails a missing namespace with a clear not-enabled error when the server cannot create namespaces", async () => {
    const clients = makeMockClients();
    clients.core.createNamespace.mockRejectedValue({ code: 403, message: "namespaces is forbidden" });
    const error = await ensureTenant(clients as never, input).catch((e) => e);
    expect(error).toBeInstanceOf(TenantNamespaceError);
    expect(error.reason).toBe("not_enabled");
    expect(error.message).toContain("paperclip-owned does not exist");
    expect(error.message).toContain("not enabled for Kubernetes sandboxes");
    expect(error.message).not.toContain("is forbidden");
    // No tenant resource is created in a namespace that is not there.
    expect(clients.core.createNamespacedServiceAccount).not.toHaveBeenCalled();
    expect(clients.networking.createNamespacedNetworkPolicy).not.toHaveBeenCalled();
  });

  it("still creates a missing namespace, labelled for the company, when the server may create namespaces", async () => {
    const clients = makeMockClients();
    await ensureTenant(clients as never, input);
    const created = clients.calls.find((call) => call.kind === "Namespace");
    expect((created?.body as { metadata: { labels: Record<string, string> } }).metadata.labels["paperclip.io/company-id"]).toBe(input.companyId);
    expect(clients.core.createNamespacedServiceAccount).toHaveBeenCalled();
  });

  it("checks the label of a namespace another worker created between our read and our create", async () => {
    const clients = makeMockClients();
    clients.core.createNamespace.mockRejectedValue({ statusCode: 409 });
    clients.core.readNamespace
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce(ownedBy(OTHER_COMPANY));
    const error = await ensureTenant(clients as never, input).catch((e) => e);
    expect(error).toBeInstanceOf(TenantNamespaceError);
    expect(error.reason).toBe("company_mismatch");
    expect(clients.core.createNamespacedServiceAccount).not.toHaveBeenCalled();

    // A winner with the right label is accepted.
    const ok = makeMockClients();
    ok.core.createNamespace.mockRejectedValue({ statusCode: 409 });
    ok.core.readNamespace.mockRejectedValueOnce({ code: 404 }).mockResolvedValueOnce(ownedBy(input.companyId));
    await expect(ensureTenant(ok as never, input)).resolves.not.toThrow();
  });

  it("does not cache a refusal, so a corrected label is used on the very next acquire", async () => {
    invalidateTenantCache();
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue({ metadata: { name: "paperclip-owned" } });
    const now = () => 1_000;
    await expect(ensureTenantCached(clients as never, input, now)).rejects.toBeInstanceOf(TenantNamespaceError);
    clients.core.readNamespace.mockResolvedValue(ownedBy(input.companyId));
    await expect(ensureTenantCached(clients as never, input, now)).resolves.toBeUndefined();
    expect(clients.core.readNamespace).toHaveBeenCalledTimes(2);
  });

  it("reads the namespace once per cached window and never serves another company from the cache", async () => {
    invalidateTenantCache();
    const clients = makeMockClients();
    clients.core.readNamespace.mockResolvedValue(ownedBy(input.companyId));
    let now = 1_000;
    await ensureTenantCached(clients as never, input, () => now);
    now += 60_000;
    await ensureTenantCached(clients as never, input, () => now);
    expect(clients.core.readNamespace).toHaveBeenCalledTimes(1);

    // Same namespace, different company: the cached success is not reused.
    const other = { ...input, companyId: OTHER_COMPANY };
    await expect(ensureTenantCached(clients as never, other, () => now)).rejects.toBeInstanceOf(TenantNamespaceError);
    expect(clients.core.readNamespace).toHaveBeenCalledTimes(2);

    // After the cache window the check runs again, so a later relabel is seen.
    now += 10 * 60_000;
    clients.core.readNamespace.mockResolvedValue(ownedBy(OTHER_COMPANY));
    await expect(ensureTenantCached(clients as never, input, () => now)).rejects.toBeInstanceOf(TenantNamespaceError);
  });
});

describe("assertPodCapacity", () => {
  function quotaClients(status: unknown) {
    return { core: { readNamespacedResourceQuota: vi.fn().mockResolvedValue({ status }) } };
  }

  it("throws OverCapacityError when every pod in the quota is in use", async () => {
    const clients = quotaClients({ hard: { pods: "20" }, used: { pods: "20" } });
    await expect(assertPodCapacity(clients as never, "paperclip-acme")).rejects.toThrow(OverCapacityError);
    await expect(assertPodCapacity(clients as never, "paperclip-acme")).rejects.toThrow(/Over capacity/);
  });

  it("passes when there is headroom, or when quota status is not populated yet", async () => {
    await expect(
      assertPodCapacity(quotaClients({ hard: { pods: "20" }, used: { pods: "19" } }) as never, "ns"),
    ).resolves.toBeUndefined();
    await expect(assertPodCapacity(quotaClients(undefined) as never, "ns")).resolves.toBeUndefined();
  });

  it("fails the 11th pod fast when CPU limits are exhausted although the pod count is not (old 20 CPU quota)", async () => {
    const need = podQuotaNeed();
    const clients = quotaClients({
      hard: { pods: "20", "limits.cpu": "20", "limits.memory": "40Gi" },
      used: { pods: "10", "limits.cpu": "20", "limits.memory": "40Gi" },
    });
    await expect(assertPodCapacity(clients as never, "paperclip-acme", need)).rejects.toThrow(/Over capacity.*limits\.cpu/);
    // Without a pod size the check is pod-count only, as before.
    await expect(assertPodCapacity(clients as never, "paperclip-acme")).resolves.toBeUndefined();
  });

  it("fails fast on memory limits and requests too, and admits a pod that still fits", async () => {
    const need = podQuotaNeed();
    const memFull = quotaClients({
      hard: { pods: "20", "limits.cpu": "40", "limits.memory": "80Gi" },
      used: { pods: "19", "limits.cpu": "38", "limits.memory": "78Gi" },
    });
    await expect(assertPodCapacity(memFull as never, "ns", need)).rejects.toThrow(/limits\.memory/);
    const fits = quotaClients({
      hard: { pods: "20", "limits.cpu": "40", "limits.memory": "80Gi", "requests.cpu": "5", "requests.memory": "10Gi" },
      used: { pods: "19", "limits.cpu": "38", "limits.memory": "76Gi", "requests.cpu": "4750m", "requests.memory": "9728Mi" },
    });
    await expect(assertPodCapacity(fits as never, "ns", need)).resolves.toBeUndefined();
    const reqFull = quotaClients({
      hard: { pods: "20", "requests.cpu": "5" },
      used: { pods: "19", "requests.cpu": "4900m" },
    });
    await expect(assertPodCapacity(reqFull as never, "ns", need)).rejects.toThrow(/requests\.cpu/);
  });

  it("uses spec.hard over a lagging status.hard, so a freshly raised quota admits the run", async () => {
    const clients = {
      core: {
        readNamespacedResourceQuota: vi.fn().mockResolvedValue({
          spec: { hard: { pods: "20", "limits.cpu": "40" } },
          status: { hard: { pods: "20", "limits.cpu": "20" }, used: { pods: "10", "limits.cpu": "20" } },
        }),
      },
    };
    await expect(assertPodCapacity(clients as never, "ns", podQuotaNeed())).resolves.toBeUndefined();
  });

  it("never blocks a run when the quota cannot be read", async () => {
    const clients = { core: { readNamespacedResourceQuota: vi.fn().mockRejectedValue({ code: 404 }) } };
    await expect(assertPodCapacity(clients as never, "ns")).resolves.toBeUndefined();
  });
});

describe("isQuotaExceededMessage", () => {
  it("recognizes the Kubernetes quota rejection wordings and nothing else", () => {
    expect(isQuotaExceededMessage('pods "x" is forbidden: exceeded quota: paperclip-quota, requested: pods=1')).toBe(true);
    expect(isQuotaExceededMessage("Pod quota exceeded")).toBe(true);
    expect(isQuotaExceededMessage("0/3 nodes are available: Insufficient cpu")).toBe(false);
    expect(isQuotaExceededMessage(undefined)).toBe(false);
  });
});
