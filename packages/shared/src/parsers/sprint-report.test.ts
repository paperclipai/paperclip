/**
 * Unit tests for sprint-report parser
 */

import { describe, it, expect } from "vitest";
import { parseSprintReport } from "./sprint-report.js";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("parseSprintReport", () => {
  it("should parse a complete sprint report", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.data).toBeDefined();
    expect(result.data?.sprintId).toBe("2024-03-31");
    expect(result.data?.deploymentUrl).toContain("taskmaster-lite");
  });

  it("should extract deployment metadata", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    expect(result.data?.deploymentUrl).toBeTruthy();
    expect(result.data?.deploymentTime).toBeTruthy();
    expect(result.data?.deploymentTime).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("should extract features shipped table", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    expect(result.data?.featuresShipped).toBeInstanceOf(Array);
    expect(result.data?.featuresShipped.length).toBe(6);
  });

  it("should extract shipped feature details", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    const f1 = result.data?.featuresShipped.find((f) => f.taskId === "F1");
    expect(f1?.taskId).toBe("F1");
    expect(f1?.title).toBe("Authentication UI");
    expect(f1?.engineer).toBe("Alpha");
    expect(f1?.status).toBe("shipped");
  });

  it("should extract features dropped table", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    expect(result.data?.featuresDropped).toBeInstanceOf(Array);
    expect(result.data?.featuresDropped.length).toBe(2);
  });

  it("should extract dropped feature details", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    const f4 = result.data?.featuresDropped.find((f) => f.taskId === "F4");
    expect(f4?.taskId).toBe("F4");
    expect(f4?.title).toBe("Task Details Modal");
    expect(f4?.reason).toContain("Time constraint");
  });

  it("should extract summary section", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    expect(result.data?.summary).toBeTruthy();
    expect(result.data?.summary).toContain("deployed");
  });

  it("should handle missing sprint ID", () => {
    const content = `
# Report

Deployment URL: https://example.com

## Features Shipped

| Task ID | Feature |
|---------|---------|
| F1 | Feature 1 |
`;
    const result = parseSprintReport(content);

    expect(result.errors.some((e) => e.message.includes("Sprint ID"))).toBe(true);
  });

  it("should handle missing deployment URL", () => {
    const content = `
Sprint ID: 2024-03-31

## Features Shipped

| Task ID | Feature |
|---------|---------|
| F1 | Feature 1 |
`;
    const result = parseSprintReport(content);

    expect(result.errors.some((e) => e.message.includes("Deployment URL"))).toBe(true);
  });

  it("should handle document with no features shipped", () => {
    const content = `
Sprint ID: 2024-03-31
Deployment URL: https://example.com

## Features Shipped

None
`;
    const result = parseSprintReport(content);

    expect(result.data?.featuresShipped.length).toBe(0);
  });

  it("should handle document with no features dropped", () => {
    const content = `
Sprint ID: 2024-03-31
Deployment URL: https://example.com

## Features Shipped

| Task ID | Feature |
|---------|---------|
| F1 | Feature 1 |

## Features Dropped

None
`;
    const result = parseSprintReport(content);

    expect(result.data?.featuresDropped.length).toBe(0);
  });

  it("should parse partial status for shipped features", () => {
    const content = `
Sprint ID: test-sprint
Deployment URL: https://test.com

## Features Shipped

| Task ID | Title | Engineer | Status |
|---------|-------|----------|--------|
| F1 | Feature 1 | Alpha | partial |
| F2 | Feature 2 | Beta | shipped |
`;
    const result = parseSprintReport(content);

    expect(result.data?.featuresShipped[0]?.status).toBe("partial");
    expect(result.data?.featuresShipped[1]?.status).toBe("shipped");
  });

  it("should parse dropped features from list format", () => {
    const content = `
Sprint ID: test-sprint
Deployment URL: https://test.com

## Features Dropped

- F1: First Feature — Time constraint
- F2: Second Feature (Not started)
`;
    const result = parseSprintReport(content);

    expect(result.data?.featuresDropped.length).toBeGreaterThan(0);
  });

  it("should extract sprint ID from title", () => {
    const content = `
# Sprint 2024-04-15

Deployment URL: https://example.com
`;
    const result = parseSprintReport(content);

    expect(result.data?.sprintId).toBe("2024-04-15");
  });

  it("should handle alternative feature dropped format with dashes", () => {
    const content = `
Sprint ID: test
Deployment URL: https://test.com

## Features Dropped

| Task ID | Feature | Reason |
|---------|---------|--------|
| F1 | Feature 1 | Time limit |
`;
    const result = parseSprintReport(content);

    expect(result.data?.featuresDropped[0]?.taskId).toBe("F1");
  });

  it("should handle deployment time in various formats", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    // Should be able to parse any ISO date format
    expect(result.data?.deploymentTime).toBeTruthy();
  });

  it("should require both ID and URL for valid report", () => {
    const content = `
# Some Report

No sprint ID or URL here
`;
    const result = parseSprintReport(content);

    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it("should preserve engineer information in shipped features", () => {
    const content = `
Sprint ID: test
Deployment URL: https://test.com

## Features Shipped

| Task ID | Feature | Engineer |
|---------|---------|----------|
| F1 | Auth | Alpha |
| F2 | API | Beta |
`;
    const result = parseSprintReport(content);

    expect(result.data?.featuresShipped[0]?.engineer).toBe("Alpha");
    expect(result.data?.featuresShipped[1]?.engineer).toBe("Beta");
  });

  it("should handle long feature descriptions", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-report.md"),
      "utf-8"
    );
    const result = parseSprintReport(content);

    const shipped = result.data?.featuresShipped;
    expect(shipped?.[0]?.title.length).toBeGreaterThan(0);
    expect(shipped?.some((f) => f.title.length > 20)).toBe(true);
  });

  it("should handle empty sections gracefully", () => {
    const content = `
Sprint ID: test
Deployment URL: https://test.com

## Features Shipped

## Features Dropped
`;
    const result = parseSprintReport(content);

    // Should not crash, should return empty arrays
    expect(result.data?.featuresShipped).toBeInstanceOf(Array);
    expect(result.data?.featuresDropped).toBeInstanceOf(Array);
  });
});
