import { describe, expect, it } from "vitest";
import {
  buildContentCampaignMarkdown,
  buildDailyBriefMarkdown,
  buildEmailReplyMarkdown,
  buildFocusPlanMarkdown,
  buildLeadPipelineMarkdown,
  buildMissionControlMarkdown,
  buildProposalMarkdown,
  buildWatchdogMarkdown,
  extractActionItems,
  normalizePlatforms,
  normalizeStage,
  summarizeTranscript,
} from "../src/domain.js";

describe("business workflow domain helpers", () => {
  it("extracts action items from transcript-like bullet lists", () => {
    const items = extractActionItems(`Action items:\n- Alice to send proposal by Friday\n- Owner: Bob Deadline: 2026-05-07 Schedule onboarding demo`);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toContain("Alice to send proposal by Friday");
    expect(items[1]?.owner).toBe("Bob");
    expect(items[1]?.title).toBe("Schedule onboarding demo");
  });

  it("builds proposal and email drafts", () => {
    const proposal = buildProposalMarkdown({
      title: "Discovery",
      notes: "Client wants a proposal for CRM automation and daily reporting.",
    });
    const email = buildEmailReplyMarkdown({
      subject: "Scope follow-up",
      senderName: "Jamie",
      thread: "Thanks for the call. Please confirm the best next step and timeline.",
      desiredOutcome: "confirm the implementation timeline",
      companyName: "Acme",
    });

    expect(proposal).toContain("# Proposal — Discovery");
    expect(proposal).toContain("## Deliverables");
    expect(email).toContain("# Email Reply Draft — Scope follow-up");
    expect(email).toContain("Hi Jamie,");
    expect(email).toContain("implementation timeline");
  });

  it("normalizes platforms and stages", () => {
    expect(summarizeTranscript("Line one\n\nLine two\nLine three")).toContain("Line one");
    expect(normalizePlatforms(["X", "linkedin", "x", " newsletter "], ["x"])).toEqual(["x", "linkedin", "newsletter"]);
    expect(normalizeStage("Proposal")).toBe("proposal");
    expect(normalizeStage("unknown", "nurture")).toBe("nurture");
  });

  it("builds CRM and campaign markdown", () => {
    const pipeline = buildLeadPipelineMarkdown({
      leadName: "Jane Smith",
      organization: "Acme",
      stage: "proposal",
      score: 75,
      nextStep: "Send the automation proposal",
      nextFollowUp: "2026-05-09",
      summary: "Strong intent from operations lead.",
      source: "ui",
    });
    const campaign = buildContentCampaignMarkdown({
      campaignName: "Q2 workflow sprint",
      sourceTitle: "Founder interview",
      sourceSummary: "This story explains how operator workflows move from transcript to execution.",
      platforms: ["x", "linkedin"],
      angle: "Show speed to value.",
      callToAction: "Reply for the workflow pack.",
    });

    expect(pipeline).toContain("# Lead Pipeline — Jane Smith @ Acme");
    expect(pipeline).toContain("Stage: proposal");
    expect(campaign).toContain("# Content Campaign — Q2 workflow sprint");
    expect(campaign).toContain("### x");
    expect(campaign).toContain("Reply for the workflow pack.");
  });

  it("builds daily brief, focus, mission control, and watchdog reports", () => {
    const dailyBrief = buildDailyBriefMarkdown({
      companyName: "Acme",
      openIssueTitles: ["Follow up with lead", "Review proposal"],
      activeGoalTitles: ["Launch outbound motion"],
      recentRecords: [
        {
          id: "rec_1",
          kind: "lead",
          title: "Lead: Jane",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const focusPlan = buildFocusPlanMarkdown({
      companyName: "Acme",
      date: "2026-05-08",
      blocks: [
        { start: "09:00", end: "10:30", label: "Proposal follow-up", reason: "high priority todo" },
      ],
      openIssueTitles: ["Proposal follow-up"],
      activeGoalTitles: ["Launch outbound motion"],
    });
    const missionControl = buildMissionControlMarkdown({
      companyName: "Acme",
      objective: "Launch workflow week",
      lanePlans: [
        { lane: "Revenue", owner: "Ops Agent", focus: "Unblock top deals." },
        { lane: "Content", focus: "Ship campaign assets." },
      ],
      openIssueTitles: ["Unblock proposal review"],
      activeGoalTitles: ["Launch workflow week"],
      riskTitles: ["One stakeholder is blocked"],
    });
    const watchdog = buildWatchdogMarkdown({
      companyName: "Acme",
      blockedIssueTitles: ["Blocked deal review"],
      staleIssueTitles: ["Old proposal thread"],
      followUpsDue: ["Jane Smith — Send proposal"],
      recentRecords: [
        {
          id: "rec_2",
          kind: "watchdog",
          title: "Watchdog report",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(dailyBrief).toContain("# Daily Brief — Acme");
    expect(focusPlan).toContain("# Focus Plan — Acme");
    expect(focusPlan).toContain("Proposal follow-up");
    expect(missionControl).toContain("# Mission Control — Launch workflow week");
    expect(missionControl).toContain("Revenue: Unblock top deals.");
    expect(watchdog).toContain("# Watchdog Report — Acme");
    expect(watchdog).toContain("Jane Smith — Send proposal");
  });
});