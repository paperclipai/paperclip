import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SANDBOX_GROUP,
  __clearSandboxApiVersionCache,
  resolveSandboxApiVersion,
} from "../../src/sandbox-api-version.js";

/** A KubeClients stand-in whose discovery reports the given served versions. */
function clientsServing(versions: string[], getAPIVersions = vi.fn()) {
  getAPIVersions.mockResolvedValue({
    groups: [
      { name: "batch", versions: [{ version: "v1" }] },
      { name: SANDBOX_GROUP, versions: versions.map((version) => ({ version })) },
    ],
  });
  return { clients: { apis: { getAPIVersions } } as never, getAPIVersions };
}

/** A KubeClients stand-in whose discovery does not list the sandbox group at all. */
function clientsWithoutGroup() {
  return {
    apis: {
      getAPIVersions: vi.fn().mockResolvedValue({
        groups: [{ name: "batch", versions: [{ version: "v1" }] }],
      }),
    },
  } as never;
}

beforeEach(() => {
  __clearSandboxApiVersionCache();
});

describe("resolveSandboxApiVersion", () => {
  it("prefers v1beta1 when the cluster serves it (agent-sandbox >= v0.5.0)", async () => {
    const { clients } = clientsServing(["v1alpha1", "v1beta1"]);
    expect(await resolveSandboxApiVersion(clients, "https://a")).toBe("v1beta1");
  });

  it("falls back to v1alpha1 on controllers that predate the graduation", async () => {
    const { clients } = clientsServing(["v1alpha1"]);
    expect(await resolveSandboxApiVersion(clients, "https://a")).toBe("v1alpha1");
  });

  it("names the missing controller when the API group is absent", async () => {
    await expect(
      resolveSandboxApiVersion(clientsWithoutGroup(), "https://a"),
    ).rejects.toThrow(/agent-sandbox/);
    __clearSandboxApiVersionCache();
    await expect(
      resolveSandboxApiVersion(clientsWithoutGroup(), "https://a"),
    ).rejects.toThrow(/backend/);
  });

  it("asks for an upgrade when the group serves only versions this plugin cannot address", async () => {
    const { clients } = clientsServing(["v1"]);
    await expect(resolveSandboxApiVersion(clients, "https://a")).rejects.toThrow(
      /Upgrade the agent-sandbox controller/,
    );
  });

  it("discovers once per API-server URL and serves later calls from the cache", async () => {
    const { clients, getAPIVersions } = clientsServing(["v1beta1"]);
    expect(await resolveSandboxApiVersion(clients, "https://a")).toBe("v1beta1");

    // A client that would throw if it were consulted: the second call must not
    // reach discovery at all.
    const exploding = {
      apis: {
        getAPIVersions: vi.fn().mockRejectedValue(new Error("discovery must not run again")),
      },
    } as never;
    expect(await resolveSandboxApiVersion(exploding, "https://a")).toBe("v1beta1");
    expect(getAPIVersions).toHaveBeenCalledTimes(1);
  });

  it("resolves each API-server URL independently", async () => {
    const beta = clientsServing(["v1beta1"]);
    const alpha = clientsServing(["v1alpha1"]);
    expect(await resolveSandboxApiVersion(beta.clients, "https://a")).toBe("v1beta1");
    expect(await resolveSandboxApiVersion(alpha.clients, "https://b")).toBe("v1alpha1");
    expect(beta.getAPIVersions).toHaveBeenCalledTimes(1);
    expect(alpha.getAPIVersions).toHaveBeenCalledTimes(1);
  });

  it("shares one discovery request between concurrent first callers", async () => {
    let release!: (value: unknown) => void;
    const getAPIVersions = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const clients = { apis: { getAPIVersions } } as never;

    const first = resolveSandboxApiVersion(clients, "https://a");
    const second = resolveSandboxApiVersion(clients, "https://a");
    release({ groups: [{ name: SANDBOX_GROUP, versions: [{ version: "v1beta1" }] }] });

    expect(await first).toBe("v1beta1");
    expect(await second).toBe("v1beta1");
    expect(getAPIVersions).toHaveBeenCalledTimes(1);
  });

  it("does not poison the cache with a transient discovery failure", async () => {
    const failing = {
      apis: { getAPIVersions: vi.fn().mockRejectedValue(new Error("connection reset")) },
    } as never;
    await expect(resolveSandboxApiVersion(failing, "https://a")).rejects.toThrow(
      /connection reset/,
    );

    // The retry must re-run discovery rather than replay the rejected promise.
    const { clients } = clientsServing(["v1beta1"]);
    expect(await resolveSandboxApiVersion(clients, "https://a")).toBe("v1beta1");
  });
});
