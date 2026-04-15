import { describe, expect, it } from "vitest";
import {
  evaluateKatyaCheckWindow,
  evaluateKatyaOutreachHardening,
  isBlockerEscalationComplete,
  packageBlockerEscalationForPaperclip,
} from "../services/katya-autonomy.js";

describe("katya autonomy phase 3", () => {
  it("requires outreach quotas + prospect path + queue discipline", () => {
    const missing = evaluateKatyaOutreachHardening({
      quotas: { thursday: 0, friday: null },
      prospectMatchPath: [],
      approvalQueueStatus: "tbd",
    });
    expect(missing.complete).toBe(false);
    expect(missing.missing).toEqual(expect.arrayContaining([
      "thursday quota",
      "friday quota",
      "prospect match path",
      "approval queue discipline",
    ]));

    const good = evaluateKatyaOutreachHardening({
      quotas: { thursday: 12, friday: 8 },
      prospectMatchPath: ["source ICP", "score prospects", "route to approvals"],
      approvalQueueStatus: "reviewing_in_queue",
    });
    expect(good.complete).toBe(true);
    expect(good.discipline.approvalQueueDisciplined).toBe(true);
  });

  it("enforces blocker escalation terminal-state discipline", () => {
    expect(isBlockerEscalationComplete({
      owner: { displayName: "Felix" },
      dueAt: "2026-03-25T15:00:00Z",
      terminalState: "blocked",
      notes: null,
    })).toBe(false);

    expect(isBlockerEscalationComplete({
      owner: { displayName: "Felix" },
      dueAt: "2026-03-25T15:00:00Z",
      terminalState: "blocked_with_new_time",
      notes: null,
    })).toBe(true);
  });

  it("packages blocker escalation for paperclip and evaluates check windows", () => {
    const packaged = packageBlockerEscalationForPaperclip({
      owner: { displayName: "Katya" },
      dueAt: " 2026-03-25T15:00:00Z ",
      terminalState: "needs_review",
      notes: " waiting on external owner ",
    });
    expect(packaged.complete).toBe(true);
    expect(packaged.terminalState).toBe("NEEDS_REVIEW");
    expect(packaged.notes).toBe("waiting on external owner");

    const check = evaluateKatyaCheckWindow("10:00", {
      behind: true,
      reasons: ["overdue items"],
      overdueCount: 1,
      weeklyBehindCount: 0,
      weeklyMissedCount: 0,
    });
    expect(check.isScheduledCheck).toBe(true);
    expect(check.shouldEscalate).toBe(true);
  });
});
