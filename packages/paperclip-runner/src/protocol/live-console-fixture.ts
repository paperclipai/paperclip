import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import {
  parseHarnessRuntimeRequestResolution,
  type HarnessRuntimeRequest,
} from "../contracts/harness-driver.js";
import {
  createCodexQuestionResponseContext,
  runtimeRequestKind,
  runtimeRequestResponse,
} from "../drivers/codex/codex-question-adapter.js";

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

export interface LiveConsoleControlFixture {
  turnId?: string;
  expected: string;
}

export interface LiveConsoleConformanceFixture {
  schema: typeof LIVE_CONSOLE_CONFORMANCE_SCHEMA;
  codexVersion: string;
  runtimeRequests: LiveConsoleRuntimeRequestFixture[];
  goals: LiveConsoleGoalFixture[];
  lineage: {
    rootThreadId: string;
    childThread: Record<string, unknown> & {
      id: string;
      sessionId: string;
      agentNickname: string;
      agentRole: string;
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: string;
            depth: number;
            agent_path: string[];
            agent_nickname: string;
            agent_role: string;
          };
        };
      };
    };
  };
  controls: {
    sameTurnSteer: LiveConsoleControlFixture & { turnId: string };
    staleTurnSteer: LiveConsoleControlFixture & { turnId: string };
    interruptBeforeStart: LiveConsoleControlFixture;
    interruptAfterTerminal: LiveConsoleControlFixture;
  };
  reconnect: {
    runId: string;
    normalizedSessionId: string;
    driverSessionId: string;
    providerSessionId: string;
    lastSourceSequence: number;
  };
  redactionMarkers: string[];
}

const MAX_LIVE_CONSOLE_FIXTURE_BYTES = 1024 * 1024;
const MAX_RUNTIME_REQUEST_CASES = 64;
const MAX_REDACTION_MARKERS = 64;
const MAX_CONTROL_CASES = 64;
const GOAL_METHODS = {
  get: "thread/goal/get",
  set: "thread/goal/set",
  pause: "thread/goal/set",
  resume: "thread/goal/set",
  clear: "thread/goal/clear",
} as const;
const CONTROL_EXPECTATIONS = {
  sameTurnSteer: { expected: "acknowledged", requiresTurnId: true },
  staleTurnSteer: { expected: "stale_turn", requiresTurnId: true },
  interruptBeforeStart: { expected: "queued", requiresTurnId: false },
  interruptAfterTerminal: {
    expected: "already_terminal",
    requiresTurnId: false,
  },
} as const;

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
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_LIVE_CONSOLE_FIXTURE_BYTES) {
    throw new Error("Live console fixture exceeded its file-size limit");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  const fixture = record(value);
  if (fixture?.schema !== LIVE_CONSOLE_CONFORMANCE_SCHEMA) {
    throw new Error("Live console fixture has an unsupported schema");
  }
  if (!nonEmpty(fixture.codexVersion)) {
    throw new Error("Live console fixture must name the observed Codex version");
  }
  if (
    !Array.isArray(fixture.runtimeRequests) ||
    fixture.runtimeRequests.length === 0 ||
    fixture.runtimeRequests.length > MAX_RUNTIME_REQUEST_CASES
  ) {
    throw new Error("Live console fixture must include runtime request cases");
  }
  if (!Array.isArray(fixture.goals) || fixture.goals.length !== 5) {
    throw new Error("Live console fixture must include all five goal operations");
  }
  const requestIds = new Set<string>();
  for (const candidate of fixture.runtimeRequests) {
    const request = record(candidate);
    const resolution = record(request?.resolution);
    const kind = nonEmpty(request?.method)
      ? runtimeRequestKind(request.method)
      : null;
    if (
      !nonEmpty(request?.id) ||
      requestIds.has(request.id) ||
      !nonEmpty(request.method) ||
      kind === null ||
      request.requestKind !== kind ||
      !nonEmpty(resolution?.action) ||
      record(request.expectedResponse) === null
    ) {
      throw new Error("Live console fixture contains an invalid runtime request case");
    }
    try {
      const parsedResolution = parseHarnessRuntimeRequestResolution(kind, resolution);
      const harnessRequest: HarnessRuntimeRequest = {
        requestId: request.id,
        requestKind: kind,
        method: request.method,
        turnId: "fixture-turn",
        itemId: request.id,
        status: "pending",
        prompt: "fixture request",
        details: {},
      };
      if (
        !isDeepStrictEqual(
          runtimeRequestResponse(
            harnessRequest,
            parsedResolution,
            createCodexQuestionResponseContext(),
          ),
          request.expectedResponse,
        )
      ) {
        throw new Error("expected response does not match the declared resolution");
      }
    } catch {
      throw new Error("Live console fixture contains an invalid runtime request case");
    }
    requestIds.add(request.id);
  }
  const actions = new Set<string>();
  for (const candidate of fixture.goals) {
    const goal = record(candidate);
    if (goal === null) {
      throw new Error("Live console fixture contains an invalid goal operation");
    }
    const action = goal?.action;
    if (
      typeof action !== "string" ||
      !(action in GOAL_METHODS) ||
      goal.method !== GOAL_METHODS[action as keyof typeof GOAL_METHODS] ||
      !validGoalParams(action as keyof typeof GOAL_METHODS, goal.params)
    ) {
      throw new Error("Live console fixture contains an invalid goal operation");
    }
    actions.add(action);
  }
  if (!["get", "set", "pause", "resume", "clear"].every((action) => actions.has(action))) {
    throw new Error("Live console fixture goal operation set is incomplete");
  }
  const lineage = record(fixture.lineage);
  const child = record(lineage?.childThread);
  const childSource = record(child?.source);
  const childSubAgent = record(childSource?.subAgent);
  const childSpawn = record(childSubAgent?.thread_spawn);
  const childAgentPath = childSpawn?.agent_path;
  const controls = record(fixture.controls);
  const reconnect = record(fixture.reconnect);
  if (
    !nonEmpty(lineage?.rootThreadId) ||
    !nonEmpty(child?.id) ||
    !nonEmpty(child.sessionId) ||
    child.id === lineage.rootThreadId ||
    childSpawn === null ||
    childSpawn.parent_thread_id !== lineage.rootThreadId ||
    !Number.isSafeInteger(childSpawn.depth) ||
    (childSpawn.depth as number) < 1 ||
    !Array.isArray(childAgentPath) ||
    childAgentPath.length === 0 ||
    childAgentPath.length > 64 ||
    !childAgentPath.every(nonEmpty) ||
    !nonEmpty(childSpawn.agent_nickname) ||
    !nonEmpty(childSpawn.agent_role) ||
    child.agentNickname !== childSpawn.agent_nickname ||
    child.agentRole !== childSpawn.agent_role ||
    !nonEmpty(reconnect?.runId) ||
    !nonEmpty(reconnect.normalizedSessionId) ||
    !nonEmpty(reconnect.driverSessionId) ||
    !nonEmpty(reconnect.providerSessionId) ||
    !Number.isSafeInteger(reconnect.lastSourceSequence) ||
    (reconnect.lastSourceSequence as number) < 0
  ) {
    throw new Error("Live console fixture identity or lineage is incomplete");
  }
  const controlNames = Object.keys(CONTROL_EXPECTATIONS);
  if (
    controls === null ||
    Object.keys(controls).length > MAX_CONTROL_CASES ||
    Object.keys(controls).length !== controlNames.length ||
    controlNames.some((name) => {
      const expectation =
        CONTROL_EXPECTATIONS[name as keyof typeof CONTROL_EXPECTATIONS];
      const control = record(controls[name]);
      if (
        control === null ||
        control.expected !== expectation.expected ||
        Object.keys(control).some(
          (key) => key !== "expected" && key !== "turnId",
        )
      ) {
        return true;
      }
      return expectation.requiresTurnId
        ? !nonEmpty(control.turnId)
        : control.turnId !== undefined;
    })
  ) {
    throw new Error("Live console fixture controls are invalid");
  }
  if (
    !Array.isArray(fixture.redactionMarkers) ||
    fixture.redactionMarkers.length > MAX_REDACTION_MARKERS ||
    !fixture.redactionMarkers.every(nonEmpty)
  ) {
    throw new Error("Live console fixture redaction markers are invalid");
  }
  return value as LiveConsoleConformanceFixture;
}

function validGoalParams(
  action: keyof typeof GOAL_METHODS,
  value: unknown,
): boolean {
  const params = record(value);
  if (params === null) return false;
  if (action === "get" || action === "clear") {
    return Object.keys(params).length === 0;
  }
  if (action === "pause" || action === "resume") {
    return Object.keys(params).length === 1 &&
      params.status === (action === "pause" ? "paused" : "active");
  }
  return nonEmpty(params.objective) &&
    params.status === "active" &&
    Object.keys(params).every((key) =>
      key === "objective" || key === "status" || key === "tokenBudget"
    ) &&
    (params.tokenBudget === undefined ||
      params.tokenBudget === null ||
      (Number.isSafeInteger(params.tokenBudget) && (params.tokenBudget as number) >= 0));
}
