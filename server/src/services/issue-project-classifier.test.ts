import { describe, expect, it } from "vitest";
import {
  suggestProjectsForIssue,
  type ClassifierProject,
  type ProjectSignal,
  type ProjectSuggestion,
} from "./issue-project-classifier.js";

// Fixtures modelled on the real Tony AI Lab project set (TON-2266 grounding).
const PROJECTS: ClassifierProject[] = [
  { id: "p-onboard", name: "Onboarding", description: "", status: "in_progress" },
  {
    id: "p-aios",
    name: "AI OS & PoC Legacy & Business Logic",
    description:
      "Porting existing PoC projects and business ideas into the Paperclip management ecosystem for AI OS integration.",
    status: "backlog",
  },
  {
    id: "p-acme",
    name: "Acme Payments — agent ops (SYNTHETIC DEMO)",
    description:
      "SYNTHETIC demo data only. Fictional buyer Acme Payments. Backs the Agent Ops Control Room demo. Scripted incidents: duplicate-work prevention via checkout lock and 409, blocked work auto-resolution.",
    status: "in_progress",
  },
  {
    id: "p-uncl",
    name: "미분류(Done) 정리함",
    description: "프로젝트 미지정 이슈들의 단일 보관·정리 프로젝트. 그룹핑만 부여한다.",
    status: "in_progress",
  },
  {
    id: "p-blocked",
    name: "🚧 진행 중 · 블로커 추적 (In-Flight & Blocked)",
    description:
      "blocked 이슈와 장기 진행/검토 이슈를 한 곳에 모아 추적하는 프로젝트. 코드 리포 없음. 상태 추적 전용.",
    status: "in_progress",
  },
];

const SIGNALS: ProjectSignal[] = [
  {
    projectId: "p-aios",
    issues: [
      { title: "Port KoreaLog crawler PoC into Paperclip workspace" },
      { title: "AI OS governance posture card on 8088 desktop surface" },
      { title: "Errand mission templates business logic engine" },
    ],
  },
  {
    projectId: "p-acme",
    issues: [
      { title: "Agent Ops Control Room: duplicate checkout 409 incident script" },
      { title: "Acme Payments synthetic demo data seeding" },
    ],
  },
];

describe("suggestProjectsForIssue", () => {
  it("routes an AI-OS/PoC porting issue to the AI OS project", () => {
    const result = suggestProjectsForIssue(
      {
        title: "Port the fintech payment engine PoC into the Paperclip AI OS ecosystem",
        description: "Business logic migration for AI OS integration.",
      },
      PROJECTS,
      SIGNALS,
    );
    expect(result.topConfident?.projectId).toBe("p-aios");
    expect(result.topConfident?.matchedTerms).toContain("os");
  });

  it("routes a synthetic-demo agent-ops issue to the Acme demo project", () => {
    const result = suggestProjectsForIssue(
      {
        title: "Acme Payments demo: scripted duplicate-work checkout incident",
        description: "Agent ops control room synthetic demo data.",
      },
      PROJECTS,
      SIGNALS,
    );
    expect(result.topConfident?.projectId).toBe("p-acme");
  });

  it("ranks projects and returns explainable matched terms", () => {
    const result = suggestProjectsForIssue(
      { title: "AI OS PoC business logic port" },
      PROJECTS,
      SIGNALS,
    );
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].projectId).toBe("p-aios");
    expect(result.suggestions[0].reason).toMatch(/Overlaps on/);
    // Scores are sorted descending.
    for (let i = 1; i < result.suggestions.length; i++) {
      expect(result.suggestions[i - 1].score).toBeGreaterThanOrEqual(
        result.suggestions[i].score,
      );
    }
  });

  it("withholds a one-click default when the issue has no salient overlap", () => {
    const result = suggestProjectsForIssue(
      { title: "Rotate leaked API key exposed in comments" },
      PROJECTS,
      SIGNALS,
    );
    // Security key-rotation shares no project vocabulary → no confident default.
    expect(result.topConfident).toBeNull();
  });

  it("honours excludeProjectIds (e.g. the catch-all 미분류 bucket)", () => {
    const result = suggestProjectsForIssue(
      { title: "미분류 정리 대상 이슈 그룹핑" },
      PROJECTS,
      SIGNALS,
      { excludeProjectIds: ["p-uncl"] },
    );
    expect(result.suggestions.every((s: ProjectSuggestion) => s.projectId !== "p-uncl")).toBe(true);
    expect(result.topConfident?.projectId).not.toBe("p-uncl");
  });

  it("never suggests archived/paused projects", () => {
    const archived: ClassifierProject[] = [
      ...PROJECTS,
      { id: "p-old", name: "Legacy AI OS PoC archive", status: "archived" },
    ];
    const result = suggestProjectsForIssue(
      { title: "AI OS PoC port" },
      archived,
      SIGNALS,
    );
    expect(result.suggestions.every((s: ProjectSuggestion) => s.projectId !== "p-old")).toBe(true);
  });

  it("returns empty when there are no eligible candidate projects", () => {
    const result = suggestProjectsForIssue({ title: "anything" }, [], []);
    expect(result.suggestions).toEqual([]);
    expect(result.topConfident).toBeNull();
  });
});
