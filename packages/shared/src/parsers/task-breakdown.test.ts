/**
 * Unit tests for task-breakdown parser
 */

import { describe, it, expect } from "vitest";
import { parseTaskBreakdown } from "./task-breakdown.js";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("parseTaskBreakdown", () => {
  it("should parse a complete task breakdown table", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-task-breakdown.md"),
      "utf-8"
    );
    const result = parseTaskBreakdown(content);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.data).toBeDefined();
    expect(result.data?.length).toBe(8); // 4 frontend + 4 backend
  });

  it("should extract all required task fields", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-task-breakdown.md"),
      "utf-8"
    );
    const result = parseTaskBreakdown(content);

    const task = result.data?.[0];
    expect(task?.id).toBe("F1");
    expect(task?.title).toBe("Auth UI");
    expect(task?.description).toBeTruthy();
    expect(task?.acceptanceCriteria).toBeInstanceOf(Array);
    expect(task?.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(task?.estimate).toBe(30);
    expect(task?.assignment).toBe("Alpha");
    expect(task?.vLabel).toBe("V1");
  });

  it("should parse V-label correctly", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-task-breakdown.md"),
      "utf-8"
    );
    const result = parseTaskBreakdown(content);

    const v1Tasks = result.data?.filter((t) => t.vLabel === "V1");
    const v2Tasks = result.data?.filter((t) => t.vLabel === "V2");

    expect(v1Tasks?.length).toBe(6);
    expect(v2Tasks?.length).toBe(2);
  });

  it("should parse task dependencies", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-task-breakdown.md"),
      "utf-8"
    );
    const result = parseTaskBreakdown(content);

    const f2Task = result.data?.find((t) => t.id === "F2");
    expect(f2Task?.dependencies).toContain("F1");

    const f3Task = result.data?.find((t) => t.id === "F3");
    expect(f3Task?.dependencies).toContain("F2");
  });

  it("should handle empty dependencies correctly", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-task-breakdown.md"),
      "utf-8"
    );
    const result = parseTaskBreakdown(content);

    const f1Task = result.data?.find((t) => t.id === "F1");
    expect(f1Task?.dependencies.length).toBe(0);
  });

  it("should parse task estimates as numbers", () => {
    const content = readFileSync(
      resolve(__dirname, "__fixtures__/sample-task-breakdown.md"),
      "utf-8"
    );
    const result = parseTaskBreakdown(content);

    const task = result.data?.[0];
    expect(task?.estimate).toEqual(expect.any(Number));
    expect(task?.estimate).toBeGreaterThan(0);
  });

  it("should handle document with no tasks", () => {
    const content = `
# Task Breakdown

No tasks defined yet.
`;
    const result = parseTaskBreakdown(content);

    expect(result.data?.length).toBe(0);
    expect(result.errors.some((e) => e.message.includes("No tasks"))).toBe(true);
    expect(result.isValid).toBe(false);
  });

  it("should handle malformed table gracefully", () => {
    const content = `
# Task Breakdown

| Task ID | Title |
| F1 | Broken table, missing separator row
| F2 | Another task |
`;
    const result = parseTaskBreakdown(content);

    // Should either skip malformed rows or handle gracefully
    expect(result.data).toBeDefined();
  });

  it("should handle empty content", () => {
    const content = "";
    const result = parseTaskBreakdown(content);

    expect(result.data?.length).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.isValid).toBe(false);
  });

  it("should parse list format tasks", () => {
    const content = `
# Tasks

- Task ID: T1
  Title: First Task
  Description: Do something
  Acceptance Criteria:
    - Criterion 1
    - Criterion 2
  Estimate: 30
  Assignment: Engineer
  V-Label: V1
`;
    const result = parseTaskBreakdown(content);

    expect(result.data?.length).toBeGreaterThan(0);
    const task = result.data?.[0];
    expect(task?.id).toBe("T1");
  });

  it("should normalize V-labels to standard format", () => {
    const content = `
# Tasks

| Task ID | Title | V-Label |
|---------|-------|---------|
| T1 | Task 1 | V1 |
| T2 | Task 2 | v2 |
| T3 | Task 3 | VERSION3 |
`;
    const result = parseTaskBreakdown(content);

    expect(result.data?.[0]?.vLabel).toBe("V1");
    expect(result.data?.[1]?.vLabel).toBe("V2");
    expect(result.data?.[2]?.vLabel).toBe("V3");
  });

  it("should handle various acceptance criteria formats", () => {
    const content = `
# Tasks

| Task ID | Title | Acceptance Criteria |
|---------|-------|-------------------|
| T1 | Task | - Criterion 1\\n- Criterion 2 |
| T2 | Task2 | Feature works, Tests pass |
`;
    const result = parseTaskBreakdown(content);

    expect(result.data?.[0]?.acceptanceCriteria).toBeInstanceOf(Array);
  });

  it("should require both ID and Title for valid task", () => {
    const content = `
| Task ID | Title |
|---------|-------|
| T1 | Valid Task |
| | Missing ID |
| T3 |  |
`;
    const result = parseTaskBreakdown(content);

    // Should only include tasks with both ID and Title
    expect(result.data?.length).toBeLessThanOrEqual(1);
    expect(result.data?.[0]?.id).toBe("T1");
  });
});
