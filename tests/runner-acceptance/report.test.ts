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

  it("fails closed when assertions are missing or are not an array", () => {
    const cell = cells[0]!;
    const withoutAssertions = { ...passingResult(cell) } as Record<string, unknown>;
    delete withoutAssertions.assertions;
    const missing = buildRunnerAcceptanceReport({
      cells: [cell],
      results: [withoutAssertions],
    });
    const nonArray = buildRunnerAcceptanceReport({
      cells: [cell],
      results: [{ ...passingResult(cell), assertions: { passed: true } }],
    });

    for (const report of [missing, nonArray]) {
      expect(report).toMatchObject({ selected: 1, passed: 0, failed: 1 });
      expect(report.results[0]).toMatchObject({
        valid: false,
        assertions: [],
      });
      expect(report.results[0]?.validationErrors).toEqual(expect.arrayContaining([
        "assertions must be an array",
        `missing assertion ${cell.assertions[0]}`,
      ]));
    }
  });

  it("normalizes invalid scalar and assertion types without throwing", () => {
    const cell = cells[0]!;
    const report = buildRunnerAcceptanceReport({
      cells: [cell],
      results: [{
        schema: 1,
        cellId: cell.id,
        attempt: "1",
        status: true,
        failureClass: 42,
        error: { message: "failed" },
        startedAt: 1,
        finishedAt: null,
        durationMs: "1000",
        redaction: false,
        assertions: [
          null,
          { id: cell.assertions[0], passed: "yes", detail: 42 },
        ],
      }],
    });

    expect(report).toMatchObject({ selected: 1, passed: 0, failed: 1 });
    expect(report.results[0]).toMatchObject({
      attempt: 0,
      status: "failed",
      startedAt: "",
      finishedAt: "",
      durationMs: 0,
      redaction: "failed",
      valid: false,
    });
    expect(report.results[0]?.validationErrors).toEqual(expect.arrayContaining([
      "unsupported result schema",
      "attempt must be a positive safe integer",
      "duration must be a non-negative finite number",
      "timestamps must be valid ISO-compatible values",
      "status must be passed or failed",
      "failureClass is unsupported",
      "error must be a string when present",
      "redaction did not pass",
      "assertion 0 must be an object",
      `assertion ${cell.assertions[0]} passed must be a boolean`,
      `assertion ${cell.assertions[0]} detail must be a string when present`,
    ]));
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
