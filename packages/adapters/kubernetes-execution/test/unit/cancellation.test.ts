import { describe, it, expect, vi } from "vitest";
import { cancelJob } from "../../src/orchestrator/cancellation.js";

describe("cancelJob", () => {
  it("calls deleteNamespacedJob with foreground propagation and 30s grace", async () => {
    const client = {
      batch: { deleteNamespacedJob: vi.fn(async () => ({})) },
    } as unknown as Parameters<typeof cancelJob>[0]["client"];
    await cancelJob({ client, namespace: "ns", jobName: "job-x" });
    expect(client.batch.deleteNamespacedJob).toHaveBeenCalledWith(
      "job-x",
      "ns",
      undefined,
      undefined,
      30,
      undefined,
      "Foreground",
    );
  });

  it("respects custom grace period", async () => {
    const client = {
      batch: { deleteNamespacedJob: vi.fn(async () => ({})) },
    } as unknown as Parameters<typeof cancelJob>[0]["client"];
    await cancelJob({ client, namespace: "ns", jobName: "job-x", graceSeconds: 60 });
    expect(client.batch.deleteNamespacedJob).toHaveBeenCalledWith(
      "job-x",
      "ns",
      undefined,
      undefined,
      60,
      undefined,
      "Foreground",
    );
  });
});
