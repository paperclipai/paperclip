import { describe, expect, it } from "vitest";
import {
  buildIssueRoutingText,
  pickOperationsAssignmentCandidate,
  resolveEligibleOperationsAssignmentCandidates,
} from "../services/issue-routing-heuristics.ts";

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

  it("routes explicit QA intent in the title even when the description is empty", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-title-qa",
        identifier: "COMA-2001",
        title: "QA verification required for checkout totals fix",
        description: null,
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("QA Agent");
  });

  it("does not treat generic verify wording inside an engineering bug report as QA intent", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-live-coma-1266",
        identifier: "COMA-1266",
        title: "[P0] Price displays show total that does not match unit × quantity",
        description: [
          "## Scenario",
          "1. On the Products page, find the item \"Aceite oliva virgen extra\".",
          "2. Observe it shows a unit price that does not match the rendered total.",
          "",
          "## Expected Behavior",
          "- User should never see a price they cannot verify mentally.",
          "- Multiple supplier prices should display clearly with quantities and totals.",
          "",
          "## Minimal Fix",
          "Display a mathematically correct line total alongside the unit price and delta.",
        ].join("\n"),
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Product Engineer - App");
  });

  it("does not treat release-build failures as QA intent", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-release-build",
        identifier: "COMA-2004",
        title: "Release build crashes on startup in checkout",
        description: "The production release build crashes before the cart UI renders.",
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Product Engineer - App");
  });

  it("does not treat smoke-test instructions inside an engineering ticket as QA handoff intent", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-smoke-test",
        identifier: "COMA-2005",
        title: "Fix checkout totals rounding bug",
        description: [
          "Implement the totals fix in the cart renderer.",
          "After the fix, run a smoke test on the checkout flow and post the result.",
        ].join("\n"),
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Product Engineer - App");
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
        title: "Fix website landing page rendering bug",
        description: "Website homepage hero fails to render on the marketing site",
        projectId: "project-website",
        projectName: "Website",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Product Engineer - Web");
  });

  it("keeps App project route/page issues on the app engineer", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-5",
        identifier: "COMA-1197",
        title: "[P0] Cart panel not accessible — cannot review order or trigger checkout",
        description: [
          "Navigate to /market/products, add items via + controls. Click the cart-status-bar button.",
          "The /market/cart route shows an empty page with only minimal navigation.",
        ].join("\n"),
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Product Engineer - App");
  });

  it("routes backend API failures to the platform engineer even when the browser is the reporter", () => {
    const candidate = pickOperationsAssignmentCandidate({
      issue: {
        id: "issue-6",
        identifier: "COMA-1189",
        title: "[P0] Backend /api/offers/best returns HTTP 500 — blocks pricing and optimizer",
        description: [
          "The /api/offers/best backend endpoint returns HTTP 500 Internal Server Error.",
          "This endpoint is called by the browser when computing best offers/pricing for cart items and the optimizer.",
        ].join("\n"),
        projectId: "project-app",
        projectName: "App",
      },
      openAssignedIssues: [],
      availableCandidates: [...baseCandidates],
      pausedFallbackCandidates: [...baseCandidates],
    });

    expect(candidate?.name).toBe("Platform Engineer");
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

  it("does not treat QA and Release Engineer as an engineering specialist during eligibility checks", () => {
    const eligible = resolveEligibleOperationsAssignmentCandidates(
      {
        id: "issue-eligibility",
        identifier: "COMA-3001",
        title: "Fix checkout pricing bug",
        description: "Cart totals are wrong in the app.",
        projectId: "project-app",
        projectName: "App",
      },
      [
        ...baseCandidates,
        {
          id: "qa-release",
          name: "QA and Release Engineer",
          role: "qa",
          title: "QA and Release Engineer",
          capabilities: "Owns QA classification and release-readiness judgment.",
          status: "idle",
        },
      ],
    );

    expect(eligible.map((candidate) => candidate.name)).toEqual(["Product Engineer - App"]);
  });
});
