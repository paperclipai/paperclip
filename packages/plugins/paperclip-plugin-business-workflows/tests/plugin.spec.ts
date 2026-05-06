import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Company, Goal, Issue, Project } from "@paperclipai/shared";
import { ACTION_KEYS, DATA_KEYS, JOB_KEYS, STATE_KEYS, TOOL_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function buildCompany(now: Date): Company {
  return {
    id: "co_1",
    name: "Acme",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    createdAt: now,
    updatedAt: now,
    issuePrefix: "ACM",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10 * 1024 * 1024,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
  };
}

function buildProject(now: Date): Project {
  return {
    id: "proj_1",
    companyId: "co_1",
    urlKey: "growth",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Growth",
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/paperclip-growth",
      effectiveLocalFolder: "/tmp/paperclip-growth",
      origin: "local_folder",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildGoal(now: Date): Goal {
  return {
    id: "goal_1",
    companyId: "co_1",
    title: "Launch growth workflows",
    description: null,
    level: "team",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildAgent(now: Date): Agent {
  return {
    id: "agent_1",
    companyId: "co_1",
    name: "Ops Agent",
    urlKey: "ops-agent",
    role: "pm",
    title: "Operator",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: true },
    lastHeartbeatAt: now,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildIssue(overrides: Partial<Issue> = {}): Issue {
  const now = overrides.createdAt ?? new Date("2026-05-01T09:00:00.000Z");
  return {
    id: overrides.id ?? "issue_seed",
    companyId: overrides.companyId ?? "co_1",
    projectId: overrides.projectId ?? "proj_1",
    projectWorkspaceId: overrides.projectWorkspaceId ?? null,
    goalId: overrides.goalId ?? null,
    parentId: overrides.parentId ?? null,
    title: overrides.title ?? "Seed issue",
    description: overrides.description ?? null,
    status: overrides.status ?? "todo",
    priority: overrides.priority ?? "medium",
    assigneeAgentId: overrides.assigneeAgentId ?? null,
    assigneeUserId: overrides.assigneeUserId ?? null,
    checkoutRunId: overrides.checkoutRunId ?? null,
    executionRunId: overrides.executionRunId ?? null,
    executionAgentNameKey: overrides.executionAgentNameKey ?? null,
    executionLockedAt: overrides.executionLockedAt ?? null,
    createdByAgentId: overrides.createdByAgentId ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
    issueNumber: overrides.issueNumber ?? null,
    identifier: overrides.identifier ?? null,
    originKind: overrides.originKind ?? "plugin:paperclipai.business-workflows",
    originId: overrides.originId ?? null,
    originRunId: overrides.originRunId ?? null,
    requestDepth: overrides.requestDepth ?? 0,
    billingCode: overrides.billingCode ?? null,
    assigneeAdapterOverrides: overrides.assigneeAdapterOverrides ?? null,
    executionWorkspaceId: overrides.executionWorkspaceId ?? null,
    executionWorkspacePreference: overrides.executionWorkspacePreference ?? null,
    executionWorkspaceSettings: overrides.executionWorkspaceSettings ?? null,
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    hiddenAt: overrides.hiddenAt ?? null,
    blockedBy: overrides.blockedBy,
    blocks: overrides.blocks,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe("business workflows plugin", () => {
  it("creates meeting issues/tasks and stores a daily brief", async () => {
    const harness = createTestHarness({ manifest });
    const now = new Date("2026-05-03T10:00:00.000Z");

    harness.seed({
      companies: [buildCompany(now)],
      projects: [buildProject(now)],
      goals: [buildGoal(now)],
    });

    await plugin.definition.setup(harness.ctx);

    const ingestResult = await harness.performAction<{ parentIssueId: string; createdTaskCount: number }>(
      ACTION_KEYS.ingestMeetingTranscript,
      {
        companyId: "co_1",
        projectId: "proj_1",
        title: "Weekly Sync",
        transcript: "Action items:\n- Alice to send proposal by Friday\n- Bob to schedule follow-up demo",
      },
    );

    expect(ingestResult.createdTaskCount).toBe(2);

    const issues = await harness.ctx.issues.list({ companyId: "co_1", limit: 20, offset: 0 });
    expect(issues).toHaveLength(3);

    const brief = await harness.performAction<{ markdown: string }>(ACTION_KEYS.generateDailyBrief, { companyId: "co_1" });
    expect(brief.markdown).toContain("Daily Brief — Acme");

    const storedBrief = harness.getState({ scopeKind: "company", scopeId: "co_1", stateKey: STATE_KEYS.latestDailyBrief }) as { markdown: string };
    expect(storedBrief.markdown).toContain("Open items");

    const overview = await harness.getData<{ counts: { records: number; openIssues: number } }>("overview", { companyId: "co_1" });
    expect(overview.counts.records).toBeGreaterThan(0);
    expect(overview.counts.openIssues).toBeGreaterThan(0);
  });

  it("handles email, pipeline, campaigns, focus plans, mission control, and watchdog reports", async () => {
    const harness = createTestHarness({ manifest });
    const now = new Date("2026-05-03T10:00:00.000Z");
    const staleDate = new Date("2026-04-20T10:00:00.000Z");

    harness.seed({
      companies: [buildCompany(now)],
      projects: [buildProject(now)],
      goals: [buildGoal(now)],
      agents: [buildAgent(now)],
      issues: [
        buildIssue({
          id: "issue_stale_blocked",
          title: "Blocked deal review",
          description: "Waiting on approval",
          status: "blocked",
          priority: "high",
          createdAt: staleDate,
          updatedAt: staleDate,
        }),
      ],
    });

    await plugin.definition.setup(harness.ctx);

    const email = await harness.performAction<{ issueId: string; replyMarkdown: string }>(ACTION_KEYS.ingestEmailThread, {
      companyId: "co_1",
      projectId: "proj_1",
      subject: "Re: CRM automation scope",
      fromName: "Morgan",
      fromEmail: "morgan@example.com",
      desiredOutcome: "confirm the timeline and proposal path",
      thread: "Please confirm the scope and next step.\nAction items:\n- Send the scoped proposal by Friday",
    });
    expect(email.replyMarkdown).toContain("# Email Reply Draft — Re: CRM automation scope");

    const calendar = await harness.performAction<{ issueId: string; createdTaskCount: number }>(ACTION_KEYS.ingestCalendarEvent, {
      companyId: "co_1",
      projectId: "proj_1",
      title: "Pipeline review",
      startsAt: "2026-05-05T09:00:00.000Z",
      attendees: ["alex@example.com", "jamie@example.com"],
      notes: "Action items:\n- Review stalled deals\n- Prepare renewal summary",
    });
    expect(calendar.createdTaskCount).toBe(2);

    await harness.performAction<{ issueId: string }>(ACTION_KEYS.ingestLead, {
      companyId: "co_1",
      projectId: "proj_1",
      leadName: "Jane Smith",
      organization: "Acme Inc.",
      need: "Automate sales follow-up",
      notes: "Interested in reporting automation.",
      source: "ui",
    });

    const pipeline = await harness.performAction<{ stage: string; followUpIssueId: string | null; markdown: string }>(ACTION_KEYS.updateLeadPipeline, {
      companyId: "co_1",
      projectId: "proj_1",
      leadName: "Jane Smith",
      organization: "Acme Inc.",
      stage: "proposal",
      nextStep: "Send the automation proposal",
      nextFollowUp: "2026-05-01",
      notes: "Strong intent and budget alignment.",
      source: "ui",
    });
    expect(pipeline.stage).toBe("proposal");
    expect(pipeline.followUpIssueId).toBeTruthy();
    expect(pipeline.markdown).toContain("Stage: proposal");

    const campaign = await harness.performAction<{ parentIssueId: string; childIssueIds: string[]; markdown: string }>(ACTION_KEYS.generateContentCampaign, {
      companyId: "co_1",
      projectId: "proj_1",
      campaignName: "Q2 workflow sprint",
      sourceTitle: "Founder interview clip",
      sourceSummary: "Turn the founder interview into a multi-platform workflow story.",
      angle: "Show transcript-to-revenue speed.",
      callToAction: "Reply for the workflow pack.",
      platforms: ["x", "linkedin"],
    });
    expect(campaign.childIssueIds).toHaveLength(2);
    expect(campaign.markdown).toContain("# Content Campaign — Q2 workflow sprint");

    const focus = await harness.performAction<{ date: string; markdown: string }>(ACTION_KEYS.planFocusBlocks, {
      companyId: "co_1",
      date: "2026-05-05",
      preferredStart: "09:00",
      hours: 3,
    });
    expect(focus.date).toBe("2026-05-05");
    expect(focus.markdown).toContain("# Focus Plan — Acme");

    const mission = await harness.performAction<{ goalId: string; parentIssueId: string; invokedAgentIds: string[] }>(ACTION_KEYS.launchMissionControl, {
      companyId: "co_1",
      projectId: "proj_1",
      objective: "Ship the workflow launch week",
      lanes: ["Revenue", "Content"],
      invokeAgents: true,
    });
    expect(mission.goalId).toBeTruthy();
    expect(mission.parentIssueId).toBeTruthy();
    expect(mission.invokedAgentIds).toEqual(["agent_1"]);

    const watchdog = await harness.performAction<{ blockedIssueCount: number; staleIssueCount: number; followUpsDueCount: number; markdown: string }>(ACTION_KEYS.runPipelineWatchdog, {
      companyId: "co_1",
    });
    expect(watchdog.blockedIssueCount).toBeGreaterThan(0);
    expect(watchdog.staleIssueCount).toBeGreaterThan(0);
    expect(watchdog.followUpsDueCount).toBeGreaterThan(0);
    expect(watchdog.markdown).toContain("# Watchdog Report — Acme");

    const emailReplyState = harness.getState({ scopeKind: "company", scopeId: "co_1", stateKey: STATE_KEYS.latestEmailReply }) as { subject: string; markdown: string };
    const missionState = harness.getState({ scopeKind: "company", scopeId: "co_1", stateKey: STATE_KEYS.latestMissionControlPlan }) as { objective: string; markdown: string };
    const watchdogState = harness.getState({ scopeKind: "company", scopeId: "co_1", stateKey: STATE_KEYS.latestWatchdogReport }) as { markdown: string };
    expect(emailReplyState.subject).toBe("Re: CRM automation scope");
    expect(missionState.objective).toBe("Ship the workflow launch week");
    expect(watchdogState.markdown).toContain("Blocked Issues");

    const overview = await harness.getData<{
      counts: { leadPipeline: number; agents: number; followUpsDue: number };
      latestEmailReply: { subject: string } | null;
      leadPipeline: Array<{ leadName: string; stage: string }>;
    }>(DATA_KEYS.overview, { companyId: "co_1" });
    expect(overview.counts.leadPipeline).toBeGreaterThan(0);
    expect(overview.counts.agents).toBe(1);
    expect(overview.counts.followUpsDue).toBeGreaterThan(0);
    expect(overview.latestEmailReply?.subject).toBe("Re: CRM automation scope");
    expect(overview.leadPipeline.some((entry) => entry.leadName === "Jane Smith" && entry.stage === "proposal")).toBe(true);

    const toolResult = await harness.executeTool<{ content?: string; error?: string }>(TOOL_KEYS.contentCampaignPack, {
      campaignName: "Operator sprint",
      sourceTitle: "Ops memo",
      sourceSummary: "Turn the memo into a set of campaign assets.",
      platforms: ["x", "newsletter"],
    });
    expect(toolResult.error).toBeUndefined();
    expect(toolResult.content).toContain("# Content Campaign — Operator sprint");

    await harness.runJob(JOB_KEYS.pipelineWatchdog);
    expect(harness.metrics.some((metric) => metric.name === "watchdog.generated")).toBe(true);
  });
});