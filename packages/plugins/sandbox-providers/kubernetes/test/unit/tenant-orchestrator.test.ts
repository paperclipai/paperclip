import { describe, it, expect, vi } from "vitest";
import {
  assertPodCapacity,
  ensureTenant,
  ensureTenantCached,
  invalidateTenantCache,
  isQuotaExceededMessage,
  OverCapacityError,
} from "../../src/tenant-orchestrator.js";

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
    clients.core.readNamespace.mockResolvedValue({ body: { metadata: { name: baseInput.namespace } } });
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
        readNamespace: vi.fn().mockResolvedValue({}),
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
    const readNamespace = vi.fn(async () => { await gate; return {}; });
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
