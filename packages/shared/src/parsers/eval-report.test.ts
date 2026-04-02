/**
 * Unit tests for eval-report parser
 */

import { describe, it, expect } from "vitest";
import { parseEvalReport, determinePassResult } from "./eval-report.js";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("parseEvalReport", () => {
  it("should parse a complete passing eval report", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-pass.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.data).toBeDefined();
    expect(result.data?.taskId).toBe("F3");
    expect(result.data?.featureTitle).toBe("Task Creation Modal");
    expect(result.data?.passResult).toBe(true);
  });

  it("should parse a complete failing eval report", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-fail.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    expect(result.isValid).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.taskId).toBe("B2");
    expect(result.data?.passResult).toBe(false);
  });

  it("should extract evaluation scores from passing report", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-pass.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    const scores = result.data?.evalScores;
    expect(scores?.functionality).toBe(9);
    expect(scores?.codeQuality).toBe(8);
    expect(scores?.testing).toBe(8);
    expect(scores?.documentation).toBe(7);
  });

  it("should extract evaluation scores from failing report", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-fail.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    const scores = result.data?.evalScores;
    expect(scores?.functionality).toBe(5);
    expect(scores?.codeQuality).toBe(4);
    expect(scores?.testing).toBe(3);
    expect(scores?.documentation).toBe(2);
  });

  it("should extract test evidence section", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-pass.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    expect(result.data?.testEvidence).toContain("Form renders");
    expect(result.data?.testEvidence).toContain("validation");
  });

  it("should extract required fixes list from failing report", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-fail.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    expect(result.data?.requiredFixes).toBeInstanceOf(Array);
    expect(result.data?.requiredFixes.length).toBeGreaterThan(0);
    expect(result.data?.requiredFixes[0]).toContain("Implement");
  });

  it("should extract evaluator name", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-pass.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    expect(result.data?.evaluator).toBe("QA Engineer");
  });

  it("should extract evaluation timestamp", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-pass.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    expect(result.data?.evaluatedAt).toBeTruthy();
    expect(result.data?.evaluatedAt).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("should determine PASS when total >= 24 and all >= 6", () => {
    const scores = {
      functionality: 7,
      codeQuality: 7,
      testing: 5,
      documentation: 6,
    };
    expect(determinePassResult(scores)).toBe(false); // total 25 but testing < 6
  });

  it("should determine PASS for all 6+ scores and total >= 24", () => {
    const scores = {
      functionality: 6,
      codeQuality: 6,
      testing: 6,
      documentation: 6,
    };
    expect(determinePassResult(scores)).toBe(true); // total 24, all 6
  });

  it("should determine FAIL when total < 24", () => {
    const scores = {
      functionality: 5,
      codeQuality: 5,
      testing: 5,
      documentation: 5,
    };
    expect(determinePassResult(scores)).toBe(false); // total 20
  });

  it("should determine FAIL when any score < 6", () => {
    const scores = {
      functionality: 9,
      codeQuality: 9,
      testing: 9,
      documentation: 5,
    };
    expect(determinePassResult(scores)).toBe(false); // total 32 but documentation < 6
  });

  it("should handle missing task ID", () => {
    const content = `
# Eval Report

Feature: Some Feature
Evaluator: QA

## Evaluation Scores

| Criterion | Score |
|-----------|-------|
| Functionality | 8 |
| Code Quality | 8 |
| Testing | 8 |
| Documentation | 8 |
`;
    const result = parseEvalReport(content);

    expect(result.errors.some((e) => e.message.includes("Task ID"))).toBe(true);
  });

  it("should handle missing feature title", () => {
    const content = `
Task ID: T1

## Evaluation Scores

| Criterion | Score |
|-----------|-------|
| Functionality | 8 |
| Code Quality | 8 |
| Testing | 8 |
| Documentation | 8 |
`;
    const result = parseEvalReport(content);

    expect(result.errors.some((e) => e.message.includes("Feature"))).toBe(true);
  });

  it("should handle missing evaluation scores", () => {
    const content = `
Task ID: T1
Feature: Some Feature
Evaluator: QA
`;
    const result = parseEvalReport(content);

    expect(result.errors.some((e) => e.message.includes("evaluation"))).toBe(true);
  });

  it("should parse evaluation scores from field format", () => {
    const content = `
Task ID: T1
Feature: Test Feature
Evaluator: QA
Functionality: 8
Code Quality: 7
Testing: 9
Documentation: 6
`;
    const result = parseEvalReport(content);

    const scores = result.data?.evalScores;
    expect(scores?.functionality).toBe(8);
    expect(scores?.codeQuality).toBe(7);
  });

  it("should handle empty required fixes", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-pass.md"),
      "utf-8"
    );
    // Should have empty or minimal fixes for passing report
    const result = parseEvalReport(content);

    expect(result.data?.requiredFixes).toBeInstanceOf(Array);
  });

  it("should extract notes section", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-eval-pass.md"),
      "utf-8"
    );
    const result = parseEvalReport(content);

    expect(result.data?.notes).toBeTruthy();
    expect(result.data?.notes).toContain("high-quality");
  });

  it("should handle edge case: scores at boundary values", () => {
    const content = `
Task ID: T1
Feature: Boundary Test
Evaluator: QA
Functionality: 6
Code Quality: 6
Testing: 6
Documentation: 6
`;
    const result = parseEvalReport(content);

    expect(result.data?.passResult).toBe(true); // exactly at boundary
  });

  it("should handle edge case: one score just below boundary", () => {
    const content = `
Task ID: T1
Feature: Edge Test
Evaluator: QA
Functionality: 7
Code Quality: 7
Testing: 7
Documentation: 2
`;
    const result = parseEvalReport(content);

    expect(result.data?.passResult).toBe(false); // one score < 6
  });
});
