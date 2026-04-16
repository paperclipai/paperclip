import { describe, expect, it } from "vitest";
import { buildIssueRoutingText, pickOperationsAssignmentCandidate } from "../services/issue-routing-heuristics.ts";

describe("issue routing heuristics", () => {
  const baseCandidates = [
    {
      id: "app-engineer",
      name: "Product Engineer - App",
      role: "engineer",
      title: "Product Engineer",
      capabilities: "Implements and diagnoses scoped app issues only.",
      status: "idle",
    },
    {
      id: "web-engineer",
      name: "Product Engineer - Web",
      role: "engineer",
      title: "Website Product Engineer",
      capabilities: "Implements and diagnoses scoped web issues only.",
      status: "idle",
    },
    {
      id: "qa-agent",
      name: "QA Agent",
      role: "qa",
      title: "QA Specialist",
      capabilities: "Verifies releases and reproduces bugs.",
      status: "idle",
    },
    {
      id: "platform-engineer",
      name: "Platform Engineer",
      role: "engineer",
      title: "Infra / Platform Engineer",
      capabilities: "Diagnoses runtime, infrastructure, and deployment blockers.",
      status: "idle",
    },
    {
      id: "onboarding-agent",
      name: "Onboarding Agent",
      role: "pm",
      title: "Onboarding Agent",
      capabilities:
        "Executes scoped onboarding follow-up. Does not self-direct or perform product/platform debugging.",
      status: "idle",
    },
  ] as const;

  it("includes description in routing text and keeps identifier as fallback", () => {
    const routingText = buildIssueRoutingText({
      identifier: "COMA-1061",
      description: "QA follow-up for the checkout flow",
      title: "Merge branches",
      projectName: "App",
    });

    expect(routingText).toContain("qa follow-up for the checkout flow");
    expect(routingText).toContain("coma-1061");
  });

  it("routes baseline app work to the app engineer", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-1",
        identifier: "COMA-1061",
        title: "Fix cart checkout bug",
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Product Engineer - App");
  });

  it("routes explicit QA intent in the description to the QA agent", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-2",
        identifier: "COMA-2001",
        title: "Fix cart checkout bug",
        description: "QA verification required before release",
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("QA Agent");
  });

  it("routes explicit platform intent in the description to the platform engineer", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-3",
        identifier: "COMA-2002",
        title: "Fix cart checkout bug",
        description: "Platform runtime investigation for the checkout service",
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Platform Engineer");
  });

  it("routes explicit web intent in the description to the web engineer", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-4",
        identifier: "COMA-2003",
        title: "Fix cart checkout bug",
        description: "Web browser-only rendering issue for checkout",
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Product Engineer - Web");
  });

  it("routes onboarding work to the onboarding agent", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-2",
        identifier: "COMA-2001",
        title: "Customer onboarding rollout follow-up",
        projectId: "project-cx",
        projectName: "Customers",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Onboarding Agent");
  });
});
