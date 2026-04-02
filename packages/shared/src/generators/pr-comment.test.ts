/**
 * Tests for PR comment generator
 */

import { generatePRComment } from "./pr-comment.js";
import type { ArtifactData } from "./types.js";

describe("generatePRComment", () => {
  const mockArtifactData: ArtifactData = {
    sprintPlan: {
      sprintId: "2026-03-31-sprint-1",
      brief: "Build a task management system with real-time updates",
      productName: "TaskFlow",
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

  test("should generate PR comment with correct header", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.header).toContain("🚀");
    expect(comment.header).toContain("Release");
    expect(comment.header).toContain("shipped");
  });

  test("should generate valid markdown", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.markdown).toContain("##");
    expect(comment.markdown).toContain("🚀");
    expect(comment.markdown).toContain("Features Shipped");
  });

  test("should include features table", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.featuresTable).toContain("Feature");
    expect(comment.featuresTable).toContain("QA Score");
    expect(comment.featuresTable).toContain("Engineer");
    expect(comment.featuresTable).toContain("Create and Edit Tasks");
    expect(comment.featuresTable).toContain("engineer-alpha");
  });

  test("should include QA score emojis", () => {
    const comment = generatePRComment(mockArtifactData);

    // Should have emojis for quality assessment
    expect(comment.featuresTable).toMatch(/[✅🟢🟡🔴]/);
  });

  test("should include dropped features section", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.droppedFeaturesSection).toContain("Advanced search");
    expect(comment.droppedFeaturesSection).toContain("Deferred to V2");
  });

  test("should include Paperclip link when provided", () => {
    const comment = generatePRComment(mockArtifactData, {
      paperclipIssueId: "sprint-2026-03-31",
    });

    expect(comment.paperclipLink).toContain("Paperclip");
    expect(comment.paperclipLink).toContain("sprint-2026-03-31");
  });

  test("should include deployment URL", () => {
    const comment = generatePRComment(mockArtifactData, {
      deploymentUrl: "https://custom.example.com",
    });

    expect(comment.deploymentUrl).toBe("https://custom.example.com");
  });

  test("should stay under 5000 character limit", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.markdown.length).toBeLessThan(5000);
  });

  test("should include summary one-liner", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.summary).toBeTruthy();
    expect(comment.summary.toLowerCase()).toContain("ship");
  });

  test("should handle empty features", () => {
    const emptyData: ArtifactData = {
      ...mockArtifactData,
      sprintReport: {
        ...mockArtifactData.sprintReport,
        featuresShipped: [],
        featuresDropped: [],
      },
    };

    const comment = generatePRComment(emptyData);

    expect(comment.markdown).toBeTruthy();
    expect(comment.featuresTable).toContain("No features");
  });

  test("should handle many features without exceeding limit", () => {
    const manyFeaturesData: ArtifactData = {
      ...mockArtifactData,
      sprintReport: {
        ...mockArtifactData.sprintReport,
        featuresShipped: Array.from({ length: 20 }, (_, i) => ({
          taskId: `TASK-${i}`,
          title: `Feature ${i}`,
          engineer: "engineer",
          status: "shipped" as const,
        })),
      },
    };

    const comment = generatePRComment(manyFeaturesData);

    expect(comment.markdown.length).toBeLessThan(5000);
  });

  test("should include Links section", () => {
    const comment = generatePRComment(mockArtifactData, {
      deploymentUrl: "https://example.com",
      paperclipIssueId: "issue-123",
    });

    expect(comment.markdown).toContain("Links");
  });

  test("should include sprint brief in summary", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.markdown).toContain("Task management system");
  });

  test("should handle missing deployment URL gracefully", () => {
    const noDeployData: ArtifactData = {
      ...mockArtifactData,
      sprintReport: {
        ...mockArtifactData.sprintReport,
        deploymentUrl: "",
      },
    };

    const comment = generatePRComment(noDeployData);

    expect(comment.markdown).toBeTruthy();
  });

  test("should generate CalVer version", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.header).toMatch(/v\d{4}\.\d{3}\.\d+/);
  });

  test("should display all engineer names", () => {
    const comment = generatePRComment(mockArtifactData);

    expect(comment.markdown).toContain("engineer-alpha");
    expect(comment.markdown).toContain("engineer-beta");
  });

  test("should handle missing eval data with fallback", () => {
    const noEvalData: ArtifactData = {
      ...mockArtifactData,
      evals: [],
    };

    const comment = generatePRComment(noEvalData);

    expect(comment.markdown).toBeTruthy();
    // Should use handoff scores
    expect(comment.featuresTable).toContain("9");
  });
});
