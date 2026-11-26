import { describe, expect, it } from "vitest";
import {
  automationCandidateReason,
  automationHintForTask,
  automationStartLabel,
  createAutomationProposalSchema,
  createRoutineFromTaskSchema,
  rankAutomationCandidates,
  RESPONSIBILITY_AUTOMATION_LEVEL_LABEL,
  RESPONSIBILITY_AUTOMATION_MOSTLY_SHARE,
  responsibilityAutomationLevel,
  responsibilityAutomationShare,
  responsibleAutomationAgentId,
  suggestCadenceFromTitle,
  type AutomationCandidateInput,
} from "./responsibility-automation.js";
import { reportStandingCheckSchema } from "./standing-checks.js";

describe("how automated a responsibility is", () => {
  it("has no share with neither automations nor manual tasks", () => {
    expect(responsibilityAutomationShare(0, 0)).toBeNull();
    expect(responsibilityAutomationShare(2, 6)).toBe(0.25);
    expect(responsibilityAutomationShare(3, 0)).toBe(1);
  });

  it.each([
    // [automations, manual tasks, level]
    [0, 0, "manual"], // nothing filed
    [0, 7, "manual"],
    [1, 3, "some_automated"], // 25%
    [2, 3, "some_automated"], // 40%
    [1, 1, "mostly_automated"], // exactly half
    [3, 1, "mostly_automated"], // 75%
    [2, 0, "automated"],
  ] as const)("%i automations and %i manual tasks is %s", (automations, manual, level) => {
    expect(responsibilityAutomationLevel(automations, manual)).toBe(level);
  });

  it("puts the threshold at half and names the levels in plain words", () => {
    expect(RESPONSIBILITY_AUTOMATION_MOSTLY_SHARE).toBe(0.5);
    expect(responsibilityAutomationLevel(49, 51)).toBe("some_automated");
    expect(responsibilityAutomationLevel(50, 50)).toBe("mostly_automated");
    expect(Object.values(RESPONSIBILITY_AUTOMATION_LEVEL_LABEL)).toEqual(["Manual", "Some automated", "Mostly automated", "Automated"]);
  });
});

describe("the trigger hint", () => {
  it.each([
    // [title, trigger, words, cadence label]
    ["Weekly investor pipeline review", "schedule", "Weekly", "Every Monday at 9 AM"],
    ["Monday metrics", "schedule", "Monday", "Every Monday at 9 AM"],
    ["Check page speed every morning", "schedule", "every morning", "Every day at 9 AM"],
    ["Quarterly board deck", "schedule", "Quarterly", null],
    ["Daily triage of new tickets", "schedule", "Daily", "Every day at 9 AM"],
    ["Prepare the board report", "schedule", "report", null],
    ["Reconcile the Stripe payouts", "schedule", "Reconcile", null],
    ["Send the board update", "schedule", "Send the board update", null],
    ["Triage new support tickets", "webhook", "Triage", null],
    ["Reply to inbound investor emails", "webhook", "Reply", null],
    ["Review community pull requests", "webhook", "pull requests", null],
    ["Answer requests for the Fund VI materials", "webhook", "requests", null],
    ["Follow up on overdue invoices", "standing_check", "Follow up", null],
    ["Chase candidates who have waited more than two days", "standing_check", "Chase", null],
    ["Make sure every new hire has a laptop", "standing_check", "Make sure", null],
    ["Keep an eye on the error budget", "standing_check", "Keep an eye", null],
    ["Reply to the founders who have waited more than two weeks", "standing_check", "waited", null],
  ] as const)("%s → %s", (title, trigger, words, cadenceLabel) => {
    const hint = automationHintForTask({ title });
    expect(hint).toMatchObject({ trigger, words, cadenceLabel });
    expect(hint!.why.length).toBeGreaterThan(10);
  });

  it.each(["Fix the checkout button", "Get the cap table from counsel", "Everyone offsite plan", "Renew the firm's domain", "Every candidate deserves a reply"])(
    "gives no trigger claim for %s",
    (title) => {
      // "Every candidate…": "every" names no time, and "reply" is in the title, so it is a webhook hint at most.
      const hint = automationHintForTask({ title });
      if (title.startsWith("Every candidate")) expect(hint?.trigger).toBe("webhook");
      else expect(hint).toBeNull();
    },
  );

  it("says why in hedged words, never as a decision", () => {
    expect(automationHintForTask({ title: "Weekly pipeline review" })!.why).toBe(
      "The title says “Weekly”, so a schedule could fit: every Monday at 9 AM.",
    );
    expect(automationHintForTask({ title: "Prepare the board report" })!.why).toBe(
      "“report” usually comes round regularly, so a schedule could fit; how often is still to settle.",
    );
    expect(automationHintForTask({ title: "Triage new support tickets" })!.why).toBe(
      "It sounds like reacting to something coming in (“Triage”), so a webhook could start it.",
    );
    expect(automationHintForTask({ title: "Follow up on overdue invoices" })!.why).toBe(
      "It sounds like watching for something (“Follow up”), so a standing check on each wake-up could fit.",
    );
  });

  it("reads a cadence from the title when it names one", () => {
    expect(suggestCadenceFromTitle("Thursday pipeline review")).toEqual({ frequency: "weekly", dayOfWeek: "thursday", dayOfMonth: null, time: "09:00" });
    expect(suggestCadenceFromTitle("Every weekday inbox sweep")).toMatchObject({ frequency: "weekdays" });
    expect(suggestCadenceFromTitle("Daily standup notes")).toMatchObject({ frequency: "daily" });
    expect(suggestCadenceFromTitle("Check the queue every day")).toMatchObject({ frequency: "daily" });
    expect(suggestCadenceFromTitle("Weekly competitor summary")).toMatchObject({ frequency: "weekly", dayOfWeek: "monday" });
    expect(suggestCadenceFromTitle("Monthly LP letter")).toEqual({ frequency: "monthly", dayOfWeek: null, dayOfMonth: 1, time: "09:00" });
    expect(suggestCadenceFromTitle("Quarterly board deck")).toBeNull();
    expect(suggestCadenceFromTitle("Send the October update")).toBeNull();
  });
});

describe("ranking the manual tasks that could be automated", () => {
  const task = (overrides: Partial<AutomationCandidateInput> & Pick<AutomationCandidateInput, "id" | "title">): AutomationCandidateInput => ({
    status: "todo",
    assigneeAgentId: null,
    completedAt: null,
    updatedAt: "2026-11-01T00:00:00Z",
    hasPendingOffer: false,
    ...overrides,
  });

  it("puts an agent's offer first, then tasks with a hint, then done before open, then with an agent", () => {
    const tasks = [
      task({ id: "open-person", title: "Ask Dana for an intro" }),
      task({ id: "open-agent", title: "Draft the hiring plan", assigneeAgentId: "agent" }),
      task({ id: "done-person", title: "Call the bank", status: "done", completedAt: "2026-11-10T00:00:00Z" }),
      task({ id: "done-agent", title: "Clean up the CRM", status: "done", assigneeAgentId: "agent", completedAt: "2026-11-09T00:00:00Z" }),
      task({ id: "hinted-open", title: "Triage new support tickets" }),
      task({ id: "hinted-done", title: "Send the October update", status: "done", completedAt: "2026-10-31T00:00:00Z" }),
      task({ id: "offered", title: "Competitor pricing", status: "done", assigneeAgentId: "agent", completedAt: "2026-10-01T00:00:00Z", hasPendingOffer: true }),
    ];
    expect(rankAutomationCandidates(tasks).map((entry) => entry.id)).toEqual([
      "offered",
      "hinted-done",
      "hinted-open",
      "done-agent",
      "done-person",
      "open-agent",
      "open-person",
    ]);
    expect(tasks.map((entry) => [entry.id, automationCandidateReason(entry)])).toEqual([
      ["open-person", "open"],
      ["open-agent", "with_agent"],
      ["done-person", "done"],
      ["done-agent", "done_by_agent"],
      ["hinted-open", "hint"],
      ["hinted-done", "hint"],
      ["offered", "pending_offer"],
    ]);
  });

  it("breaks ties by the most recent, then the id", () => {
    const tasks = [
      task({ id: "b", title: "Clean up", status: "done", completedAt: "2026-11-01T00:00:00Z" }),
      task({ id: "c", title: "Tidy up", status: "done", completedAt: "2026-11-05T00:00:00Z" }),
      task({ id: "a", title: "Sort out", status: "done", completedAt: "2026-11-01T00:00:00Z" }),
    ];
    expect(rankAutomationCandidates(tasks).map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });
});

describe("the responsible agent", () => {
  const canTakeWork = (id: string) => id !== "paused";
  it("is the task's agent, else one working under the responsibility, else the first assignable", () => {
    expect(responsibleAutomationAgentId({ taskAgentId: "task-agent", agentsUnderResponsibility: ["runner"], firstAssignableAgentId: "first", canTakeWork })).toBe("task-agent");
    expect(responsibleAutomationAgentId({ taskAgentId: "paused", agentsUnderResponsibility: ["paused", "runner"], firstAssignableAgentId: "first", canTakeWork })).toBe("runner");
    expect(responsibleAutomationAgentId({ taskAgentId: null, agentsUnderResponsibility: [], firstAssignableAgentId: "first", canTakeWork })).toBe("first");
    expect(responsibleAutomationAgentId({ taskAgentId: null, agentsUnderResponsibility: [], firstAssignableAgentId: null, canTakeWork })).toBeNull();
  });
});

describe("setting an automation up by hand", () => {
  const body = { title: "Weekly pipeline review", cadence: { frequency: "weekly", dayOfWeek: "monday", time: "09:00" }, assigneeAgentId: "6f1b2d1e-1b2c-4d5e-8f90-123456789abc" };

  it("needs a title, a complete cadence and an agent", () => {
    expect(createRoutineFromTaskSchema.safeParse(body).success).toBe(true);
    expect(createRoutineFromTaskSchema.safeParse({ ...body, title: " " }).success).toBe(false);
    expect(createRoutineFromTaskSchema.safeParse({ ...body, title: "Report on {{topic}}" }).success).toBe(false);
    expect(createRoutineFromTaskSchema.safeParse({ ...body, cadence: { frequency: "weekly", time: "09:00" } }).success).toBe(false);
    expect(createRoutineFromTaskSchema.safeParse({ ...body, assigneeAgentId: undefined }).success).toBe(false);
    expect(createRoutineFromTaskSchema.safeParse({ ...body, extra: true }).success).toBe(false);
  });
});

describe("an agent's automation proposal", () => {
  const base = { title: "Triage new tickets", instructions: "Label each new ticket and route it." };

  it("takes one of three ways to start, each complete", () => {
    expect(createAutomationProposalSchema.safeParse({ ...base, trigger: { kind: "schedule", cadence: { frequency: "daily", time: "08:00" } } }).success).toBe(true);
    expect(createAutomationProposalSchema.safeParse({ ...base, trigger: { kind: "webhook", caller: "The help desk, when a ticket is opened" } }).success).toBe(true);
    expect(createAutomationProposalSchema.safeParse({ ...base, trigger: { kind: "standing_check", lookFor: "Tickets older than a day", whenFound: "Nudge the owner" } }).success).toBe(true);
    expect(createAutomationProposalSchema.safeParse({ ...base, trigger: { kind: "schedule", cadence: { frequency: "weekly", time: "08:00" } } }).success).toBe(false);
    expect(createAutomationProposalSchema.safeParse({ ...base, trigger: { kind: "webhook" } }).success).toBe(false);
    expect(createAutomationProposalSchema.safeParse({ ...base, trigger: { kind: "standing_check", lookFor: "x" } }).success).toBe(false);
    expect(createAutomationProposalSchema.safeParse({ ...base, trigger: { kind: "cron" } }).success).toBe(false);
    expect(createAutomationProposalSchema.safeParse({ ...base, instructions: "Use {{ticket}}", trigger: { kind: "webhook", caller: "x" } }).success).toBe(false);
  });

  it("says how it starts in plain words", () => {
    expect(automationStartLabel({ kind: "schedule", cadence: { frequency: "weekly", dayOfWeek: "friday", time: "16:30" } }, "Analyst")).toBe("Every Friday at 4:30 PM");
    expect(automationStartLabel({ kind: "webhook", caller: "x" }, "Analyst")).toBe("When another system calls it");
    expect(automationStartLabel({ kind: "standing_check", lookFor: "x", whenFound: "y" }, "Analyst")).toBe("Each time Analyst wakes up");
  });
});

describe("a standing check's result", () => {
  it("needs a note when the agent acted", () => {
    expect(reportStandingCheckSchema.safeParse({ outcome: "nothing_needed" }).success).toBe(true);
    expect(reportStandingCheckSchema.safeParse({ outcome: "acted" }).success).toBe(false);
    expect(reportStandingCheckSchema.safeParse({ outcome: "acted", note: "Nudged two owners" }).success).toBe(true);
    expect(reportStandingCheckSchema.safeParse({ outcome: "maybe" }).success).toBe(false);
  });
});
