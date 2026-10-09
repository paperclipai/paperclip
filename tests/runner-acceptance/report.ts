import { runnerAcceptanceMatrix } from "./catalog.js";
import { findSensitiveJsonValue, redactText } from "./redaction.js";
import type {
  AggregatedAcceptanceResult,
  FailureClass,
  RunnerAcceptanceCell,
  RunnerAcceptanceReport,
  RunnerAcceptanceResult,
} from "./types.js";

const RESULT_SCHEMA = "paperclip.runner-acceptance.result/v1" as const;
const ALLOWED_FAILURE_CLASSES = new Set<FailureClass>([
  "candidate_failure",
  "transient_infrastructure",
  "permanent_infrastructure",
  "secret_leak",
  "cleanup_failure",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function field(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function textField(value: Record<string, unknown>, key: string): string | null {
  const candidate = field(value, key);
  return typeof candidate === "string" ? candidate : null;
}

function numericField(value: Record<string, unknown>, key: string): number | null {
  const candidate = field(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : null;
}

function safeSensitivePayloadError(value: unknown): string | null {
  try {
    const leak = findSensitiveJsonValue(value);
    return leak ? `unsafe result payload: ${leak}` : null;
  } catch {
    return "result payload could not be inspected safely";
  }
}

function validationErrors(
  value: unknown,
  cell: RunnerAcceptanceCell,
) {
  const errors: string[] = [];
  const result = record(value);
  if (!result) return ["result must be an object"];

  if (field(result, "schema") !== RESULT_SCHEMA) {
    errors.push("unsupported result schema");
  }
  if (textField(result, "cellId") !== cell.id) {
    errors.push("result cellId does not match the acceptance cell");
  }
  const attempt = numericField(result, "attempt");
  if (attempt === null || !Number.isSafeInteger(attempt) || attempt < 1) {
    errors.push("attempt must be a positive safe integer");
  }
  const durationMs = numericField(result, "durationMs");
  if (durationMs === null || durationMs < 0) {
    errors.push("duration must be a non-negative finite number");
  }
  const startedAt = textField(result, "startedAt");
  const finishedAt = textField(result, "finishedAt");
  if (
    startedAt === null
    || finishedAt === null
    || !Number.isFinite(Date.parse(startedAt))
    || !Number.isFinite(Date.parse(finishedAt))
  ) {
    errors.push("timestamps must be valid ISO-compatible values");
  }
  const status = field(result, "status");
  if (status !== "passed" && status !== "failed") {
    errors.push("status must be passed or failed");
  }
  const failureClass = field(result, "failureClass");
  if (failureClass !== undefined && !ALLOWED_FAILURE_CLASSES.has(failureClass as FailureClass)) {
    errors.push("failureClass is unsupported");
  }
  const error = field(result, "error");
  if (error !== undefined && typeof error !== "string") {
    errors.push("error must be a string when present");
  }
  if (field(result, "redaction") !== "passed") errors.push("redaction did not pass");
  const sensitivePayloadError = safeSensitivePayloadError(value);
  if (sensitivePayloadError) errors.push(sensitivePayloadError);

  const rawAssertions = field(result, "assertions");
  const assertions = Array.isArray(rawAssertions) ? rawAssertions : [];
  if (!Array.isArray(rawAssertions)) errors.push("assertions must be an array");

  const outcomes = new Map<string, { passed: boolean }>();
  let duplicateAssertionId = false;
  for (const [index, rawAssertion] of assertions.entries()) {
    const assertion = record(rawAssertion);
    if (!assertion) {
      errors.push(`assertion ${index} must be an object`);
      continue;
    }
    const id = textField(assertion, "id");
    if (!id || id.trim().length === 0) {
      errors.push(`assertion ${index} id must be a non-empty string`);
      continue;
    }
    const passed = field(assertion, "passed");
    if (typeof passed !== "boolean") {
      errors.push(`assertion ${id} passed must be a boolean`);
    }
    const detail = field(assertion, "detail");
    if (detail !== undefined && typeof detail !== "string") {
      errors.push(`assertion ${id} detail must be a string when present`);
    }
    if (outcomes.has(id)) duplicateAssertionId = true;
    else outcomes.set(id, { passed: passed === true });
  }
  if (duplicateAssertionId) errors.push("duplicate assertion ids");

  for (const assertionId of cell.assertions) {
    const outcome = outcomes.get(assertionId);
    if (!outcome) errors.push(`missing assertion ${assertionId}`);
    else if (!outcome.passed) errors.push(`failed assertion ${assertionId}`);
  }
  const unknownAssertions = [...outcomes.keys()]
    .filter((id) => !cell.assertions.includes(id));
  if (unknownAssertions.length > 0) {
    errors.push(`unknown assertions: ${redactText(unknownAssertions.join(", "))}`);
  }
  if (status !== "passed") {
    errors.push(
      typeof error === "string" && error.length > 0
        ? redactText(error)
        : typeof failureClass === "string" && ALLOWED_FAILURE_CLASSES.has(failureClass as FailureClass)
          ? failureClass
          : "acceptance cell failed",
    );
  }
  return errors;
}

function normalizedResult(
  value: unknown,
  cell: RunnerAcceptanceCell,
): RunnerAcceptanceResult {
  const result = record(value) ?? {};
  const attempt = numericField(result, "attempt");
  const durationMs = numericField(result, "durationMs");
  const status = field(result, "status");
  const failureClass = field(result, "failureClass");
  const error = textField(result, "error");
  const startedAt = textField(result, "startedAt");
  const finishedAt = textField(result, "finishedAt");
  const rawAssertions = field(result, "assertions");
  const assertions = Array.isArray(rawAssertions) ? rawAssertions : [];
  return {
    schema: RESULT_SCHEMA,
    cellId: cell.id,
    attempt: attempt !== null && Number.isSafeInteger(attempt) && attempt >= 1
      ? attempt
      : 0,
    status: status === "passed" ? "passed" : "failed",
    ...(typeof failureClass === "string" && ALLOWED_FAILURE_CLASSES.has(failureClass as FailureClass)
      ? { failureClass: failureClass as FailureClass }
      : {}),
    ...(error ? { error: redactText(error) } : {}),
    startedAt: startedAt === null ? "" : redactText(startedAt),
    finishedAt: finishedAt === null ? "" : redactText(finishedAt),
    durationMs: durationMs !== null && durationMs >= 0
      ? durationMs
      : 0,
    redaction: field(result, "redaction") === "passed" ? "passed" : "failed",
    assertions: cell.assertions.flatMap((id) => {
      const assertion = assertions
        .map(record)
        .find((candidate) => candidate && textField(candidate, "id") === id);
      return assertion
        ? [{
            id,
            passed: field(assertion, "passed") === true,
            ...(typeof field(assertion, "detail") === "string"
              ? { detail: redactText(field(assertion, "detail") as string) }
              : {}),
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
  results: readonly unknown[];
  cells?: readonly RunnerAcceptanceCell[];
  generatedAt?: string;
}): RunnerAcceptanceReport {
  const cells = input.cells ?? runnerAcceptanceMatrix;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const candidates = new Map<string, Array<{ index: number; value: unknown }>>();
  for (const [index, value] of input.results.entries()) {
    const result = record(value);
    const cellId = result ? textField(result, "cellId") : null;
    const candidateCellId = cellId ?? `malformed-result-${index + 1}`;
    candidates.set(candidateCellId, [
      ...(candidates.get(candidateCellId) ?? []),
      { index, value },
    ]);
  }

  const selected = cells.map((cell) => {
    const attempts = (candidates.get(cell.id) ?? []).sort((left, right) => {
      const leftRecord = record(left.value) ?? {};
      const rightRecord = record(right.value) ?? {};
      const leftAttempt = numericField(leftRecord, "attempt") ?? 0;
      const rightAttempt = numericField(rightRecord, "attempt") ?? 0;
      const leftFinishedAt = textField(leftRecord, "finishedAt");
      const rightFinishedAt = textField(rightRecord, "finishedAt");
      const leftFinishedTime = leftFinishedAt === null ? 0 : Date.parse(leftFinishedAt) || 0;
      const rightFinishedTime = rightFinishedAt === null ? 0 : Date.parse(rightFinishedAt) || 0;
      return rightAttempt - leftAttempt
        || rightFinishedTime - leftFinishedTime
        || left.index - right.index;
    });
    const candidate = attempts[0];
    if (!candidate) return missingResult(cell, generatedAt);
    const errors = validationErrors(candidate.value, cell);
    return {
      ...normalizedResult(candidate.value, cell),
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
