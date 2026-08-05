import { describe, expect, it, vi } from "vitest";
import { assertPodContainerReady, execInReadyPod } from "../../src/pod-readiness.js";

function clientsFor(status: Record<string, unknown>) {
  return { core: { readNamespacedPod: vi.fn().mockResolvedValue({ status }) } } as never;
}

const readyStatus = {
  phase: "Running",
  conditions: [{ type: "Ready", status: "True" }],
  containerStatuses: [{ name: "agent", ready: true, state: { running: { startedAt: "now" } } }],
};

describe("pod exec readiness gate", () => {
  it("fails closed unless the actual pod and requested container are ready", async () => {
    await expect(assertPodContainerReady(clientsFor({ phase: "Pending" }), "ns", "pod", "agent"))
      .rejects.toThrow(/not running, ready/);
    await expect(assertPodContainerReady(clientsFor({
      ...readyStatus,
      containerStatuses: [{ name: "other", ready: true, state: { running: {} } }],
    }), "ns", "pod", "agent")).rejects.toThrow(/not running, ready/);
  });

  it("calls exec only after the readiness check succeeds", async () => {
    const clients = clientsFor(readyStatus);
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const result = await execInReadyPod({} as never, clients, "ns", "pod", "agent", ["/bin/sh"], undefined, 1000, exec);
    expect(result.stdout).toBe("ok");
    expect(clients.core.readNamespacedPod).toHaveBeenCalledBefore(exec);
    expect(exec).toHaveBeenCalledWith({}, "ns", "pod", "agent", ["/bin/sh"], undefined, 1000);
  });
});
