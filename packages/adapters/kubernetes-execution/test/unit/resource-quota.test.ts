import { describe, it, expect } from "vitest";
import {
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
});
