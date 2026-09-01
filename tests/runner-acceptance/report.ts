import { runnerAcceptanceMatrix } from "./catalog.js";
import { findSensitiveJsonValue, redactText } from "./redaction.js";
import type {
  AggregatedAcceptanceResult,
  RunnerAcceptanceCell,
  RunnerAcceptanceReport,
  RunnerAcceptanceResult,
} from "./types.js";

function validationErrors(
  result: RunnerAcceptanceResult,
  cell: RunnerAcceptanceCell,
) {
  const errors: string[] = [];
  if (result.schema !== "paperclip.runner-acceptance.result/v1") {
    errors.push("unsupported result schema");
  }
  if (!Number.isSafeInteger(result.attempt) || result.attempt < 1) {
    errors.push("attempt must be a positive safe integer");
  }
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
    errors.push("duration must be a non-negative finite number");
  }
  if (
    !Number.isFinite(Date.parse(result.startedAt))
    || !Number.isFinite(Date.parse(result.finishedAt))
  ) {
    errors.push("timestamps must be valid ISO-compatible values");
  }
  if (result.redaction !== "passed") errors.push("redaction did not pass");
  const leak = findSensitiveJsonValue(result);
  if (leak) errors.push(`unsafe result payload: ${leak}`);

  const outcomes = new Map(result.assertions.map((assertion) => [assertion.id, assertion]));
  if (outcomes.size !== result.assertions.length) {
    errors.push("duplicate assertion ids");
  }
  for (const assertionId of cell.assertions) {
    const outcome = outcomes.get(assertionId);
    if (!outcome) errors.push(`missing assertion ${assertionId}`);
    else if (!outcome.passed) errors.push(`failed assertion ${assertionId}`);
  }
  const unknownAssertions = result.assertions
    .map(({ id }) => id)
    .filter((id) => !cell.assertions.includes(id));
  if (unknownAssertions.length > 0) {
    errors.push(`unknown assertions: ${redactText(unknownAssertions.join(", "))}`);
  }
  if (result.status !== "passed") {
    errors.push(
      result.error
        ? redactText(result.error)
        : result.failureClass ?? "acceptance cell failed",
    );
  }
  return errors;
}

function normalizedResult(
  result: RunnerAcceptanceResult,
  cell: RunnerAcceptanceCell,
): RunnerAcceptanceResult {
  const allowedFailureClasses = new Set([
    "candidate_failure",
    "transient_infrastructure",
    "permanent_infrastructure",
    "secret_leak",
    "cleanup_failure",
  ]);
  return {
    schema: "paperclip.runner-acceptance.result/v1",
    cellId: cell.id,
    attempt: Number.isSafeInteger(result.attempt) && result.attempt >= 1
      ? result.attempt
      : 0,
    status: result.status === "passed" ? "passed" : "failed",
    ...(result.failureClass && allowedFailureClasses.has(result.failureClass)
      ? { failureClass: result.failureClass }
      : {}),
    ...(result.error ? { error: redactText(result.error) } : {}),
    startedAt: redactText(result.startedAt),
    finishedAt: redactText(result.finishedAt),
    durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0
      ? result.durationMs
      : 0,
    redaction: result.redaction === "passed" ? "passed" : "failed",
    assertions: cell.assertions.flatMap((id) => {
      const assertion = result.assertions.find((candidate) => candidate.id === id);
      return assertion
        ? [{
            id,
            passed: assertion.passed === true,
            ...(assertion.detail ? { detail: redactText(assertion.detail) } : {}),
          }]
        : [];
    }),
  };
}

function missingResult(cell: RunnerAcceptanceCell, generatedAt: string): AggregatedAcceptanceResult {
  return {
    schema: "paperclip.runner-acceptance.result/v1",
    cellId: cell.id,
    attempt: 0,
    status: "failed",
    failureClass: "permanent_infrastructure",
    error: "No result was supplied",
    startedAt: generatedAt,
    finishedAt: generatedAt,
    durationMs: 0,
    redaction: "passed",
    assertions: [],
    valid: false,
    validationErrors: ["No result was supplied"],
  };
}

export function buildRunnerAcceptanceReport(input: {
  results: readonly RunnerAcceptanceResult[];
  cells?: readonly RunnerAcceptanceCell[];
  generatedAt?: string;
}): RunnerAcceptanceReport {
  const cells = input.cells ?? runnerAcceptanceMatrix;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const candidates = new Map<string, RunnerAcceptanceResult[]>();
  for (const result of input.results) {
    candidates.set(result.cellId, [
      ...(candidates.get(result.cellId) ?? []),
      result,
    ]);
  }

  const selected = cells.map((cell) => {
    const attempts = (candidates.get(cell.id) ?? []).sort((left, right) =>
      right.attempt - left.attempt
      || Date.parse(right.finishedAt) - Date.parse(left.finishedAt));
    const result = attempts[0];
    if (!result) return missingResult(cell, generatedAt);
    const errors = validationErrors(result, cell);
    return {
      ...normalizedResult(result, cell),
      valid: errors.length === 0,
      validationErrors: errors,
    } satisfies AggregatedAcceptanceResult;
  });

  const knownCellIds = new Set(cells.map(({ id }) => id));
  const unknownCellIds = [...candidates.keys()].filter((id) => !knownCellIds.has(id));
  if (unknownCellIds.length > 0) {
    throw new Error(`Results reference unknown acceptance cells: ${unknownCellIds.join(", ")}`);
  }

  return {
    schema: "paperclip.runner-acceptance.report/v1",
    generatedAt,
    suiteDefinitionHash: cells[0]?.suiteDefinitionHash ?? "empty",
    selected: selected.length,
    passed: selected.filter(({ valid }) => valid).length,
    failed: selected.filter(({ valid }) => !valid).length,
    retries: selected.reduce((sum, result) => sum + Math.max(0, result.attempt - 1), 0),
    results: selected,
  };
}

function escapeMarkdown(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderRunnerAcceptanceMarkdown(report: RunnerAcceptanceReport) {
  return [
    "# Runner acceptance",
    "",
    `Passed: ${report.passed}/${report.selected}`,
    "",
    "| Cell | Attempt | Result | Duration | Detail |",
    "|---|---:|---|---:|---|",
    ...report.results.map((result) =>
      `| ${escapeMarkdown(result.cellId)} | ${result.attempt} | ${result.valid ? "pass" : "fail"} | ${Math.round(result.durationMs / 1000)}s | ${escapeMarkdown(result.validationErrors.join("; ") || "ok")} |`),
    "",
  ].join("\n");
}

function xml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderRunnerAcceptanceJUnit(report: RunnerAcceptanceReport) {
  const cases = report.results.map((result) => {
    const failure = result.valid
      ? ""
      : `<failure message="${xml(result.validationErrors.join("; "))}"/>`;
    return `<testcase classname="runner-acceptance" name="${xml(result.cellId)}" time="${result.durationMs / 1000}">${failure}</testcase>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="Runner acceptance" tests="${report.selected}" failures="${report.failed}">${cases}</testsuite>\n`;
}
