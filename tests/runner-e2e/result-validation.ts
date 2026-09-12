import type { RunnerE2EResult } from "./types.js";

type Rule = (value: unknown, at: string) => void;
const invalid = (at: string): never => {
  throw new Error(`Invalid retained runner result field: ${at}`);
};
const string: Rule = (value, at) => {
  if (typeof value !== "string") invalid(at);
};
const number: Rule = (value, at) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid(at);
};
const integer: Rule = (value, at) => {
  number(value, at);
  if (!Number.isSafeInteger(value)) invalid(at);
};
const boolean: Rule = (value, at) => {
  if (typeof value !== "boolean") invalid(at);
};
const object: Rule = (value, at) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(at);
};
const optional =
  (rule: Rule): Rule =>
  (value, at) => {
    if (value !== undefined) rule(value, at);
  };
const nullable =
  (rule: Rule): Rule =>
  (value, at) => {
    if (value !== null) rule(value, at);
  };
const oneOf =
  (...values: string[]): Rule =>
  (value, at) => {
    if (typeof value !== "string" || !values.includes(value)) invalid(at);
  };
const array =
  (rule: Rule): Rule =>
  (value, at) => {
    if (!Array.isArray(value)) invalid(at);
    (value as unknown[]).forEach((item, index) =>
      rule(item, `${at}[${index}]`),
    );
  };
const shape =
  (fields: Record<string, Rule>): Rule =>
  (value, at) => {
    object(value, at);
    for (const [key, rule] of Object.entries(fields))
      rule((value as Record<string, unknown>)[key], `${at}.${key}`);
  };
const date: Rule = (value, at) => {
  string(value, at);
  if (!Number.isFinite(Date.parse(value as string))) invalid(at);
};
const url: Rule = (value, at) => {
  string(value, at);
  try {
    const parsed = new URL(value as string);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      invalid(at);
  } catch {
    invalid(at);
  }
};
const relativeFile: Rule = (value, at) => {
  string(value, at);
  if (
    !/^[A-Za-z0-9_.\-/]+$/.test(value as string) ||
    (value as string).startsWith("/") ||
    (value as string)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    invalid(at);
};
const runtime = shape({
  provider: oneOf("local", "daytona"),
  agentRunDurationMs: number,
  leaseDurationMs: nullable(number),
  leaseCount: integer,
  cpuCores: optional(number),
  memoryGiB: optional(number),
  diskGiB: optional(number),
  estimatedListCostUsd: optional(number),
  costStatus: oneOf("estimated", "unavailable", "not_metered"),
  costSource: oneOf(
    "daytona_public_list_price",
    "provider_cost_unavailable",
    "local_not_metered",
  ),
  pricingAsOf: optional(string),
  pricingUrl: optional(url),
});
const llm = shape({
  runCount: integer,
  runsWithTokenUsage: integer,
  runsWithReportedCost: integer,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  totalTokens: number,
  reportedCostUsd: number,
  costStatus: oneOf("reported", "partial", "unpriced", "unavailable"),
});
const billing = shape({
  llm,
  runtime,
  reportedCostUsd: number,
  estimatedRuntimeCostUsd: number,
  observedAndEstimatedCostUsd: number,
  complete: boolean,
});
const matcher: Rule = (value, at) => {
  object(value, at);
  const item = value as Record<string, unknown>;
  string(item.kind, `${at}.kind`);
  const kinds: Record<string, Rule> = {
    message_exact: shape({ expected: string }),
    message_contains: shape({ expected: string }),
    message_occurrences: shape({ expected: string, count: integer }),
    message_regex: shape({ pattern: string, flags: optional(string) }),
    message_ordered: shape({ expected: array(string) }),
    issue_status: shape({ expected: string }),
    run_status: shape({ expected: string }),
    runtime_mode: shape({ expected: oneOf("legacy", "native") }),
    environment: shape({ expected: oneOf("local", "daytona") }),
    file_exists: shape({ path: string }),
    file_exact: shape({ path: string, expected: string }),
    file_contains: shape({ path: string, expected: string }),
    artifact_exists: shape({ name: string, mimeType: optional(string) }),
    json_path: shape({ path: string }),
    json_schema: shape({ schema: object }),
  };
  const rule = kinds[item.kind as string];
  if (!rule) invalid(`${at}.kind`);
  rule(value, at);
};
const fields = {
  schema: oneOf(
    "paperclip.runner-e2e.result/v1",
    "paperclip.runner-e2e.result/v2",
  ),
  executionId: string,
  suiteId: optional(string),
  suiteDefinitionHash: optional(string),
  source: optional(
    shape({
      sha: nullable(string),
      ref: nullable(string),
      workflowRunUrl: nullable(url),
    }),
  ),
  rankingSnapshot: optional(
    shape({
      snapshotId: string,
      capturedAt: date,
      sourceUrl: url,
      rank: integer,
      canonicalModelId: string,
    }),
  ),
  attempt: integer,
  status: oneOf("passed", "failed"),
  failureClass: optional(
    oneOf(
      "candidate_failure",
      "provider_variance",
      "transient_infrastructure",
      "permanent_infrastructure",
      "secret_leak",
      "cleanup_failure",
    ),
  ),
  error: optional(string),
  profileId: string,
  environmentId: oneOf("local", "daytona"),
  caseId: string,
  provider: string,
  model: string,
  runtimeMode: oneOf("legacy", "native"),
  issueId: optional(string),
  issueIdentifier: optional(nullable(string)),
  runIds: optional(array(string)),
  turnTimings: optional(
    array(
      shape({
        turn: integer,
        submittedAt: date,
        runStartedAt: nullable(date),
        runFinishedAt: nullable(date),
        schedulerLatencyMs: nullable(number),
        runDurationMs: nullable(number),
        responseLatencyMs: nullable(number),
        runId: string,
        leaseAcquisitionOutcome: oneOf(
          "created",
          "resumed",
          "replacement",
          "unknown",
        ),
      }),
    ),
  ),
  startedAt: date,
  finishedAt: date,
  durationMs: number,
  // Provider usage is intentionally opaque. Billing reads only finite numbers;
  // the dashboard shows opaque diagnostics through escaped JSON.
  usage: optional(nullable(object)),
  runtimeUsage: optional(runtime),
  billing: optional(billing),
  matcherResults: optional(
    array(shape({ matcher, passed: boolean, detail: string })),
  ),
  screenshots: optional(
    array(
      shape({
        id: string,
        label: string,
        file: relativeFile,
        publication: optional(oneOf("public-runner-fixture")),
      }),
    ),
  ),
  cleanup: oneOf("not_started", "passed", "failed"),
} satisfies Record<keyof RunnerE2EResult, Rule>;
const result = shape(fields);

/** Validate every typed result field before upgrading, path construction or HTML rendering. */
export function validateRetainedRunnerResult(
  value: unknown,
): asserts value is RunnerE2EResult {
  result(value, "result");
}
