import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "./agents";
import { api } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("agentsApi.retryFailedRun", () => {
  it("sends only the selected failed run and preserves a retry waiting for dispatch", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({
      actionId: "retry-action", status: "queued", runId: null, issueId: "issue-1",
    });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .resolves.toEqual({ runId: null, issueId: "issue-1" });
    expect(post).toHaveBeenCalledExactlyOnceWith("/agents/agent-1/wakeup?companyId=company-1", {
      source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: "original-failure",
    });
  });

  it.each(["failed", "timed_out", "cancelled", "interrupted"])(
    "reports a replayed %s retry instead of silently succeeding",
    async (status) => {
      const post = vi.spyOn(api, "post").mockResolvedValue({ id: "previous-retry", status });
      await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
        .rejects.toThrow("The previous retry has already stopped");
      expect(post).toHaveBeenCalledOnce();
    },
  );

  it.each(["queued", "running", "succeeded"])("accepts a %s successor without dispatching again", async (status) => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ id: "successor", status });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .resolves.toEqual({ runId: "successor", issueId: null });
    expect(post).toHaveBeenCalledOnce();
  });

  it.each(["queued", "deferred", "running", "succeeded"])("accepts a durable %s chat retry receipt", async (status) => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ actionId: "retry-action", status, runId: "successor", issueId: "issue-1" });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .resolves.toEqual({ runId: "successor", issueId: "issue-1" });
    expect(post).toHaveBeenCalledOnce();
  });

  it.each(["failed", "cancelled"])("reports a %s chat retry that could not start", async (status) => {
    vi.spyOn(api, "post").mockResolvedValue({ actionId: "retry-action", status, runId: null, issueId: "issue-1" });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .rejects.toThrow("This retry could not start");
  });

  it("accepts an ordinary run receipt without a status", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ id: "successor" });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .resolves.toEqual({ runId: "successor", issueId: null });
  });

  it.each([{ skipped: true }, { status: "skipped" }])("reports skipped-wake guidance for %j", async (receipt) => {
    vi.spyOn(api, "post").mockResolvedValue({ ...receipt, message: "Task execution is paused." });
    await expect(agentsApi.retryFailedRun("agent-1", "original-failure", "company-1"))
      .rejects.toThrow("Task execution is paused.");
  });
});

it("retries lifecycle work through the company-scoped agent route", async () => {
  const result = { id: "agent-1", lifecycleState: "preparing" };
  const post = vi.spyOn(api, "post").mockResolvedValue(result);
  await expect(agentsApi.retryLifecycle("agent-1", "company-1")).resolves.toEqual(result);
  expect(post).toHaveBeenCalledWith("/agents/agent-1/lifecycle/retry?companyId=company-1", {});
});
