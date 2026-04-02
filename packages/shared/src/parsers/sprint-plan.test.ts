/**
 * Unit tests for sprint-plan parser
 */

import { describe, it, expect } from "vitest";
import { parseSprintPlan } from "./sprint-plan.js";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("parseSprintPlan", () => {
  it("should parse a complete sprint plan document", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-plan.md"),
      "utf-8"
    );
    const result = parseSprintPlan(content);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.data).toBeDefined();
    expect(result.data?.sprintId).toBe("2024-03-31");
    expect(result.data?.productName).toBe("TaskMaster Lite");
    expect(result.data?.targetUser).toContain("productivity");
    expect(result.data?.vLabelBreakdown.v1).toBe(90);
    expect(result.data?.vLabelBreakdown.v2).toBe(40);
    expect(result.data?.vLabelBreakdown.v3).toBe(30);
    expect(result.data?.riskAssessment.length).toBeGreaterThan(0);
  });

  it("should extract brief section correctly", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-plan.md"),
      "utf-8"
    );
    const result = parseSprintPlan(content);

    expect(result.data?.brief).toContain("task management");
    expect(result.data?.brief).toContain("create, view, update, and delete");
  });

  it("should extract data model section", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-plan.md"),
      "utf-8"
    );
    const result = parseSprintPlan(content);

    expect(result.data?.dataModel).toContain("User");
    expect(result.data?.dataModel).toContain("Task");
  });

  it("should extract tech stack section", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-plan.md"),
      "utf-8"
    );
    const result = parseSprintPlan(content);

    expect(result.data?.techStack).toContain("React");
    expect(result.data?.techStack).toContain("PostgreSQL");
  });

  it("should parse risk assessment as list", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-sprint-plan.md"),
      "utf-8"
    );
    const result = parseSprintPlan(content);

    expect(result.data?.riskAssessment).toBeInstanceOf(Array);
    expect(result.data?.riskAssessment.length).toBe(4);
    expect(result.data?.riskAssessment[0]).toContain("PostgreSQL");
  });

  it("should handle missing sprint ID gracefully", () => {
    const content = `
## Brief
Build a task manager

## Product
Name: TaskMaster
`;
    const result = parseSprintPlan(content);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Sprint ID"))).toBe(true);
  });

  it("should handle missing brief section", () => {
    const content = `
# Sprint 2024-03-31

## Product
Name: TaskMaster
`;
    const result = parseSprintPlan(content);

    expect(result.errors.some((e) => e.message.includes("Brief"))).toBe(true);
  });

  it("should handle missing product name", () => {
    const content = `
# Sprint 2024-03-31

## Brief
Build a task manager

## Product
Target User: Users
`;
    const result = parseSprintPlan(content);

    expect(result.errors.some((e) => e.message.includes("Product name"))).toBe(true);
  });

  it("should handle document with missing sections gracefully", () => {
    const content = `
# Sprint minimal-2024

## Brief
Build something

## Product
Name: MinimalApp
`;
    const result = parseSprintPlan(content);

    expect(result.data).toBeDefined();
    expect(result.data?.dataModel).toBe("");
    expect(result.data?.techStack).toBe("");
    expect(result.data?.vLabelBreakdown.v1).toBe(0);
  });

  it("should handle empty document", () => {
    const content = "";
    const result = parseSprintPlan(content);

    expect(result.data).not.toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.isValid).toBe(false);
  });

  it("should handle malformed V-label breakdown", () => {
    const content = `
# Sprint 2024-03-31

## Brief
Build app

## Product
Name: App

## V-Label Breakdown
Invalid table format
`;
    const result = parseSprintPlan(content);

    // Should not crash, should return zero values
    expect(result.data?.vLabelBreakdown.v1).toBe(0);
    expect(result.data?.vLabelBreakdown.v2).toBe(0);
  });

  it("should parse alternative field separator (colon vs dash)", () => {
    const content = `
# Sprint test-sprint

## Brief
Build something

## Product
Name: TestApp
Target User: Everyone
Primary Flow: Click button
`;
    const result = parseSprintPlan(content);

    expect(result.data?.productName).toBe("TestApp");
    expect(result.data?.targetUser).toBe("Everyone");
    expect(result.data?.primaryFlow).toBe("Click button");
  });
});
