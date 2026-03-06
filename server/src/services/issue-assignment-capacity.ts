type PlainObject = Record<string, unknown>;

export type AssignmentCapacityTarget = "running" | "queued" | null;
export type AssignmentCapacityReason = "max_running_reached" | "max_queued_reached";

export interface AssignmentCapacityCounts {
  running: number;
  queued: number;
}

export interface AssignmentCapacityLimits {
  maxRunning: number | null;
  maxQueued: number | null;
}

export interface AssignmentCapacityConfig {
  defaultMaxRunning: number | null;
  defaultMaxQueued: number | null;
  foundingEngineerNameKey: string;
  foundingEngineerLegacyOpenCap: number | null;
  foundingEngineerMaxRunning: number | null;
  foundingEngineerMaxQueued: number | null;
}

export interface AssignmentCapacityViolation {
  code: "assignment_capacity_exceeded";
  reason: AssignmentCapacityReason;
  attemptedState: Exclude<AssignmentCapacityTarget, null>;
  message: string;
}

function asRecord(value: unknown): PlainObject | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  return value as PlainObject;
}

function asNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : null;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function firstNonNull(...values: Array<number | null>): number | null {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

function normalizedNameKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function parseRuntimeAssignmentLimits(runtimeConfig: unknown): AssignmentCapacityLimits {
  const runtime = asRecord(runtimeConfig);
  if (!runtime) {
    return { maxRunning: null, maxQueued: null };
  }

  const assignment =
    asRecord(runtime.assignment) ??
    asRecord(runtime.issueAssignment) ??
    asRecord(runtime.assignmentCapacity);
  if (!assignment) {
    return { maxRunning: null, maxQueued: null };
  }

  return {
    maxRunning: firstNonNull(
      asPositiveInteger(assignment.maxRunningIssues),
      asPositiveInteger(assignment.maxRunning),
      asPositiveInteger(assignment.runningCap),
    ),
    maxQueued: firstNonNull(
      asPositiveInteger(assignment.maxQueuedIssues),
      asPositiveInteger(assignment.maxQueued),
      asPositiveInteger(assignment.queuedCap),
    ),
  };
}

export function parseCapacityEnvInteger(value: unknown): number | null {
  return asPositiveInteger(value);
}

export function resolveAssignmentCapacityLimits(input: {
  agentName: string | null | undefined;
  runtimeConfig: unknown;
  config: AssignmentCapacityConfig;
}): AssignmentCapacityLimits {
  const runtimeLimits = parseRuntimeAssignmentLimits(input.runtimeConfig);

  let maxRunning = firstNonNull(runtimeLimits.maxRunning, input.config.defaultMaxRunning);
  let maxQueued = firstNonNull(runtimeLimits.maxQueued, input.config.defaultMaxQueued);

  const isFoundingEngineer =
    normalizedNameKey(input.agentName) === normalizedNameKey(input.config.foundingEngineerNameKey);

  if (isFoundingEngineer) {
    const foundingRunning = firstNonNull(
      input.config.foundingEngineerMaxRunning,
      input.config.foundingEngineerLegacyOpenCap != null ? 1 : null,
    );
    const foundingQueued = firstNonNull(
      input.config.foundingEngineerMaxQueued,
      input.config.foundingEngineerLegacyOpenCap != null && foundingRunning != null
        ? Math.max(0, input.config.foundingEngineerLegacyOpenCap - foundingRunning)
        : null,
    );
    maxRunning = firstNonNull(maxRunning, foundingRunning);
    maxQueued = firstNonNull(maxQueued, foundingQueued);
  }

  return {
    maxRunning: asNonNegativeInteger(maxRunning),
    maxQueued: asNonNegativeInteger(maxQueued),
  };
}

export function assignmentCapacityTargetForStatus(status: string | null | undefined): AssignmentCapacityTarget {
  if (status === "in_progress") return "running";
  if (status === "todo") return "queued";
  return null;
}

export function evaluateAssignmentCapacity(input: {
  target: AssignmentCapacityTarget;
  counts: AssignmentCapacityCounts;
  limits: AssignmentCapacityLimits;
}): AssignmentCapacityViolation | null {
  if (input.target === "running" && input.limits.maxRunning != null) {
    if (input.counts.running >= input.limits.maxRunning) {
      return {
        code: "assignment_capacity_exceeded",
        reason: "max_running_reached",
        attemptedState: "running",
        message: `Running capacity reached (${input.counts.running}/${input.limits.maxRunning} in_progress tasks).`,
      };
    }
  }

  if (input.target === "queued" && input.limits.maxQueued != null) {
    if (input.counts.queued >= input.limits.maxQueued) {
      return {
        code: "assignment_capacity_exceeded",
        reason: "max_queued_reached",
        attemptedState: "queued",
        message: `Queued capacity reached (${input.counts.queued}/${input.limits.maxQueued} todo tasks).`,
      };
    }
  }

  return null;
}
