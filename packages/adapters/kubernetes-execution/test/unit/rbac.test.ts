import { describe, it, expect } from "vitest";
import { buildAgentServiceAccount, buildDriverRoleBinding } from "../../src/orchestrator/rbac.js";

describe("buildAgentServiceAccount", () => {
  it("creates paperclip-agent SA with token automounting disabled", () => {
    const sa = buildAgentServiceAccount({ namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme" });
    expect(sa.metadata?.name).toBe("paperclip-agent");
    expect(sa.metadata?.namespace).toBe("paperclip-acme");
    expect(sa.automountServiceAccountToken).toBe(false);
    expect(sa.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
    expect(sa.metadata?.labels?.["paperclip.ai/company-id"]).toBe("c-1");
  });
});

describe("buildDriverRoleBinding", () => {
  it("references the driver SA in its own namespace and the cluster role for tenant management", () => {
    const rb = buildDriverRoleBinding({
      namespace: "paperclip-acme",
      driverServiceAccount: { name: "paperclip-driver", namespace: "paperclip-system" },
      clusterRoleName: "paperclip-tenant-manager",
      companyId: "c-1", companySlug: "acme",
    });
    expect(rb.subjects?.[0]).toMatchObject({ kind: "ServiceAccount", name: "paperclip-driver", namespace: "paperclip-system" });
    expect(rb.roleRef.kind).toBe("ClusterRole");
    expect(rb.roleRef.name).toBe("paperclip-tenant-manager");
    expect(rb.metadata?.namespace).toBe("paperclip-acme");
    expect(rb.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
  });
});
