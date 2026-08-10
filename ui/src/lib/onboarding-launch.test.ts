import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONBOARDING_TASK_DESCRIPTION,
  DEFAULT_ONBOARDING_TASK_TITLE,
  ONBOARDING_CEO_HIRE_IDEMPOTENCY_KEY,
  buildOnboardingCeoHirePayload,
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId,
  selectReusableOnboardingProject,
} from "./onboarding-launch";

describe("selectDefaultCompanyGoalId", () => {
  it("prefers the earliest active root company goal", () => {
    expect(
      selectDefaultCompanyGoalId([
        {
          id: "team-goal",
          companyId: "company-1",
          title: "Nested",
          description: null,
          level: "team",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-04T00:00:00Z"),
          updatedAt: new Date("2026-03-04T00:00:00Z"),
        },
        {
          id: "goal-2",
          companyId: "company-1",
          title: "Later active root",
          description: null,
          level: "company",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-03T00:00:00Z"),
          updatedAt: new Date("2026-03-03T00:00:00Z"),
        },
        {
          id: "goal-1",
          companyId: "company-1",
          title: "Earliest active root",
          description: null,
          level: "company",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-02T00:00:00Z"),
          updatedAt: new Date("2026-03-02T00:00:00Z"),
        },
      ]),
    ).toBe("goal-1");
  });

  it("falls back to the earliest root company goal when none are active", () => {
    expect(
      selectDefaultCompanyGoalId([
        {
          id: "goal-2",
          companyId: "company-1",
          title: "Cancelled root",
          description: null,
          level: "company",
          status: "cancelled",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-03T00:00:00Z"),
          updatedAt: new Date("2026-03-03T00:00:00Z"),
        },
        {
          id: "goal-1",
          companyId: "company-1",
          title: "Earliest root",
          description: null,
          level: "company",
          status: "planned",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-02T00:00:00Z"),
          updatedAt: new Date("2026-03-02T00:00:00Z"),
        },
      ]),
    ).toBe("goal-1");
  });
});

describe("onboarding launch payloads", () => {
  it("uses one stable company-scoped intent key when onboarding retries the founding CEO hire", () => {
    expect(ONBOARDING_CEO_HIRE_IDEMPOTENCY_KEY).toBe("onboarding:founding-ceo:v1");
    expect(buildOnboardingCeoHirePayload({
      name: "CEO",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5" },
      runtimeConfig: { heartbeat: { enabled: false } },
    })).toEqual({
      name: "CEO",
      role: "ceo",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5" },
      runtimeConfig: { heartbeat: { enabled: false } },
      idempotencyKey: "onboarding:founding-ceo:v1",
    });
  });

  it("boots the CEO with a dynamic company-scoped operating harness mandate", () => {
    expect(DEFAULT_ONBOARDING_TASK_TITLE).toBe(
      "Design and staff this company's operating harness",
    );
    expect(DEFAULT_ONBOARDING_TASK_DESCRIPTION).toContain(
      "smallest complete operating harness for this company",
    );
    expect(DEFAULT_ONBOARDING_TASK_DESCRIPTION).toContain(
      "current roster, and existing capabilities",
    );
    expect(DEFAULT_ONBOARDING_TASK_DESCRIPTION).toContain(
      "Do not duplicate roles or copy agents, configuration, credentials, or secrets from another company",
    );
    expect(DEFAULT_ONBOARDING_TASK_DESCRIPTION).toContain(
      "request company-scoped hires through the normal approval flow",
    );
  });

  it("gates the default operating-harness mandate on a registered assessment document", () => {
    const payload = buildOnboardingIssuePayload({
      title: DEFAULT_ONBOARDING_TASK_TITLE,
      description: DEFAULT_ONBOARDING_TASK_DESCRIPTION,
      assigneeAgentId: "agent-1",
      projectId: "project-1",
      goalId: "goal-1",
    });

    expect(payload.executionContract).toMatchObject({
      schemaVersion: 2,
      taskType: "company_operating_harness_bootstrap",
      core: {
        acceptanceChecks: expect.arrayContaining([
          expect.stringContaining("registered as a qualifying document work product"),
        ]),
        requiredOutputs: [{ workProductType: "document" }],
      },
    });
  });

  it("reuses a non-cancelled Onboarding project by name", () => {
    expect(
      selectReusableOnboardingProject([
        { id: "cancelled", name: "Onboarding", status: "cancelled" },
        { id: "active", name: " onboarding ", status: "in_progress" },
      ]),
    ).toEqual({ id: "active", name: " onboarding ", status: "in_progress" });

    expect(
      selectReusableOnboardingProject([
        { id: "cancelled", name: "Onboarding", status: "cancelled" },
        { id: "other", name: "Roadmap", status: "in_progress" },
      ]),
    ).toBeNull();
  });

  it("links the onboarding project and first issue to the selected goal", () => {
    expect(buildOnboardingProjectPayload("goal-1")).toEqual({
      name: "Onboarding",
      status: "in_progress",
      goalIds: ["goal-1"],
    });

    expect(
      buildOnboardingIssuePayload({
        title: "  Hire your first engineer  ",
        description: "  Kick off the hiring plan  ",
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        goalId: "goal-1",
      }),
    ).toEqual({
      title: "Hire your first engineer",
      description: "Kick off the hiring plan",
      assigneeAgentId: "agent-1",
      projectId: "project-1",
      goalId: "goal-1",
      status: "todo",
    });
  });

  it("omits goal links when no default company goal exists", () => {
    expect(buildOnboardingProjectPayload(null)).toEqual({
      name: "Onboarding",
      status: "in_progress",
    });

    expect(
      buildOnboardingIssuePayload({
        title: "Task",
        description: "",
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        goalId: null,
      }),
    ).toEqual({
      title: "Task",
      assigneeAgentId: "agent-1",
      projectId: "project-1",
      status: "todo",
    });
  });
});
