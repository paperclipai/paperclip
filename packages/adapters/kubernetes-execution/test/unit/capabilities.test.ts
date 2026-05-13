import { describe, it, expect, vi } from "vitest";
import { probeClusterCapabilities } from "../../src/orchestrator/capabilities.js";

function fakeClient(opts: {
  hasCilium: boolean;
  nodes: { arch: string }[];
  storageClasses: string[];
  defaultStorageClass?: string;
}) {
  return {
    request: vi.fn(async (method: string, path: string) => {
      if (path.includes("/apis/cilium.io/v2")) {
        return opts.hasCilium ? { kind: "APIResourceList", resources: [] } : null;
      }
      if (path.includes("/apis/storage.k8s.io/v1/storageclasses")) {
        return {
          items: opts.storageClasses.map((name) => ({
            metadata: {
              name,
              annotations:
                name === opts.defaultStorageClass
                  ? { "storageclass.kubernetes.io/is-default-class": "true" }
                  : {},
            },
          })),
        };
      }
      return null;
    }),
    core: {
      listNode: vi.fn(async () => ({
        body: { items: opts.nodes.map((n) => ({ status: { nodeInfo: { architecture: n.arch } } })) },
      })),
    },
  } as unknown as Parameters<typeof probeClusterCapabilities>[0];
}

describe("probeClusterCapabilities", () => {
  it("detects cilium and arm64 nodes", async () => {
    const c = fakeClient({
      hasCilium: true,
      nodes: [{ arch: "amd64" }, { arch: "arm64" }],
      storageClasses: ["standard", "gp3"],
      defaultStorageClass: "gp3",
    });
    const caps = await probeClusterCapabilities(c);
    expect(caps.cilium).toBe(true);
    expect(caps.architectures).toEqual(expect.arrayContaining(["amd64", "arm64"]));
    expect(caps.storageClass).toBe("gp3");
  });

  it("falls back to first storage class when none is marked default", async () => {
    const c = fakeClient({
      hasCilium: false,
      nodes: [{ arch: "amd64" }],
      storageClasses: ["standard"],
    });
    const caps = await probeClusterCapabilities(c);
    expect(caps.cilium).toBe(false);
    expect(caps.storageClass).toBe("standard");
  });

  it("handles cilium API absence gracefully", async () => {
    const c = fakeClient({
      hasCilium: false,
      nodes: [{ arch: "amd64" }],
      storageClasses: ["standard"],
      defaultStorageClass: "standard",
    });
    const caps = await probeClusterCapabilities(c);
    expect(caps.cilium).toBe(false);
  });

  it("falls back to amd64 when no nodes report a recognized architecture", async () => {
    const c = fakeClient({
      hasCilium: false,
      nodes: [{ arch: "ppc64le" }],
      storageClasses: ["standard"],
    });
    const caps = await probeClusterCapabilities(c);
    expect(caps.architectures).toEqual(["amd64"]);
  });

  it("returns 'standard' when no storage classes exist", async () => {
    const c = fakeClient({
      hasCilium: false,
      nodes: [{ arch: "amd64" }],
      storageClasses: [],
    });
    const caps = await probeClusterCapabilities(c);
    expect(caps.storageClass).toBe("standard");
  });

  it("treats request() throwing on cilium probe as cilium=false", async () => {
    const c = {
      request: vi.fn(async (method: string, path: string) => {
        if (path.includes("/apis/cilium.io/v2")) throw new Error("404");
        if (path.includes("/storageclasses")) return { items: [{ metadata: { name: "standard" } }] };
        return null;
      }),
      core: {
        listNode: vi.fn(async () => ({ body: { items: [{ status: { nodeInfo: { architecture: "amd64" } } }] } })),
      },
    } as unknown as Parameters<typeof probeClusterCapabilities>[0];
    const caps = await probeClusterCapabilities(c);
    expect(caps.cilium).toBe(false);
  });
});
