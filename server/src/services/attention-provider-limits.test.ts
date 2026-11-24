import { describe, expect, it } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { groupProviderLimits, providerLimitForHold } from "./attention-provider-limits.js";

const run = { runId: "run-1", taskId: "task-1", agentId: "agent-1", agentName: "Editor", account: "account-1" };
const reset = "2026-11-24T21:00:00Z";
const scheduled = { providerLimitResetAt: reset, providerLimitAutomatic: true };

describe("provider usage limits in the inbox", () => {
  it("uses the same known account and reset across agents, keeping unverified or estimated windows separate", () => {
    const episode = providerLimitForHold(run, scheduled, "").episode;
    const other = { ...run, runId: "run-2", taskId: "task-2", agentId: "agent-2" };
    expect(providerLimitForHold(other, scheduled, "").episode).toBe(episode);
    expect(providerLimitForHold({ ...other, account: "account-2" }, scheduled, "").episode).not.toBe(episode);
    expect(providerLimitForHold(other, { ...scheduled, providerLimitEstimated: true }, "").episode).not.toBe(episode);
    expect(providerLimitForHold({ ...other, account: null }, scheduled, "").episode).not.toBe(episode);
  });

  it("labels a scheduled recheck independently of what the provider reported", () => {
    const retryAt = new Date(reset).toISOString();
    expect(providerLimitForHold(run, { ...scheduled, providerLimitEstimated: true }, ""))
      .toMatchObject({ grouping: "retry_chain", resetAt: null, retryAt, state: "scheduled" });
    expect(providerLimitForHold({ ...run, account: null }, scheduled, ""))
      .toMatchObject({ grouping: "retry_chain", resetAt: retryAt, state: "scheduled" });
    expect(providerLimitForHold(run, scheduled, ""))
      .toMatchObject({ grouping: "account_window", resetAt: retryAt });
  });

  it("keeps the dismissal stable across lead changes and isolates different recipients", () => {
    const member = (id: string, userId: string, manual = false) => ({
      id, audience: { kind: "user", userId },
      providerLimit: providerLimitForHold({ ...run, runId: id },
        { ...scheduled, ...(manual && { providerLimitResume: { state: "not_requested" } }) }, ""),
    } as AttentionItem);
    const first = member("first", "me");
    groupProviderLimits([first]);
    const key = first.dismissalKey;
    const manual = member("second", "me", true);
    const other = member("third", "someone-else");
    groupProviderLimits([first, manual, other]);
    expect(first.obligationLeadId).toBe(manual.id);
    expect(manual.dismissalKey).toBe(key);
    expect(other.obligationLeadId).toBe(other.id);
    expect(other.dismissalKey).not.toBe(key);
  });

  it("keeps a queued retry waiting, and a known reset without an automatic retry actionable", () => {
    expect(providerLimitForHold(run, { ...scheduled, providerLimitResume: { state: "requested" } }, "").state).toBe("retry_requested");
    expect(providerLimitForHold(run, { providerLimitResetAt: reset }, "Retry this task.").state).toBe("needs_retry");
    expect(providerLimitForHold(run, { providerLimitResetAt: reset }, "Paperclip will retry this task then.").state).toBe("scheduled");
  });
});
