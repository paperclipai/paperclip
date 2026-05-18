import { describe, it, expect, vi } from "vitest";
import {
  createSandboxCr,
  deleteSandboxCr,
  getSandboxCrStatus,
  findPodForSandbox,
  SandboxCrTimeoutError,
  waitForSandboxReady,
} from "../../src/sandbox-cr-orchestrator.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

// Helpers to build mock CR objects with given phase
function makeCr(phase: string, podName?: string): Record<string, unknown> {
  return {
    metadata: { uid: "sandbox-uid-123" },
    status: {
      phase,
      ...(podName ? { podName } : {}),
    },
  };
}

describe("createSandboxCr", () => {
  it("calls custom.createNamespacedCustomObject with the correct params", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "test-uid" } });
    const clients = { custom: { createNamespacedCustomObject: create } };
    const manifest = {
      apiVersion: "agents.x-k8s.io/v1alpha1",
      kind: "Sandbox",
      metadata: { name: "pc-abc", namespace: "paperclip-acme" },
    };
    const result = await createSandboxCr(clients as never, "paperclip-acme", manifest);
    expect(create).toHaveBeenCalledWith({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: "paperclip-acme",
      plural: SANDBOX_PLURAL,
      body: manifest,
    });
    expect(result.uid).toBe("test-uid");
  });

  it("throws if the API response has no UID", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: {} });
    const clients = { custom: { createNamespacedCustomObject: create } };
    await expect(
      createSandboxCr(clients as never, "ns", {}),
    ).rejects.toThrow("Sandbox CR created without a UID");
  });
});

describe("getSandboxCrStatus", () => {
  it("maps phase=Ready to SandboxStatus.phase=Running with active=1", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Running");
    expect(status.active).toBe(1);
    expect(status.complete).toBe(false);
  });

  it("maps phase=Pending to SandboxStatus.phase=Pending", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Pending");
    expect(status.active).toBe(0);
  });

  it("maps phase=Failed to SandboxStatus.phase=Failed with failed=1", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "uid-1" },
      status: {
        phase: "Failed",
        conditions: [
          { type: "Failed", reason: "ImagePullFailed", message: "no image" },
        ],
      },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Failed");
    expect(status.failed).toBe(1);
    expect(status.reason).toBe("ImagePullFailed");
  });

  it("maps phase=Terminating to SandboxStatus.phase=Running with reason=Terminating", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Terminating"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Running");
    expect(status.reason).toBe("Terminating");
  });
});

describe("findPodForSandbox", () => {
  it("returns status.podName from the Sandbox CR when set", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready", "pc-abc-pod-xyz"));
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { listNamespacedPod: vi.fn() },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(podName).toBe("pc-abc-pod-xyz");
    // Should NOT have called listNamespacedPod (primary path succeeded)
    expect(clients.core.listNamespacedPod).not.toHaveBeenCalled();
  });

  it("falls back to pod listing when status.podName is absent", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending")); // no podName
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "pc-abc-001", labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" } },
          status: { phase: "Running" },
        },
      ],
    });
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    // name starts with "pc-abc" → matched by prefix heuristic
    expect(podName).toBe("pc-abc-001");
  });

  it("returns null when no pod is found in fallback", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const list = vi.fn().mockResolvedValue({ items: [] });
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(podName).toBeNull();
  });
});

describe("deleteSandboxCr", () => {
  it("calls custom.deleteNamespacedCustomObject with Foreground propagation", async () => {
    const del = vi.fn().mockResolvedValue({});
    const clients = { custom: { deleteNamespacedCustomObject: del } };
    await deleteSandboxCr(clients as never, "ns", "pc-abc");
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: "ns",
        plural: SANDBOX_PLURAL,
        name: "pc-abc",
        propagationPolicy: "Foreground",
      }),
    );
  });
});

describe("waitForSandboxReady", () => {
  it("resolves immediately when Sandbox is already Ready", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await waitForSandboxReady(
      clients as never,
      "ns",
      "pc-abc",
      { timeoutMs: 5000, pollMs: 10 },
    );
    expect(status.phase).toBe("Running"); // Ready maps to Running
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("polls until Ready", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(makeCr("Pending"))
      .mockResolvedValueOnce(makeCr("Pending"))
      .mockResolvedValueOnce(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await waitForSandboxReady(
      clients as never,
      "ns",
      "pc-abc",
      { timeoutMs: 5000, pollMs: 10 },
    );
    expect(status.phase).toBe("Running");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("throws SandboxCrTimeoutError when deadline is exceeded", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    await expect(
      waitForSandboxReady(clients as never, "ns", "pc-abc", {
        timeoutMs: 50,
        pollMs: 10,
      }),
    ).rejects.toBeInstanceOf(SandboxCrTimeoutError);
  });

  it("throws an error describing the failure when Sandbox fails", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1" },
      status: { phase: "Failed", conditions: [{ type: "Failed", reason: "OOMKilled" }] },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    await expect(
      waitForSandboxReady(clients as never, "ns", "pc-abc", {
        timeoutMs: 5000,
        pollMs: 10,
      }),
    ).rejects.toThrow(/failed.*OOMKilled/i);
  });
});
