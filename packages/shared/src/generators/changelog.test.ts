/**
 * Tests for changelog generator
 */

import { generateChangelogEntry } from "./changelog.js";
import type { ArtifactData } from "./types.js";

describe("generateChangelogEntry", () => {
  const mockArtifactData: ArtifactData = {
    sprintPlan: {
      sprintId: "2026-03-31-sprint-1",
      brief: "Build a task management system",
      productName: "TaskFlow",
      targetUser: "Teams",
      primaryFlow: "Create → Edit → Done",
      dataModel: "Standard task schema",
      techStack: "React + Node.js",
      vLabelBreakdown: { v1: 100, v2: 50, v3: 30 },
      riskAssessment: ["Scale concern"],
    },
    taskBreakdown: [],
    handoffs: [
      {
        taskId: "TASK-001",
        engineer: "engineer-alpha",
        summary: "Task creation UI",
        selfEvaluationScores: {
          functionality: 9,
          codeQuality: 8,
          testing: 8,
          documentation: 8,
        },
      },
      {
        taskId: "TASK-002",
        engineer: "engineer-beta",
        summary: "Task list view",
        selfEvaluationScores: {
          functionality: 8,
          codeQuality: 8,
          testing: 8,
          documentation: 8,
        },
      },
    ],
    evals: [
      {
        taskId: "TASK-001",
        featureTitle: "Create and Edit Tasks",
        evalScores: {
          functionality: 10,
          codeQuality: 9,
          testing: 8,
          documentation: 8,
        },
        passResult: true,
        notes: "Good implementation",
      },
      {
        taskId: "TASK-002",
        featureTitle: "Task List",
        evalScores: {
          functionality: 8,
          codeQuality: 8,
          testing: 8,
          documentation: 8,
        },
        passResult: true,
        notes: "Clean and responsive",
      },
    ],
    sprintReport: {
      sprintId: "2026-03-31-sprint-1",
      deploymentUrl: "https://example.com/deploy",
      deploymentTime: "2026-03-31T18:00:00Z",
      summary: "Task management release",
      featuresShipped: [
        {
          taskId: "TASK-001",
          title: "Create and Edit Tasks",
          engineer: "engineer-alpha",
          status: "shipped",
        },
        {
          taskId: "TASK-002",
          title: "Task List with Filtering",
          engineer: "engineer-beta",
          status: "shipped",
        },
      ],
      featuresDropped: [
        {
          taskId: "TASK-003",
          title: "Advanced search",
          reason: "Deferred to V2",
        },
      ],
    },
  };

  test("should generate changelog entry with correct version format", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.version).toMatch(/^v\d{4}\.\d{3}\.\d+$/);
    expect(entry.version).toBe("v2026.090.0");
  });

  test("should extract sprint ID from artifact data", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.sprintId).toBe("2026-03-31-sprint-1");
  });

  test("should use deployment date for changelog entry", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.date).toBe("2026-03-31");
  });

  test("should extract summary from sprint plan", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.summary).toBe("Build a task management system");
  });

  test("should include all shipped features with QA scores", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.featuresShipped).toHaveLength(2);
    expect(entry.featuresShipped[0].title).toBe("Create and Edit Tasks");
    expect(entry.featuresShipped[0].qaScore).toBe(9); // avg of 10,9,8,8
    expect(entry.featuresShipped[0].engineer).toBe("engineer-alpha");
  });

  test("should calculate QA score from eval report", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    // (10 + 9 + 8 + 8) / 4 = 8.75 ≈ 9
    expect(entry.featuresShipped[0].qaScore).toBe(9);

    // (8 + 8 + 8 + 8) / 4 = 8
    expect(entry.featuresShipped[1].qaScore).toBe(8);
  });

  test("should include dropped features with reasons", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.featuresDropped).toHaveLength(1);
    expect(entry.featuresDropped[0].title).toBe("Advanced search");
    expect(entry.featuresDropped[0].reason).toBe("Deferred to V2");
  });

  test("should extract unique contributors", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.contributors).toContain("engineer-alpha");
    expect(entry.contributors).toContain("engineer-beta");
    expect(entry.contributors.length).toBe(2);
  });

  test("should generate valid markdown", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.markdown).toContain(`## ${entry.version}`);
    expect(entry.markdown).toContain("### Features");
    expect(entry.markdown).toContain("### Contributors");
    expect(entry.markdown).toContain("engineer-alpha");
    expect(entry.markdown).toContain("engineer-beta");
  });

  test("should include feature descriptions in markdown", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.markdown).toContain("Create and Edit Tasks");
    expect(entry.markdown).toContain("Task List with Filtering");
  });

  test("should include QA scores in markdown with correct format", () => {
    const entry = generateChangelogEntry(mockArtifactData);

    expect(entry.markdown).toContain("9/10");
    expect(entry.markdown).toContain("8/10");
  });

  test("should handle missing eval reports with default score", () => {
    const dataWithoutEvals: ArtifactData = {
      ...mockArtifactData,
      evals: [],
    };

    const entry = generateChangelogEntry(dataWithoutEvals);

    // Should use handoff scores instead
    expect(entry.featuresShipped[0].qaScore).toBe(8); // avg of 9,8,8,8
  });

  test("should clamp QA scores to 0-10 range", () => {
    const dataWithBadScores: ArtifactData = {
      ...mockArtifactData,
      evals: [
        {
          taskId: "TASK-001",
          evalScores: {
            functionality: 15,
            codeQuality: -5,
            testing: 8,
            documentation: 8,
          },
        },
      ],
    };

    const entry = generateChangelogEntry(dataWithBadScores);

    expect(entry.featuresShipped[0].qaScore).toBeLessThanOrEqual(10);
    expect(entry.featuresShipped[0].qaScore).toBeGreaterThanOrEqual(0);
  });

  test("should handle empty features list", () => {
    const emptyData: ArtifactData = {
      ...mockArtifactData,
      sprintReport: {
        ...mockArtifactData.sprintReport,
        featuresShipped: [],
        featuresDropped: [],
      },
    };

    const entry = generateChangelogEntry(emptyData);

    expect(entry.featuresShipped).toHaveLength(0);
    expect(entry.featuresDropped).toHaveLength(0);
  });

  test("should detect breaking changes", () => {
    const dataWithBreakingChanges: ArtifactData = {
      ...mockArtifactData,
      sprintPlan: {
        ...mockArtifactData.sprintPlan,
        dataModel: "BREAKING: Changed task schema structure",
      },
    };

    const entry = generateChangelogEntry(dataWithBreakingChanges);

    expect(entry.breakingChanges.length).toBeGreaterThan(0);
  });
});
