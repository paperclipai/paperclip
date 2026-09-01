import { describe, expect, it } from "vitest";

import { runnerAcceptanceMatrix } from "./catalog.js";
import {
  buildRunnerAcceptanceReport,
  renderRunnerAcceptanceJUnit,
  renderRunnerAcceptanceMarkdown,
} from "./report.js";
import type { RunnerAcceptanceCell, RunnerAcceptanceResult } from "./types.js";

function passingResult(
  cell: RunnerAcceptanceCell,
  attempt = 1,
): RunnerAcceptanceResult {
  return {
    schema: "paperclip.runner-acceptance.result/v1",
    cellId: cell.id,
    attempt,
    status: "passed",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: `2026-09-01T00:00:0${attempt}.000Z`,
    durationMs: attempt * 1_000,
    redaction: "passed",
    assertions: cell.assertions.map((id) => ({ id, passed: true })),
  };
}

describe("Runner acceptance report", () => {
  const cells = runnerAcceptanceMatrix.slice(0, 2);

  it("selects the newest attempt and reports missing cells without publishing evidence", () => {
    const retry = passingResult(cells[0]!, 2);
    const report = buildRunnerAcceptanceReport({
      cells,
      generatedAt: "2026-09-01T00:01:00.000Z",
      results: [
        {
          ...passingResult(cells[0]!),
          status: "failed",
          failureClass: "transient_infrastructure",
          error: "connection timed out",
        },
        retry,
      ],
    });

    expect(report).toMatchObject({
      selected: 2,
      passed: 1,
      failed: 1,
      retries: 1,
    });
    expect(report.results[0]).toMatchObject({ attempt: 2, valid: true });
    expect(report.results[1]).toMatchObject({
      attempt: 0,
      valid: false,
      error: "No result was supplied",
    });
  });

  it("fails closed on incomplete assertions or unsafe structured values", () => {
    const cell = cells[0]!;
    const incomplete = passingResult(cell);
    const report = buildRunnerAcceptanceReport({
      cells: [cell],
      results: [{
        ...incomplete,
        error: "redacted diagnostic",
        assertions: incomplete.assertions.slice(1),
      }],
    });
    expect(report.failed).toBe(1);
    expect(report.results[0]?.validationErrors).toContain(
      `missing assertion ${cell.assertions[0]}`,
    );

    const unsafeResult = {
      ...passingResult(cell),
      diagnostic: { accessToken: "not-a-real-sensitive-value" },
    } as unknown as RunnerAcceptanceResult;
    const unsafe = buildRunnerAcceptanceReport({
      cells: [cell],
      results: [unsafeResult],
    });
    expect(unsafe.failed).toBe(1);
    expect(unsafe.results[0]?.validationErrors).toContain(
      "unsafe result payload: sensitive field accessToken",
    );
    expect(JSON.stringify(unsafe.results[0])).not.toContain(
      "not-a-real-sensitive-value",
    );
    expect(unsafe.results[0]).not.toHaveProperty("diagnostic");
  });

  it("renders deterministic Markdown and JUnit summaries", () => {
    const report = buildRunnerAcceptanceReport({
      cells,
      results: cells.map((cell) => passingResult(cell)),
      generatedAt: "2026-09-01T00:01:00.000Z",
    });
    const markdown = renderRunnerAcceptanceMarkdown(report);
    const junit = renderRunnerAcceptanceJUnit(report);

    expect(markdown).toContain("Passed: 2/2");
    expect(markdown).toContain(cells[0]!.id);
    expect(junit).toContain('tests="2" failures="0"');
    expect(junit).toContain('classname="runner-acceptance"');
  });

  it("rejects results for cells outside the declared catalog", () => {
    expect(() => buildRunnerAcceptanceReport({
      cells,
      results: [{ ...passingResult(cells[0]!), cellId: "unknown.cell" }],
    })).toThrow("unknown acceptance cells");
  });
});
