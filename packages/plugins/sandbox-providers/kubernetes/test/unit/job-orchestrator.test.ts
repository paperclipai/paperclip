import { describe, it, expect, vi } from "vitest";
import { createJob, deleteJob, getJobStatus, findPodForJob, JobTimeoutError, waitForJobCompletion } from "../../src/job-orchestrator.js";

describe("createJob", () => {
  it("calls batch.createNamespacedJob with the manifest", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "abc-uid" } });
    const clients = { batch: { createNamespacedJob: create } };
    const jobManifest = { apiVersion: "batch/v1", kind: "Job", metadata: { name: "r-1", namespace: "ns" }, spec: { template: {} } };
    const result = await createJob(clients as never, "ns", jobManifest);
    expect(create).toHaveBeenCalledWith({ namespace: "ns", body: jobManifest });
    expect(result.uid).toBe("abc-uid");
  });
});

describe("getJobStatus", () => {
  it("returns phase=Succeeded when succeeded count is 1", async () => {
    const get = vi.fn().mockResolvedValue({ status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Succeeded");
    expect(status.complete).toBe(true);
  });

  it("returns phase=Failed when failed count is >0", async () => {
    const get = vi.fn().mockResolvedValue({ status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Failed");
    expect(status.reason).toBe("DeadlineExceeded");
  });

  it("returns phase=Running when active count is >0", async () => {
    const get = vi.fn().mockResolvedValue({ status: { active: 1 } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Running");
  });

  it("returns phase=Pending when no active/succeeded/failed counters set", async () => {
    const get = vi.fn().mockResolvedValue({ status: {} });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Pending");
  });
});

describe("findPodForJob", () => {
  it("lists pods by job-name label and returns the first running pod", async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ metadata: { name: "r-1-xyz" }, status: { phase: "Running" } }] });
    const clients = { core: { listNamespacedPod: list } };
    const podName = await findPodForJob(clients as never, "ns", "r-1");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ namespace: "ns", labelSelector: "job-name=r-1" }));
    expect(podName).toBe("r-1-xyz");
  });

  it("returns null when no pod is found", async () => {
    const list = vi.fn().mockResolvedValue({ items: [] });
    const clients = { core: { listNamespacedPod: list } };
    const podName = await findPodForJob(clients as never, "ns", "r-1");
    expect(podName).toBeNull();
  });
});

describe("deleteJob", () => {
  it("calls batch.deleteNamespacedJob with foreground propagation", async () => {
    const del = vi.fn().mockResolvedValue({});
    const clients = { batch: { deleteNamespacedJob: del } };
    await deleteJob(clients as never, "ns", "r-1");
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns",
        name: "r-1",
        propagationPolicy: "Foreground",
      }),
    );
  });
});

describe("waitForJobCompletion", () => {
  it("throws JobTimeoutError when the deadline is exceeded", async () => {
    const get = vi.fn().mockResolvedValue({ status: { active: 1 } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    await expect(
      waitForJobCompletion(clients as never, "ns", "r-1", { timeoutMs: 50, pollMs: 10 }),
    ).rejects.toBeInstanceOf(JobTimeoutError);
  });
});
