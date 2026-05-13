import { describe, it, expect, vi } from "vitest";
import {
  applyLimitRange,
  buildResourceQuota,
  buildLimitRange,
  defaultTenantQuota,
  defaultTenantLimits,
} from "../../src/orchestrator/resource-quota.js";

describe("buildResourceQuota", () => {
  it("uses defaults when no tenant override is supplied", () => {
    const q = buildResourceQuota({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      override: null,
    });
    expect(q.spec?.hard?.["requests.cpu"]).toBe(defaultTenantQuota.requestsCpu);
    expect(q.spec?.hard?.["count/jobs.batch"]).toBe(String(defaultTenantQuota.countJobs));
    expect(q.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
  });

  it("respects tenant override values", () => {
    const q = buildResourceQuota({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      override: { requestsCpu: "32", countJobs: 200 },
    });
    expect(q.spec?.hard?.["requests.cpu"]).toBe("32");
    expect(q.spec?.hard?.["count/jobs.batch"]).toBe("200");
    // Other defaults still apply
    expect(q.spec?.hard?.["requests.memory"]).toBe(defaultTenantQuota.requestsMemory);
  });
});

describe("buildLimitRange", () => {
  it("emits Container + PVC limits with default values", () => {
    const lr = buildLimitRange({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      override: null,
    });
    const container = lr.spec?.limits?.find((l) => l.type === "Container");
    // The k8s typed client renames `default` → `_default` because `default` is a reserved
    // word in TypeScript. The wire format still uses `default`; we assert the JS field name.
    expect(container?._default?.cpu).toBe(defaultTenantLimits.default.cpu);
    expect(container?.defaultRequest?.memory).toBe(defaultTenantLimits.defaultRequest.memory);
    expect(container?.max?.cpu).toBe(defaultTenantLimits.max.cpu);
    const pvc = lr.spec?.limits?.find((l) => l.type === "PersistentVolumeClaim");
    expect(pvc?.max?.storage).toBe(defaultTenantLimits.pvcMaxStorage);
  });

  it("override merges deeply: setting only default.cpu keeps default.memory", () => {
    const lr = buildLimitRange({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      override: { default: { cpu: "2" } },
    });
    const container = lr.spec?.limits?.find((l) => l.type === "Container");
    expect(container?._default?.cpu).toBe("2");
    expect(container?._default?.memory).toBe(defaultTenantLimits.default.memory);
  });

  it("patches the Kubernetes wire field name for container defaults", async () => {
    const patchNamespacedLimitRange = vi.fn(async () => ({}));
    const client = {
      core: {
        readNamespacedLimitRange: vi.fn(async () => ({})),
        patchNamespacedLimitRange,
      },
    };
    const lr = buildLimitRange({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      override: null,
    });

    await applyLimitRange(client as never, lr);

    const patchBody = patchNamespacedLimitRange.mock.calls[0]?.[2];
    const container = patchBody?.spec?.limits?.find((l: { type?: string }) => l.type === "Container");
    expect(container?.default?.cpu).toBe(defaultTenantLimits.default.cpu);
    expect(container?._default).toBeUndefined();
  });

  it("creates with the Kubernetes wire field name for container defaults", async () => {
    const createNamespacedLimitRange = vi.fn(async () => ({}));
    const client = {
      core: {
        readNamespacedLimitRange: vi.fn(async () => {
          const err = new Error("not found") as Error & { response?: { statusCode?: number } };
          err.response = { statusCode: 404 };
          throw err;
        }),
        createNamespacedLimitRange,
      },
    };
    const lr = buildLimitRange({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      override: null,
    });

    await applyLimitRange(client as never, lr);

    const createBody = createNamespacedLimitRange.mock.calls[0]?.[1];
    const container = createBody?.spec?.limits?.find((l: { type?: string }) => l.type === "Container");
    expect(container?.default?.cpu).toBe(defaultTenantLimits.default.cpu);
    expect(container?._default).toBeUndefined();
  });
});
