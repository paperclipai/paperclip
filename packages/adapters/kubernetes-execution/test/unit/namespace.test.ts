import { describe, it, expect, vi } from "vitest";
import { applyNamespace, buildNamespace } from "../../src/orchestrator/namespace.js";
import type { KubernetesApiClient } from "../../src/types.js";

describe("buildNamespace", () => {
  it("produces a namespace with paperclip labels and PSS restricted", () => {
    const ns = buildNamespace({
      name: "paperclip-acme-corp",
      companyId: "c-uuid",
      companySlug: "acme-corp",
    });
    expect(ns.kind).toBe("Namespace");
    expect(ns.metadata?.name).toBe("paperclip-acme-corp");
    expect(ns.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
    expect(ns.metadata?.labels?.["paperclip.ai/company-id"]).toBe("c-uuid");
    expect(ns.metadata?.labels?.["paperclip.ai/company-slug"]).toBe("acme-corp");
    expect(ns.metadata?.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(ns.metadata?.labels?.["pod-security.kubernetes.io/audit"]).toBe("restricted");
    expect(ns.metadata?.labels?.["pod-security.kubernetes.io/warn"]).toBe("restricted");
  });

  it("merges extra labels with the base set", () => {
    const ns = buildNamespace({
      name: "paperclip-x", companyId: "c", companySlug: "x",
      extraLabels: { "custom/label": "value" },
    });
    expect(ns.metadata?.labels?.["custom/label"]).toBe("value");
    // base labels still present
    expect(ns.metadata?.labels?.["paperclip.ai/managed-by"]).toBe("paperclip");
  });
});

describe("applyNamespace cross-tenant guard", () => {
  function makeClient(opts: {
    readNamespace: ReturnType<typeof vi.fn>;
    patchNamespace?: ReturnType<typeof vi.fn>;
    createNamespace?: ReturnType<typeof vi.fn>;
  }): KubernetesApiClient {
    return {
      core: {
        readNamespace: opts.readNamespace,
        patchNamespace: opts.patchNamespace ?? vi.fn(async () => ({ body: {} })),
        createNamespace: opts.createNamespace ?? vi.fn(async () => ({ body: {} })),
      },
    } as unknown as KubernetesApiClient;
  }

  it("refuses to patch a namespace owned by a different company", async () => {
    // The pre-existing namespace is paperclip-managed but labeled for company A.
    // Company B's ensureTenant call must NOT silently take it over.
    const readNamespace = vi.fn(async () => ({
      body: {
        metadata: {
          name: "paperclip-acme",
          labels: {
            "paperclip.ai/managed-by": "paperclip",
            "paperclip.ai/company-id": "company-A",
            "paperclip.ai/company-slug": "acme",
          },
        },
      },
    }));
    const patchNamespace = vi.fn();
    const client = makeClient({ readNamespace, patchNamespace });
    const incoming = buildNamespace({ name: "paperclip-acme", companyId: "company-B", companySlug: "acme" });
    await expect(applyNamespace(client, incoming)).rejects.toThrow(/labeled for company company-A, not company-B/);
    expect(patchNamespace).not.toHaveBeenCalled();
  });

  it("permits patching a namespace owned by the same company", async () => {
    const readNamespace = vi.fn(async () => ({
      body: {
        metadata: {
          name: "paperclip-acme",
          labels: {
            "paperclip.ai/managed-by": "paperclip",
            "paperclip.ai/company-id": "company-A",
            "paperclip.ai/company-slug": "acme",
          },
        },
      },
    }));
    const patchNamespace = vi.fn(async () => ({ body: {} }));
    const client = makeClient({ readNamespace, patchNamespace });
    const incoming = buildNamespace({ name: "paperclip-acme", companyId: "company-A", companySlug: "acme" });
    await expect(applyNamespace(client, incoming)).resolves.toEqual({ created: false });
    expect(patchNamespace).toHaveBeenCalledTimes(1);
  });

  it("still refuses to patch a namespace not labeled managed-by=paperclip", async () => {
    const readNamespace = vi.fn(async () => ({
      body: { metadata: { name: "paperclip-acme", labels: {} } },
    }));
    const patchNamespace = vi.fn();
    const client = makeClient({ readNamespace, patchNamespace });
    const incoming = buildNamespace({ name: "paperclip-acme", companyId: "company-A", companySlug: "acme" });
    await expect(applyNamespace(client, incoming)).rejects.toThrow(/missing label paperclip.ai\/managed-by/);
    expect(patchNamespace).not.toHaveBeenCalled();
  });
});
