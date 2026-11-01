import { describe, it, expect, vi } from "vitest";
import type { KubeClients } from "../../src/kube-client.js";
import {
  resolveSandboxApiVersion,
  SANDBOX_GROUP,
  SUPPORTED_SANDBOX_VERSIONS,
} from "../../src/sandbox-api-version.js";

/**
 * A clients stub whose discovery call returns the given API groups. Only
 * `apis.getAPIVersions` is reachable from the version resolver, so the rest of
 * the client set stays absent on purpose: a test that starts exercising another
 * client should have to say so.
 */
function makeClients(
  groups: Array<{ name: string; versions: string[] }>,
): { clients: KubeClients; getAPIVersions: ReturnType<typeof vi.fn> } {
  const getAPIVersions = vi.fn().mockResolvedValue({
    groups: groups.map((group) => ({
      name: group.name,
      versions: group.versions.map((version) => ({
        groupVersion: `${group.name}/${version}`,
        version,
      })),
    })),
  });
  return { clients: { apis: { getAPIVersions } } as unknown as KubeClients, getAPIVersions };
}

describe("resolveSandboxApiVersion", () => {
  it("uses v1beta1 on a cluster that serves only v1beta1 (agent-sandbox v1.0.0 and later)", async () => {
    const { clients } = makeClients([{ name: SANDBOX_GROUP, versions: ["v1beta1"] }]);
    await expect(resolveSandboxApiVersion(clients)).resolves.toBe("v1beta1");
  });

  it("prefers v1beta1 on a cluster that still serves both (agent-sandbox v0.5.x)", async () => {
    const { clients } = makeClients([
      { name: SANDBOX_GROUP, versions: ["v1alpha1", "v1beta1"] },
    ]);
    await expect(resolveSandboxApiVersion(clients)).resolves.toBe("v1beta1");
  });

  it("falls back to v1alpha1 on a cluster that serves only the older version", async () => {
    const { clients } = makeClients([{ name: SANDBOX_GROUP, versions: ["v1alpha1"] }]);
    await expect(resolveSandboxApiVersion(clients)).resolves.toBe("v1alpha1");
  });

  it("fails with an actionable message when the cluster has no agent-sandbox controller", async () => {
    const { clients } = makeClients([{ name: "batch", versions: ["v1"] }]);
    await expect(resolveSandboxApiVersion(clients)).rejects.toThrow(
      /does not serve the "agents.x-k8s.io" API group.*backend.*job/s,
    );
  });

  it("fails and names the served versions when none of them is supported", async () => {
    const { clients } = makeClients([{ name: SANDBOX_GROUP, versions: ["v2"] }]);
    await expect(resolveSandboxApiVersion(clients)).rejects.toThrow(/\[v2\]/);
  });

  it("asks the cluster once per client set", async () => {
    const { clients, getAPIVersions } = makeClients([
      { name: SANDBOX_GROUP, versions: ["v1beta1"] },
    ]);

    const [first, second] = await Promise.all([
      resolveSandboxApiVersion(clients),
      resolveSandboxApiVersion(clients),
    ]);
    const third = await resolveSandboxApiVersion(clients);

    expect([first, second, third]).toEqual(["v1beta1", "v1beta1", "v1beta1"]);
    expect(getAPIVersions).toHaveBeenCalledOnce();
  });

  it("does not cache a failed lookup, so a transient discovery error can recover", async () => {
    const getAPIVersions = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({
        groups: [
          {
            name: SANDBOX_GROUP,
            versions: [{ groupVersion: `${SANDBOX_GROUP}/v1beta1`, version: "v1beta1" }],
          },
        ],
      });
    const clients = { apis: { getAPIVersions } } as unknown as KubeClients;

    await expect(resolveSandboxApiVersion(clients)).rejects.toThrow("connection reset");
    await expect(resolveSandboxApiVersion(clients)).resolves.toBe("v1beta1");
    expect(getAPIVersions).toHaveBeenCalledTimes(2);
  });

  it("keeps the supported versions ordered newest first", () => {
    expect([...SUPPORTED_SANDBOX_VERSIONS]).toEqual(["v1beta1", "v1alpha1"]);
  });
});
