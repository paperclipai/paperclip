import type { agents, Db, heartbeatRuns } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentProviderLimitCooldown } from "../native-runtime/native-startup-retry.js";
import { createProviderLimitWait, type ProviderLimitWaitDependencies } from "./provider-limit-wait.js";

vi.mock("../native-runtime/native-startup-retry.js", () => ({ agentProviderLimitCooldown: vi.fn() }));
vi.mock("../../modules/run-dispatch/index.js", () => ({ AI_CONNECTION_POOL_WAIT_RETRY_REASON: "ai_connection_pool_wait" }));

afterEach(() => vi.useRealTimers());

describe("provider limit wait timestamps", () => {
  it.each([
    { resetReported: false, outcome: "scheduled", remainingMs: 3_600_000, relative: "in 1 hour" },
    { resetReported: true, outcome: "scheduled", remainingMs: 3_600_000, relative: "in 1 hour" },
    { resetReported: false, outcome: "unavailable", remainingMs: 3_600_000, relative: "in 1 hour" },
    { resetReported: true, outcome: "unavailable", remainingMs: 3_600_000, relative: "in 1 hour" },
    { resetReported: false, outcome: "scheduled", remainingMs: 2_640_000, relative: "in 44 minutes" },
    { resetReported: true, outcome: "scheduled", remainingMs: 1000, relative: "in 1 minute" },
    { resetReported: true, outcome: "scheduled", remainingMs: 7_200_000, relative: "in 2 hours" },
  ])("shows relative time and a UTC deadline while preserving the exact retry time: %j", async ({ resetReported, outcome, remainingMs, relative }) => {
    const resetAt = new Date("2099-11-18T20:17:34.353Z");
    const now = new Date(resetAt.getTime() - remainingMs);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.mocked(agentProviderLimitCooldown).mockResolvedValue({
      resetAt, resetReported, category: "rate_limit", sourceRunId: "limited-run",
    });
    const run = { id: "waiting-run", companyId: "company", agentId: "agent", status: "running",
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: "wake" } as typeof heartbeatRuns.$inferSelect;
    const agent = { id: "agent", runtimeConfig: {} } as typeof agents.$inferSelect;
    const deps = {
      setRunStatusIfRunning: vi.fn(async () => ({ updated: true, run })),
      setWakeupStatus: vi.fn(async () => undefined),
      appendRunEvent: vi.fn(async () => undefined),
      scheduleBoundedRetryForRun: vi.fn(async () => ({ outcome })),
      releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
      finalizeAgentStatus: vi.fn(async () => undefined),
    } satisfies ProviderLimitWaitDependencies;

    await expect(createProviderLimitWait({} as Db, deps).deferRunForProviderLimit(run, agent, {
      resumingAdmittedRun: false, conversation: false,
    })).resolves.toBe(true);

    const label = `${relative} (Nov 18, 2099, 8:17 PM UTC)`;
    const message = `The provider usage limit for this agent is expected to reset ${label}${
      resetReported ? "" : " (no reset time was reported, so Paperclip waits one hour)"
    }. Paperclip will start this work then.`;
    expect(deps.setRunStatusIfRunning).toHaveBeenCalledWith(run.id, "cancelled", expect.objectContaining({
      error: message,
      resultJson: expect.objectContaining({
        providerLimitWait: expect.objectContaining({ resetAt: resetAt.toISOString(), resetReported }),
        retryAt: resetAt.toISOString(),
      }),
    }));
    expect(deps.setWakeupStatus).toHaveBeenCalledWith("wake", "cancelled", { finishedAt: now, error: message });
    expect(deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(run, agent, expect.objectContaining({ now, delayMs: remainingMs + 1000 }));
    expect(deps.appendRunEvent).toHaveBeenCalledWith(run, expect.objectContaining({
      message: outcome === "scheduled"
        ? `Waiting for the provider usage limit to reset ${label} before starting work`
        : `The provider usage limit resets ${label}; this wake could not schedule its retry and released the task`,
      payload: expect.objectContaining({ resetAt: resetAt.toISOString(), retryScheduled: outcome === "scheduled" }),
    }));
  });
});
