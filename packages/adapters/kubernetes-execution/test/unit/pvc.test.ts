import { describe, it, expect } from "vitest";
import { buildAgentWorkspacePvc } from "../../src/orchestrator/pvc.js";

describe("buildAgentWorkspacePvc", () => {
  it("creates a PVC with paperclip labels and the requested storage class + size", () => {
    const pvc = buildAgentWorkspacePvc({
      namespace: "paperclip-acme",
      agentId: "a-1",
      agentSlug: "a-acme",
      companyId: "c-1",
      companySlug: "acme",
      storageClass: "gp3",
      sizeGi: 20,
      strategyKey: "git-clone",
    });
    expect(pvc.kind).toBe("PersistentVolumeClaim");
    expect(pvc.metadata?.name).toBe("agent-a-acme-workspace");
    expect(pvc.metadata?.labels?.["paperclip.ai/role"]).toBe("agent-workspace");
    expect(pvc.metadata?.labels?.["paperclip.ai/agent-id"]).toBe("a-1");
    expect(pvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.spec?.storageClassName).toBe("gp3");
    expect(pvc.spec?.resources?.requests?.storage).toBe("20Gi");
    expect(pvc.metadata?.annotations?.["paperclip.ai/workspace-strategy"]).toBe("git-clone");
  });

  it("defaults to 10Gi when sizeGi is not specified", () => {
    const pvc = buildAgentWorkspacePvc({
      namespace: "paperclip-acme", agentId: "a-1", agentSlug: "a-acme",
      companyId: "c-1", companySlug: "acme",
      storageClass: "standard", strategyKey: "none",
    });
    expect(pvc.spec?.resources?.requests?.storage).toBe("10Gi");
  });
});
