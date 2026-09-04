import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { Matcher } from "./types.js";

interface JsonSchemaValidator {
  (value: unknown): boolean;
  errors?: unknown;
}

interface Ajv2020Instance {
  compile(schema: Record<string, unknown>): JsonSchemaValidator;
}

const runnerRequire = createRequire(
  new URL("../../packages/paperclip-runner/package.json", import.meta.url),
);
const Ajv2020 = runnerRequire("ajv/dist/2020.js").default as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => Ajv2020Instance;
const jsonSchemaCompiler = new Ajv2020({ allErrors: true, strict: false });

export interface MatcherObservation {
  message?: string;
  issueStatus?: string;
  runStatus?: string;
  runtimeMode?: string;
  environment?: string;
  files?: Record<string, string>;
  artifacts?: Array<{ name: string; mimeType?: string }>;
  json?: unknown;
}

export interface MatcherResult {
  matcher: Matcher;
  passed: boolean;
  detail: string;
}

function normalizeMessage(value: string | undefined) {
  return (
    (value ?? "")
      .replace(/\r\n/g, "\n")
      // Some provider renderers escape underscores in plain-text identifiers
      // before persisting Markdown. Treat that presentation-only escape as the
      // same visible marker for exact/contains/ordered message assertions.
      .replace(/\\_/g, "_")
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}

function readJsonPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[segment];
    }, value);
}

function countOccurrences(value: string, expected: string): number {
  if (!expected) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= value.length - expected.length) {
    const index = value.indexOf(expected, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + expected.length;
  }
  return count;
}

export async function evaluateMatcher(
  matcher: Matcher,
  observation: MatcherObservation,
): Promise<MatcherResult> {
  const message = normalizeMessage(observation.message);
  let passed = false;
  let actual: unknown;
  if (matcher.kind === "message_exact") {
    actual = message;
    passed = message === normalizeMessage(matcher.expected);
  } else if (matcher.kind === "message_contains") {
    actual = message;
    passed = message.includes(normalizeMessage(matcher.expected));
  } else if (matcher.kind === "message_occurrences") {
    actual = countOccurrences(message, normalizeMessage(matcher.expected));
    passed = actual === matcher.count;
  } else if (matcher.kind === "message_regex") {
    actual = message;
    passed = new RegExp(matcher.pattern, matcher.flags).test(message);
  } else if (matcher.kind === "message_ordered") {
    actual = message;
    let cursor = 0;
    passed = matcher.expected.every((expected) => {
      const normalizedExpected = normalizeMessage(expected);
      const index = message.indexOf(normalizedExpected, cursor);
      if (index < 0) return false;
      cursor = index + normalizedExpected.length;
      return true;
    });
  } else if (matcher.kind === "issue_status") {
    actual = observation.issueStatus;
    passed = actual === matcher.expected;
  } else if (matcher.kind === "run_status") {
    actual = observation.runStatus;
    passed = actual === matcher.expected;
  } else if (matcher.kind === "runtime_mode") {
    actual = observation.runtimeMode;
    passed = actual === matcher.expected;
  } else if (matcher.kind === "environment") {
    actual = observation.environment;
    passed = actual === matcher.expected;
  } else if (
    matcher.kind === "file_exists" ||
    matcher.kind === "file_contains"
  ) {
    try {
      actual =
        observation.files?.[matcher.path] ??
        (await readFile(matcher.path, "utf8"));
      passed =
        matcher.kind === "file_exists" ||
        String(actual).includes(matcher.expected);
    } catch {
      actual = undefined;
      passed = false;
    }
  } else if (matcher.kind === "artifact_exists") {
    actual = observation.artifacts ?? [];
    passed = (observation.artifacts ?? []).some(
      (artifact) =>
        artifact.name === matcher.name &&
        (!matcher.mimeType || artifact.mimeType === matcher.mimeType),
    );
  } else if (matcher.kind === "json_path") {
    actual = readJsonPath(observation.json, matcher.path);
    passed = JSON.stringify(actual) === JSON.stringify(matcher.expected);
  } else {
    const validate = jsonSchemaCompiler.compile(matcher.schema);
    passed = validate(observation.json);
    actual = passed
      ? observation.json
      : { value: observation.json, errors: validate.errors ?? [] };
  }
  return {
    matcher,
    passed,
    detail: passed
      ? "matched"
      : `expected ${JSON.stringify(matcher)}; observed ${JSON.stringify(actual)}`,
  };
}

export async function evaluateMatchers(
  matchers: readonly Matcher[],
  observation: MatcherObservation,
): Promise<MatcherResult[]> {
  return Promise.all(
    matchers.map((matcher) => evaluateMatcher(matcher, observation)),
  );
}
