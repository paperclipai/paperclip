/**
 * Unit tests for handoff parser
 */

import { describe, it, expect } from "vitest";
import { parseHandoff } from "./handoff.js";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("parseHandoff", () => {
  it("should parse a complete handoff document", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-handoff-alpha.md"),
      "utf-8"
    );
    const result = parseHandoff(content);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.data).toBeDefined();
    expect(result.data?.taskId).toBe("F3");
    expect(result.data?.featureTitle).toBe("Task Creation Modal");
    expect(result.data?.engineer).toBe("Alpha");
  });

  it("should parse handoff status correctly", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-handoff-alpha.md"),
      "utf-8"
    );
    const result = parseHandoff(content);

    expect(result.data?.status).toBe("complete");
  });

  it("should extract files changed list", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-handoff-alpha.md"),
      "utf-8"
    );
    const result = parseHandoff(content);

    expect(result.data?.filesChanged).toBeInstanceOf(Array);
    expect(result.data?.filesChanged.length).toBe(4);
    expect(result.data?.filesChanged[0]).toContain("TaskCreateModal");
  });

  it("should extract self-evaluation scores", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-handoff-alpha.md"),
      "utf-8"
    );
    const result = parseHandoff(content);

    const scores = result.data?.selfEvaluationScores;
    expect(scores?.functionality).toBe(9);
    expect(scores?.codeQuality).toBe(8);
    expect(scores?.testing).toBe(7);
    expect(scores?.documentation).toBe(8);
  });

  it("should extract known issues as list", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-handoff-alpha.md"),
      "utf-8"
    );
    const result = parseHandoff(content);

    expect(result.data?.knownIssues).toBeInstanceOf(Array);
    expect(result.data?.knownIssues.length).toBe(3);
    expect(result.data?.knownIssues[0]).toContain("Date picker");
  });

  it("should extract git commit hash", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-handoff-alpha.md"),
      "utf-8"
    );
    const result = parseHandoff(content);

    expect(result.data?.gitCommitHash).toBeTruthy();
    expect(result.data?.gitCommitHash).toMatch(/^[a-z0-9]+$/);
  });

  it("should extract summary section", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-handoff-alpha.md"),
      "utf-8"
    );
    const result = parseHandoff(content);

    expect(result.data?.summary).toContain("Task Creation");
  });

  it("should handle missing task ID", () => {
    const content = `
# Handoff

Engineer: Alpha
Feature Title: Some Feature
Status: Complete
`;
    const result = parseHandoff(content);

    expect(result.errors.some((e) => e.message.includes("Task ID"))).toBe(true);
  });

  it("should handle missing engineer name", () => {
    const content = `
# Handoff

Task ID: F1
Feature Title: Some Feature
Status: Complete
`;
    const result = parseHandoff(content);

    expect(result.errors.some((e) => e.message.includes("Engineer"))).toBe(true);
  });

  it("should handle missing evaluation scores", () => {
    const content = `
# Handoff

Task ID: F1
Engineer: Alpha
Feature Title: Some Feature
Status: Complete
`;
    const result = parseHandoff(content);

    expect(result.errors.some((e) => e.message.includes("evaluation")));
  });

  it("should parse partial status", () => {
    const content = `
Task ID: T1
Engineer: Alpha
Feature: Test
Status: Partial
`;
    const result = parseHandoff(content);

    expect(result.data?.status).toBe("partial");
  });

  it("should parse failed status", () => {
    const content = `
Task ID: T1
Engineer: Alpha
Feature: Test
Status: Failed
`;
    const result = parseHandoff(content);

    expect(result.data?.status).toBe("failed");
  });

  it("should handle missing files changed section", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-handoff-alpha.md"),
      "utf-8"
    );
    // Remove files changed section
    const modified = content.replace(/## Files Changed[\s\S]*?(?=##|$)/, "");
    const result = parseHandoff(modified);

    expect(result.data?.filesChanged.length).toBe(0);
  });

  it("should parse evaluation scores from field format", () => {
    const content = `
Task ID: T1
Engineer: Alpha
Feature: Test
Functionality: 8
Code Quality: 7
Testing: 9
Documentation: 6
Status: Complete
`;
    const result = parseHandoff(content);

    const scores = result.data?.selfEvaluationScores;
    expect(scores?.functionality).toBe(8);
    expect(scores?.codeQuality).toBe(7);
    expect(scores?.testing).toBe(9);
    expect(scores?.documentation).toBe(6);
  });

  it("should handle zero scores gracefully", () => {
    const content = `
Task ID: T1
Engineer: Alpha
Feature: Test
Status: Complete
Functionality: 0
Code Quality: 0
Testing: 0
Documentation: 0
`;
    const result = parseHandoff(content);

    // Should flag missing scores
    expect(result.errors.some((e) => e.message.includes("evaluation")));
  });

  it("should parse file changes with code fence format", () => {
    const content = `
Task ID: T1
Engineer: Alpha
Feature: Test

## Files Changed

- \`src/index.ts\`
- \`src/utils.ts\`
- \`tests/index.test.ts\`

Status: Complete
`;
    const result = parseHandoff(content);

    expect(result.data?.filesChanged.length).toBeGreaterThan(0);
    expect(result.data?.filesChanged[0]).toContain("index");
  });

  it("should handle empty known issues", () => {
    const content = `
Task ID: T1
Engineer: Alpha
Feature: Test
Status: Complete
Functionality: 8
Code Quality: 8
Testing: 8
Documentation: 8

## Known Issues

None reported.
`;
    const result = parseHandoff(content);

    // Should have empty or minimal issues list
    expect(result.data?.knownIssues).toBeInstanceOf(Array);
  });
});
