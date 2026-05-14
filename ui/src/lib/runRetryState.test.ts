import { describe, expect, it } from "vitest";
import { describeRunRetryState, formatRetryReason } from "./runRetryState";

describe("runRetryState", () => {
  it("formats internal retry reasons for operators", () => {
    expect(formatRetryReason("transient_failure")).toBe("瞬时故障");
    expect(formatRetryReason("issue_continuation_needed")).toBe("需要接续");
    expect(formatRetryReason("max_turns_continuation")).toBe("达到轮次接续");
    expect(formatRetryReason("custom_reason")).toBe("custom reason");
  });

  it("describes scheduled retries", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "已安排重试",
      detail: "第 2 次尝试 · 瞬时故障",
    });
  });

  it("describes max-turn continuation retries distinctly", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-max-turns",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "max_turns_continuation",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "已安排接续",
      detail: "第 1 次尝试 · 达到轮次接续",
    });
  });

  it("describes exhausted retries", () => {
    expect(
      describeRunRetryState({
        status: "failed",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 4,
        scheduledRetryReason: "transient_failure",
        retryExhaustedReason: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      }),
    ).toMatchObject({
      kind: "exhausted",
      badgeLabel: "重试耗尽",
      detail: "第 4 次尝试 · 瞬时故障 · 自动重试已用尽",
      secondary: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued 需要人工介入。",
    });
  });
});
