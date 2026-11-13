import { readFile } from "node:fs/promises";

import type {
  NativeRunEvent,
  NativeRunEventType,
  NativeRunIdentity,
  NativeRunResult,
  NativeRunStatus,
} from "../contracts/types.js";

export const CONFORMANCE_FIXTURE_SCHEMA = "paperclip.runner.conformance.fixture.v1";

export interface ConformanceFixture {
  schemaVersion: typeof CONFORMANCE_FIXTURE_SCHEMA;
  run: NativeRunIdentity;
  events: NativeRunEvent[];
  result: NativeRunResult;
}

export const conformanceFixtureUrl = new URL(
  "../../protocol/fixtures/conformance-minimal-run.json",
  import.meta.url,
);

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`${path} must be a stable lowercase identifier`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function parseRun(value: unknown): NativeRunIdentity {
  const run = asRecord(value, "run");
  return {
    runId: asIdentifier(run.runId, "run.runId"),
    sessionId: asIdentifier(run.sessionId, "run.sessionId"),
    companyId: asIdentifier(run.companyId, "run.companyId"),
    issueId: asIdentifier(run.issueId, "run.issueId"),
    agentId: asIdentifier(run.agentId, "run.agentId"),
  };
}

function parseEvents(value: unknown, runId: string): NativeRunEvent[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("events must contain at least run.started and run.completed");
  }

  const allowedTypes = new Set<NativeRunEventType>(["run.started", "run.completed"]);
  const events = value.map((entry, index) => {
    const event = asRecord(entry, `events[${index}]`);
    const type = asString(event.type, `events[${index}].type`) as NativeRunEventType;
    if (!allowedTypes.has(type)) {
      throw new Error(`events[${index}].type is unsupported`);
    }
    if (event.runId !== runId) {
      throw new Error(`events[${index}].runId must match run.runId`);
    }
    if (event.sequence !== index + 1) {
      throw new Error(`events[${index}].sequence must be ${index + 1}`);
    }
    return {
      eventId: asIdentifier(event.eventId, `events[${index}].eventId`),
      runId,
      sequence: index + 1,
      type,
    };
  });

  if (events[0]?.type !== "run.started") {
    throw new Error("the first event must be run.started");
  }
  if (events.at(-1)?.type !== "run.completed") {
    throw new Error("the final event must be run.completed");
  }
  return events;
}

function parseResult(value: unknown, runId: string): NativeRunResult {
  const result = asRecord(value, "result");
  if (result.runId !== runId) {
    throw new Error("result.runId must match run.runId");
  }
  const status = asString(result.status, "result.status") as NativeRunStatus;
  if (status !== "succeeded") {
    throw new Error("the Conformance fixture result must be succeeded");
  }
  return {
    runId,
    status,
    summary: asString(result.summary, "result.summary"),
  };
}

export function validateConformanceFixture(value: unknown): ConformanceFixture {
  const fixture = asRecord(value, "fixture");
  if (fixture.schemaVersion !== CONFORMANCE_FIXTURE_SCHEMA) {
    throw new Error(`schemaVersion must be ${CONFORMANCE_FIXTURE_SCHEMA}`);
  }
  const run = parseRun(fixture.run);
  return {
    schemaVersion: CONFORMANCE_FIXTURE_SCHEMA,
    run,
    events: parseEvents(fixture.events, run.runId),
    result: parseResult(fixture.result, run.runId),
  };
}

export async function loadConformanceFixture(
  url: URL = conformanceFixtureUrl,
): Promise<ConformanceFixture> {
  const contents = await readFile(url, "utf8");
  return validateConformanceFixture(JSON.parse(contents) as unknown);
}
