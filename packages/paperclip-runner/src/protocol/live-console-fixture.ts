import { readFile } from "node:fs/promises";

export const LIVE_CONSOLE_CONFORMANCE_SCHEMA =
  "paperclip.runner.live-console.conformance.v1" as const;

export interface LiveConsoleRuntimeRequestFixture {
  id: string;
  method: string;
  requestKind: string;
  resolution: Record<string, unknown> & { action: string };
  expectedResponse: Record<string, unknown>;
}

export interface LiveConsoleGoalFixture {
  action: "get" | "set" | "pause" | "resume" | "clear";
  method: string;
  params: Record<string, unknown>;
}

export interface LiveConsoleConformanceFixture {
  schema: typeof LIVE_CONSOLE_CONFORMANCE_SCHEMA;
  codexVersion: string;
  runtimeRequests: LiveConsoleRuntimeRequestFixture[];
  goals: LiveConsoleGoalFixture[];
  lineage: {
    rootThreadId: string;
    childThread: Record<string, unknown> & { id: string; sessionId: string };
  };
  controls: Record<string, { turnId?: string; expected: string }>;
  reconnect: {
    runId: string;
    normalizedSessionId: string;
    driverSessionId: string;
    providerSessionId: string;
    lastSourceSequence: number;
  };
  redactionMarkers: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Load the deterministic Live console wire fixture without trusting its shape. */
export async function loadLiveConsoleConformanceFixture(
  path: string,
): Promise<LiveConsoleConformanceFixture> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  const fixture = record(value);
  if (fixture?.schema !== LIVE_CONSOLE_CONFORMANCE_SCHEMA) {
    throw new Error("Live console fixture has an unsupported schema");
  }
  if (!nonEmpty(fixture.codexVersion)) {
    throw new Error("Live console fixture must name the observed Codex version");
  }
  if (!Array.isArray(fixture.runtimeRequests) || fixture.runtimeRequests.length === 0) {
    throw new Error("Live console fixture must include runtime request cases");
  }
  if (!Array.isArray(fixture.goals) || fixture.goals.length !== 5) {
    throw new Error("Live console fixture must include all five goal operations");
  }
  const requestIds = new Set<string>();
  for (const candidate of fixture.runtimeRequests) {
    const request = record(candidate);
    const resolution = record(request?.resolution);
    if (
      !nonEmpty(request?.id) ||
      requestIds.has(request.id) ||
      !nonEmpty(request.method) ||
      !nonEmpty(request.requestKind) ||
      !nonEmpty(resolution?.action) ||
      record(request.expectedResponse) === null
    ) {
      throw new Error("Live console fixture contains an invalid runtime request case");
    }
    requestIds.add(request.id);
  }
  const actions = new Set(fixture.goals.map((candidate) => record(candidate)?.action));
  if (!["get", "set", "pause", "resume", "clear"].every((action) => actions.has(action))) {
    throw new Error("Live console fixture goal operation set is incomplete");
  }
  const lineage = record(fixture.lineage);
  const child = record(lineage?.childThread);
  const reconnect = record(fixture.reconnect);
  if (
    !nonEmpty(lineage?.rootThreadId) ||
    !nonEmpty(child?.id) ||
    !nonEmpty(child.sessionId) ||
    !nonEmpty(reconnect?.runId) ||
    !nonEmpty(reconnect.normalizedSessionId) ||
    !nonEmpty(reconnect.driverSessionId) ||
    !nonEmpty(reconnect.providerSessionId) ||
    !Number.isInteger(reconnect.lastSourceSequence)
  ) {
    throw new Error("Live console fixture identity or lineage is incomplete");
  }
  if (!Array.isArray(fixture.redactionMarkers) || !fixture.redactionMarkers.every(nonEmpty)) {
    throw new Error("Live console fixture redaction markers are invalid");
  }
  return value as LiveConsoleConformanceFixture;
}
