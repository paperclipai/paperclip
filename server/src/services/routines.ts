import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, not, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  activityLog,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  documentRevisions,
  documents,
  executionWorkspaces,
  folders,
  goals,
  heartbeatRuns,
  issueInboxArchives,
  issueReadStates,
  issueRecoveryActions,
  issues,
  pluginManagedResources,
  plugins,
  projects,
  routineRevisions,
  routineRuns,
  routineDocuments,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type {
  CreateRoutine,
  CreateRoutineTrigger,
  Routine,
  RoutineDetail,
  RoutineDescriptionDocument,
  RoutineListItem,
  RoutineManagedByPlugin,
  RoutineRevision,
  RoutineRevisionSnapshotV1,
  RoutineRunSummary,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
  RoutineVariable,
  RunRoutine,
  UpdateRoutine,
  UpdateRoutineTrigger,
} from "@paperclipai/shared";
import {
  WORKSPACE_BRANCH_ROUTINE_VARIABLE,
  getBuiltinRoutineVariableValues,
  extractRoutineVariableNames,
  interpolateRoutineTemplate,
  isValidRoutineDateString,
  pluginOperationIssueOriginKind,
  routineRevisionSnapshotSchema,
  stringifyRoutineVariableValue,
  syncRoutineVariablesWithTemplate,
} from "@paperclipai/shared";
import { trackRoutineRun } from "@paperclipai/shared/telemetry";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { issueService } from "./issues.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { secretService } from "./secrets.js";
import { parseCron, validateCron } from "./cron.js";
import { heartbeatService } from "./heartbeat.js";
import {
  instanceSettingsService,
  isTruthyRuntimeEnvValue,
  resolveWorktreeRunExecutionActivationState,
  type WorktreeRunExecutionActivationState,
} from "./instance-settings.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const MAX_CATCH_UP_RUNS = 25;
const MAX_ROUTINE_REVISIONS = 100;
const ACTIVITY_GATE_IGNORED_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
  "issue.inbox_touched",
];
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type RoutineRecoveryMutationAuthorization = {
  actorType: "agent" | "board";
  actionId: string;
  attemptCount: number;
  recoveryIssueId: string;
  terminatedAgentId: string;
  ownerAgentId: string | null;
  runId: string | null;
  routineIds: string[];
  triggerIds: string[];
};

type Actor = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
  routineRecoveryAuthorization?: RoutineRecoveryMutationAuthorization | null;
};
type RoutineRow = typeof routines.$inferSelect;
type RoutineTriggerRow = typeof routineTriggers.$inferSelect;

export function routineRecoveryTriggerDispositionMarker(
  authorization: Pick<RoutineRecoveryMutationAuthorization, "actionId" | "attemptCount">,
  triggerId: string,
  enabled: boolean,
) {
  return [
    "paperclip-recovery-trigger-disposition",
    authorization.actionId,
    authorization.attemptCount,
    triggerId,
    enabled ? "enabled" : "disabled",
  ].join(":");
}

async function resolveCompanyDefaultResponsibleUserId(db: Db, companyId: string) {
  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (company?.defaultResponsibleUserId) return company.defaultResponsibleUserId;

  const owner = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        eq(companyMemberships.membershipRole, "owner"),
      ),
    )
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return owner?.userId ?? null;
}

async function resolveRoutineResponsibleUserId(db: Db, companyId: string, actorUserId: string | null | undefined, parentIssueId?: string | null) {
  if (actorUserId) return actorUserId;
  if (parentIssueId) {
    const parent = await db
      .select({ responsibleUserId: issues.responsibleUserId, createdByUserId: issues.createdByUserId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, parentIssueId)))
      .then((rows) => rows[0] ?? null);
    if (parent?.responsibleUserId) return parent.responsibleUserId;
    if (parent?.createdByUserId) return parent.createdByUserId;
  }
  return resolveCompanyDefaultResponsibleUserId(db, companyId);
}

const ROUTINE_DESCRIPTION_DOCUMENT_KEY = "description" as const;

interface RoutineTriggerSecretRestoreMaterial extends RoutineTriggerSecretMaterial {
  triggerId: string;
}

function routineWebhookSecretConfigPath(secretId: string) {
  return `webhookSecret:${secretId}`;
}

function assertTimeZone(timeZone: string) {
  try {
    getZonedMinuteFormatter(timeZone).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

// Constructing an Intl.DateTimeFormat costs ~1ms of ICU work, and
// computeNextRun calls getZonedMinuteParts once per minute-step (up to
// 366*24*60*5 iterations for sparse schedules), which can block the event
// loop for minutes per scheduler tick. Formatter instances are immutable,
// so cache one per timezone. See #8033.
const zonedMinuteFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedMinuteFormatter(timeZone: string) {
  let formatter = zonedMinuteFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    zonedMinuteFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getZonedMinuteParts(date: Date, timeZone: string) {
  const formatter = getZonedMinuteFormatter(timeZone);
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

export function nextCronTickInTimeZone(expression: string, timeZone: string, after: Date) {
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

function isSubHourlyCronExpression(expression: string, timeZone: string, after: Date) {
  const firstTick = nextCronTickInTimeZone(expression, timeZone, after);
  if (!firstTick) return false;

  const windowEnd = firstTick.getTime() + 24 * 60 * 60 * 1000;
  let occurrenceCount = 1;
  let cursor = firstTick;
  while (occurrenceCount <= 24) {
    const nextTick = nextCronTickInTimeZone(expression, timeZone, cursor);
    if (!nextTick || nextTick.getTime() >= windowEnd) return false;
    occurrenceCount += 1;
    cursor = nextTick;
  }
  return true;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created" && issueId) return `Created execution issue ${issueId}`;
  if (status === "coalesced") return "Coalesced into an existing live execution issue";
  if (status === "skipped_paused") return "Skipped because the project is paused";
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

function parseDateVariableValue(name: string, raw: unknown) {
  if (typeof raw !== "string") {
    throw unprocessable(`Variable "${name}" must be a YYYY-MM-DD date`);
  }
  const normalized = raw.trim();
  if (!isValidRoutineDateString(normalized)) {
    throw unprocessable(`Variable "${name}" must be a valid YYYY-MM-DD date`);
  }
  return normalized;
}

function normalizeRoutineVariableValue(variable: RoutineVariable, raw: unknown): string | number | boolean | null {
  if (raw == null) return null;
  if (variable.type === "boolean") return parseBooleanVariableValue(variable.name, raw);
  if (variable.type === "number") return parseNumberVariableValue(variable.name, raw);
  if (variable.type === "date") return parseDateVariableValue(variable.name, raw);

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

function statusRequiresDefaultAgent(status: string) {
  return status === "active";
}

function normalizeDraftRoutineStatus(status: string, assigneeAgentId: string | null | undefined) {
  if (statusRequiresDefaultAgent(status) && !assigneeAgentId) {
    return "paused";
  }
  return status;
}

function assertRoutineCanEnable(status: string, assigneeAgentId: string | null | undefined) {
  if (statusRequiresDefaultAgent(status) && !assigneeAgentId) {
    throw unprocessable("Default agent required");
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
    automaticVariables?: Record<string, string | number | boolean>;
  },
) {
  if (variables.length === 0) return {} as Record<string, string | number | boolean>;
  const provided = collectProvidedRoutineVariables(input.source, input.payload, input.variables);
  const automaticVariables = input.automaticVariables ?? {};
  const resolved: Record<string, string | number | boolean> = {};
  const missing: string[] = [];

  for (const variable of variables) {
    // Workspace-derived automatic values are authoritative for variables that
    // Paperclip manages from execution context, so callers cannot override them.
    const candidate = automaticVariables[variable.name] !== undefined
      ? automaticVariables[variable.name]
      : provided[variable.name] !== undefined
        ? provided[variable.name]
        : variable.defaultValue;
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

function normalizeRoutineDispatchFingerprintValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeRoutineDispatchFingerprintValue(item));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeRoutineDispatchFingerprintValue(value[key])]),
    );
  }
  return String(value);
}

function createRoutineDispatchFingerprint(input: {
  payload: Record<string, unknown> | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  assigneeAgentId: string | null;
  routineRevisionId: string | null;
  routineEnvFingerprint: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: Record<string, unknown> | null;
  title: string;
  description: string | null;
}) {
  const canonical = JSON.stringify(normalizeRoutineDispatchFingerprintValue(input));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function createRoutineEnvFingerprint(env: unknown) {
  const canonical = JSON.stringify(normalizeRoutineDispatchFingerprintValue(env ?? null));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function readManagedRoutineIssueTemplate(defaultsJson: Record<string, unknown> | null | undefined) {
  const value = defaultsJson?.issueTemplate;
  if (!isPlainRecord(value)) return null;
  return {
    surfaceVisibility: typeof value.surfaceVisibility === "string" ? value.surfaceVisibility : null,
    originId: typeof value.originId === "string" && value.originId.trim() ? value.originId.trim() : null,
    billingCode: typeof value.billingCode === "string" && value.billingCode.trim() ? value.billingCode.trim() : null,
  };
}

function routineUsesWorkspaceBranch(routine: typeof routines.$inferSelect) {
  return (routine.variables ?? []).some((variable) => variable.name === WORKSPACE_BRANCH_ROUTINE_VARIABLE)
    || extractRoutineVariableNames([routine.title, routine.description]).includes(WORKSPACE_BRANCH_ROUTINE_VARIABLE);
}

function routineRevisionSnapshotRoutine(routine: RoutineRow): RoutineRevisionSnapshotV1["routine"] {
  return {
    id: routine.id,
    companyId: routine.companyId,
    projectId: routine.projectId,
    goalId: routine.goalId,
    parentIssueId: routine.parentIssueId,
    title: routine.title,
    description: routine.description,
    assigneeAgentId: routine.assigneeAgentId,
    priority: routine.priority as RoutineRevisionSnapshotV1["routine"]["priority"],
    status: routine.status as RoutineRevisionSnapshotV1["routine"]["status"],
    concurrencyPolicy: routine.concurrencyPolicy as RoutineRevisionSnapshotV1["routine"]["concurrencyPolicy"],
    catchUpPolicy: routine.catchUpPolicy as RoutineRevisionSnapshotV1["routine"]["catchUpPolicy"],
    activityGatePolicy: routine.activityGatePolicy as RoutineRevisionSnapshotV1["routine"]["activityGatePolicy"],
    activityGateScope: routine.activityGateScope as RoutineRevisionSnapshotV1["routine"]["activityGateScope"],
    variables: routine.variables ?? [],
    env: routine.env ?? null,
    responsibleUserId: routine.responsibleUserId ?? null,
  };
}

function routineRevisionSnapshotTrigger(trigger: RoutineTriggerRow): RoutineRevisionSnapshotV1["triggers"][number] {
  return {
    id: trigger.id,
    kind: trigger.kind as RoutineRevisionSnapshotV1["triggers"][number]["kind"],
    label: trigger.label,
    enabled: trigger.enabled,
    cronExpression: trigger.cronExpression,
    timezone: trigger.timezone,
    publicId: trigger.publicId,
    signingMode: trigger.signingMode as RoutineRevisionSnapshotV1["triggers"][number]["signingMode"],
    replayWindowSec: trigger.replayWindowSec,
  };
}

async function buildRoutineRevisionSnapshot(
  executor: Db,
  routine: RoutineRow,
): Promise<RoutineRevisionSnapshotV1> {
  const triggers = await executor
    .select()
    .from(routineTriggers)
    .where(and(eq(routineTriggers.companyId, routine.companyId), eq(routineTriggers.routineId, routine.id)))
    .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));

  return {
    version: 1,
    routine: routineRevisionSnapshotRoutine(routine),
    triggers: triggers.map(routineRevisionSnapshotTrigger),
  };
}

function canonicalSnapshot(value: RoutineRevisionSnapshotV1) {
  return JSON.stringify(value);
}

function snapshotsMatch(left: RoutineRevisionSnapshotV1, right: RoutineRevisionSnapshotV1) {
  return canonicalSnapshot(left) === canonicalSnapshot(right);
}

function routineCurrentFieldsMatch(left: RoutineRow, right: RoutineRow) {
  return snapshotsMatch(
    { version: 1, routine: routineRevisionSnapshotRoutine(left), triggers: [] },
    { version: 1, routine: routineRevisionSnapshotRoutine(right), triggers: [] },
  );
}

function mapRoutineRevision(row: typeof routineRevisions.$inferSelect): RoutineRevision {
  return {
    ...row,
    snapshot: row.snapshot as RoutineRevisionSnapshotV1,
  };
}

function mapRoutineDescriptionDocument(row: {
  id: string;
  companyId: string;
  routineId: string;
  key: string;
  title: string | null;
  format: string;
  latestBody: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RoutineDescriptionDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
    title: row.title,
    format: "markdown",
    body: row.latestBody,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function routineService(
  db: Db,
  deps: {
    heartbeat?: IssueAssignmentWakeupDeps;
    pluginWorkerManager?: PluginWorkerManager;
    runtimeEnv?: Record<string, string | undefined>;
  } = {},
) {
  const issueSvc = issueService(db);
  const secretsSvc = secretService(db);
  const instanceSettings = instanceSettingsService(db);
  const runtimeEnv = deps.runtimeEnv ?? process.env;
  const heartbeat = deps.heartbeat ?? heartbeatService(db, {
    pluginWorkerManager: deps.pluginWorkerManager,
  });

  async function getRoutineById(id: string) {
    return db
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getManagedRoutineBinding(routine: typeof routines.$inferSelect) {
    return db
      .select({
        pluginKey: pluginManagedResources.pluginKey,
        defaultsJson: pluginManagedResources.defaultsJson,
        manifestJson: plugins.manifestJson,
      })
      .from(pluginManagedResources)
      .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
      .where(
        and(
          eq(pluginManagedResources.companyId, routine.companyId),
          eq(pluginManagedResources.resourceKind, "routine"),
          eq(pluginManagedResources.resourceId, routine.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function listManagedRoutineMetadata(routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineManagedByPlugin>();
    const rows = await db
      .select({
        id: pluginManagedResources.id,
        pluginId: pluginManagedResources.pluginId,
        pluginKey: pluginManagedResources.pluginKey,
        manifestJson: plugins.manifestJson,
        resourceKey: pluginManagedResources.resourceKey,
        resourceId: pluginManagedResources.resourceId,
        defaultsJson: pluginManagedResources.defaultsJson,
        createdAt: pluginManagedResources.createdAt,
        updatedAt: pluginManagedResources.updatedAt,
      })
      .from(pluginManagedResources)
      .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
      .where(
        and(
          eq(pluginManagedResources.resourceKind, "routine"),
          inArray(pluginManagedResources.resourceId, routineIds),
        ),
      );
    return new Map(rows.map((row) => [
      row.resourceId,
      {
        id: row.id,
        pluginId: row.pluginId,
        pluginKey: row.pluginKey,
        pluginDisplayName: row.manifestJson.displayName ?? row.pluginKey,
        resourceKind: "routine",
        resourceKey: row.resourceKey,
        defaultsJson: row.defaultsJson,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } satisfies RoutineManagedByPlugin,
    ]));
  }

  async function getTriggerById(id: string) {
    return db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getRoutineDescriptionDocument(
    routineId: string,
    executor: Db | any = db,
  ): Promise<RoutineDescriptionDocument | null> {
    const row = await executor
      .select({
        id: documents.id,
        companyId: documents.companyId,
        routineId: routineDocuments.routineId,
        key: routineDocuments.key,
        title: documents.title,
        format: documents.format,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
        createdByAgentId: documents.createdByAgentId,
        createdByUserId: documents.createdByUserId,
        updatedByAgentId: documents.updatedByAgentId,
        updatedByUserId: documents.updatedByUserId,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(routineDocuments)
      .innerJoin(documents, eq(routineDocuments.documentId, documents.id))
      .where(and(
        eq(routineDocuments.routineId, routineId),
        eq(routineDocuments.key, ROUTINE_DESCRIPTION_DOCUMENT_KEY),
      ))
      .then((rows: any[]) => rows[0] ?? null);
    return row ? mapRoutineDescriptionDocument(row) : null;
  }

  async function upsertRoutineDescriptionDocument(
    executor: Db | any,
    routine: RoutineRow,
    actor: Actor,
    options: { changeSummary?: string | null } = {},
  ): Promise<RoutineDescriptionDocument> {
    if (executor === db) {
      return db.transaction(async (tx) => (
        upsertRoutineDescriptionDocument(tx as unknown as Db, routine, actor, options)
      ));
    }

    const now = new Date();
    const body = routine.description ?? "";
    const existing = await getRoutineDescriptionDocument(routine.id, executor);

    if (existing) {
      if (existing.body === body) return existing;
      const nextRevisionNumber = existing.latestRevisionNumber + 1;
      const [revision] = await executor
        .insert(documentRevisions)
        .values({
          companyId: routine.companyId,
          documentId: existing.id,
          revisionNumber: nextRevisionNumber,
          title: "Routine description",
          format: "markdown",
          body,
          changeSummary: options.changeSummary ?? null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          createdAt: now,
        })
        .returning();

      await executor
        .update(documents)
        .set({
          title: "Routine description",
          format: "markdown",
          latestBody: body,
          latestRevisionId: revision.id,
          latestRevisionNumber: nextRevisionNumber,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: now,
        })
        .where(eq(documents.id, existing.id));
      await executor
        .update(routineDocuments)
        .set({ updatedAt: now })
        .where(eq(routineDocuments.documentId, existing.id));

      return {
        ...existing,
        title: "Routine description",
        body,
        latestRevisionId: revision.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        updatedAt: now,
      };
    }

    const [document] = await executor
      .insert(documents)
      .values({
        companyId: routine.companyId,
        title: "Routine description",
        format: "markdown",
        latestBody: body,
        latestRevisionId: null,
        latestRevisionNumber: 1,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        updatedByAgentId: actor.agentId ?? null,
        updatedByUserId: actor.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [revision] = await executor
      .insert(documentRevisions)
      .values({
        companyId: routine.companyId,
        documentId: document.id,
        revisionNumber: 1,
        title: "Routine description",
        format: "markdown",
        body,
        changeSummary: options.changeSummary ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        createdAt: now,
      })
      .returning();
    await executor
      .update(documents)
      .set({ latestRevisionId: revision.id })
      .where(eq(documents.id, document.id));
    await executor.insert(routineDocuments).values({
      companyId: routine.companyId,
      routineId: routine.id,
      documentId: document.id,
      key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id: document.id,
      companyId: routine.companyId,
      routineId: routine.id,
      key: ROUTINE_DESCRIPTION_DOCUMENT_KEY,
      title: document.title,
      format: "markdown",
      body,
      latestRevisionId: revision.id,
      latestRevisionNumber: 1,
      createdByAgentId: document.createdByAgentId,
      createdByUserId: document.createdByUserId,
      updatedByAgentId: document.updatedByAgentId,
      updatedByUserId: document.updatedByUserId,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  async function appendRoutineRevision(
    executor: Db,
    routine: RoutineRow,
    actor: Actor,
    options: {
      changeSummary?: string | null;
      restoredFromRevisionId?: string | null;
    } = {},
  ) {
    const snapshot = await buildRoutineRevisionSnapshot(executor, routine);
    const nextRevisionNumber = routine.latestRevisionId ? routine.latestRevisionNumber + 1 : 1;
    const now = new Date();
    const [revision] = await executor
      .insert(routineRevisions)
      .values({
        companyId: routine.companyId,
        routineId: routine.id,
        revisionNumber: nextRevisionNumber,
        title: snapshot.routine.title,
        description: snapshot.routine.description,
        snapshot,
        changeSummary: options.changeSummary ?? null,
        restoredFromRevisionId: options.restoredFromRevisionId ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
        createdByRunId: actor.runId ?? null,
        responsibleUserId: snapshot.routine.responsibleUserId ?? null,
        createdAt: now,
      })
      .returning();

    const [updatedRoutine] = await executor
      .update(routines)
      .set({
        latestRevisionId: revision.id,
        latestRevisionNumber: nextRevisionNumber,
        updatedAt: now,
      })
      .where(eq(routines.id, routine.id))
      .returning();

    const routineForDocument = updatedRoutine ?? {
      ...routine,
      latestRevisionId: revision.id,
      latestRevisionNumber: nextRevisionNumber,
      updatedAt: now,
    };
    await upsertRoutineDescriptionDocument(executor, routineForDocument, actor, {
      changeSummary: options.changeSummary ?? null,
    });

    return {
      routine: routineForDocument,
      revision: mapRoutineRevision(revision),
    };
  }

  async function assertRoutineAccess(companyId: string, routineId: string) {
    const routine = await getRoutineById(routineId);
    if (!routine) throw notFound("Routine not found");
    if (routine.companyId !== companyId) throw forbidden("Routine must belong to same company");
    return routine;
  }

  function validateLockedRoutineAssignee(
    companyId: string,
    agent: { id: string; companyId: string; status: string } | null,
  ) {
    if (!agent) throw notFound("Assignee agent not found");
    if (agent.companyId !== companyId) throw unprocessable("Assignee must belong to same company");
    if (agent.status === "pending_approval") throw conflict("Cannot assign routines to pending approval agents");
    if (agent.status === "terminated") throw conflict("Cannot assign routines to terminated agents");
    return agent;
  }

  async function lockAssignableAgent(executor: Db, companyId: string, agentId: string | null | undefined) {
    if (!agentId) return null;
    const locked = await lockAgentRows(executor, [agentId]);
    return validateLockedRoutineAssignee(companyId, locked.get(agentId) ?? null);
  }

  async function lockAssignableAgentForDispatch(
    executor: Db,
    companyId: string,
    agentId: string | null | undefined,
  ) {
    if (!agentId) return null;
    const agent = await executor
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      // SHARE blocks termination's status update while remaining compatible
      // with the foreign-key KEY SHARE locks taken by issue/run inserts.
      .for("share")
      .then((rows) => rows[0] ?? null);
    return validateLockedRoutineAssignee(companyId, agent);
  }

  async function lockAgentRows(executor: Db, agentIds: Array<string | null | undefined>) {
    const ids = Array.from(new Set(agentIds.filter((id): id is string => Boolean(id)))).sort();
    if (ids.length === 0) {
      return new Map<string, { id: string; companyId: string; status: string }>();
    }
    const rows = await executor
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(inArray(agents.id, ids))
      .orderBy(asc(agents.id))
      .for("update")
      .then((result) => result);
    return new Map(rows.map((row) => [row.id, row]));
  }

  function recoveryInventoryIds(value: unknown, key: "routines" | "triggers") {
    const contract = isPlainRecord(value) ? value : null;
    const recovery = contract && isPlainRecord(contract.routineRecovery)
      ? contract.routineRecovery
      : null;
    const entries = recovery && Array.isArray(recovery[key]) ? recovery[key] : [];
    return entries
      .map((entry) => isPlainRecord(entry) && typeof entry.id === "string" ? entry.id : null)
      .filter((id): id is string => Boolean(id));
  }

  function sameStringSet(left: string[], right: string[]) {
    if (left.length !== right.length) return false;
    const expected = new Set(left);
    return right.every((value) => expected.has(value));
  }

  async function lockActiveTerminatedOwnerTriggerInventory(
    executor: Db,
    companyId: string,
    triggerIds: string[],
  ) {
    const requestedTriggerIds = Array.from(new Set(triggerIds)).sort();
    if (requestedTriggerIds.length === 0) return [];

    // This is intentionally a pre-read. Once a matching inventory is found,
    // the issue and action are locked separately in the same order used by
    // agent termination: agents -> routines -> triggers -> issues -> actions.
    // Avoiding FOR UPDATE on a join also keeps Postgres from choosing a lock
    // order for us.
    const candidateRows = await executor
      .select({
        issueId: issues.id,
        executionContract: issues.executionContract,
      })
      .from(issueRecoveryActions)
      .innerJoin(
        issues,
        and(
          eq(issues.id, issueRecoveryActions.sourceIssueId),
          eq(issues.companyId, issueRecoveryActions.companyId),
        ),
      )
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.cause, "terminated_routine_owner"),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ),
      )
      .orderBy(asc(issues.id), asc(issueRecoveryActions.id));
    const requestedTriggerIdSet = new Set(requestedTriggerIds);
    const candidateIssueIds = Array.from(new Set(
      candidateRows
        .filter((row) =>
          recoveryInventoryIds(row.executionContract, "triggers")
            .some((triggerId) => requestedTriggerIdSet.has(triggerId)),
        )
        .map((row) => row.issueId),
    )).sort();
    if (candidateIssueIds.length === 0) return [];

    const lockedIssues = await executor
      .select({ id: issues.id, executionContract: issues.executionContract })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, candidateIssueIds)))
      .orderBy(asc(issues.id))
      .for("update");
    const lockedIssueInventory = new Map(
      lockedIssues.map((issue) => [
        issue.id,
        recoveryInventoryIds(issue.executionContract, "triggers")
          .filter((triggerId) => requestedTriggerIdSet.has(triggerId)),
      ]),
    );
    const matchingLockedIssueIds = lockedIssues
      .filter((issue) => (lockedIssueInventory.get(issue.id)?.length ?? 0) > 0)
      .map((issue) => issue.id)
      .sort();
    if (matchingLockedIssueIds.length === 0) return [];

    const lockedActions = await executor
      .select({ id: issueRecoveryActions.id, sourceIssueId: issueRecoveryActions.sourceIssueId })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, matchingLockedIssueIds),
          eq(issueRecoveryActions.cause, "terminated_routine_owner"),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ),
      )
      .orderBy(asc(issueRecoveryActions.id))
      .for("update");
    const protectedTriggerIds = new Set<string>();
    for (const action of lockedActions) {
      for (const triggerId of lockedIssueInventory.get(action.sourceIssueId) ?? []) {
        protectedTriggerIds.add(triggerId);
      }
    }
    return [...protectedTriggerIds].sort();
  }

  async function lockAndValidateRoutineRecoveryAuthorization(
    executor: Db,
    routine: Pick<RoutineRow, "id" | "companyId">,
    actor: Actor,
  ) {
    const authorization = actor.routineRecoveryAuthorization;
    if (!authorization) return null;
    if (!authorization.routineIds.includes(routine.id)) {
      throw forbidden("Routine is outside the active recovery inventory");
    }
    if (
      authorization.actorType === "agent" &&
      (!actor.agentId ||
        actor.agentId !== authorization.ownerAgentId ||
        !actor.runId ||
        actor.runId !== authorization.runId)
    ) {
      throw forbidden("Routine recovery authorization no longer matches the acting agent run");
    }

    if (authorization.actorType === "agent") {
      const run = await executor
        .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, authorization.runId!),
            eq(heartbeatRuns.companyId, routine.companyId),
            eq(heartbeatRuns.agentId, authorization.ownerAgentId!),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const context = isPlainRecord(run?.contextSnapshot) ? run.contextSnapshot : null;
      if (
        !run ||
        run.status !== "running" ||
        context?.source !== "issue_recovery_action" ||
        context?.wakeReason !== "source_scoped_recovery_action" ||
        context?.recoveryCause !== "terminated_routine_owner" ||
        context?.recoveryActionId !== authorization.actionId ||
        context?.recoveryAttempt !== authorization.attemptCount ||
        context?.routineRecoveryIssueId !== authorization.recoveryIssueId ||
        context?.terminatedAgentId !== authorization.terminatedAgentId ||
        !Array.isArray(context?.routineIds) ||
        !context.routineIds.includes(routine.id)
      ) {
        throw forbidden("Routine recovery delivery is no longer active");
      }
    }

    const recoveryIssue = await executor
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        originKind: issues.originKind,
        originId: issues.originId,
        executionContract: issues.executionContract,
      })
      .from(issues)
      .where(
        and(
          eq(issues.id, authorization.recoveryIssueId),
          eq(issues.companyId, routine.companyId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !recoveryIssue ||
      recoveryIssue.originKind !== "harness_liveness_escalation" ||
      recoveryIssue.originId !== `agent_termination_routine_handoff:${authorization.terminatedAgentId}` ||
      (authorization.actorType === "agent" && recoveryIssue.assigneeAgentId !== authorization.ownerAgentId)
    ) {
      throw forbidden("Routine recovery issue ownership changed");
    }
    const contractRoutineIds = recoveryInventoryIds(recoveryIssue.executionContract, "routines");
    const contractTriggerIds = recoveryInventoryIds(recoveryIssue.executionContract, "triggers");
    if (
      !sameStringSet(contractRoutineIds, authorization.routineIds) ||
      !sameStringSet(contractTriggerIds, authorization.triggerIds) ||
      !contractRoutineIds.includes(routine.id)
    ) {
      throw conflict("Routine recovery inventory changed; reload before mutating routines");
    }

    const action = await executor
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.id, authorization.actionId),
          eq(issueRecoveryActions.companyId, routine.companyId),
          eq(issueRecoveryActions.sourceIssueId, authorization.recoveryIssueId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !action ||
      action.cause !== "terminated_routine_owner" ||
      action.attemptCount !== authorization.attemptCount ||
      (authorization.actorType === "agent" &&
        (action.status !== "active" || action.ownerAgentId !== authorization.ownerAgentId)) ||
      (authorization.actorType === "board" && !["active", "escalated"].includes(action.status)) ||
      (authorization.actorType === "agent" && action.timeoutAt !== null && action.timeoutAt <= new Date())
    ) {
      throw forbidden("Routine recovery action changed or expired; reload before mutating routines");
    }
    return authorization;
  }

  function assertPrelockedRoutineAssignee(
    routine: Pick<RoutineRow, "assigneeAgentId">,
    prelockedAgentIds: Set<string>,
  ) {
    if (routine.assigneeAgentId && !prelockedAgentIds.has(routine.assigneeAgentId)) {
      throw conflict("Routine assignee changed while waiting for the lifecycle lock; retry the update");
    }
  }

  async function assertRestorableAssignee(
    companyId: string,
    assigneeAgentId: string | null | undefined,
    actor: Actor,
  ) {
    await assertAssignableAgent(db, companyId, assigneeAgentId, { kind: "routine" });
    if (actor.agentId && assigneeAgentId !== actor.agentId) {
      throw forbidden("Agents can only restore routine revisions assigned to themselves");
    }
  }

  async function assertProject(companyId: string, projectId: string | null | undefined) {
    if (!projectId) return;
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

  async function assertRoutineFolder(companyId: string, folderId: string | null | undefined) {
    if (!folderId) return;
    const folder = await db
      .select({ id: folders.id, kind: folders.kind })
      .from(folders)
      .where(and(eq(folders.companyId, companyId), eq(folders.id, folderId)))
      .then((rows) => rows[0] ?? null);
    if (!folder) throw notFound("Folder not found");
    if (folder.kind !== "routine") throw unprocessable("Folder kind must match routine");
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
        dispatchFingerprint: routineRuns.dispatchFingerprint,
        routineRevisionId: routineRuns.routineRevisionId,
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
        dispatchFingerprint: row.dispatchFingerprint,
        routineRevisionId: row.routineRevisionId,
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

  async function listLiveIssueByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineListItem["activeIssue"]>();
    const executionBoundRows = await db
      .selectDistinctOn([issues.originId], {
        originId: issues.originId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
      })
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
          eq(issues.originKind, "routine_execution"),
          inArray(issues.originId, routineIds),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          visibleIssueCondition(),
        ),
      )
      .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

    const rowsByOriginId = new Map<string, (typeof executionBoundRows)[number]>();
    for (const row of executionBoundRows) {
      if (!row.originId) continue;
      rowsByOriginId.set(row.originId, row);
    }

    const missingRoutineIds = routineIds.filter((routineId) => !rowsByOriginId.has(routineId));
    if (missingRoutineIds.length > 0) {
      const legacyRows = await db
        .selectDistinctOn([issues.originId], {
          originId: issues.originId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          updatedAt: issues.updatedAt,
        })
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
            eq(issues.originKind, "routine_execution"),
            inArray(issues.originId, missingRoutineIds),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
            visibleIssueCondition(),
          ),
        )
        .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

      for (const row of legacyRows) {
        if (!row.originId) continue;
        rowsByOriginId.set(row.originId, row);
      }
    }

    const map = new Map<string, RoutineListItem["activeIssue"]>();
    for (const row of rowsByOriginId.values()) {
      if (!row.originId) continue;
      map.set(row.originId, {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updatedAt,
      });
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

  async function getAutomaticRoutineDispatchEligibility(
    routine: typeof routines.$inferSelect,
    activation?: WorktreeRunExecutionActivationState,
  ) {
    if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) return { eligible: true };

    const resolvedActivation = activation ?? await resolveWorktreeRunExecutionActivationState({
      getExperimental: instanceSettings.getExperimental,
      runtimeEnv,
    });
    if (!resolvedActivation.armed) return { eligible: false };

    const cutoff = new Date(resolvedActivation.cutoff);
    if (Number.isNaN(cutoff.getTime()) || routine.createdAt < cutoff) return { eligible: false };
    return { eligible: true };
  }

  async function evaluateActivityGate(routine: typeof routines.$inferSelect, now: Date) {
    const lastDispatchedRun = await db
      .select({ triggeredAt: routineRuns.triggeredAt })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.companyId, routine.companyId),
          eq(routineRuns.routineId, routine.id),
          sql`${routineRuns.status} not in ('skipped', 'coalesced')`,
        ),
      )
      .orderBy(desc(routineRuns.triggeredAt), desc(routineRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!lastDispatchedRun) {
      return { fire: true, windowStart: null, matchedActivity: null };
    }

    const projectScopeCondition = routine.activityGateScope === "project"
      ? routine.projectId
        ? sql`(
          (${activityLog.entityType} = 'project' and ${activityLog.entityId} = ${routine.projectId})
          or (${activityLog.details} ->> 'projectId') = ${routine.projectId}
          or exists (
            select 1
            from ${issues} activity_issue
            where activity_issue.company_id = ${routine.companyId}
              and activity_issue.project_id = ${routine.projectId}
              and activity_issue.id::text = ${activityLog.entityId}
              and ${activityLog.entityType} = 'issue'
          )
          or exists (
            select 1
            from ${heartbeatRuns} activity_run
            inner join ${issues} run_issue
              on run_issue.company_id = ${routine.companyId}
              and run_issue.id::text = activity_run.context_snapshot ->> 'issueId'
            where activity_run.company_id = ${routine.companyId}
              and activity_run.id = ${activityLog.runId}
              and run_issue.project_id = ${routine.projectId}
          )
          or exists (
            select 1
            from ${routines} activity_routine
            where activity_routine.company_id = ${routine.companyId}
              and activity_routine.project_id = ${routine.projectId}
              and activity_routine.id::text = ${activityLog.entityId}
              and ${activityLog.entityType} = 'routine'
          )
          or exists (
            select 1
            from ${routineRuns} activity_routine_run
            inner join ${routines} activity_routine
              on activity_routine.company_id = ${routine.companyId}
              and activity_routine.id = activity_routine_run.routine_id
            where activity_routine_run.company_id = ${routine.companyId}
              and activity_routine_run.id::text = ${activityLog.entityId}
              and activity_routine.project_id = ${routine.projectId}
              and ${activityLog.entityType} = 'routine_run'
          )
          )`
        : sql`false`
      : undefined;

    const matchedActivity = await db
      .select({
        id: activityLog.id,
        action: activityLog.action,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, routine.companyId),
          gt(activityLog.createdAt, lastDispatchedRun.triggeredAt),
          lte(activityLog.createdAt, now),
          sql`${activityLog.action} not in (${sql.join(ACTIVITY_GATE_IGNORED_ACTIONS.map((action) => sql`${action}`), sql`, `)})`,
          sql`not (
            ${activityLog.actorId} = 'routine-scheduler'
            and (
              (${activityLog.details} ->> 'routineId') = ${routine.id}
              or (${activityLog.entityType} = 'routine' and ${activityLog.entityId} = ${routine.id})
            )
          )`,
          sql`not exists (
            select 1
            from ${heartbeatRuns} own_run
            inner join ${issues} own_issue
              on own_issue.company_id = ${routine.companyId}
              and own_issue.id::text = own_run.context_snapshot ->> 'issueId'
            where own_run.company_id = ${routine.companyId}
              and own_run.id = ${activityLog.runId}
              and own_issue.origin_kind = 'routine_execution'
              and own_issue.origin_id = ${routine.id}
          )`,
          projectScopeCondition,
        ),
      )
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return {
      fire: matchedActivity !== null,
      windowStart: lastDispatchedRun.triggeredAt,
      matchedActivity,
    };
  }

  // Records an automatic firing that was claimed but intentionally not dispatched. The
  // scheduler advances its tick before calling this helper, so suppressed work is never
  // replayed after a setting or project state changes.
  async function recordSuppressedAutomaticRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect;
    source: "schedule" | "webhook";
    reason: string;
    nextRunAt?: Date | null;
    details?: Record<string, unknown> | null;
  }) {
    const triggeredAt = new Date();
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: input.source,
          status: "skipped",
          triggeredAt,
          failureReason: input.reason,
          completedAt: triggeredAt,
          linkedIssueId: null,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId: input.routine.responsibleUserId ?? null,
          triggerPayload: input.details ?? null,
        })
        .returning();
      await updateRoutineTouchedState({
        routineId: input.routine.id,
        triggerId: input.trigger.id,
        triggeredAt,
        status: input.reason === "paused"
          ? "skipped_paused"
          : input.reason === "no_external_activity"
            ? "skipped_no_activity"
            : "skipped_worktree_execution_cutoff",
        nextRunAt: input.nextRunAt,
      }, txDb);
      return createdRun;
    });

    try {
      await logActivity(db, {
        companyId: input.routine.companyId,
        actorType: "system",
        actorId: input.source === "schedule" ? "routine-scheduler" : "routine-webhook",
        action: "routine.run_skipped",
        entityType: "routine_run",
        entityId: run.id,
        details: {
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: input.source,
          status: "skipped",
          reason: input.reason,
          ...(input.details ?? {}),
        },
      });
    } catch (err) {
      logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log skipped routine run");
    }

    return run;
  }

  function routineExecutionFingerprintCondition(dispatchFingerprint?: string | null) {
    if (!dispatchFingerprint) return null;
    // The "default" arm preserves coalescing against pre-migration open issues.
    // It becomes inert once those legacy routine execution issues drain out.
    return or(
      eq(issues.originFingerprint, dispatchFingerprint),
      eq(issues.originFingerprint, "default"),
    );
  }

  async function findLiveExecutionIssue(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
    dispatchFingerprint?: string | null,
    origin?: { kind: string; id: string | null },
  ) {
    const fingerprintCondition = routineExecutionFingerprintCondition(dispatchFingerprint);
    const originKind = origin?.kind ?? "routine_execution";
    const originId = origin?.id ?? routine.id;
    const executionBoundIssue = await executor
      .select()
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
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          visibleIssueCondition(),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
    if (executionBoundIssue) return executionBoundIssue;

    return executor
      .select()
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
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          visibleIssueCondition(),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
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

  async function prepareWebhookSecret(
    companyId: string,
    routineId: string,
    actor: Actor,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const providerId = getConfiguredSecretProvider();
    const name = `routine-${routineId}-${crypto.randomBytes(6).toString("hex")}`;
    // Provider I/O is intentionally completed before any agent/routine row
    // lock. secretService.create has provider-write rollback compensation.
    const secret = await secretsSvc.create(companyId, {
      name,
      key: name,
      provider: providerId,
      value: secretValue,
      managedMode: "paperclip_managed",
      description: `Webhook auth for routine ${routineId}`,
    }, actor);
    return { secret, secretValue };
  }

  async function bindPreparedWebhookSecret(
    executor: Db,
    companyId: string,
    routineId: string,
    secretId: string,
  ) {
    await executor.insert(companySecretBindings).values({
      companyId,
      secretId,
      targetType: "routine",
      targetId: routineId,
      configPath: routineWebhookSecretConfigPath(secretId),
    });
  }

  async function cleanupPreparedWebhookSecret(
    prepared: Awaited<ReturnType<typeof prepareWebhookSecret>>,
    originalError?: unknown,
  ) {
    try {
      await secretsSvc.remove(prepared.secret.id);
    } catch (cleanupError) {
      logger.error(
        { err: cleanupError, secretId: prepared.secret.id },
        "failed to compensate prepared routine webhook secret",
      );
      if (originalError !== undefined) {
        throw new AggregateError(
          [originalError, cleanupError],
          "Routine webhook mutation failed and prepared-secret cleanup also failed",
        );
      }
      throw cleanupError;
    }
    if (originalError !== undefined) throw originalError;
  }

  async function cleanupPreparedWebhookSecrets(
    preparedSecrets: Iterable<Awaited<ReturnType<typeof prepareWebhookSecret>>>,
    originalError: unknown,
  ): Promise<never> {
    const cleanupErrors: unknown[] = [];
    for (const prepared of preparedSecrets) {
      try {
        await cleanupPreparedWebhookSecret(prepared);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [originalError, ...cleanupErrors],
        `Routine webhook mutation failed and ${cleanupErrors.length} prepared-secret cleanup operation(s) failed`,
      );
    }
    throw originalError;
  }

  async function resolveTriggerSecret(trigger: typeof routineTriggers.$inferSelect, companyId: string) {
    if (!trigger.secretId) throw notFound("Routine trigger secret not found");
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.companyId !== companyId) throw notFound("Routine trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest", {
      consumerType: "routine",
      consumerId: trigger.routineId,
      actorType: "system",
      actorId: null,
      configPath: routineWebhookSecretConfigPath(trigger.secretId),
    });
    return value;
  }

  async function touchIssueForUserInbox(
    executor: Db,
    input: {
      companyId: string;
      issueId: string;
      userId: string;
      touchedAt: Date;
    },
  ) {
    await executor.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "user",
      actorId: input.userId,
      action: "issue.inbox_touched",
      entityType: "issue",
      entityId: input.issueId,
      responsibleUserId: input.userId,
      details: { source: "manual_routine_run" },
      createdAt: input.touchedAt,
    });

    await executor
      .delete(issueInboxArchives)
      .where(
        and(
          eq(issueInboxArchives.companyId, input.companyId),
          eq(issueInboxArchives.issueId, input.issueId),
          eq(issueInboxArchives.userId, input.userId),
        ),
      );
  }

  async function dispatchRoutineRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    projectId?: string | null;
    projectWorkspaceId?: string | null;
    assigneeAgentId?: string | null;
    idempotencyKey?: string | null;
    executionWorkspaceId?: string | null;
    executionWorkspacePreference?: string | null;
    executionWorkspaceSettings?: Record<string, unknown> | null;
    descriptionAppendix?: string | null;
    nextRunAtOverride?: Date | null;
    actor?: Actor;
  }) {
    const routine = await getRoutineById(input.routine.id);
    if (!routine || routine.companyId !== input.routine.companyId) {
      throw notFound("Routine not found");
    }
    const projectId = input.projectId ?? routine.projectId ?? null;
    const assigneeAgentId = input.assigneeAgentId ?? routine.assigneeAgentId ?? null;
    const projectWorkspaceId = input.projectWorkspaceId ?? null;
    if (!assigneeAgentId) {
      throw unprocessable("Default agent required");
    }
    await assertAssignableAgent(db, routine.companyId, assigneeAgentId, { kind: "routine" });
    const automaticVariables: Record<string, string | number | boolean> = {};
    if (input.executionWorkspaceId && routineUsesWorkspaceBranch(routine)) {
      const workspace = await db
        .select({
          branchName: executionWorkspaces.branchName,
          mode: executionWorkspaces.mode,
        })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.id, input.executionWorkspaceId),
            eq(executionWorkspaces.companyId, routine.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const branchName = workspace?.branchName?.trim();
      if (workspace && workspace.mode !== "shared_workspace" && branchName) {
        automaticVariables[WORKSPACE_BRANCH_ROUTINE_VARIABLE] = branchName;
      }
    }
    const resolvedVariables = resolveRoutineVariableValues(routine.variables ?? [], {
      ...input,
      automaticVariables,
    });
    const allVariables = { ...getBuiltinRoutineVariableValues(), ...automaticVariables, ...resolvedVariables };
    const title = interpolateRoutineTemplate(routine.title, allVariables) ?? routine.title;
    const baseDescription = interpolateRoutineTemplate(routine.description, allVariables);
    const description = [baseDescription, input.descriptionAppendix]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n\n");
    const triggerPayload = mergeRoutineRunPayload(input.payload, { ...automaticVariables, ...resolvedVariables });
    const managedRoutineBinding = await getManagedRoutineBinding(routine);
    const managedIssueTemplate = readManagedRoutineIssueTemplate(managedRoutineBinding?.defaultsJson);
    const issueOriginKind = managedIssueTemplate?.surfaceVisibility === "plugin_operation" && managedRoutineBinding
      ? pluginOperationIssueOriginKind(managedRoutineBinding.pluginKey)
      : "routine_execution";
    const issueOriginId = managedIssueTemplate?.originId ?? routine.id;
    const issueBillingCode = managedIssueTemplate?.billingCode ?? null;
    const dispatchFingerprint = createRoutineDispatchFingerprint({
      payload: triggerPayload,
      projectId,
      projectWorkspaceId,
      assigneeAgentId,
      routineRevisionId: routine.latestRevisionId,
      routineEnvFingerprint: createRoutineEnvFingerprint(routine.env),
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      executionWorkspacePreference: input.executionWorkspacePreference ?? null,
      executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
      title,
      description,
    });
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // Lifecycle mutations take the agent lock before the routine lock. Use
      // the same order for dispatch so termination cannot deadlock with a run
      // that is being created.
      await lockAssignableAgentForDispatch(txDb, routine.companyId, assigneeAgentId);
      const lockedRoutine = await txDb
        .select()
        .from(routines)
        .where(and(eq(routines.id, routine.id), eq(routines.companyId, routine.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!lockedRoutine) throw notFound("Routine not found");
      if (lockedRoutine.latestRevisionId !== routine.latestRevisionId) {
        throw conflict("Routine changed while dispatching; retry the run");
      }
      const lockedAssigneeAgentId = input.assigneeAgentId ?? lockedRoutine.assigneeAgentId ?? null;
      if (lockedAssigneeAgentId !== assigneeAgentId) {
        throw conflict("Routine assignee changed while dispatching; retry the run");
      }
      if (lockedRoutine.status === "archived") throw conflict("Routine is archived");
      if (
        (input.source === "schedule" || input.source === "webhook") &&
        lockedRoutine.status !== "active"
      ) {
        throw conflict("Routine trigger is not active");
      }
      const trigger = input.trigger
        ? await txDb
            .select()
            .from(routineTriggers)
            .where(and(
              eq(routineTriggers.id, input.trigger.id),
              eq(routineTriggers.routineId, lockedRoutine.id),
              eq(routineTriggers.companyId, lockedRoutine.companyId),
            ))
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (input.trigger && !trigger) throw conflict("Routine trigger is not active");
      if (trigger && !trigger.enabled) throw conflict("Routine trigger is not active");
      if (
        trigger &&
        input.trigger &&
        (
          trigger.kind !== input.trigger.kind ||
          trigger.cronExpression !== input.trigger.cronExpression ||
          trigger.timezone !== input.trigger.timezone ||
          trigger.publicId !== input.trigger.publicId ||
          trigger.secretId !== input.trigger.secretId ||
          trigger.signingMode !== input.trigger.signingMode ||
          trigger.replayWindowSec !== input.trigger.replayWindowSec
        )
      ) {
        throw conflict("Routine trigger changed while dispatching; retry the run");
      }
      if (input.actor) {
        await lockAndValidateRoutineRecoveryAuthorization(txDb, lockedRoutine, input.actor);
      }

      if (input.idempotencyKey) {
        const existing = await txDb
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.companyId, routine.companyId),
              eq(routineRuns.routineId, routine.id),
              eq(routineRuns.source, input.source),
              eq(routineRuns.idempotencyKey, input.idempotencyKey),
              trigger ? eq(routineRuns.triggerId, trigger.id) : isNull(routineRuns.triggerId),
            ),
          )
          .orderBy(desc(routineRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return existing;
      }

      const triggeredAt = new Date();
      const manualRunnerUserId = input.source === "manual" ? input.actor?.userId ?? null : null;
      const latestRevisionResponsibleUserId = routine.latestRevisionId
        ? await txDb
            .select({
              responsibleUserId: routineRevisions.responsibleUserId,
              snapshot: routineRevisions.snapshot,
            })
            .from(routineRevisions)
            .where(and(
              eq(routineRevisions.companyId, routine.companyId),
              eq(routineRevisions.routineId, routine.id),
              eq(routineRevisions.id, routine.latestRevisionId),
            ))
            .then((rows) => {
              const row = rows[0] ?? null;
              const snapshot = row?.snapshot as RoutineRevisionSnapshotV1 | undefined;
              return row?.responsibleUserId ?? snapshot?.routine.responsibleUserId ?? null;
            })
        : null;
      const responsibleUserId =
        manualRunnerUserId ?? latestRevisionResponsibleUserId ?? routine.responsibleUserId ?? null;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: routine.companyId,
          routineId: routine.id,
          triggerId: trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload,
          dispatchFingerprint,
          routineRevisionId: routine.latestRevisionId,
          responsibleUserId,
        })
        .returning();

      const nextRunAt = input.nextRunAtOverride !== undefined
        ? input.nextRunAtOverride
        : trigger?.kind === "schedule" && trigger.cronExpression && trigger.timezone
          ? nextCronTickInTimeZone(trigger.cronExpression, trigger.timezone, triggeredAt)
          : undefined;

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      try {
        const activeIssue = await findLiveExecutionIssue(routine, txDb, dispatchFingerprint, {
          kind: issueOriginKind,
          id: issueOriginId,
        });
        if (activeIssue && routine.concurrencyPolicy !== "always_enqueue") {
          const status = routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          if (manualRunnerUserId) {
            await touchIssueForUserInbox(txDb, {
              companyId: routine.companyId,
              issueId: activeIssue.id,
              userId: manualRunnerUserId,
              touchedAt: triggeredAt,
            });
          }
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: activeIssue.id,
            coalescedIntoRunId: activeIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateRoutineTouchedState({
            routineId: routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: activeIssue.id,
            nextRunAt,
          }, txDb);
          return updated ?? createdRun;
        }

        try {
          createdIssue = await issueSvc.create(routine.companyId, {
            projectId,
            goalId: routine.goalId,
            parentId: routine.parentIssueId,
            projectWorkspaceId,
            title,
            description,
            status: "todo",
            priority: routine.priority,
            assigneeAgentId,
            createdByAgentId: input.source === "manual" ? input.actor?.agentId ?? null : null,
            createdByUserId: manualRunnerUserId,
            responsibleUserId,
            trustExplicitResponsibleUserId: true,
            originKind: issueOriginKind,
            originId: issueOriginId,
            originRunId: createdRun.id,
            originFingerprint: dispatchFingerprint,
            billingCode: issueBillingCode,
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
          if (!isOpenExecutionConflict || routine.concurrencyPolicy === "always_enqueue") {
            throw error;
          }

          const existingIssue = await findLiveExecutionIssue(routine, txDb, dispatchFingerprint, {
            kind: issueOriginKind,
            id: issueOriginId,
          });
          if (!existingIssue) throw error;
          const status = routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          if (manualRunnerUserId) {
            await touchIssueForUserInbox(txDb, {
              companyId: routine.companyId,
              issueId: existingIssue.id,
              userId: manualRunnerUserId,
              touchedAt: triggeredAt,
            });
          }
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: existingIssue.id,
            coalescedIntoRunId: existingIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateRoutineTouchedState({
            routineId: routine.id,
            triggerId: trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: existingIssue.id,
            nextRunAt,
          }, txDb);
          return updated ?? createdRun;
        }

        // Keep the dispatch lock until the issue is linked to a queued heartbeat run.
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
          routineId: routine.id,
          triggerId: trigger?.id ?? null,
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
          routineId: routine.id,
          triggerId: trigger?.id ?? null,
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
          companyId: routine.companyId,
          actorType: "system",
          actorId,
          action: "routine.run_triggered",
          entityType: "routine_run",
          entityId: run.id,
          details: {
            routineId: routine.id,
            triggerId: input.trigger?.id ?? null,
            source: run.source,
            status: run.status,
          },
        });
      } catch (err) {
        logger.warn({ err, routineId: routine.id, runId: run.id }, "failed to log automated routine run");
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
    evaluateActivityGate,
    get: getRoutineById,
    getTrigger: getTriggerById,

    list: async (
      companyId: string,
      filters?: { projectId?: string | null },
    ): Promise<RoutineListItem[]> => {
      const conditions = [eq(routines.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(routines.projectId, filters.projectId));

      const rows = await db
        .select()
        .from(routines)
        .where(and(...conditions))
        .orderBy(desc(routines.updatedAt), asc(routines.title));
      const routineIds = rows.map((row) => row.id);
      const [triggersByRoutine, latestRunByRoutine, activeIssueByRoutine, managedByRoutine] = await Promise.all([
        listTriggersForRoutineIds(companyId, routineIds),
        listLatestRunByRoutineIds(companyId, routineIds),
        listLiveIssueByRoutineIds(companyId, routineIds),
        listManagedRoutineMetadata(routineIds),
      ]);
      return rows.map((row) => ({
        ...row,
        managedByPlugin: managedByRoutine.get(row.id) ?? null,
        triggers: (triggersByRoutine.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind as RoutineListItem["triggers"][number]["kind"],
          label: trigger.label,
          enabled: trigger.enabled,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
          nextRunAt: trigger.nextRunAt,
          lastFiredAt: trigger.lastFiredAt,
          lastResult: trigger.lastResult,
        })),
        lastRun: latestRunByRoutine.get(row.id) ?? null,
        activeIssue: activeIssueByRoutine.get(row.id) ?? null,
      }));
    },

    getDetail: async (id: string): Promise<RoutineDetail | null> => {
      const row = await getRoutineById(id);
      if (!row) return null;
      const [project, assignee, parentIssue, descriptionDocument, triggers, recentRuns, activeIssue, managedByRoutine] = await Promise.all([
        row.projectId
          ? db.select().from(projects).where(eq(projects.id, row.projectId)).then((rows) => rows[0] ?? null)
          : null,
        row.assigneeAgentId
          ? db.select().from(agents).where(eq(agents.id, row.assigneeAgentId)).then((rows) => rows[0] ?? null)
          : null,
        row.parentIssueId ? issueSvc.getById(row.parentIssueId) : null,
        getRoutineDescriptionDocument(row.id),
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
            dispatchFingerprint: routineRuns.dispatchFingerprint,
            routineRevisionId: routineRuns.routineRevisionId,
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
              dispatchFingerprint: run.dispatchFingerprint,
              routineRevisionId: run.routineRevisionId,
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
        findLiveExecutionIssue(row),
        listManagedRoutineMetadata([row.id]),
      ]);

      return {
        ...row,
        managedByPlugin: managedByRoutine.get(row.id) ?? null,
        project,
        assignee,
        parentIssue,
        descriptionDocument,
        triggers: triggers as RoutineTrigger[],
        recentRuns,
        activeIssue,
      };
    },

    getDescriptionDocument: async (routineId: string) => getRoutineDescriptionDocument(routineId),

    create: async (companyId: string, input: CreateRoutine, actor: Actor): Promise<Routine> => {
      await assertProject(companyId, input.projectId ?? null);
      await assertRoutineFolder(companyId, input.folderId ?? null);
      await assertAssignableAgent(db, companyId, input.assigneeAgentId ?? null, { kind: "routine" });
      if (input.goalId) await assertGoal(companyId, input.goalId);
      if (input.parentIssueId) await assertParentIssue(companyId, input.parentIssueId);
      const env = input.env === undefined || input.env === null
        ? null
        : await secretsSvc.normalizeEnvBindingsForPersistence(companyId, input.env, {
            strictMode: process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true",
            fieldPath: "env",
          });
      const variables = syncRoutineVariablesWithTemplate(
        [input.title, input.description],
        sanitizeRoutineVariableInputs(input.variables),
      );
      assertRoutineVariableDefinitions(variables);
      const status = normalizeDraftRoutineStatus(input.status, input.assigneeAgentId);
      const responsibleUserId = await resolveRoutineResponsibleUserId(db, companyId, actor.userId, input.parentIssueId ?? null);
      if (!responsibleUserId) {
        throw unprocessable("Routine requires a responsible user");
      }
      const createdRoutine = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await lockAssignableAgent(txDb, companyId, input.assigneeAgentId ?? null);
        const [created] = await txDb
          .insert(routines)
          .values({
            companyId,
            projectId: input.projectId ?? null,
            folderId: input.folderId ?? null,
            goalId: input.goalId ?? null,
            parentIssueId: input.parentIssueId ?? null,
            title: input.title,
            description: input.description ?? null,
            assigneeAgentId: input.assigneeAgentId ?? null,
            priority: input.priority,
            status,
            concurrencyPolicy: input.concurrencyPolicy,
            catchUpPolicy: input.catchUpPolicy,
            activityGatePolicy: input.activityGatePolicy ?? "always",
            activityGateScope: input.activityGateScope ?? "company",
            variables,
            env,
            responsibleUserId,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
          })
          .returning();
        const { routine } = await appendRoutineRevision(txDb, created, actor, {
          changeSummary: "Created routine",
        });
        if (env) {
          await secretsSvc.syncEnvBindingsForTarget(
            companyId,
            { targetType: "routine", targetId: routine.id },
            env,
            { db: tx },
          );
        }
        return routine;
      });
      return createdRoutine;
    },

    update: async (id: string, patch: UpdateRoutine, actor: Actor): Promise<Routine | null> => {
      const existing = await getRoutineById(id);
      if (!existing) return null;
      const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
      const nextFolderId = patch.folderId === undefined ? existing.folderId : patch.folderId;
      const nextAssigneeAgentId = patch.assigneeAgentId === undefined ? existing.assigneeAgentId : patch.assigneeAgentId;
      const nextTitle = patch.title ?? existing.title;
      const nextDescription = patch.description === undefined ? existing.description : patch.description;
      const nextEnv = patch.env === undefined
        ? existing.env
        : patch.env === null
          ? null
          : await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, patch.env, {
              strictMode: process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true",
              fieldPath: "env",
            });
      const requestedStatus = patch.status ?? existing.status;
      if (patch.status === "active") {
        assertRoutineCanEnable(patch.status, nextAssigneeAgentId);
      }
      const nextStatus = patch.assigneeAgentId === undefined
        ? requestedStatus
        : normalizeDraftRoutineStatus(requestedStatus, nextAssigneeAgentId);
      const nextVariables = syncRoutineVariablesWithTemplate(
        [nextTitle, nextDescription],
        patch.variables === undefined ? existing.variables : sanitizeRoutineVariableInputs(patch.variables),
      );
      if (patch.projectId !== undefined) await assertProject(existing.companyId, nextProjectId);
      if (patch.folderId !== undefined) await assertRoutineFolder(existing.companyId, nextFolderId);
      if (patch.assigneeAgentId !== undefined || patch.status === "active") {
        await assertAssignableAgent(db, existing.companyId, nextAssigneeAgentId, { kind: "routine" });
      }
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
      const responsibleUserId = await resolveRoutineResponsibleUserId(
        db,
        existing.companyId,
        actor.userId,
        patch.parentIssueId === undefined ? existing.parentIssueId : patch.parentIssueId,
      );
      if (!responsibleUserId) {
        throw unprocessable("Routine requires a responsible user");
      }
      const updatedRoutine = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const needsAssigneeLifecycleLock =
          patch.assigneeAgentId !== undefined ||
          patch.status === "active" ||
          Boolean(actor.routineRecoveryAuthorization);
        const targetAssigneeAgentId = patch.assigneeAgentId !== undefined
          ? patch.assigneeAgentId
          : existing.assigneeAgentId;
        const prelockedAgents = needsAssigneeLifecycleLock
          ? await lockAgentRows(txDb, [
              existing.assigneeAgentId,
              targetAssigneeAgentId,
              actor.routineRecoveryAuthorization?.ownerAgentId,
            ])
          : new Map<string, { id: string; companyId: string; status: string }>();
        const prelockedAgentIds = new Set(prelockedAgents.keys());
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, id))
          .then((rows) => rows[0] ?? null);
        if (!locked) return null;
        if (needsAssigneeLifecycleLock) {
          // Agent rows are always locked before the routine row. If ownership
          // drifted after the pre-read, abort instead of taking a new agent lock
          // after the routine lock (which would invert termination lock order).
          assertPrelockedRoutineAssignee(locked, prelockedAgentIds);
        }
        await lockAndValidateRoutineRecoveryAuthorization(txDb, locked, actor);

        if (patch.baseRevisionId && patch.baseRevisionId !== locked.latestRevisionId) {
          throw conflict("Routine was updated by someone else", {
            currentRevisionId: locked.latestRevisionId,
          });
        }

        const lockedNextProjectId = patch.projectId === undefined ? locked.projectId : patch.projectId;
        const lockedNextAssigneeAgentId = patch.assigneeAgentId === undefined
          ? locked.assigneeAgentId
          : patch.assigneeAgentId;
        const lockedRequestedStatus = patch.status ?? locked.status;
        if (lockedRequestedStatus === "active") {
          assertRoutineCanEnable(lockedRequestedStatus, lockedNextAssigneeAgentId);
        }
        const lockedNextStatus = patch.assigneeAgentId === undefined
          ? lockedRequestedStatus
          : normalizeDraftRoutineStatus(lockedRequestedStatus, lockedNextAssigneeAgentId);
        const lockedNextTitle = patch.title ?? locked.title;
        const lockedNextDescription = patch.description === undefined ? locked.description : patch.description;
        const lockedNextVariables = syncRoutineVariablesWithTemplate(
          [lockedNextTitle, lockedNextDescription],
          patch.variables === undefined ? locked.variables : sanitizeRoutineVariableInputs(patch.variables),
        );
        assertRoutineVariableDefinitions(lockedNextVariables);
        if (enabledScheduleTriggers) {
          assertScheduleCompatibleVariables(lockedNextVariables);
        }
        if (needsAssigneeLifecycleLock && lockedNextAssigneeAgentId) {
          validateLockedRoutineAssignee(
            locked.companyId,
            prelockedAgents.get(lockedNextAssigneeAgentId) ?? null,
          );
        }

        const candidate: RoutineRow = {
          ...locked,
          projectId: lockedNextProjectId,
          folderId: patch.folderId === undefined ? locked.folderId : patch.folderId,
          goalId: patch.goalId === undefined ? locked.goalId : patch.goalId,
          parentIssueId: patch.parentIssueId === undefined ? locked.parentIssueId : patch.parentIssueId,
          title: lockedNextTitle,
          description: lockedNextDescription,
          assigneeAgentId: lockedNextAssigneeAgentId,
          priority: patch.priority ?? locked.priority,
          status: lockedNextStatus,
          concurrencyPolicy: patch.concurrencyPolicy ?? locked.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? locked.catchUpPolicy,
          activityGatePolicy: patch.activityGatePolicy ?? locked.activityGatePolicy,
          activityGateScope: patch.activityGateScope ?? locked.activityGateScope,
          variables: lockedNextVariables,
          env: patch.env === undefined ? locked.env : nextEnv,
          responsibleUserId: locked.responsibleUserId ?? responsibleUserId,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        };

        const folderChanged = patch.folderId !== undefined && locked.folderId !== candidate.folderId;
        if (locked.latestRevisionId && routineCurrentFieldsMatch(locked, candidate)) {
          if (!folderChanged) return locked;
          const [updated] = await txDb
            .update(routines)
            .set({
              folderId: candidate.folderId,
              updatedByAgentId: actor.agentId ?? null,
              updatedByUserId: actor.userId ?? null,
              updatedAt: new Date(),
            })
            .where(eq(routines.id, id))
            .returning();
          return updated ?? locked;
        }

        const nextSnapshot = await buildRoutineRevisionSnapshot(txDb, candidate);
        if (locked.latestRevisionId) {
          const latestRevision = await txDb
            .select({ snapshot: routineRevisions.snapshot })
            .from(routineRevisions)
            .where(
              and(
                eq(routineRevisions.companyId, locked.companyId),
                eq(routineRevisions.routineId, locked.id),
                eq(routineRevisions.id, locked.latestRevisionId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (latestRevision && snapshotsMatch(nextSnapshot, latestRevision.snapshot as RoutineRevisionSnapshotV1)) {
            if (patch.env !== undefined) {
              await secretsSvc.syncEnvBindingsForTarget(
                locked.companyId,
                { targetType: "routine", targetId: locked.id },
                candidate.env,
                { db: tx },
              );
            }
            return locked;
          }
        }

        const [updated] = await txDb
          .update(routines)
          .set({
            projectId: candidate.projectId,
            folderId: candidate.folderId,
            goalId: candidate.goalId,
            parentIssueId: candidate.parentIssueId,
            title: candidate.title,
            description: candidate.description,
            assigneeAgentId: candidate.assigneeAgentId,
            priority: candidate.priority,
            status: candidate.status,
            concurrencyPolicy: candidate.concurrencyPolicy,
            catchUpPolicy: candidate.catchUpPolicy,
            activityGatePolicy: candidate.activityGatePolicy,
            activityGateScope: candidate.activityGateScope,
            variables: candidate.variables,
            env: candidate.env,
            responsibleUserId: candidate.responsibleUserId,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routines.id, id))
          .returning();
        if (!updated) return null;
        const { routine } = await appendRoutineRevision(txDb, updated, actor, {
          changeSummary: "Updated routine",
        });
        if (patch.env !== undefined) {
          await secretsSvc.syncEnvBindingsForTarget(
            routine.companyId,
            { targetType: "routine", targetId: routine.id },
            routine.env,
            { db: tx },
          );
        }
        return routine;
      });
      return updatedRoutine;
    },

    createTrigger: async (
      routineId: string,
      input: CreateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial | null; revision: RoutineRevision }> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");

      let preparedWebhookSecret: Awaited<ReturnType<typeof prepareWebhookSecret>> | null = null;
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
        preparedWebhookSecret = await prepareWebhookSecret(routine.companyId, routine.id, actor);
        secretId = preparedWebhookSecret.secret.id;
        secretMaterial = {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
          webhookSecret: preparedWebhookSecret.secretValue,
        };
      }

      let result: {
        trigger: typeof routineTriggers.$inferSelect;
        revision: RoutineRevision;
        secretMaterial: RoutineTriggerSecretMaterial | null;
      };
      try {
        result = await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          const prelockedAgents = await lockAgentRows(txDb, [
            routine.assigneeAgentId,
            actor.routineRecoveryAuthorization?.ownerAgentId,
          ]);
          const prelockedAgentIds = new Set(prelockedAgents.keys());
          await tx.execute(sql`select id from ${routines} where ${routines.id} = ${routine.id} for update`);
          const lockedRoutine = await txDb
            .select()
            .from(routines)
            .where(eq(routines.id, routine.id))
            .then((rows) => rows[0] ?? null);
          if (!lockedRoutine) throw notFound("Routine not found");
          assertPrelockedRoutineAssignee(lockedRoutine, prelockedAgentIds);
          await lockAndValidateRoutineRecoveryAuthorization(txDb, lockedRoutine, actor);
          if ((input.enabled ?? true) && lockedRoutine.assigneeAgentId) {
            validateLockedRoutineAssignee(
              lockedRoutine.companyId,
              prelockedAgents.get(lockedRoutine.assigneeAgentId) ?? null,
            );
          }
          if (input.kind === "schedule") {
            assertScheduleCompatibleVariables(lockedRoutine.variables ?? []);
          }
          if (preparedWebhookSecret) {
            await bindPreparedWebhookSecret(
              txDb,
              lockedRoutine.companyId,
              lockedRoutine.id,
              preparedWebhookSecret.secret.id,
            );
          }
          const [createdTrigger] = await txDb
            .insert(routineTriggers)
            .values({
              companyId: lockedRoutine.companyId,
              routineId: lockedRoutine.id,
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
          const appended = await appendRoutineRevision(txDb, lockedRoutine, actor, {
            changeSummary: `Created ${input.kind} trigger`,
          });
          return { trigger: createdTrigger, revision: appended.revision, secretMaterial };
        });
      } catch (error) {
        if (preparedWebhookSecret) {
          await cleanupPreparedWebhookSecret(preparedWebhookSecret, error);
        }
        throw error;
      }

      return {
        trigger: result.trigger as RoutineTrigger,
        secretMaterial: result.secretMaterial,
        revision: result.revision,
      };
    },

    updateTrigger: async (
      id: string,
      patch: UpdateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; revision: RoutineRevision } | null> => {
      const existing = await getTriggerById(id);
      if (!existing) return null;
      const preReadRoutine = await getRoutineById(existing.routineId);
      if (!preReadRoutine) throw notFound("Routine not found");

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const prelockedAgents = await lockAgentRows(txDb, [
          preReadRoutine.assigneeAgentId,
          actor.routineRecoveryAuthorization?.ownerAgentId,
        ]);
        const prelockedAgentIds = new Set(prelockedAgents.keys());
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        assertPrelockedRoutineAssignee(routine, prelockedAgentIds);
        const lockedTrigger = await txDb
          .select()
          .from(routineTriggers)
          .where(and(eq(routineTriggers.id, id), eq(routineTriggers.routineId, routine.id)))
          .then((rows) => rows[0] ?? null);
        if (!lockedTrigger) return null;
        const recoveryAuthorization = await lockAndValidateRoutineRecoveryAuthorization(txDb, routine, actor);

        const lockedEnabled = patch.enabled ?? lockedTrigger.enabled;
        let lockedCronExpression = lockedTrigger.cronExpression;
        let lockedTimezone = lockedTrigger.timezone;
        let lockedNextRunAt = lockedTrigger.nextRunAt;
        if (lockedTrigger.kind === "schedule") {
          lockedCronExpression = patch.cronExpression === undefined
            ? lockedTrigger.cronExpression
            : patch.cronExpression;
          lockedTimezone = patch.timezone === undefined ? lockedTrigger.timezone : patch.timezone;
          if (!lockedCronExpression) throw unprocessable("Scheduled triggers require cronExpression");
          if (!lockedTimezone) throw unprocessable("Scheduled triggers require timezone");
          const cronError = validateCron(lockedCronExpression);
          if (cronError) throw unprocessable(cronError);
          assertTimeZone(lockedTimezone);
          lockedNextRunAt = nextCronTickInTimeZone(lockedCronExpression, lockedTimezone, new Date());
          if (lockedEnabled) assertScheduleCompatibleVariables(routine.variables ?? []);
        }
        if (lockedEnabled && routine.assigneeAgentId) {
          validateLockedRoutineAssignee(
            routine.companyId,
            prelockedAgents.get(routine.assigneeAgentId) ?? null,
          );
        }

        const [updated] = await txDb
          .update(routineTriggers)
          .set({
            label: patch.label === undefined ? lockedTrigger.label : patch.label,
            enabled: lockedEnabled,
            cronExpression: lockedCronExpression,
            timezone: lockedTimezone,
            nextRunAt: lockedNextRunAt,
            signingMode: patch.signingMode === undefined ? lockedTrigger.signingMode : patch.signingMode,
            replayWindowSec: patch.replayWindowSec === undefined
              ? lockedTrigger.replayWindowSec
              : patch.replayWindowSec,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, id))
          .returning();
        if (!updated) return null;
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary:
            recoveryAuthorization && patch.enabled !== undefined
              ? routineRecoveryTriggerDispositionMarker(
                  recoveryAuthorization,
                  lockedTrigger.id,
                  lockedEnabled,
                )
              : `Updated ${lockedTrigger.kind} trigger`,
        });
        return { trigger: updated as RoutineTrigger, revision: appended.revision };
      });
      return result;
    },

    deleteTrigger: async (id: string, actor: Actor = {}): Promise<{ deleted: boolean; revision: RoutineRevision | null }> => {
      const existing = await getTriggerById(id);
      if (!existing) return { deleted: false, revision: null };
      const preReadRoutine = await getRoutineById(existing.routineId);
      if (!preReadRoutine) throw notFound("Routine not found");
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const prelockedAgents = await lockAgentRows(txDb, [
          preReadRoutine.assigneeAgentId,
          actor.routineRecoveryAuthorization?.ownerAgentId,
        ]);
        const prelockedAgentIds = new Set(prelockedAgents.keys());
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        assertPrelockedRoutineAssignee(routine, prelockedAgentIds);
        const lockedTrigger = await txDb
          .select({ id: routineTriggers.id })
          .from(routineTriggers)
          .where(and(eq(routineTriggers.id, id), eq(routineTriggers.routineId, routine.id)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedTrigger) return { deleted: false, revision: null };
        const protectedTriggerIds = await lockActiveTerminatedOwnerTriggerInventory(
          txDb,
          routine.companyId,
          [lockedTrigger.id],
        );
        if (protectedTriggerIds.includes(lockedTrigger.id)) {
          throw conflict(
            "Typed recovery triggers cannot be deleted; explicitly enable or disable the trigger instead",
          );
        }
        const recoveryAuthorization = await lockAndValidateRoutineRecoveryAuthorization(txDb, routine, actor);
        if (recoveryAuthorization?.triggerIds.includes(lockedTrigger.id)) {
          throw conflict(
            "Typed recovery triggers cannot be deleted; explicitly enable or disable the trigger instead",
          );
        }
        await txDb.delete(routineTriggers).where(eq(routineTriggers.id, id));
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: `Deleted ${existing.kind} trigger`,
        });
        return { deleted: true, revision: appended.revision };
      });
      if (result.deleted && existing.secretId) {
        try {
          await secretsSvc.remove(existing.secretId);
        } catch (err) {
          logger.warn(
            { err, routineId: existing.routineId, triggerId: existing.id, secretId: existing.secretId },
            "failed to remove routine trigger webhook secret after trigger deletion",
          );
        }
      }
      return result;
    },

    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial; revision: RoutineRevision }> => {
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Routine trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, actor);
      const { trigger, revision } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        const [updated] = await txDb
          .update(routineTriggers)
          .set({
            lastRotatedAt: new Date(),
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routineTriggers.id, id))
          .returning();
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: "Rotated webhook trigger secret",
        });
        return { trigger: updated, revision: appended.revision };
      });

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial: {
          webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${existing.publicId}/fire`,
          webhookSecret: secretValue,
        },
        revision,
      };
    },

    listRevisions: async (routineId: string): Promise<RoutineRevision[]> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");
      const rows = await db
        .select()
        .from(routineRevisions)
        .where(and(eq(routineRevisions.companyId, routine.companyId), eq(routineRevisions.routineId, routine.id)))
        .orderBy(desc(routineRevisions.revisionNumber), desc(routineRevisions.createdAt))
        .limit(MAX_ROUTINE_REVISIONS);
      return rows.map(mapRoutineRevision);
    },

    restoreRevision: async (
      routineId: string,
      revisionId: string,
      actor: Actor,
    ): Promise<{
      routine: Routine;
      revision: RoutineRevision;
      restoredFromRevisionId: string;
      restoredFromRevisionNumber: number;
      secretMaterials: RoutineTriggerSecretRestoreMaterial[];
    }> => {
      const existingRoutine = await getRoutineById(routineId);
      if (!existingRoutine) throw notFound("Routine not found");
      const targetRevision = await db
        .select()
        .from(routineRevisions)
        .where(
          and(
            eq(routineRevisions.companyId, existingRoutine.companyId),
            eq(routineRevisions.routineId, existingRoutine.id),
            eq(routineRevisions.id, revisionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!targetRevision) throw notFound("Routine revision not found");

      const snapshot = routineRevisionSnapshotSchema.parse(targetRevision.snapshot) as RoutineRevisionSnapshotV1;
      const routineSnapshot = snapshot.routine;
      await assertRestorableAssignee(existingRoutine.companyId, routineSnapshot.assigneeAgentId, actor);
      if (existingRoutine.latestRevisionId === targetRevision.id) {
        throw conflict("Selected revision is already the latest revision", {
          currentRevisionId: existingRoutine.latestRevisionId,
        });
      }

      const preflightTriggerIds = await db
        .select({ id: routineTriggers.id })
        .from(routineTriggers)
        .where(
          and(
            eq(routineTriggers.companyId, existingRoutine.companyId),
            eq(routineTriggers.routineId, existingRoutine.id),
          ),
        )
        .then((rows) => new Set(rows.map((row) => row.id)));
      const webhookSnapshotsNeedingSecrets = snapshot.triggers.filter(
        (trigger) => trigger.kind === "webhook" && !preflightTriggerIds.has(trigger.id),
      );
      const preparedWebhookSecrets = new Map<
        string,
        {
          publicId: string;
          prepared: Awaited<ReturnType<typeof prepareWebhookSecret>>;
          secretMaterial: RoutineTriggerSecretRestoreMaterial;
        }
      >();
      try {
        for (const trigger of webhookSnapshotsNeedingSecrets) {
          const publicId = crypto.randomBytes(12).toString("hex");
          const prepared = await prepareWebhookSecret(existingRoutine.companyId, existingRoutine.id, actor);
          preparedWebhookSecrets.set(trigger.id, {
            publicId,
            prepared,
            secretMaterial: {
              triggerId: trigger.id,
              webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
              webhookSecret: prepared.secretValue,
            },
          });
        }
      } catch (error) {
        return cleanupPreparedWebhookSecrets(
          [...preparedWebhookSecrets.values()].map((entry) => entry.prepared),
          error,
        );
      }

      try {
        const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const prelockedAgents = await lockAgentRows(txDb, [
          existingRoutine.assigneeAgentId,
          routineSnapshot.assigneeAgentId,
          actor.routineRecoveryAuthorization?.ownerAgentId,
        ]);
        const prelockedAgentIds = new Set(prelockedAgents.keys());
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existingRoutine.id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existingRoutine.id))
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Routine not found");
        assertPrelockedRoutineAssignee(locked, prelockedAgentIds);
        if (locked.latestRevisionId !== existingRoutine.latestRevisionId) {
          throw conflict("Routine changed while webhook secrets were prepared; retry the restore", {
            currentRevisionId: locked.latestRevisionId,
          });
        }
        if (routineSnapshot.assigneeAgentId) {
          validateLockedRoutineAssignee(
            locked.companyId,
            prelockedAgents.get(routineSnapshot.assigneeAgentId) ?? null,
          );
        }
        const currentTriggers = await txDb
          .select({ id: routineTriggers.id })
          .from(routineTriggers)
          .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.routineId, locked.id)))
          .orderBy(asc(routineTriggers.id))
          .for("update");
        const currentTriggerIds = new Set(currentTriggers.map((trigger) => trigger.id));
        if (
          currentTriggerIds.size !== preflightTriggerIds.size ||
          [...currentTriggerIds].some((triggerId) => !preflightTriggerIds.has(triggerId))
        ) {
          throw conflict("Routine triggers changed while webhook secrets were prepared; retry the restore");
        }
        const snapshotTriggerIds = new Set(snapshot.triggers.map((trigger) => trigger.id));
        const omittedCurrentTriggerIds = [...currentTriggerIds]
          .filter((triggerId) => !snapshotTriggerIds.has(triggerId))
          .sort();
        const protectedOmittedTriggerIds = await lockActiveTerminatedOwnerTriggerInventory(
          txDb,
          locked.companyId,
          omittedCurrentTriggerIds,
        );
        if (protectedOmittedTriggerIds.length > 0) {
          throw conflict(
            "Routine recovery cannot restore a revision that removes typed trigger inventory; explicitly enable or disable each trigger instead",
            { triggerIds: protectedOmittedTriggerIds },
          );
        }
        const recoveryAuthorization = await lockAndValidateRoutineRecoveryAuthorization(txDb, locked, actor);
        const omittedTypedTriggerIds = recoveryAuthorization
          ? recoveryAuthorization.triggerIds.filter(
              (triggerId) => currentTriggerIds.has(triggerId) && !snapshotTriggerIds.has(triggerId),
            )
          : [];
        if (omittedTypedTriggerIds.length > 0) {
          throw conflict(
            "Routine recovery cannot restore a revision that removes typed trigger inventory; explicitly enable or disable each trigger instead",
            { triggerIds: omittedTypedTriggerIds },
          );
        }
        const missingWebhookTriggers = snapshot.triggers
          .filter((trigger) => trigger.kind === "webhook" && !currentTriggerIds.has(trigger.id));
        const recreatedWebhookSecrets = new Map<string, { publicId: string; secretId: string; secretMaterial: RoutineTriggerSecretRestoreMaterial }>();
        for (const trigger of missingWebhookTriggers) {
          const preparedEntry = preparedWebhookSecrets.get(trigger.id);
          if (!preparedEntry) {
            throw conflict("Routine trigger state changed while webhook secrets were prepared; retry the restore");
          }
          await bindPreparedWebhookSecret(
            txDb,
            locked.companyId,
            locked.id,
            preparedEntry.prepared.secret.id,
          );
          recreatedWebhookSecrets.set(trigger.id, {
            publicId: preparedEntry.publicId,
            secretId: preparedEntry.prepared.secret.id,
            secretMaterial: preparedEntry.secretMaterial,
          });
        }

        const now = new Date();
        const [restoredRoutine] = await txDb
          .update(routines)
          .set({
            projectId: routineSnapshot.projectId,
            goalId: routineSnapshot.goalId,
            parentIssueId: routineSnapshot.parentIssueId,
            title: routineSnapshot.title,
            description: routineSnapshot.description,
            assigneeAgentId: routineSnapshot.assigneeAgentId,
            priority: routineSnapshot.priority,
            status: routineSnapshot.status,
            concurrencyPolicy: routineSnapshot.concurrencyPolicy,
            catchUpPolicy: routineSnapshot.catchUpPolicy,
            activityGatePolicy: routineSnapshot.activityGatePolicy,
            activityGateScope: routineSnapshot.activityGateScope,
            variables: routineSnapshot.variables,
            env: routineSnapshot.env,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: now,
          })
          .where(eq(routines.id, locked.id))
          .returning();

        if (snapshotTriggerIds.size === 0) {
          await txDb
            .delete(routineTriggers)
            .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.routineId, locked.id)));
        } else {
          await txDb
            .delete(routineTriggers)
            .where(
              and(
                eq(routineTriggers.companyId, locked.companyId),
                eq(routineTriggers.routineId, locked.id),
                not(inArray(routineTriggers.id, snapshot.triggers.map((trigger) => trigger.id))),
              ),
            );
        }

        for (const triggerSnapshot of snapshot.triggers) {
          const current = await txDb
            .select()
            .from(routineTriggers)
            .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.id, triggerSnapshot.id)))
            .then((rows) => rows[0] ?? null);
          const webhookSecret = recreatedWebhookSecrets.get(triggerSnapshot.id);
          const restoredNextRunAt = triggerSnapshot.kind === "schedule" && triggerSnapshot.enabled
            && triggerSnapshot.cronExpression && triggerSnapshot.timezone
            ? nextCronTickInTimeZone(triggerSnapshot.cronExpression, triggerSnapshot.timezone, now)
            : null;
          const baseValues = {
            companyId: locked.companyId,
            routineId: locked.id,
            kind: triggerSnapshot.kind,
            label: triggerSnapshot.label,
            enabled: triggerSnapshot.enabled,
            cronExpression: triggerSnapshot.kind === "schedule" ? triggerSnapshot.cronExpression : null,
            timezone: triggerSnapshot.kind === "schedule" ? triggerSnapshot.timezone : null,
            publicId: triggerSnapshot.kind === "webhook" ? (current?.publicId ?? webhookSecret?.publicId ?? triggerSnapshot.publicId) : null,
            secretId: triggerSnapshot.kind === "webhook" ? (current?.secretId ?? webhookSecret?.secretId ?? null) : null,
            signingMode: triggerSnapshot.kind === "webhook" ? triggerSnapshot.signingMode : null,
            replayWindowSec: triggerSnapshot.kind === "webhook" ? triggerSnapshot.replayWindowSec : null,
            nextRunAt: restoredNextRunAt,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: now,
          };
          if (current) {
            await txDb.update(routineTriggers).set(baseValues).where(eq(routineTriggers.id, triggerSnapshot.id));
          } else {
            await txDb.insert(routineTriggers).values({
              id: triggerSnapshot.id,
              ...baseValues,
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.userId ?? null,
              createdAt: now,
            });
          }
        }

        const recoveryDispositionMarkers = recoveryAuthorization
          ? snapshot.triggers
              .filter((trigger) => recoveryAuthorization.triggerIds.includes(trigger.id))
              .map((trigger) =>
                routineRecoveryTriggerDispositionMarker(
                  recoveryAuthorization,
                  trigger.id,
                  trigger.enabled,
                ),
              )
          : [];
        const appended = await appendRoutineRevision(txDb, restoredRoutine ?? locked, actor, {
          changeSummary: recoveryDispositionMarkers.length > 0
            ? [
                `Restored from revision ${targetRevision.revisionNumber}`,
                ...recoveryDispositionMarkers,
              ].join("\n")
            : `Restored from revision ${targetRevision.revisionNumber}`,
          restoredFromRevisionId: targetRevision.id,
        });
        await secretsSvc.syncEnvBindingsForTarget(
          locked.companyId,
          { targetType: "routine", targetId: locked.id },
          routineSnapshot.env,
          { db: tx },
        );
        return {
          routine: appended.routine,
          revision: appended.revision,
          restoredFromRevisionId: targetRevision.id,
          restoredFromRevisionNumber: targetRevision.revisionNumber,
          secretMaterials: [...recreatedWebhookSecrets.values()].map((entry) => entry.secretMaterial),
        };
        });
        return result;
      } catch (error) {
        return cleanupPreparedWebhookSecrets(
          [...preparedWebhookSecrets.values()].map((entry) => entry.prepared),
          error,
        );
      }
    },

    runRoutine: async (id: string, input: RunRoutine, actor?: Actor) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      const assigneeAgentId = input.assigneeAgentId ?? routine.assigneeAgentId ?? null;
      await assertAssignableAgent(db, routine.companyId, assigneeAgentId, { kind: "routine" });
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.routineId !== routine.id) throw forbidden("Trigger does not belong to routine");
      if (trigger && !trigger.enabled) throw conflict("Routine trigger is not active");
      return dispatchRoutineRun({
        routine,
        trigger,
        source: input.source,
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        projectId: input.projectId ?? null,
        projectWorkspaceId: input.projectWorkspaceId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        idempotencyKey: input.idempotencyKey,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
        executionWorkspaceSettings:
          (input.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null,
        actor,
      });
    },

    runPipelineStageEntryRoutine: async (id: string, input: RunRoutine & { descriptionAppendix?: string | null }, actor?: Actor) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      const assigneeAgentId = input.assigneeAgentId ?? routine.assigneeAgentId ?? null;
      await assertAssignableAgent(db, routine.companyId, assigneeAgentId, { kind: "routine" });
      return dispatchRoutineRun({
        routine,
        trigger: null,
        source: "api",
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        projectId: input.projectId ?? null,
        projectWorkspaceId: input.projectWorkspaceId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        idempotencyKey: input.idempotencyKey,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
        executionWorkspaceSettings:
          (input.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null,
        descriptionAppendix: input.descriptionAppendix ?? null,
        actor,
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
      if (!trigger.enabled || routine.status !== "active") throw conflict("Routine trigger is not active");

      if (trigger.signingMode === "none") {
        // No authentication — the publicId in the URL acts as a shared secret.
      } else if (trigger.signingMode === "github_hmac") {
        const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        // Accept X-Hub-Signature-256 (GitHub/Sentry) or fall back to the
        // generic X-Paperclip-Signature header so operators can use github_hmac
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

      const eligibility = await getAutomaticRoutineDispatchEligibility(routine);
      if (!eligibility.eligible) {
        return recordSuppressedAutomaticRun({
          routine,
          trigger,
          source: "webhook",
          reason: "worktree_execution_cutoff",
        });
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
          dispatchFingerprint: routineRuns.dispatchFingerprint,
          routineRevisionId: routineRuns.routineRevisionId,
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
        dispatchFingerprint: row.dispatchFingerprint,
        routineRevisionId: row.routineRevisionId,
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

    tickScheduledTriggers: async (now: Date = new Date()) => {
      const worktreeActivation = isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)
        ? await resolveWorktreeRunExecutionActivationState({
          getExperimental: instanceSettings.getExperimental,
          runtimeEnv,
        })
        : undefined;
      const due = await db
        .select({
          trigger: routineTriggers,
          routine: routines,
          projectPausedAt: projects.pausedAt,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .leftJoin(projects, eq(routines.projectId, projects.id))
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

        // Suppress scheduled firings while the routine's project is paused. The tick is still
        // claimed and advanced to the next single cron tick (no backfill), so resume continues
        // at the next cron boundary instead of replaying missed firings. Routines with no
        // project are never suppressed here.
        const projectPaused = !!(row.routine.projectId && row.projectPausedAt);
        const automaticEligibility = await getAutomaticRoutineDispatchEligibility(row.routine, worktreeActivation);
        const worktreeSuppressed = !automaticEligibility.eligible;

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (!projectPaused && !worktreeSuppressed && row.routine.catchUpPolicy === "enqueue_missed_with_cap") {
          if (isSubHourlyCronExpression(row.trigger.cronExpression, row.trigger.timezone, now)) {
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);
          } else {
            let cursor: Date | null = row.trigger.nextRunAt;
            runCount = 0;
            while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
              runCount += 1;
              claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, cursor);
              cursor = claimedNextRunAt;
            }
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

        if (projectPaused || worktreeSuppressed) {
          await recordSuppressedAutomaticRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
            reason: worktreeSuppressed ? "worktree_execution_cutoff" : "paused",
            nextRunAt: claimedNextRunAt,
          });
          continue;
        }

        const activityGate = row.routine.activityGatePolicy === "require_external_activity"
          ? await evaluateActivityGate(row.routine, now)
          : null;
        if (activityGate && !activityGate.fire) {
          await recordSuppressedAutomaticRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
            reason: "no_external_activity",
            nextRunAt: claimedNextRunAt,
            details: {
              activityGate: {
                verdict: "quiet",
                windowStart: activityGate.windowStart?.toISOString() ?? null,
                matchedActivityId: null,
              },
            },
          });
          continue;
        }

        for (let i = 0; i < runCount; i += 1) {
          await dispatchRoutineRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
            nextRunAtOverride: claimedNextRunAt,
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
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;
      if (issue.status === "done") {
        return finalizeRun(issue.originRunId, {
          status: "completed",
          completedAt: new Date(),
        });
      }
      if (issue.status === "blocked" || issue.status === "cancelled") {
        return finalizeRun(issue.originRunId, {
          status: "failed",
          failureReason: `Execution issue moved to ${issue.status}`,
          completedAt: new Date(),
        });
      }
      return null;
    },
  };
}
