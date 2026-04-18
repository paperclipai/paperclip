import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  companySecrets,
  goals,
  heartbeatRuns,
  issues,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type {
  CreateRoutine,
  CreateRoutineTrigger,
  Routine,
  RoutineDetail,
  RoutineIssueSummary,
  RoutineListItem,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
  RoutineVariable,
  RunRoutine,
  UpdateRoutine,
  UpdateRoutineTrigger,
} from "@paperclipai/shared";
import {
  interpolateRoutineTemplate,
  normalizeIssuePriority,
  stringifyRoutineVariableValue,
  syncRoutineVariablesWithTemplate,
} from "@paperclipai/shared";
import { trackRoutineRun } from "@paperclipai/shared/telemetry";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";
import { parseCron, validateCron } from "./cron.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running"];
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const MAX_CATCH_UP_RUNS = 25;

function asUuidParam(value: string) {
  return sql`${value}::uuid`;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type Actor = { agentId?: string | null; userId?: string | null };

function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

function getZonedMinuteParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

function matchesCronMinute(expression: string, timeZone: string, date: Date) {
  const cron = parseCron(expression);
  const parts = getZonedMinuteParts(date, timeZone);
  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.daysOfMonth.includes(parts.day) &&
    cron.months.includes(parts.month) &&
    cron.daysOfWeek.includes(parts.weekday)
  );
}

function nextCronTickInTimeZone(expression: string, timeZone: string, after: Date) {
  const trimmed = expression.trim();
  assertTimeZone(timeZone);
  const error = validateCron(trimmed);
  if (error) {
    throw unprocessable(error);
  }

  const cursor = floorToMinute(after);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60 * 5;
  for (let i = 0; i < limit; i += 1) {
    if (matchesCronMinute(trimmed, timeZone, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created" && issueId) return `Created execution issue ${issueId}`;
  if (status === "issue_reused" && issueId) return `Reused execution issue ${issueId}`;
  if (status === "coalesced") return "Coalesced into an existing live execution issue";
  if (status === "skipped") return "Skipped because a live execution issue already exists";
  if (status === "completed") return "Execution issue completed";
  if (status === "failed") return "Execution failed";
  return status;
}

function normalizeWebhookTimestampMs(rawTimestamp: string) {
  const parsed = Number(rawTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBooleanVariableValue(name: string, raw: unknown) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && (raw === 0 || raw === 1)) return raw === 1;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  throw unprocessable(`Variable "${name}" must be a boolean`);
}

function parseNumberVariableValue(name: string, raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw unprocessable(`Variable "${name}" must be a number`);
}

function normalizeRoutineVariableValue(variable: RoutineVariable, raw: unknown): string | number | boolean | null {
  if (raw == null) return null;
  if (variable.type === "boolean") return parseBooleanVariableValue(variable.name, raw);
  if (variable.type === "number") return parseNumberVariableValue(variable.name, raw);

  const normalized = stringifyRoutineVariableValue(raw);
  if (variable.type === "select") {
    if (!variable.options.includes(normalized)) {
      throw unprocessable(`Variable "${variable.name}" must match one of: ${variable.options.join(", ")}`);
    }
  }
  return normalized;
}

function isMissingRoutineVariableValue(value: string | number | boolean | null) {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function assertRoutineVariableDefinitions(variables: RoutineVariable[]) {
  for (const variable of variables) {
    if (variable.defaultValue != null) {
      normalizeRoutineVariableValue(variable, variable.defaultValue);
    }
    if (variable.type === "select" && variable.options.length === 0) {
      throw unprocessable(`Variable "${variable.name}" must define at least one option`);
    }
  }
}

function sanitizeRoutineVariableInputs(
  variables: Array<Partial<RoutineVariable> & Pick<RoutineVariable, "name">> | null | undefined,
): RoutineVariable[] {
  return (variables ?? []).map((variable) => ({
    name: variable.name,
    label: variable.label ?? null,
    type: variable.type ?? "text",
    defaultValue: variable.defaultValue ?? null,
    required: variable.required ?? true,
    options: variable.options ?? [],
  }));
}

function assertScheduleCompatibleVariables(variables: RoutineVariable[]) {
  const missingDefaults = variables
    .filter((variable) => variable.required)
    .filter((variable) => {
      try {
        return isMissingRoutineVariableValue(normalizeRoutineVariableValue(variable, variable.defaultValue));
      } catch {
        return true;
      }
    })
    .map((variable) => variable.name);
  if (missingDefaults.length > 0) {
    throw unprocessable(
      `Scheduled routines require defaults for required variables: ${missingDefaults.join(", ")}`,
    );
  }
}

function collectProvidedRoutineVariables(
  source: "schedule" | "manual" | "api" | "webhook",
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, unknown> | null | undefined,
) {
  const nestedVariables = isPlainRecord(payload) && isPlainRecord(payload.variables) ? payload.variables : {};
  const provided = {
    ...(source === "webhook" && payload ? payload : {}),
    ...nestedVariables,
    ...(variables ?? {}),
  };
  delete provided.variables;
  return provided;
}

function resolveRoutineVariableValues(
  variables: RoutineVariable[],
  input: {
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
  },
) {
  if (variables.length === 0) return {} as Record<string, string | number | boolean>;
  const provided = collectProvidedRoutineVariables(input.source, input.payload, input.variables);
  const resolved: Record<string, string | number | boolean> = {};
  const missing: string[] = [];

  for (const variable of variables) {
    const candidate = provided[variable.name] !== undefined ? provided[variable.name] : variable.defaultValue;
    const normalized = normalizeRoutineVariableValue(variable, candidate);
    if (normalized == null || (typeof normalized === "string" && normalized.trim().length === 0)) {
      if (variable.required) missing.push(variable.name);
      continue;
    }
    resolved[variable.name] = normalized;
  }

  if (missing.length > 0) {
    throw unprocessable(`Missing routine variables: ${missing.join(", ")}`);
  }

  return resolved;
}

function mergeRoutineRunPayload(
  payload: Record<string, unknown> | null | undefined,
  variables: Record<string, string | number | boolean>,
) {
  if (Object.keys(variables).length === 0) return payload ?? null;
  if (!payload) return { variables };
  const existingVariables = isPlainRecord(payload.variables) ? payload.variables : {};
  return {
    ...payload,
    variables: {
      ...existingVariables,
      ...variables,
    },
  };
}

export function routineService(db: Db, deps: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const issueSvc = issueService(db);
  const secretsSvc = secretService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db);

  async function getRoutineById(id: string) {
    return db
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getTriggerById(id: string) {
    return db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertRoutineAccess(companyId: string, routineId: string) {
    const routine = await getRoutineById(routineId);
    if (!routine) throw notFound("Routine not found");
    if (routine.companyId !== companyId) throw forbidden("Routine must belong to same company");
    return routine;
  }

  async function assertAssignableAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Assignee agent not found");
    if (agent.companyId !== companyId) throw unprocessable("Assignee must belong to same company");
    if (agent.status === "pending_approval") throw conflict("Cannot assign routines to pending approval agents");
    if (agent.status === "terminated") throw conflict("Cannot assign routines to terminated agents");
  }

  async function assertProject(companyId: string, projectId: string) {
    const project = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) throw unprocessable("Project must belong to same company");
  }

  async function assertGoal(companyId: string, goalId: string) {
    const goal = await db
      .select({ id: goals.id, companyId: goals.companyId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.companyId !== companyId) throw unprocessable("Goal must belong to same company");
  }

  async function assertParentIssue(companyId: string, issueId: string) {
    const parentIssue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!parentIssue) throw notFound("Parent issue not found");
    if (parentIssue.companyId !== companyId) throw unprocessable("Parent issue must belong to same company");
  }

  async function listTriggersForRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineTrigger[]>();
    const rows = await db
      .select()
      .from(routineTriggers)
      .where(and(eq(routineTriggers.companyId, companyId), inArray(routineTriggers.routineId, routineIds)))
      .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));
    const map = new Map<string, RoutineTrigger[]>();
    for (const row of rows) {
      const list = map.get(row.routineId) ?? [];
      list.push(row);
      map.set(row.routineId, list);
    }
    return map;
  }

  async function listLatestRunByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineRunSummary>();
    const rows = await db
      .selectDistinctOn([routineRuns.routineId], {
        id: routineRuns.id,
        companyId: routineRuns.companyId,
        routineId: routineRuns.routineId,
        triggerId: routineRuns.triggerId,
        source: routineRuns.source,
        status: routineRuns.status,
        triggeredAt: routineRuns.triggeredAt,
        idempotencyKey: routineRuns.idempotencyKey,
        triggerPayload: routineRuns.triggerPayload,
        linkedIssueId: routineRuns.linkedIssueId,
        coalescedIntoRunId: routineRuns.coalescedIntoRunId,
        failureReason: routineRuns.failureReason,
        completedAt: routineRuns.completedAt,
        createdAt: routineRuns.createdAt,
        updatedAt: routineRuns.updatedAt,
        triggerKind: routineTriggers.kind,
        triggerLabel: routineTriggers.label,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(routineRuns)
      .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
      .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
      .where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.routineId, routineIds)))
      .orderBy(routineRuns.routineId, desc(routineRuns.createdAt), desc(routineRuns.id));

    const map = new Map<string, RoutineRunSummary>();
    for (const row of rows) {
      map.set(row.routineId, {
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
            role: null,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      });
    }
    return map;
  }

  type OpenRoutineIssueRow = {
    id: string;
    originId: string | null;
    identifier: string | null;
    title: string;
    status: string;
    priority: string;
    updatedAt: Date;
    createdAt: Date;
    originRunId: string | null;
    routineBoundRunId: string | null;
    routineIssueRole: string | null;
    executionRunId: string | null;
    assigneeAgentId: string | null;
  };

  type RoutineExecutionView = {
    canonicalIssue: RoutineIssueSummary | null;
    liveIssue: RoutineIssueSummary | null;
    activeIssue: RoutineIssueSummary | null;
    executionState: RoutineDetail["executionState"];
    canonicalIssueRow: OpenRoutineIssueRow | null;
    liveIssueRow: OpenRoutineIssueRow | null;
    rows: OpenRoutineIssueRow[];
  };

  type RoutineExecutionRepairCandidate = {
    routineId: string;
    companyId: string;
    status: typeof routines.$inferSelect.status;
    concurrencyPolicy: typeof routines.$inferSelect.concurrencyPolicy;
    executionState: RoutineDetail["executionState"];
    canonicalIssueId: string | null;
    liveIssueId: string | null;
    staleExecutionLockIssueIds: string[];
    issueIdsToCanonicalize: string[];
    issueIdsToParallelize: string[];
    duplicateIssueIds: string[];
    wakeupIdsToCancel: string[];
    queuedRunIdsToCancel: string[];
  };

  type RoutineExecutionRepairInspection = {
    routinesInspected: number;
    routinesWithChanges: number;
    staleExecutionLocks: {
      count: number;
      issueIds: string[];
    };
    canonicalRoleUpdates: {
      count: number;
      issueIds: string[];
    };
    parallelRoleUpdates: {
      count: number;
      issueIds: string[];
    };
    duplicateIssues: {
      count: number;
      issueIds: string[];
    };
    wakeupsToCancel: {
      count: number;
      wakeupIds: string[];
    };
    queuedRunsToCancel: {
      count: number;
      runIds: string[];
    };
    routines: RoutineExecutionRepairCandidate[];
  };

  type RoutineExecutionRepairSummary = {
    routinesInspected: number;
    routinesReconciled: number;
    staleExecutionLocksCleared: number;
    canonicalRolesUpdated: number;
    parallelRolesUpdated: number;
    duplicateIssuesSuperseded: number;
    wakeupsCancelled: number;
    queuedRunsCancelled: number;
  };

  function summarizeRoutineIssue(row: OpenRoutineIssueRow | null): RoutineIssueSummary | null {
    if (!row) return null;
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      priority: row.priority,
      updatedAt: row.updatedAt,
      role: row.routineIssueRole as RoutineIssueSummary["role"],
    };
  }

  async function listOpenRoutineIssueRows(companyId: string, routineIds: string[], executor: Db = db) {
    if (routineIds.length === 0) return [] as OpenRoutineIssueRow[];
    return executor
      .select({
        id: issues.id,
        originId: issues.originId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
        createdAt: issues.createdAt,
        originRunId: issues.originRunId,
        routineBoundRunId: issues.routineBoundRunId,
        routineIssueRole: issues.routineIssueRole,
        executionRunId: issues.executionRunId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "routine_execution"),
          inArray(issues.originId, routineIds),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt));
  }

  async function listLiveRoutineIssueIds(companyId: string, issueIds: string[], executor: Db = db) {
    if (issueIds.length === 0) return new Set<string>();
    const liveIssueIds = new Set<string>();
    const executionBoundRows = await executor
      .select({ issueId: issues.id })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.id, issueIds),
        ),
      );
    for (const row of executionBoundRows) {
      liveIssueIds.add(row.issueId);
    }

    const missingIssueIds = issueIds.filter((issueId) => !liveIssueIds.has(issueId));
    if (missingIssueIds.length > 0) {
      const legacyRows = await executor
        .select({ issueId: issues.id })
        .from(issues)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.companyId, issues.companyId),
            inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
          ),
        )
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.id, missingIssueIds),
          ),
        );
      for (const row of legacyRows) {
        liveIssueIds.add(row.issueId);
      }
    }

    return liveIssueIds;
  }

  function pickCanonicalRoutineIssue(
    routine: typeof routines.$inferSelect,
    rows: OpenRoutineIssueRow[],
    liveIssueIds: Set<string>,
  ) {
    if (routine.concurrencyPolicy === "always_enqueue") return null;
    const eligibleRows = rows.filter((row) => row.routineIssueRole !== "superseded");
    if (eligibleRows.length === 0) return rows[0] ?? null;
    return (
      eligibleRows.find((row) => liveIssueIds.has(row.id) && row.routineIssueRole === "canonical")
      ?? eligibleRows.find((row) => liveIssueIds.has(row.id))
      ?? eligibleRows.find((row) => row.routineIssueRole === "canonical")
      ?? eligibleRows[0]
      ?? null
    );
  }

  function pickLiveRoutineIssue(
    rows: OpenRoutineIssueRow[],
    liveIssueIds: Set<string>,
    canonicalIssue: OpenRoutineIssueRow | null,
  ) {
    if (canonicalIssue && liveIssueIds.has(canonicalIssue.id)) return canonicalIssue;
    return rows.find((row) => row.routineIssueRole !== "superseded" && liveIssueIds.has(row.id)) ?? null;
  }

  function buildRoutineExecutionView(
    routine: typeof routines.$inferSelect,
    rows: OpenRoutineIssueRow[],
    liveIssueIds: Set<string>,
  ): RoutineExecutionView {
    const canonicalIssueRow = pickCanonicalRoutineIssue(routine, rows, liveIssueIds);
    const liveIssueRow = pickLiveRoutineIssue(rows, liveIssueIds, canonicalIssueRow);
    const visibleOpenRows = rows.filter((row) => row.routineIssueRole !== "superseded");
    const executionState: RoutineDetail["executionState"] =
      routine.status !== "active" && visibleOpenRows.length > 0
        ? "paused"
        : liveIssueRow
          ? "live"
          : (canonicalIssueRow || visibleOpenRows.length > 0)
            ? "idle"
            : "none";
    const canonicalIssue = summarizeRoutineIssue(canonicalIssueRow);
    const liveIssue = summarizeRoutineIssue(liveIssueRow);
    return {
      canonicalIssue,
      liveIssue,
      activeIssue: liveIssue,
      executionState,
      canonicalIssueRow,
      liveIssueRow,
      rows,
    };
  }

  async function listRoutineExecutionViewByRoutineIds(
    routineRows: Array<typeof routines.$inferSelect>,
    executor: Db = db,
  ) {
    const routineIds = routineRows.map((row) => row.id);
    const issueRows = await listOpenRoutineIssueRows(routineRows[0]?.companyId ?? "", routineIds, executor);
    const liveIssueIds = await listLiveRoutineIssueIds(
      routineRows[0]?.companyId ?? "",
      issueRows.map((row) => row.id),
      executor,
    );
    const rowsByOriginId = new Map<string, OpenRoutineIssueRow[]>();
    for (const row of issueRows) {
      if (!row.originId) continue;
      const existing = rowsByOriginId.get(row.originId);
      if (existing) existing.push(row);
      else rowsByOriginId.set(row.originId, [row]);
    }

    const map = new Map<string, RoutineExecutionView>();
    for (const routine of routineRows) {
      map.set(routine.id, buildRoutineExecutionView(routine, rowsByOriginId.get(routine.id) ?? [], liveIssueIds));
    }
    return map;
  }

  async function updateRoutineTouchedState(input: {
    routineId: string;
    triggerId?: string | null;
    triggeredAt: Date;
    status: string;
    issueId?: string | null;
    nextRunAt?: Date | null;
  }, executor: Db = db) {
    await executor
      .update(routines)
      .set({
        lastTriggeredAt: input.triggeredAt,
        lastEnqueuedAt: input.issueId ? input.triggeredAt : undefined,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, input.routineId));

    if (input.triggerId) {
      await executor
        .update(routineTriggers)
        .set({
          lastFiredAt: input.triggeredAt,
          lastResult: nextResultText(input.status, input.issueId),
          nextRunAt: input.nextRunAt === undefined ? undefined : input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, input.triggerId));
    }
  }

  async function clearStaleExecutionLocksForRoutine(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
  ) {
    const staleIssueIds = await listStaleExecutionLockIssueIds(routine, executor);
    if (staleIssueIds.length === 0) return;

    await executor
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          inArray(issues.id, staleIssueIds),
        ),
      );
  }

  async function listStaleExecutionLockIssueIds(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
  ): Promise<string[]> {
    const lockedIssueRows = await executor
      .select({
        id: issues.id,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          eq(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
          isNotNull(issues.executionRunId),
        ),
      );

    const runIds = Array.from(
      new Set(lockedIssueRows.map((row) => row.executionRunId).filter((id): id is string => Boolean(id))),
    );
    if (runIds.length === 0) return [];

    const runRows = await executor
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, routine.companyId),
          inArray(heartbeatRuns.id, runIds),
        ),
      );
    const liveRunIds = new Set(
      runRows
        .filter((row) => LIVE_HEARTBEAT_RUN_STATUSES.includes(row.status))
        .map((row) => row.id),
    );
    return lockedIssueRows
      .filter((row) => row.executionRunId && !liveRunIds.has(row.executionRunId))
      .map((row) => row.id);
  }

  async function getRoutineExecutionView(routine: typeof routines.$inferSelect, executor: Db = db) {
    return (
      (await listRoutineExecutionViewByRoutineIds([routine], executor)).get(routine.id)
      ?? {
        canonicalIssue: null,
        liveIssue: null,
        activeIssue: null,
        executionState: "none" as const,
        canonicalIssueRow: null,
        liveIssueRow: null,
        rows: [],
      }
    );
  }

  async function cancelPendingWakeupsForIssueIds(
    companyId: string,
    issueIds: string[],
    reason: string,
    executor: Db = db,
  ) {
    const wakeupIds = await listPendingWakeupIdsForIssueIds(companyId, issueIds, executor);
    if (wakeupIds.length === 0) return 0;
    const now = new Date();
    await executor
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: reason,
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));
    return wakeupIds.length;
  }

  async function listPendingWakeupIdsForIssueIds(
    companyId: string,
    issueIds: string[],
    executor: Db = db,
  ) {
    if (issueIds.length === 0) return [] as string[];
    const wakeIssueId = sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`;
    const wakeupRows = await executor
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          inArray(wakeIssueId, Array.from(new Set(issueIds))),
        ),
    );
    return wakeupRows.map((row) => row.id);
  }

  async function listQueuedRunIdsForIssueIds(
    companyId: string,
    issueIds: string[],
    executor: Db = db,
  ) {
    if (issueIds.length === 0) return [] as string[];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const boundRunIds = await executor
      .select({ runId: issues.executionRunId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.id, uniqueIssueIds),
          isNotNull(issues.executionRunId),
        ),
      )
      .then((rows) => Array.from(new Set(rows.map((row) => row.runId).filter((runId): runId is string => Boolean(runId)))));
    const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const queuedRunRows = await executor
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "queued"),
          boundRunIds.length > 0
            ? or(inArray(runIssueId, uniqueIssueIds), inArray(heartbeatRuns.id, boundRunIds))
            : inArray(runIssueId, uniqueIssueIds),
        ),
      );
    return Array.from(new Set(queuedRunRows.map((row) => row.id)));
  }

  async function cancelQueuedRunsForIssueIds(
    companyId: string,
    issueIds: string[],
    reason: string,
    executor: Db = db,
  ) {
    const runIds = await listQueuedRunIdsForIssueIds(companyId, issueIds, executor);
    if (runIds.length === 0) return 0;

    const queuedRuns = await executor
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.id, runIds),
          eq(heartbeatRuns.status, "queued"),
        ),
      );
    if (queuedRuns.length === 0) return 0;

    const confirmedRunIds = queuedRuns.map((row) => row.id);
    const wakeupRequestIds = Array.from(
      new Set(queuedRuns.map((row) => row.wakeupRequestId).filter((id): id is string => Boolean(id))),
    );
    const now = new Date();

    if (wakeupRequestIds.length > 0) {
      await executor
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: reason,
          updatedAt: now,
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    await executor
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: reason,
        errorCode: "cancelled",
        updatedAt: now,
      })
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.id, confirmedRunIds),
          eq(heartbeatRuns.status, "queued"),
        ),
      );

    await executor
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.id, Array.from(new Set(issueIds))),
          inArray(issues.executionRunId, confirmedRunIds),
        ),
      );

    return confirmedRunIds.length;
  }

  async function inspectRoutineExecutionRepairCandidate(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
  ): Promise<RoutineExecutionRepairCandidate> {
    const [view, staleExecutionLockIssueIds] = await Promise.all([
      getRoutineExecutionView(routine, executor),
      listStaleExecutionLockIssueIds(routine, executor),
    ]);

    const canonicalIssueId = view.canonicalIssueRow?.id ?? null;
    const nonCanonicalIssueIds = canonicalIssueId
      ? view.rows.filter((row) => row.id !== canonicalIssueId).map((row) => row.id)
      : [];
    const issueIdsToCanonicalize =
      view.canonicalIssueRow && view.canonicalIssueRow.routineIssueRole !== "canonical"
        ? [view.canonicalIssueRow.id]
        : [];
    const issueIdsToParallelize = routine.concurrencyPolicy === "always_enqueue"
      ? view.rows
        .filter((row) => row.routineIssueRole == null || row.routineIssueRole === "canonical")
        .map((row) => row.id)
      : [];
    const duplicateIssueIds = routine.concurrencyPolicy === "always_enqueue" ? [] : nonCanonicalIssueIds;
    const wakeupTargetIssueIds = routine.status !== "active"
      ? view.rows.map((row) => row.id)
      : routine.concurrencyPolicy === "always_enqueue"
        ? []
        : nonCanonicalIssueIds;
    const wakeupIdsToCancel = await listPendingWakeupIdsForIssueIds(
      routine.companyId,
      wakeupTargetIssueIds,
      executor,
    );
    const queuedRunIdsToCancel = await listQueuedRunIdsForIssueIds(
      routine.companyId,
      wakeupTargetIssueIds,
      executor,
    );

    return {
      routineId: routine.id,
      companyId: routine.companyId,
      status: routine.status,
      concurrencyPolicy: routine.concurrencyPolicy,
      executionState: view.executionState,
      canonicalIssueId,
      liveIssueId: view.liveIssueRow?.id ?? null,
      staleExecutionLockIssueIds,
      issueIdsToCanonicalize,
      issueIdsToParallelize,
      duplicateIssueIds,
      wakeupIdsToCancel,
      queuedRunIdsToCancel,
    };
  }

  function summarizeRoutineExecutionRepairInspection(
    candidates: RoutineExecutionRepairCandidate[],
  ): RoutineExecutionRepairInspection {
    const staleExecutionLockIssueIds = candidates.flatMap((candidate) => candidate.staleExecutionLockIssueIds);
    const issueIdsToCanonicalize = candidates.flatMap((candidate) => candidate.issueIdsToCanonicalize);
    const issueIdsToParallelize = candidates.flatMap((candidate) => candidate.issueIdsToParallelize);
    const duplicateIssueIds = candidates.flatMap((candidate) => candidate.duplicateIssueIds);
    const wakeupIdsToCancel = candidates.flatMap((candidate) => candidate.wakeupIdsToCancel);
    const queuedRunIdsToCancel = candidates.flatMap((candidate) => candidate.queuedRunIdsToCancel);
    const changedRoutines = candidates.filter((candidate) =>
      candidate.staleExecutionLockIssueIds.length > 0 ||
      candidate.issueIdsToCanonicalize.length > 0 ||
      candidate.issueIdsToParallelize.length > 0 ||
      candidate.duplicateIssueIds.length > 0 ||
      candidate.wakeupIdsToCancel.length > 0 ||
      candidate.queuedRunIdsToCancel.length > 0
    );

    return {
      routinesInspected: candidates.length,
      routinesWithChanges: changedRoutines.length,
      staleExecutionLocks: {
        count: staleExecutionLockIssueIds.length,
        issueIds: staleExecutionLockIssueIds,
      },
      canonicalRoleUpdates: {
        count: issueIdsToCanonicalize.length,
        issueIds: issueIdsToCanonicalize,
      },
      parallelRoleUpdates: {
        count: issueIdsToParallelize.length,
        issueIds: issueIdsToParallelize,
      },
      duplicateIssues: {
        count: duplicateIssueIds.length,
        issueIds: duplicateIssueIds,
      },
      wakeupsToCancel: {
        count: wakeupIdsToCancel.length,
        wakeupIds: wakeupIdsToCancel,
      },
      queuedRunsToCancel: {
        count: queuedRunIdsToCancel.length,
        runIds: queuedRunIdsToCancel,
      },
      routines: changedRoutines,
    };
  }

  async function listRoutinesForExecutionRepair(
    input: { companyId?: string | null; routineId?: string | null } = {},
    executor: Db = db,
  ) {
    if (input.routineId) {
      const routine = await executor
        .select()
        .from(routines)
        .where(
          and(
            eq(routines.id, input.routineId),
            input.companyId ? eq(routines.companyId, input.companyId) : undefined,
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!routine) throw notFound("Routine not found");
      return [routine];
    }

    const query = executor
      .select()
      .from(routines)
      .orderBy(asc(routines.companyId), asc(routines.createdAt), asc(routines.id));
    if (input.companyId) {
      return query.where(eq(routines.companyId, input.companyId));
    }
    return query;
  }

  async function reconcileRoutineExecutionIssues(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
    options: { normalizeCanonicalRole?: boolean } = {},
  ) {
    const normalizeCanonicalRole = options.normalizeCanonicalRole ?? true;
    await clearStaleExecutionLocksForRoutine(routine, executor);
    const view = await getRoutineExecutionView(routine, executor);
    const now = new Date();

    if (routine.concurrencyPolicy === "always_enqueue") {
      const parallelIssueIds = view.rows
        .filter((row) => row.routineIssueRole == null || row.routineIssueRole === "canonical")
        .map((row) => row.id);
      if (parallelIssueIds.length > 0) {
        await executor
          .update(issues)
          .set({
            routineIssueRole: "parallel",
            updatedAt: now,
          })
          .where(inArray(issues.id, parallelIssueIds));
      }
      if (routine.status !== "active") {
        await cancelQueuedRunsForIssueIds(
          routine.companyId,
          view.rows.map((row) => row.id),
          `Routine ${routine.id} is paused`,
          executor,
        );
        await cancelPendingWakeupsForIssueIds(
          routine.companyId,
          view.rows.map((row) => row.id),
          `Routine ${routine.id} is paused`,
          executor,
        );
      }
      return getRoutineExecutionView(routine, executor);
    }

    const canonicalIssue = view.canonicalIssueRow;
    if (!canonicalIssue) {
      if (routine.status !== "active") {
        await cancelQueuedRunsForIssueIds(
          routine.companyId,
          view.rows.map((row) => row.id),
          `Routine ${routine.id} is paused`,
          executor,
        );
        await cancelPendingWakeupsForIssueIds(
          routine.companyId,
          view.rows.map((row) => row.id),
          `Routine ${routine.id} is paused`,
          executor,
        );
      }
      return view;
    }

    if (normalizeCanonicalRole && canonicalIssue.routineIssueRole !== "canonical") {
      await executor
        .update(issues)
        .set({
          routineIssueRole: "canonical",
          updatedAt: now,
        })
        .where(eq(issues.id, canonicalIssue.id));
    }

    const nonCanonicalIssueIds = view.rows
      .filter((row) => row.id !== canonicalIssue.id)
      .map((row) => row.id);
    if (nonCanonicalIssueIds.length > 0) {
      await cancelQueuedRunsForIssueIds(
        routine.companyId,
        nonCanonicalIssueIds,
        `Routine ${routine.id} duplicate execution issue superseded`,
        executor,
      );
      await cancelPendingWakeupsForIssueIds(
        routine.companyId,
        nonCanonicalIssueIds,
        `Routine ${routine.id} duplicate execution issue superseded`,
        executor,
      );
    }

    const duplicateRows = view.rows.filter(
      (row) => row.id !== canonicalIssue.id && row.routineIssueRole !== "superseded",
    );
    if (duplicateRows.length > 0) {
      await executor
        .update(issues)
        .set({
          routineIssueRole: "superseded",
          status: "cancelled",
          cancelledAt: now,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(inArray(issues.id, duplicateRows.map((row) => row.id)));
    }

    if (routine.status !== "active") {
      await cancelQueuedRunsForIssueIds(
        routine.companyId,
        view.rows.map((row) => row.id),
        `Routine ${routine.id} is paused`,
        executor,
      );
      await cancelPendingWakeupsForIssueIds(
        routine.companyId,
        view.rows.map((row) => row.id),
        `Routine ${routine.id} is paused`,
        executor,
      );
    }

    return getRoutineExecutionView(routine, executor);
  }

  async function finalizeRun(runId: string, patch: Partial<typeof routineRuns.$inferInsert>, executor: Db = db) {
    return executor
      .update(routineRuns)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(routineRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function markPreviousBoundRoutineRunCompleted(
    issue: Pick<OpenRoutineIssueRow, "originRunId" | "routineBoundRunId">,
    nextRunId: string,
    completedAt: Date,
    executor: Db = db,
  ) {
    const previousRunId = issue.routineBoundRunId ?? issue.originRunId;
    if (!previousRunId || previousRunId === nextRunId) return;
    await executor
      .update(routineRuns)
      .set({
        completedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(routineRuns.id, previousRunId),
          isNull(routineRuns.completedAt),
        ),
      );
  }

  async function finalizeRoutineRunAsCoalesced(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    createdRun: typeof routineRuns.$inferSelect;
    triggeredAt: Date;
    status: "coalesced" | "skipped";
    issue: OpenRoutineIssueRow;
    executor: Db;
    nextRunAt?: Date | null;
  }) {
    const updated = await finalizeRun(input.createdRun.id, {
      status: input.status,
      linkedIssueId: input.issue.id,
      coalescedIntoRunId: input.issue.routineBoundRunId ?? input.issue.originRunId,
      completedAt: input.triggeredAt,
    }, input.executor);
    await updateRoutineTouchedState({
      routineId: input.routine.id,
      triggerId: input.trigger?.id ?? null,
      triggeredAt: input.triggeredAt,
      status: input.status,
      issueId: input.issue.id,
      nextRunAt: input.nextRunAt,
    }, input.executor);
    return updated ?? input.createdRun;
  }

  async function reuseCanonicalRoutineIssue(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    createdRun: typeof routineRuns.$inferSelect;
    triggeredAt: Date;
    issue: OpenRoutineIssueRow;
    executor: Db;
    nextRunAt?: Date | null;
    requestedByActorType?: "system";
  }) {
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: {
        id: input.issue.id,
        assigneeAgentId: input.routine.assigneeAgentId,
        status: input.issue.status,
      },
      reason: "issue_assigned",
      mutation: "routine_reuse",
      contextSource: "routine.dispatch",
      requestedByActorType: input.requestedByActorType,
      rethrowOnError: true,
    });

    await input.executor
      .update(issues)
      .set({
        assigneeAgentId: input.routine.assigneeAgentId,
        routineBoundRunId: input.createdRun.id,
        routineIssueRole: "canonical",
        updatedAt: new Date(),
      })
      .where(eq(issues.id, input.issue.id));

    await markPreviousBoundRoutineRunCompleted(input.issue, input.createdRun.id, input.triggeredAt, input.executor);

    const updated = await finalizeRun(input.createdRun.id, {
      status: "issue_reused",
      linkedIssueId: input.issue.id,
    }, input.executor);
    await updateRoutineTouchedState({
      routineId: input.routine.id,
      triggerId: input.trigger?.id ?? null,
      triggeredAt: input.triggeredAt,
      status: "issue_reused",
      issueId: input.issue.id,
      nextRunAt: input.nextRunAt,
    }, input.executor);
    return updated ?? input.createdRun;
  }

  async function createWebhookSecret(
    companyId: string,
    routineId: string,
    actor: Actor,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const secret = await secretsSvc.create(
      companyId,
      {
        name: `routine-${routineId}-${crypto.randomBytes(6).toString("hex")}`,
        provider: "local_encrypted",
        value: secretValue,
        description: `Webhook auth for routine ${routineId}`,
      },
      actor,
    );
    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: typeof routineTriggers.$inferSelect, companyId: string) {
    if (!trigger.secretId) throw notFound("Routine trigger secret not found");
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.companyId !== companyId) throw notFound("Routine trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest");
    return value;
  }

  async function dispatchRoutineRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    executionWorkspaceId?: string | null;
    executionWorkspacePreference?: string | null;
    executionWorkspaceSettings?: Record<string, unknown> | null;
  }) {
    const resolvedVariables = resolveRoutineVariableValues(input.routine.variables ?? [], input);
    const description = interpolateRoutineTemplate(input.routine.description, resolvedVariables);
    const triggerPayload = mergeRoutineRunPayload(input.payload, resolvedVariables);
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${asUuidParam(input.routine.id)} and ${routines.companyId} = ${asUuidParam(input.routine.companyId)} for update`,
      );

      if (input.idempotencyKey) {
        const existing = await txDb
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.companyId, input.routine.companyId),
              eq(routineRuns.routineId, input.routine.id),
              eq(routineRuns.source, input.source),
              eq(routineRuns.idempotencyKey, input.idempotencyKey),
              input.trigger ? eq(routineRuns.triggerId, input.trigger.id) : isNull(routineRuns.triggerId),
            ),
          )
          .orderBy(desc(routineRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return existing;
      }

      const triggeredAt = new Date();
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload,
        })
        .returning();

      const nextRunAt = input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
        ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, triggeredAt)
        : undefined;

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      try {
        const executionView = await reconcileRoutineExecutionIssues(input.routine, db, {
          normalizeCanonicalRole: false,
        });
        if (executionView.liveIssueRow && input.routine.concurrencyPolicy !== "always_enqueue") {
          const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          return await finalizeRoutineRunAsCoalesced({
            routine: input.routine,
            trigger: input.trigger,
            createdRun,
            triggeredAt,
            status,
            issue: executionView.liveIssueRow,
            executor: txDb,
            nextRunAt,
          });
        }
        if (executionView.canonicalIssueRow && input.routine.concurrencyPolicy !== "always_enqueue") {
          return await reuseCanonicalRoutineIssue({
            routine: input.routine,
            trigger: input.trigger,
            createdRun,
            triggeredAt,
            issue: executionView.canonicalIssueRow,
            executor: txDb,
            nextRunAt,
            requestedByActorType: input.source === "schedule" ? "system" : undefined,
          });
        }

        try {
          createdIssue = await issueSvc.create(input.routine.companyId, {
            projectId: input.routine.projectId,
            goalId: input.routine.goalId,
            parentId: input.routine.parentIssueId,
            title: input.routine.title,
            description,
            status: "todo",
            priority: input.routine.priority,
            assigneeAgentId: input.routine.assigneeAgentId,
            originKind: "routine_execution",
            originId: input.routine.id,
            originRunId: createdRun.id,
            routineBoundRunId: createdRun.id,
            routineIssueRole: input.routine.concurrencyPolicy === "always_enqueue" ? "parallel" : "canonical",
            executionWorkspaceId: input.executionWorkspaceId ?? null,
            executionWorkspacePreference: input.executionWorkspacePreference ?? null,
            executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
          });
        } catch (error) {
          const isOpenExecutionConflict =
            !!error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "23505" &&
            "constraint" in error &&
            (error as { constraint?: string }).constraint === "issues_open_routine_execution_uq";
          if (!isOpenExecutionConflict || input.routine.concurrencyPolicy === "always_enqueue") {
            throw error;
          }

          const refreshedView = await reconcileRoutineExecutionIssues(input.routine, db, {
            normalizeCanonicalRole: false,
          });
          if (refreshedView.liveIssueRow) {
            const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
            return await finalizeRoutineRunAsCoalesced({
              routine: input.routine,
              trigger: input.trigger,
              createdRun,
              triggeredAt,
              status,
              issue: refreshedView.liveIssueRow,
              executor: txDb,
              nextRunAt,
            });
          }
          if (refreshedView.canonicalIssueRow) {
            return await reuseCanonicalRoutineIssue({
              routine: input.routine,
              trigger: input.trigger,
              createdRun,
              triggeredAt,
              issue: refreshedView.canonicalIssueRow,
              executor: txDb,
              nextRunAt,
              requestedByActorType: input.source === "schedule" ? "system" : undefined,
            });
          }
          throw error;
        }

        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "routine.dispatch",
          requestedByActorType: input.source === "schedule" ? "system" : undefined,
          rethrowOnError: true,
        });
        const updated = await finalizeRun(createdRun.id, {
          status: "issue_created",
          linkedIssueId: createdIssue.id,
        }, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "issue_created",
          issueId: createdIssue.id,
          nextRunAt,
        }, txDb);
        return updated ?? createdRun;
      } catch (error) {
        if (createdIssue) {
          await txDb.delete(issues).where(eq(issues.id, createdIssue.id));
        }
        const failureReason = error instanceof Error ? error.message : String(error);
        const failed = await finalizeRun(createdRun.id, {
          status: "failed",
          failureReason,
          completedAt: new Date(),
        }, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "failed",
          nextRunAt,
        }, txDb);
        return failed ?? createdRun;
      }
    });

    if (input.source === "schedule" || input.source === "webhook") {
      const actorId = input.source === "schedule" ? "routine-scheduler" : "routine-webhook";
      try {
        await logActivity(db, {
          companyId: input.routine.companyId,
          actorType: "system",
          actorId,
          action: "routine.run_triggered",
          entityType: "routine_run",
          entityId: run.id,
          details: {
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            source: run.source,
            status: run.status,
          },
        });
      } catch (err) {
        logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log automated routine run");
      }
    }

    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackRoutineRun(telemetryClient, {
        source: run.source,
        status: run.status,
      });
    }

    return run;
  }

  return {
    get: getRoutineById,
    getTrigger: getTriggerById,

    list: async (companyId: string): Promise<RoutineListItem[]> => {
      const rows = await db
        .select()
        .from(routines)
        .where(eq(routines.companyId, companyId))
        .orderBy(desc(routines.updatedAt), asc(routines.title));
      const routineIds = rows.map((row) => row.id);
      const [triggersByRoutine, latestRunByRoutine, executionViewByRoutine] = await Promise.all([
        listTriggersForRoutineIds(companyId, routineIds),
        listLatestRunByRoutineIds(companyId, routineIds),
        listRoutineExecutionViewByRoutineIds(rows),
      ]);
      return rows.map((row) => ({
        ...row,
        triggers: (triggersByRoutine.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind as RoutineListItem["triggers"][number]["kind"],
          label: trigger.label,
          enabled: trigger.enabled,
          nextRunAt: trigger.nextRunAt,
          lastFiredAt: trigger.lastFiredAt,
          lastResult: trigger.lastResult,
        })),
        lastRun: latestRunByRoutine.get(row.id) ?? null,
        canonicalIssue: executionViewByRoutine.get(row.id)?.canonicalIssue ?? null,
        liveIssue: executionViewByRoutine.get(row.id)?.liveIssue ?? null,
        executionState: executionViewByRoutine.get(row.id)?.executionState ?? "none",
        activeIssue: executionViewByRoutine.get(row.id)?.activeIssue ?? null,
      }));
    },

    getDetail: async (id: string): Promise<RoutineDetail | null> => {
      const row = await getRoutineById(id);
      if (!row) return null;
      const [project, assignee, parentIssueRaw, triggers, recentRuns, executionView] = await Promise.all([
        db.select().from(projects).where(eq(projects.id, row.projectId)).then((rows) => rows[0] ?? null),
        db.select().from(agents).where(eq(agents.id, row.assigneeAgentId)).then((rows) => rows[0] ?? null),
        row.parentIssueId ? issueSvc.getById(row.parentIssueId) : null,
        db.select().from(routineTriggers).where(eq(routineTriggers.routineId, row.id)).orderBy(asc(routineTriggers.createdAt)),
        db
          .select({
            id: routineRuns.id,
            companyId: routineRuns.companyId,
            routineId: routineRuns.routineId,
            triggerId: routineRuns.triggerId,
            source: routineRuns.source,
            status: routineRuns.status,
            triggeredAt: routineRuns.triggeredAt,
            idempotencyKey: routineRuns.idempotencyKey,
            triggerPayload: routineRuns.triggerPayload,
            linkedIssueId: routineRuns.linkedIssueId,
            coalescedIntoRunId: routineRuns.coalescedIntoRunId,
            failureReason: routineRuns.failureReason,
            completedAt: routineRuns.completedAt,
            createdAt: routineRuns.createdAt,
            updatedAt: routineRuns.updatedAt,
            triggerKind: routineTriggers.kind,
            triggerLabel: routineTriggers.label,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueStatus: issues.status,
            issuePriority: issues.priority,
            issueUpdatedAt: issues.updatedAt,
          })
          .from(routineRuns)
          .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
          .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
          .where(eq(routineRuns.routineId, row.id))
          .orderBy(desc(routineRuns.createdAt))
          .limit(25)
          .then((runs) =>
            runs.map((run) => ({
              id: run.id,
              companyId: run.companyId,
              routineId: run.routineId,
              triggerId: run.triggerId,
              source: run.source as RoutineRunSummary["source"],
              status: run.status as RoutineRunSummary["status"],
              triggeredAt: run.triggeredAt,
              idempotencyKey: run.idempotencyKey,
              triggerPayload: run.triggerPayload as Record<string, unknown> | null,
              linkedIssueId: run.linkedIssueId,
              coalescedIntoRunId: run.coalescedIntoRunId,
              failureReason: run.failureReason,
              completedAt: run.completedAt,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              linkedIssue: run.linkedIssueId
                ? {
                  id: run.linkedIssueId,
                  identifier: run.issueIdentifier,
                  title: run.issueTitle ?? "Routine execution",
                  status: run.issueStatus ?? "todo",
                  priority: run.issuePriority ?? "medium",
                  updatedAt: run.issueUpdatedAt ?? run.updatedAt,
                  role: null,
                }
                : null,
              trigger: run.triggerId
                ? {
                  id: run.triggerId,
                  kind: run.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
                  label: run.triggerLabel,
                }
                : null,
            })),
          ),
        getRoutineExecutionView(row),
      ]);
      const parentIssue = parentIssueRaw
        ? {
          id: parentIssueRaw.id,
          identifier: parentIssueRaw.identifier ?? null,
          title: parentIssueRaw.title,
          status: parentIssueRaw.status,
          priority: parentIssueRaw.priority,
          updatedAt: parentIssueRaw.updatedAt,
          role: (parentIssueRaw.routineIssueRole ?? null) as RoutineIssueSummary["role"],
        }
        : null;

      return {
        ...row,
        project,
        assignee,
        parentIssue,
        triggers: triggers as RoutineTrigger[],
        recentRuns,
        canonicalIssue: executionView.canonicalIssue,
        liveIssue: executionView.liveIssue,
        executionState: executionView.executionState,
        activeIssue: executionView.activeIssue,
      };
    },

    create: async (companyId: string, input: CreateRoutine, actor: Actor): Promise<Routine> => {
      await assertProject(companyId, input.projectId);
      await assertAssignableAgent(companyId, input.assigneeAgentId);
      if (input.goalId) await assertGoal(companyId, input.goalId);
      if (input.parentIssueId) await assertParentIssue(companyId, input.parentIssueId);
      const priority = normalizeIssuePriority(input.priority ?? null) ?? input.priority;
      const variables = syncRoutineVariablesWithTemplate(
        input.description,
        sanitizeRoutineVariableInputs(input.variables),
      );
      assertRoutineVariableDefinitions(variables);
      const [created] = await db
        .insert(routines)
        .values({
          companyId,
          projectId: input.projectId,
          goalId: input.goalId ?? null,
          parentIssueId: input.parentIssueId ?? null,
          title: input.title,
          description: input.description ?? null,
          assigneeAgentId: input.assigneeAgentId,
          priority,
          status: input.status,
          concurrencyPolicy: input.concurrencyPolicy,
          catchUpPolicy: input.catchUpPolicy,
          variables,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();
      return created;
    },

    update: async (id: string, patch: UpdateRoutine, actor: Actor): Promise<Routine | null> => {
      const existing = await getRoutineById(id);
      if (!existing) return null;
      const nextProjectId = patch.projectId ?? existing.projectId;
      const nextAssigneeAgentId = patch.assigneeAgentId ?? existing.assigneeAgentId;
      const nextDescription = patch.description === undefined ? existing.description : patch.description;
      const nextPriority = normalizeIssuePriority(patch.priority ?? null) ?? patch.priority ?? existing.priority;
      const nextVariables = syncRoutineVariablesWithTemplate(
        nextDescription,
        patch.variables === undefined ? existing.variables : sanitizeRoutineVariableInputs(patch.variables),
      );
      if (patch.projectId) await assertProject(existing.companyId, nextProjectId);
      if (patch.assigneeAgentId) await assertAssignableAgent(existing.companyId, nextAssigneeAgentId);
      if (patch.goalId) await assertGoal(existing.companyId, patch.goalId);
      if (patch.parentIssueId) await assertParentIssue(existing.companyId, patch.parentIssueId);
      assertRoutineVariableDefinitions(nextVariables);
      const enabledScheduleTriggers = await db
        .select({ id: routineTriggers.id })
        .from(routineTriggers)
        .where(
          and(
            eq(routineTriggers.routineId, existing.id),
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
          ),
        )
        .limit(1)
        .then((rows) => rows.length > 0);
      if (enabledScheduleTriggers) {
        assertScheduleCompatibleVariables(nextVariables);
      }
      const [updated] = await db
        .update(routines)
        .set({
          projectId: nextProjectId,
          goalId: patch.goalId === undefined ? existing.goalId : patch.goalId,
          parentIssueId: patch.parentIssueId === undefined ? existing.parentIssueId : patch.parentIssueId,
          title: patch.title ?? existing.title,
          description: nextDescription,
          assigneeAgentId: nextAssigneeAgentId,
          priority: nextPriority,
          status: patch.status ?? existing.status,
          concurrencyPolicy: patch.concurrencyPolicy ?? existing.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? existing.catchUpPolicy,
          variables: nextVariables,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(routines.id, id))
        .returning();
      if (!updated) return null;
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await reconcileRoutineExecutionIssues(updated, txDb);
      });
      return updated;
    },

    createTrigger: async (
      routineId: string,
      input: CreateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial | null }> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");

      let secretMaterial: RoutineTriggerSecretMaterial | null = null;
      let secretId: string | null = null;
      let publicId: string | null = null;
      let nextRunAt: Date | null = null;

      if (input.kind === "schedule") {
        assertScheduleCompatibleVariables(routine.variables ?? []);
        const timeZone = input.timezone || "UTC";
        assertTimeZone(timeZone);
        const error = validateCron(input.cronExpression);
        if (error) throw unprocessable(error);
        nextRunAt = nextCronTickInTimeZone(input.cronExpression, timeZone, new Date());
      }

      if (input.kind === "webhook") {
        publicId = crypto.randomBytes(12).toString("hex");
        const created = await createWebhookSecret(routine.companyId, routine.id, actor);
        secretId = created.secret.id;
        secretMaterial = {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
          webhookSecret: created.secretValue,
        };
      }

      const [trigger] = await db
        .insert(routineTriggers)
        .values({
          companyId: routine.companyId,
          routineId: routine.id,
          kind: input.kind,
          label: input.label ?? null,
          enabled: input.enabled ?? true,
          cronExpression: input.kind === "schedule" ? input.cronExpression : null,
          timezone: input.kind === "schedule" ? (input.timezone || "UTC") : null,
          nextRunAt,
          publicId,
          secretId,
          signingMode: input.kind === "webhook" ? input.signingMode : null,
          replayWindowSec: input.kind === "webhook" ? input.replayWindowSec : null,
          lastRotatedAt: input.kind === "webhook" ? new Date() : null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial,
      };
    },

    updateTrigger: async (id: string, patch: UpdateRoutineTrigger, actor: Actor): Promise<RoutineTrigger | null> => {
      const existing = await getTriggerById(id);
      if (!existing) return null;

      let nextRunAt = existing.nextRunAt;
      let cronExpression = existing.cronExpression;
      let timezone = existing.timezone;

      if (existing.kind === "schedule") {
        const routine = await getRoutineById(existing.routineId);
        if (!routine) throw notFound("Routine not found");
        if (patch.cronExpression !== undefined) {
          if (patch.cronExpression == null) throw unprocessable("Scheduled triggers require cronExpression");
          const error = validateCron(patch.cronExpression);
          if (error) throw unprocessable(error);
          cronExpression = patch.cronExpression;
        }
        if (patch.timezone !== undefined) {
          if (patch.timezone == null) throw unprocessable("Scheduled triggers require timezone");
          assertTimeZone(patch.timezone);
          timezone = patch.timezone;
        }
        if (cronExpression && timezone) {
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
        if ((patch.enabled ?? existing.enabled) === true) {
          assertScheduleCompatibleVariables(routine.variables ?? []);
        }
      }

      const [updated] = await db
        .update(routineTriggers)
        .set({
          label: patch.label === undefined ? existing.label : patch.label,
          enabled: patch.enabled ?? existing.enabled,
          cronExpression,
          timezone,
          nextRunAt,
          signingMode: patch.signingMode === undefined ? existing.signingMode : patch.signingMode,
          replayWindowSec: patch.replayWindowSec === undefined ? existing.replayWindowSec : patch.replayWindowSec,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, id))
        .returning();

      return (updated as RoutineTrigger | undefined) ?? null;
    },

    deleteTrigger: async (id: string): Promise<boolean> => {
      const existing = await getTriggerById(id);
      if (!existing) return false;
      await db.delete(routineTriggers).where(eq(routineTriggers.id, id));
      return true;
    },

    delete: async (id: string): Promise<boolean> => {
      const routine = await getRoutineById(id);
      if (!routine) return false;
      const executionView = await getRoutineExecutionView(routine);
      if (executionView.liveIssueRow) {
        throw conflict("Routine has an active execution run and cannot be deleted");
      }
      await db.delete(routines).where(eq(routines.id, id));
      return true;
    },

    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial }> => {
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Routine trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, actor);
      const [updated] = await db
        .update(routineTriggers)
        .set({
          lastRotatedAt: new Date(),
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, id))
        .returning();

      return {
        trigger: updated as RoutineTrigger,
        secretMaterial: {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${existing.publicId}/fire`,
          webhookSecret: secretValue,
        },
      };
    },

    runRoutine: async (id: string, input: RunRoutine) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      if (routine.status === "paused") throw conflict("Routine is paused");
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.routineId !== routine.id) throw forbidden("Trigger does not belong to routine");
      if (trigger && !trigger.enabled) throw conflict("Routine trigger is not active");
      return dispatchRoutineRun({
        routine,
        trigger,
        source: input.source,
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        idempotencyKey: input.idempotencyKey,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
        executionWorkspaceSettings:
          (input.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null,
      });
    },

    firePublicTrigger: async (publicId: string, input: {
      authorizationHeader?: string | null;
      signatureHeader?: string | null;
      hubSignatureHeader?: string | null;
      timestampHeader?: string | null;
      idempotencyKey?: string | null;
      rawBody?: Buffer | null;
      payload?: Record<string, unknown> | null;
    }) => {
      const trigger = await db
        .select()
        .from(routineTriggers)
        .where(and(eq(routineTriggers.publicId, publicId), eq(routineTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Routine trigger not found");
      const routine = await getRoutineById(trigger.routineId);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "paused") throw conflict("Routine is paused");
      if (!trigger.enabled || routine.status !== "active") throw conflict("Routine trigger is not active");

      if (trigger.signingMode === "none") {
        // No authentication — the publicId in the URL acts as a shared secret.
      } else if (trigger.signingMode === "github_hmac") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        // Accept X-Hub-Signature-256 (GitHub/Sentry) or fall back to the
        // generic X-PrivateClip-Signature header so operators can use github_hmac
        // mode with either header convention.
        const providedSignature = (input.hubSignatureHeader ?? input.signatureHeader)?.trim() ?? "";
        if (!providedSignature) throw unauthorized();
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const normalizedBuf = Buffer.from(normalizedSignature);
        const expectedBuf = Buffer.from(expectedHmac);
        const valid =
          normalizedBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(normalizedBuf, expectedBuf);
        if (!valid) throw unauthorized();
      } else if (trigger.signingMode === "bearer") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const expected = `Bearer ${secretValue}`;
        const provided = input.authorizationHeader?.trim() ?? "";
        const expectedBuf = Buffer.from(expected);
        const providedBuf = Buffer.alloc(expectedBuf.length);
        providedBuf.write(provided.slice(0, expectedBuf.length));
        const valid =
          provided.length === expected.length &&
          crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
          throw unauthorized();
        }
      } else {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader?.trim() ?? "";
        const providedTimestamp = input.timestampHeader?.trim() ?? "";
        if (!providedSignature || !providedTimestamp) throw unauthorized();
        const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
        if (tsMillis == null) throw unauthorized();
        const replayWindowSec = trigger.replayWindowSec ?? 300;
        if (Math.abs(Date.now() - tsMillis) > replayWindowSec * 1000) {
          throw unauthorized();
        }
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(`${providedTimestamp}.`)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const valid =
          normalizedSignature.length === expectedHmac.length &&
          crypto.timingSafeEqual(Buffer.from(normalizedSignature), Buffer.from(expectedHmac));
        if (!valid) throw unauthorized();
      }

      return dispatchRoutineRun({
        routine,
        trigger,
        source: "webhook",
        payload: input.payload,
        variables: isPlainRecord(input.payload) && isPlainRecord(input.payload.variables)
          ? input.payload.variables
          : null,
        idempotencyKey: input.idempotencyKey,
      });
    },

    listRuns: async (routineId: string, limit = 50): Promise<RoutineRunSummary[]> => {
      const cappedLimit = Math.max(1, Math.min(limit, 200));
      const rows = await db
        .select({
          id: routineRuns.id,
          companyId: routineRuns.companyId,
          routineId: routineRuns.routineId,
          triggerId: routineRuns.triggerId,
          source: routineRuns.source,
          status: routineRuns.status,
          triggeredAt: routineRuns.triggeredAt,
          idempotencyKey: routineRuns.idempotencyKey,
          triggerPayload: routineRuns.triggerPayload,
          linkedIssueId: routineRuns.linkedIssueId,
          coalescedIntoRunId: routineRuns.coalescedIntoRunId,
          failureReason: routineRuns.failureReason,
          completedAt: routineRuns.completedAt,
          createdAt: routineRuns.createdAt,
          updatedAt: routineRuns.updatedAt,
          triggerKind: routineTriggers.kind,
          triggerLabel: routineTriggers.label,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          issuePriority: issues.priority,
          issueUpdatedAt: issues.updatedAt,
        })
        .from(routineRuns)
        .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
        .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
        .where(eq(routineRuns.routineId, routineId))
        .orderBy(desc(routineRuns.createdAt))
        .limit(cappedLimit);

      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
            role: null,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      }));
    },

    inspectExecutionState: async (
      input: { companyId?: string | null; routineId?: string | null } = {},
    ): Promise<RoutineExecutionRepairInspection> => {
      const routineRows = await listRoutinesForExecutionRepair(input);
      const candidates = await Promise.all(
        routineRows.map((routine) => inspectRoutineExecutionRepairCandidate(routine)),
      );
      return summarizeRoutineExecutionRepairInspection(candidates);
    },

    reconcileExecutionState: async (
      input: { companyId?: string | null; routineId?: string | null } = {},
    ): Promise<RoutineExecutionRepairSummary> => {
      const routineRows = await listRoutinesForExecutionRepair(input);
      let routinesReconciled = 0;
      let staleExecutionLocksCleared = 0;
      let canonicalRolesUpdated = 0;
      let parallelRolesUpdated = 0;
      let duplicateIssuesSuperseded = 0;
      let wakeupsCancelled = 0;
      let queuedRunsCancelled = 0;

      for (const routine of routineRows) {
        const inspection = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          const currentRoutine = await txDb
            .select()
            .from(routines)
            .where(eq(routines.id, routine.id))
            .then((rows) => rows[0] ?? null);
          if (!currentRoutine) return null;
          const currentInspection = await inspectRoutineExecutionRepairCandidate(currentRoutine, txDb);
          if (
            currentInspection.staleExecutionLockIssueIds.length === 0 &&
            currentInspection.issueIdsToCanonicalize.length === 0 &&
            currentInspection.issueIdsToParallelize.length === 0 &&
            currentInspection.duplicateIssueIds.length === 0 &&
            currentInspection.wakeupIdsToCancel.length === 0 &&
            currentInspection.queuedRunIdsToCancel.length === 0
          ) {
            return currentInspection;
          }
          await reconcileRoutineExecutionIssues(currentRoutine, txDb);
          return currentInspection;
        });
        if (!inspection) continue;

        const changed =
          inspection.staleExecutionLockIssueIds.length > 0 ||
          inspection.issueIdsToCanonicalize.length > 0 ||
          inspection.issueIdsToParallelize.length > 0 ||
          inspection.duplicateIssueIds.length > 0 ||
          inspection.wakeupIdsToCancel.length > 0 ||
          inspection.queuedRunIdsToCancel.length > 0;
        if (!changed) continue;

        routinesReconciled += 1;
        staleExecutionLocksCleared += inspection.staleExecutionLockIssueIds.length;
        canonicalRolesUpdated += inspection.issueIdsToCanonicalize.length;
        parallelRolesUpdated += inspection.issueIdsToParallelize.length;
        duplicateIssuesSuperseded += inspection.duplicateIssueIds.length;
        wakeupsCancelled += inspection.wakeupIdsToCancel.length;
        queuedRunsCancelled += inspection.queuedRunIdsToCancel.length;
      }

      return {
        routinesInspected: routineRows.length,
        routinesReconciled,
        staleExecutionLocksCleared,
        canonicalRolesUpdated,
        parallelRolesUpdated,
        duplicateIssuesSuperseded,
        wakeupsCancelled,
        queuedRunsCancelled,
      };
    },

    tickScheduledTriggers: async (now: Date = new Date()) => {
      const due = await db
        .select({
          trigger: routineTriggers,
          routine: routines,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .where(
          and(
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
            eq(routines.status, "active"),
            isNotNull(routineTriggers.nextRunAt),
            lte(routineTriggers.nextRunAt, now),
          ),
        )
        .orderBy(asc(routineTriggers.nextRunAt), asc(routineTriggers.createdAt));

      let triggered = 0;
      for (const row of due) {
        if (!row.trigger.nextRunAt || !row.trigger.cronExpression || !row.trigger.timezone) continue;

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (row.routine.catchUpPolicy === "enqueue_missed_with_cap") {
          let cursor: Date | null = row.trigger.nextRunAt;
          runCount = 0;
          while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
            runCount += 1;
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, cursor);
            cursor = claimedNextRunAt;
          }
        }

        const claimed = await db
          .update(routineTriggers)
          .set({
            nextRunAt: claimedNextRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routineTriggers.id, row.trigger.id),
              eq(routineTriggers.enabled, true),
              eq(routineTriggers.nextRunAt, row.trigger.nextRunAt),
            ),
          )
          .returning({ id: routineTriggers.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        for (let i = 0; i < runCount; i += 1) {
          await dispatchRoutineRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
          });
          triggered += 1;
        }
      }

      return { triggered };
    },

    syncRunStatusForIssue: async (issueId: string) => {
      const issue = await db
        .select({
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originRunId: issues.originRunId,
          routineBoundRunId: issues.routineBoundRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      const boundRunId = issue?.routineBoundRunId ?? issue?.originRunId ?? null;
      if (!issue || issue.originKind !== "routine_execution" || !boundRunId) return null;
      if (issue.status === "done") {
        return finalizeRun(boundRunId, {
          status: "completed",
          completedAt: new Date(),
        });
      }
      if (issue.status === "blocked" || issue.status === "cancelled") {
        return finalizeRun(boundRunId, {
          status: "failed",
          failureReason: `Execution issue moved to ${issue.status}`,
          completedAt: new Date(),
        });
      }
      return null;
    },
  };
}
