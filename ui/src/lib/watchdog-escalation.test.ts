// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Issue, IssueWatchdogSummary } from "@paperclipai/shared";
import {
  WATCHDOG_MAX_RESTORATION_ATTEMPTS,
  buildWatchdogEscalationView,
  isWatchdogEscalated,
} from "./watchdog-escalation";

function watchdog(overrides: Partial<IssueWatchdogSummary> = {}): IssueWatchdogSummary {
  return {
    id: "wd-1",
    companyId: "c",
    issueId: "i",
    watchdogAgentId: "agent-wd",
    instructions: null,
    status: "active",
    watchdogIssueId: null,
    lastObservedFingerprint: "a8f7",
    lastReviewedFingerprint: null,
    restorationFingerprint: "a8f7",
    restorationVerificationPending: false,
    restorationAttemptCount: 3,
    restorationAttempts: [
      { attempt: 1, fingerprint: "a8f7", runId: "run-111aaaa", mutations: [{ type: "add_comment", issueId: "leaf-uuid-1234" }], completedAt: "2026-05-09T20:36:00.000Z" },
      { attempt: 2, fingerprint: "a8f7", runId: "run-222bbbb", mutations: [{ type: "update_issue", issueId: "leaf-uuid-1234", update: { status: "todo" } }], completedAt: "2026-05-09T20:45:00.000Z" },
      { attempt: 3, fingerprint: "a8f7", runId: "run-333cccc", mutations: [], completedAt: "2026-05-09T20:51:00.000Z" },
    ],
    restorationEscalatedAt: new Date("2026-05-09T20:51:30.000Z"),
    lastTriggeredAt: null,
    lastCompletedAt: null,
    triggerCount: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return { id: "i", identifier: "PAP-1", title: "t", watchdog: watchdog(), ...overrides } as unknown as Issue;
}

describe("watchdog-escalation", () => {
  it("detects escalation from the watchdog escalation timestamp", () => {
    expect(isWatchdogEscalated(issue())).toBe(true);
  });

  it("detects escalation from an escalated recovery action", () => {
    const i = issue({
      watchdog: watchdog({ restorationEscalatedAt: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      activeRecoveryAction: { status: "escalated" } as any,
    });
    expect(isWatchdogEscalated(i)).toBe(true);
  });

  it("is not escalated when neither signal is present", () => {
    expect(isWatchdogEscalated(issue({ watchdog: watchdog({ restorationEscalatedAt: null }) }))).toBe(false);
  });

  it("returns null when there is no watchdog", () => {
    expect(buildWatchdogEscalationView(issue({ watchdog: null }))).toBeNull();
  });

  it("builds an attempt timeline with mutation summaries and unchanged-fingerprint flags", () => {
    const view = buildWatchdogEscalationView(issue())!;
    expect(view.escalated).toBe(true);
    expect(view.attemptCount).toBe(3);
    expect(view.maxAttempts).toBe(WATCHDOG_MAX_RESTORATION_ATTEMPTS);
    expect(view.fingerprintUnchangedAcrossAttempts).toBe(true);
    expect(view.fingerprintShort).toBe("a8f7");
    expect(view.attempts).toHaveLength(3);
    expect(view.attempts[0]!.mutationSummary).toContain("commented on leaf-uui");
    expect(view.attempts[1]!.mutationSummary).toContain("→ todo");
    expect(view.attempts[2]!.mutationSummary).toContain("no restoration write");
    expect(view.attempts.every((a) => a.fingerprintUnchanged)).toBe(true);
  });
});
