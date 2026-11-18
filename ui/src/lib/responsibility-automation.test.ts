// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  automationFixture,
  automationItemFixture,
  automationOverviewFixture,
  candidateFixture,
  denseAutomationFixture,
  denseBoardOverviewFixture,
  homeAutomationFixture,
  homeOverviewFixture,
  RESPONSIBILITY_FIXTURE_NOW,
  webhookStartFixture,
} from "../../storybook/fixtures/responsibilities";
import {
  automationAreaGroups,
  automationCountsLine,
  automationLevelCounts,
  automationSentence,
  automationShareLabel,
  automationStartWords,
  candidateReasonWords,
  conversationButtonLabel,
  describeCheckAge,
  noCandidatesWords,
  readDismissedCandidates,
  remainingCandidateCount,
  stalledWords,
  visibleCandidates,
  writeDismissedCandidates,
} from "./responsibility-automation";

const names: Record<string, string> = { "agent-codex": "CodexCoder", "agent-qa": "QA" };
const agentName = (id: string) => names[id];
const now = RESPONSIBILITY_FIXTURE_NOW;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the Automation view's words", () => {
  it("puts the counts and the share in words", () => {
    expect(automationShareLabel(null)).toBeNull();
    expect(automationShareLabel(0.4)).toBe("40% automated");
    expect(automationCountsLine({ automationCount: 1, manualTaskCount: 1, nothingFiled: false })).toBe("1 automation · 1 manual task");
    expect(automationCountsLine({ automationCount: 2, manualTaskCount: 5, nothingFiled: false })).toBe("2 automations · 5 manual tasks");
    expect(automationCountsLine({ automationCount: 0, manualTaskCount: 0, nothingFiled: true })).toBe("Nothing is filed under this yet.");
    expect(automationCountsLine({ automationCount: 0, manualTaskCount: 0, nothingFiled: false })).toBe("No automations and no recent manual tasks.");
  });

  it.each([
    [{ total: 20, manual: 9, candidates: 14 }, "9 of your 20 responsibilities have nothing automated yet; 14 manual tasks could be automated."],
    [{ total: 5, manual: 1, candidates: 1 }, "1 of your 5 responsibilities has nothing automated yet; 1 manual task could be automated."],
    [{ total: 3, manual: 3, candidates: 0 }, "None of your 3 responsibilities has anything automated yet."],
    [{ total: 1, manual: 1, candidates: 2 }, "Your responsibility has nothing automated yet; 2 manual tasks could be automated."],
    [{ total: 4, manual: 0, candidates: 3 }, "Every responsibility you own has something automated; 3 manual tasks could be automated."],
    [{ total: 4, manual: 0, candidates: 0 }, "Everything you own is automated."],
    [{ total: 0, manual: 0, candidates: 0 }, "You do not own any responsibilities yet."],
  ])("overall: %o", (input, sentence) => {
    expect(automationSentence(input)).toBe(sentence);
  });

  it("says how each automation starts, who runs it and what happened last", () => {
    expect(automationStartWords(automationItemFixture({ id: "a", title: "A" }), now)).toEqual({
      kind: "schedule", label: "On a schedule", detail: "Every Monday at 9 AM", status: null,
    });
    expect(automationStartWords(automationItemFixture({ id: "b", title: "B", start: webhookStartFixture }), now)).toMatchObject({
      kind: "webhook", label: "From a webhook", detail: "when another system calls it", status: "Last called yesterday",
    });
    expect(automationStartWords(automationItemFixture({ id: "c", title: "C", assigneeAgentId: "agent-qa", start: { kind: "standing_check", lastResult: null } }), now))
      .toMatchObject({ kind: "standing_check", label: "Standing check", detail: "on each wake-up", status: "Not checked yet" });
    const acted = automationStartWords(automationItemFixture({
      id: "d", title: "D", start: { kind: "standing_check", lastResult: { checkedAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(), outcome: "acted", note: "Nudged two owners", issue: null } },
    }), now);
    expect(acted.status).toBe("Last checked 2 hours ago: acted (Nudged two owners)");
    expect(automationStartWords(automationItemFixture({ id: "e", title: "E", start: { kind: "on_request" } }), now)).toMatchObject({ label: "On request" });
    expect(describeCheckAge(now, now)).toBe("just now");
    expect(describeCheckAge(new Date(now.getTime() - 5 * 60_000), now)).toBe("5 minutes ago");
  });

  it("says why an automation is not running", () => {
    expect(stalledWords({ reason: "paused", assigneeAgentId: "agent-codex" }, agentName)).toBe("Paused");
    expect(stalledWords({ reason: "no_agent", assigneeAgentId: null }, agentName)).toBe("No agent to run it");
    expect(stalledWords({ reason: "no_wakeups", assigneeAgentId: "agent-qa" }, agentName)).toBe("Not running: QA doesn’t wake up on its own (heartbeat off)");
  });

  it("says why a task is listed, and labels the primary action with the agent", () => {
    const done = candidateFixture({ issueId: "t", title: "Call the bank", status: "done", assigneeAgentId: "agent-codex", completedAt: "2026-11-10T12:00:00Z" });
    expect(done.hint).toBeNull();
    expect(candidateReasonWords(done, agentName, now)).toBe("Done by CodexCoder 3 days ago");
    expect(candidateReasonWords({ ...done, reason: "done", assigneeAgentId: null }, agentName, now)).toBe("Done by hand 3 days ago");
    expect(candidateReasonWords({ ...done, reason: "with_agent", status: "in_progress" }, agentName, now)).toBe("With CodexCoder now");
    expect(candidateReasonWords({ ...done, reason: "open" }, agentName, now)).toBeNull();
    const hinted = candidateFixture({ issueId: "h", title: "Triage new support tickets" });
    expect(hinted).toMatchObject({ reason: "hint", hint: { trigger: "webhook" } });
    expect(candidateReasonWords(hinted, agentName, now)).toBe(hinted.hint!.why);

    expect(conversationButtonLabel({ responsibleAgentId: "agent-codex", conversation: null }, agentName)).toBe("Automate with CodexCoder");
    expect(conversationButtonLabel({ responsibleAgentId: "agent-codex", conversation: { issueId: "c", identifier: null, agentId: "agent-codex", state: "discussing" } }, agentName)).toBe("Continue with CodexCoder");
    expect(conversationButtonLabel({ responsibleAgentId: "agent-codex", conversation: { issueId: "c", identifier: null, agentId: "agent-codex", state: "proposal_waiting" } }, agentName)).toBe("Review CodexCoder’s proposal");
  });

  it("says something true when nothing is left to suggest", () => {
    expect(noCandidatesWords({ automationCount: 2, manualTaskCount: 0, nothingFiled: false })).toBe("The automations are covering the work.");
    expect(noCandidatesWords({ automationCount: 0, manualTaskCount: 0, nothingFiled: false })).toBe("No recent manual tasks to automate.");
    expect(noCandidatesWords({ automationCount: 1, manualTaskCount: 3, nothingFiled: false })).toBe("Nothing else here looks worth automating.");
    expect(noCandidatesWords({ automationCount: 0, manualTaskCount: 0, nothingFiled: true })).toBeNull();
  });
});

describe("placing the rows", () => {
  it("groups by area like the Board, the most manual first within each", () => {
    const groups = automationAreaGroups(homeOverviewFixture.areas, homeOverviewFixture.responsibilities, homeAutomationFixture);
    expect(groups.map((group) => [group.area?.title ?? null, group.automationShare, group.items.map((item) => item.id)])).toEqual([
      ["Fundraising", "14% automated", ["resp-lp-updates", "resp-fundraising"]],
      ["Portfolio", "100% automated", ["resp-portfolio"]],
      ["Team", null, ["resp-hiring"]],
      [null, "67% automated", ["resp-board-reporting"]],
    ]);
    expect(automationLevelCounts(homeOverviewFixture.responsibilities, homeAutomationFixture)).toEqual({
      manual: 2, some_automated: 1, mostly_automated: 1, automated: 1,
    });
  });

  it("filters to the chosen levels and drops empty areas", () => {
    const groups = automationAreaGroups(homeOverviewFixture.areas, homeOverviewFixture.responsibilities, homeAutomationFixture, new Set(["manual"]));
    expect(groups.map((group) => [group.area?.title ?? null, group.items.map((item) => item.id)])).toEqual([
      ["Fundraising", ["resp-lp-updates"]],
      ["Team", ["resp-hiring"]],
    ]);
  });

  it("counts a responsibility the read does not cover yet as manual", () => {
    const read = automationOverviewFixture([]);
    const groups = automationAreaGroups(homeOverviewFixture.areas, homeOverviewFixture.responsibilities, read, new Set(["manual"]));
    expect(groups.flatMap((group) => group.items)).toHaveLength(5);
  });

  it("covers every level in the dense fixture", () => {
    const counts = automationLevelCounts(denseBoardOverviewFixture.responsibilities, denseAutomationFixture);
    expect(Object.values(counts).every((value) => value > 0)).toBe(true);
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(denseBoardOverviewFixture.responsibilities.length);
  });
});

describe("which manual tasks a row shows", () => {
  const automation = automationFixture({
    responsibilityId: "r",
    areaId: null,
    runningCount: 1,
    manual: 8,
    candidates: [
      candidateFixture({ issueId: "plain-1", title: "Call the bank" }),
      candidateFixture({ issueId: "weekly", title: "Weekly pipeline review" }),
      candidateFixture({ issueId: "tickets", title: "Triage new support tickets" }),
      candidateFixture({ issueId: "plain-2", title: "Clean up the drive" }),
      candidateFixture({ issueId: "invoices", title: "Follow up on overdue invoices" }),
      candidateFixture({ issueId: "report", title: "Prepare the board report" }),
    ],
  });

  it("shows tasks with a hint first, keeps the rest reachable, and counts what the read only counted", () => {
    expect(visibleCandidates(automation, new Set())).toMatchObject({
      shown: [{ issueId: "weekly" }, { issueId: "tickets" }, { issueId: "invoices" }],
      others: [{ issueId: "plain-1" }, { issueId: "plain-2" }, { issueId: "report" }],
      unlisted: 2,
      more: 5,
    });
    expect(visibleCandidates(automation, new Set(["weekly"]))).toMatchObject({
      shown: [{ issueId: "tickets" }, { issueId: "invoices" }, { issueId: "report" }],
      more: 4,
    });
    expect(remainingCandidateCount(automationOverviewFixture([automation]), new Set(["weekly", "tickets"]))).toBe(6);
  });

  it("offers the first task to work out with the agent when none has a hint", () => {
    const plain = automationFixture({
      responsibilityId: "p", areaId: null,
      candidates: [candidateFixture({ issueId: "a", title: "Call the bank" }), candidateFixture({ issueId: "b", title: "Clean up the drive" })],
    });
    expect(visibleCandidates(plain, new Set())).toMatchObject({ shown: [{ issueId: "a" }], others: [{ issueId: "b" }], unlisted: 0, more: 1 });
  });

  it("remembers dismissals per company, and works without storage", () => {
    writeDismissedCandidates("company-a", new Set(["x", "y"]));
    expect([...readDismissedCandidates("company-a")]).toEqual(["x", "y"]);
    expect(readDismissedCandidates("company-b").size).toBe(0);
    localStorage.setItem("paperclip:responsibilities:automation-dismissed:company-c", "not json");
    expect(readDismissedCandidates("company-c").size).toBe(0);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeDismissedCandidates("company-a", new Set(["z"]))).not.toThrow();
    expect(readDismissedCandidates("company-a").size).toBe(0);
  });
});
