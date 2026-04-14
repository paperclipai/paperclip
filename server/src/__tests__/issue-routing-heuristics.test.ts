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

  it("includes project context in routing text", () => {
    expect(
      buildIssueRoutingText({
        identifier: "COMA-1061",
        title: "Merge branches",
        projectName: "App",
      }),
    ).toContain("app");
  });

  it("routes app branch merge work to the app engineer", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-1",
        identifier: "COMA-1061",
        title: "Merge branches",
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Product Engineer - App");
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
