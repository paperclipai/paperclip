import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, not, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  activityLog,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  documentRevisions,
  documents,
  executionWorkspaces,
  folders,
  goals,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueRelations,
  issueThreadInteractions,
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
  normalizeAgentUrlKey,
  pluginOperationIssueOriginKind,
  routineRevisionSnapshotSchema,
  stringifyRoutineVariableValue,
  syncRoutineVariablesWithTemplate,
} from "@paperclipai/shared";
import { trackRoutineRun } from "@paperclipai/shared/telemetry";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { resolveCompanyPrimaryProjectId } from "./company-primary-project.js";
import { getTelemetryClient } from "../telemetry.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { issueService } from "./issues.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { secretService } from "./secrets.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { parseCron, validateCron } from "./cron.js";
import { heartbeatService } from "./heartbeat.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { budgetService } from "./budgets.js";
import {
  instanceSettingsService,
  isTruthyRuntimeEnvValue,
  resolveWorktreeRunExecutionActivationState,
  type WorktreeRunExecutionActivationState,
} from "./instance-settings.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";
import { classifyNonActionableWebhookPayload, type NonActionableWebhookPayloadKind } from "./non-actionable-webhook-payload.js";
import { evaluateMcInboundTriggerPayloadFilter } from "./mc-inbound-trigger-payload.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const LIVE_SUPERSEDING_ROUTINE_EXECUTION_STATUSES = ["backlog", "todo", "in_progress", "in_review"];
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const TERMINAL_HEARTBEAT_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"];
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const MAX_CATCH_UP_RUNS = 25;
const DEFAULT_MINIMUM_SCHEDULE_INTERVAL_MINUTES = 5;
const MAX_ROUTINE_REVISIONS = 100;
const EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE = "execution_issue_status";
const EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES = ["blocked", "cancelled"] as const;
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

type ExecutionIssueTransientFailureStatus = (typeof EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES)[number];

function executionIssueTransientFailureReason(status: ExecutionIssueTransientFailureStatus) {
  return `Execution issue moved to ${status}`;
}

function executionIssueTransientFailureStatusFromPayload(payload: unknown): ExecutionIssueTransientFailureStatus | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const transientFailure = (payload as Record<string, unknown>).transientFailure;
  if (!transientFailure || typeof transientFailure !== "object" || Array.isArray(transientFailure)) return null;
  const record = transientFailure as Record<string, unknown>;
  if (record.code !== EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE) return null;
  return EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES.find((status) => record.status === status) ?? null;
}

function executionIssueTransientFailureClearedAtFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const transientFailure = (payload as Record<string, unknown>).transientFailure;
  if (!transientFailure || typeof transientFailure !== "object" || Array.isArray(transientFailure)) return null;
  const clearedAt = (transientFailure as Record<string, unknown>).clearedAt;
  return typeof clearedAt === "string" ? clearedAt : null;
}

function legacyExecutionIssueTransientFailureStatus(
  failureReason: string | null,
): ExecutionIssueTransientFailureStatus | null {
  return EXECUTION_ISSUE_TRANSIENT_FAILURE_STATUSES.find(
    (status) => failureReason === executionIssueTransientFailureReason(status),
  ) ?? null;
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

type Actor = { agentId?: string | null; userId?: string | null; runId?: string | null };
type RoutineRow = typeof routines.$inferSelect;
type RoutineTriggerRow = typeof routineTriggers.$inferSelect;

type CourierDeliveryReceipt = {
  version: 1;
  idempotencyKey: string;
  destinationIssueId: string;
  destinationIssueIdentifier: string;
  createReceipt: {
    routineRunId: string;
    destinationIssueId: string;
    destinationIssueIdentifier: string;
  };
};

function makeCourierDeliveryReceipt(input: {
  runId: string;
  idempotencyKey: string;
  issue: { id: string; identifier: string | null };
}): CourierDeliveryReceipt {
  const destinationIssueIdentifier = input.issue.identifier ?? input.issue.id;
  return {
    version: 1,
    idempotencyKey: input.idempotencyKey,
    destinationIssueId: input.issue.id,
    destinationIssueIdentifier,
    createReceipt: {
      routineRunId: input.runId,
      destinationIssueId: input.issue.id,
      destinationIssueIdentifier,
    },
  };
}

function isCourierDeliveryPayload(raw: Record<string, unknown> | null | undefined) {
  if (!raw) return false;
  // Routine webhooks also use portfolio_* event labels for normal status and
  // directive traffic. A courier is the narrower cross-company envelope: it
  // must name its source issue, which is what lets the returned receipt be
  // correlated to a retryable source delivery.
  const labels = [raw.kind, raw.type]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  const courierLabel = labels.some((value) => value === "portfolio_directive" || value === "courier_delivery");
  return courierLabel && typeof raw.sourceIssue === "string" && raw.sourceIssue.trim().length > 0;
}

/** Key order must not change the hash, or a retry that serializes its JSON
 *  differently would look like a NEW delivery and duplicate the destination
 *  task -- the exact failure the key exists to prevent. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Deterministic idempotency key for a courier envelope that did not carry one.
 *
 *  Same envelope in -> same key out -> the dedup path folds the retry into the
 *  original destination task. Callers that supply their own key keep it; this is
 *  only the fallback that makes the guarantee hold for existing senders, none of
 *  which send a key today. */
function deriveCourierIdempotencyKey(payload: Record<string, unknown> | null | undefined) {
  return `courier:${crypto.createHash("sha256").update(stableStringify(payload ?? null)).digest("hex")}`;
}

const ROUTINE_DESCRIPTION_DOCUMENT_KEY = "description" as const;
const ROUTINE_ISSUE_MODE_ENV_KEY = "PAPERCLIP_ROUTINE_ISSUE_MODE";
const ROUTINE_PARENT_LIFECYCLE_BINDING_ENV_KEY = "PAPERCLIP_ROUTINE_PARENT_LIFECYCLE_BINDING";
const ROUTINE_ISSUE_MODE_REUSE_TERMINAL = "reuse_terminal";
const ROUTINE_HEALTH_ISSUE_ORIGIN_KIND = "routine_health";
const ROUTINE_HEALTH_STREAK_THRESHOLD = 3;
const MC_INBOUND_CEO_HANDOFF_ORIGIN_KIND = "mc_inbound_ceo_handoff";
const ROUTINE_ISSUE_MODE_ALIASES = new Set([
  ROUTINE_ISSUE_MODE_REUSE_TERMINAL,
  "terminal_reuse",
  "rollup_reuse",
]);
const ROUTINE_EXECUTION_AUTO_HIDE_COMMENT_PATTERNS = [
  /^Fallback monitor: no usage-limit failures detected in the last \d+m \(checked \d+ failed runs\) and no paused primaries with stranded open issues\.\s*$/i,
  /^Fallback swap-back: no eligible reset-window state found\.\s*$/i,
];
const DEFAULT_SCHEDULE_DISPATCH_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_SCHEDULE_DISPATCH_RETRY_DELAY_MS = 5 * 60_000;

function readScheduleDispatchLockTimeoutMs() {
  const raw = process.env.ROUTINE_SCHEDULE_DISPATCH_LOCK_TIMEOUT_MS;
  if (!raw || raw.trim() === "") return DEFAULT_SCHEDULE_DISPATCH_LOCK_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SCHEDULE_DISPATCH_LOCK_TIMEOUT_MS;
  return parsed;
}

function readScheduleDispatchRetryDelayMs() {
  const raw = process.env.ROUTINE_SCHEDULE_DISPATCH_RETRY_DELAY_MS;
  if (!raw || raw.trim() === "") return DEFAULT_SCHEDULE_DISPATCH_RETRY_DELAY_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SCHEDULE_DISPATCH_RETRY_DELAY_MS;
  return parsed;
}

function computeScheduleDispatchRetryAt(triggeredAt: Date, claimedNextRunAt: Date | null) {
  if (!claimedNextRunAt) return null;
  const retryDelayMs = readScheduleDispatchRetryDelayMs();
  if (retryDelayMs <= 0) return claimedNextRunAt;
  const retryAt = new Date(triggeredAt.getTime() + retryDelayMs);
  return retryAt.getTime() < claimedNextRunAt.getTime() ? retryAt : claimedNextRunAt;
}

interface RoutineTriggerSecretRestoreMaterial extends RoutineTriggerSecretMaterial {
  triggerId: string;
}

function routineWebhookSecretConfigPath(secretId: string) {
  return `webhookSecret:${secretId}`;
}

function readPlainRoutineEnvValue(env: RoutineRow["env"], key: string): string | null {
  const binding = env?.[key];
  if (typeof binding === "string") return binding;
  if (binding && typeof binding === "object" && binding.type === "plain") return binding.value;
  return null;
}

function routineReusesTerminalExecutionIssue(routine: RoutineRow): boolean {
  const raw = readPlainRoutineEnvValue(routine.env, ROUTINE_ISSUE_MODE_ENV_KEY);
  return raw ? ROUTINE_ISSUE_MODE_ALIASES.has(raw.trim().toLowerCase()) : false;
}

function routineBindsToParentLifecycle(routine: RoutineRow): boolean {
  const raw = readPlainRoutineEnvValue(routine.env, ROUTINE_PARENT_LIFECYCLE_BINDING_ENV_KEY);
  return raw ? isTruthyRuntimeEnvValue(raw) : false;
}

function isTerminalParentFailureReason(reason: string | null | undefined) {
  return typeof reason === "string" && /^parent_issue_terminal_(done|cancelled)$/i.test(reason);
}

function isDeadScheduledRunLike(run: {
  source: string;
  status: string;
  failureReason: string | null;
}) {
  if (run.source !== "schedule") return false;
  if (run.status === "failed") return true;
  return run.status === "skipped" && isTerminalParentFailureReason(run.failureReason);
}

// THIAAAAAA-203 self-heal helpers: detect the specific failure modes that occur
// when a webhook trigger's company_secret_bindings join row has vanished while
// the underlying secret is still live.
function isBindingMissingError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: number }).status === 422 &&
    (err as { details?: { code?: string } }).details?.code === "binding_missing"
  );
}

function isConflictError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: number }).status === 409
  );
}

function isIssueWakeLockContentionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes("select id from issues where id = $1 and company_id = $2 for update")
    || message.includes("lock timeout");
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
      // hourCycle "h23" yields 0–23 (00 at midnight). The older `hour12: false`
      // can render midnight as "24" on some Node/ICU builds, so a `0 0 * * *`
      // cron never matched hour 0 and nextCronTickInTimeZone span the full
      // 5-year scan -> null nextRunAt (midnight routines silently stopped firing).
      hourCycle: "h23",
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

function readMinimumScheduleIntervalMinutes(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const minutes = (value as { minimumScheduleIntervalMinutes?: unknown }).minimumScheduleIntervalMinutes;
  return typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 1 && minutes <= 24 * 60
    ? minutes
    : null;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created" && issueId) return `Created execution issue ${issueId}`;
  if (status === "issue_reused" && issueId) return `Reused execution issue ${issueId}`;
  if (status === "coalesced") return "Coalesced into an existing live execution issue";
  if (status === "skipped_paused") return "Skipped because the project is paused";
  if (status === "skipped_ignored") return "Skipped because the webhook payload was non-actionable";
  if (status === "skipped") return "Skipped because a live execution issue already exists";
  if (status === "completed") return "Execution issue completed";
  if (status === "cancelled") return "Execution issue cancelled";
  if (status === "failed_retry_scheduled") return "Execution failed; retry scheduled";
  if (status === "failed") return "Execution failed";
  return status;
}

function withLegacyRoutineRunIssueId<T extends { linkedIssueId: string | null }>(run: T): T & { issueId: string | null } {
  return {
    ...run,
    issueId: run.linkedIssueId,
  };
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

function normalizeRoutinePauseState(input: {
  currentStatus: string;
  nextStatus: string;
  currentPauseReason: string | null;
  requestedPauseReason: string | null | undefined;
  currentPausedAt: Date | null;
  now: Date;
}) {
  if (input.nextStatus !== "paused") {
    return { pauseReason: null, pausedAt: null };
  }

  return {
    pauseReason: input.requestedPauseReason ?? input.currentPauseReason ?? "manual",
    pausedAt: input.currentStatus === "paused" ? input.currentPausedAt ?? input.now : input.now,
  };
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
    pauseReason: routine.pauseReason ?? null,
    pausedAt: routine.pausedAt?.toISOString() ?? null,
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
  const issueInteractionSvc = issueThreadInteractionService(db);
  const secretsSvc = secretService(db);
  const instanceSettings = instanceSettingsService(db);
  const runtimeEnv = deps.runtimeEnv ?? process.env;
  const heartbeat = deps.heartbeat ?? heartbeatService(db, {
    pluginWorkerManager: deps.pluginWorkerManager,
  });

  async function listRecentScheduleRunsForHealth(routineId: string, limit = ROUTINE_HEALTH_STREAK_THRESHOLD) {
    return db
      .select({
        id: routineRuns.id,
        source: routineRuns.source,
        status: routineRuns.status,
        failureReason: routineRuns.failureReason,
        triggeredAt: routineRuns.triggeredAt,
        completedAt: routineRuns.completedAt,
        createdAt: routineRuns.createdAt,
      })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(desc(routineRuns.triggeredAt), desc(routineRuns.createdAt))
      .limit(limit);
  }

  async function findOpenRoutineHealthIssue(companyId: string, routineId: string) {
    return db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, ROUTINE_HEALTH_ISSUE_ORIGIN_KIND),
        eq(issues.originId, routineId),
        not(inArray(issues.status, ["done", "cancelled"])),
      ))
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function buildRoutineHealthIssueTitle(routine: typeof routines.$inferSelect, boardActionRequired: boolean) {
    const base = `Routine health: ${routine.title}`;
    return boardActionRequired ? `BOARD ACTION REQUIRED: ${base}` : base;
  }

  function buildRoutineHealthIssueDescription(routine: typeof routines.$inferSelect) {
    return [
      "Paperclip-generated routine health issue.",
      "",
      `Routine id: ${routine.id}`,
      `Routine title: ${routine.title}`,
      "Escalation: scheduled dead-fire detection",
      "Resolution: clear the routine kill condition, then rerun or wait for the next scheduled fire.",
    ].join("\n");
  }

  function buildRoutineHealthDigestComment(input: {
    routine: typeof routines.$inferSelect;
    streak: number;
    recentRuns: Array<{
      triggeredAt: Date | null;
      status: string;
      failureReason: string | null;
    }>;
  }) {
    const lines = input.recentRuns.map((run, index) => {
      const when = (run.triggeredAt ?? null)?.toISOString?.() ?? "unknown";
      const suffix = run.failureReason ? ` (${run.failureReason})` : "";
      return `${index + 1}. ${when} — ${run.status}${suffix}`;
    });
    return [
      `Routine dead-fire digest: scheduled streak ${input.streak}/${ROUTINE_HEALTH_STREAK_THRESHOLD} for \`${input.routine.title}\`.`,
      "",
      ...lines,
    ].join("\n");
  }

  async function surfaceRoutineDeadFire(input: {
    routine: typeof routines.$inferSelect;
    run: typeof routineRuns.$inferSelect;
  }) {
    if (!isDeadScheduledRunLike(input.run)) return;

    const recentRuns = await listRecentScheduleRunsForHealth(input.routine.id);
    const streakRuns: typeof recentRuns = [];
    for (const run of recentRuns) {
      if (!isDeadScheduledRunLike(run)) break;
      streakRuns.push(run);
    }
    if (streakRuns.length === 0) return;

    const boardActionRequired = streakRuns.length >= ROUTINE_HEALTH_STREAK_THRESHOLD;
    let issue = await findOpenRoutineHealthIssue(input.routine.companyId, input.routine.id);
    if (!issue) {
      issue = await issueSvc.create(input.routine.companyId, {
        projectId: input.routine.projectId,
        goalId: input.routine.goalId,
        title: buildRoutineHealthIssueTitle(input.routine, boardActionRequired),
        description: buildRoutineHealthIssueDescription(input.routine),
        status: boardActionRequired ? "in_review" : "todo",
        priority: "high",
        assigneeAgentId: input.routine.assigneeAgentId,
        responsibleUserId: input.routine.responsibleUserId ?? null,
        trustExplicitResponsibleUserId: true,
        originKind: ROUTINE_HEALTH_ISSUE_ORIGIN_KIND,
        originId: input.routine.id,
        // Routine-health triage is diagnosis of a dead-fire, not deliverable work —
        // the only system review class still running on full-profile models
        // (0/43 cheap in the week of 2026-07-30; every sibling class was ~100%).
        // TSMC-20243 two-tier QA.
        assigneeAdapterOverrides: { modelProfile: "cheap" },
      });
      if (issue.assigneeAgentId) {
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "routine.health",
          requestedByActorType: "system",
          rethrowOnError: false,
        });
      }
    } else if (issue.title !== buildRoutineHealthIssueTitle(input.routine, boardActionRequired) || (boardActionRequired && issue.status !== "in_review")) {
      issue = await issueSvc.update(issue.id, {
        title: buildRoutineHealthIssueTitle(input.routine, boardActionRequired),
        status: boardActionRequired ? "in_review" : issue.status,
      }) ?? issue;
    }

    const digestComment = buildRoutineHealthDigestComment({
      routine: input.routine,
      streak: streakRuns.length,
      recentRuns: streakRuns,
    });
    const latestComments = await issueSvc.listComments(issue.id, { limit: 1, order: "desc" });
    if (latestComments[0]?.body !== digestComment) {
      await issueSvc.addComment(issue.id, digestComment, {}, { authorType: "system" });
    }

    if (!boardActionRequired) return;

    const existingInteraction = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existingInteraction) return;

    await issueInteractionSvc.create(
      { id: issue.id, companyId: issue.companyId },
      {
        kind: "request_confirmation",
        continuationPolicy: "wake_assignee",
        idempotencyKey: `routine-health:${input.routine.id}:dead-fire`,
        title: "Routine dead-fire streak review",
        summary: "ASK: review the dead routine streak. WHY: three consecutive scheduled fires died. ACTION: confirm the remediation path.",
        payload: {
          version: 1,
          prompt: `Review the routine-health issue for ${input.routine.title} and confirm the remediation path.`,
          allowDeclineReason: true,
        },
      },
      {},
    );
  }

  async function getRoutineById(id: string) {
    return db
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertScheduleMeetsCadenceFloor(
    routine: typeof routines.$inferSelect,
    expression: string,
    timeZone: string,
  ) {
    const [company, assignee] = await Promise.all([
      db.select({ routineGuardConfig: companies.routineGuardConfig })
        .from(companies)
        .where(eq(companies.id, routine.companyId))
        .then((rows) => rows[0] ?? null),
      routine.assigneeAgentId
        ? db.select({ runtimeConfig: agents.runtimeConfig })
          .from(agents)
          .where(eq(agents.id, routine.assigneeAgentId))
          .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    const agentConfig = assignee && typeof assignee.runtimeConfig === "object" && assignee.runtimeConfig
      ? (assignee.runtimeConfig as Record<string, unknown>).routineGuard
      : null;
    const minimumMinutes = readMinimumScheduleIntervalMinutes(agentConfig)
      ?? readMinimumScheduleIntervalMinutes(company?.routineGuardConfig)
      ?? DEFAULT_MINIMUM_SCHEDULE_INTERVAL_MINUTES;
    const first = nextCronTickInTimeZone(expression, timeZone, new Date());
    const second = first ? nextCronTickInTimeZone(expression, timeZone, first) : null;
    if (first && second && second.getTime() - first.getTime() < minimumMinutes * 60_000) {
      throw unprocessable(`Scheduled routines must run no more often than every ${minimumMinutes} minutes`);
    }
  }

  async function getRoutineAgentSummary(
    companyId: string,
    agentId: string,
  ): Promise<RoutineDetail["assignee"]> {
    return db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .then((rows) => {
        const row = rows[0];
        return row ? { ...row, urlKey: normalizeAgentUrlKey(row.name) ?? row.id } : null;
      });
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

  // Lane guardrail (2026-06-17): a routine must not be pinned to a Claude CEO/CTO in a
  // *windowed* company. claude-window-flip parks that agent outside its ~6h sprint window,
  // so off-window the routine fails "Agent is not invokable in its current state" (e.g.
  // TSMC-10109). Routines belong on the always-on codex sister (or a shell handler). TSMC
  // (always-on, no activity_window) is exempt. Mode via ROUTINE_GUARDRAIL_WINDOWED_CLAUDE:
  //   "enforce"/"block" (default) -> reject;  "warn" -> log + allow;  "off" -> skip.
  // (Base assignability — org-chain/lifecycle eligibility — now lives in the shared
  // assertAssignableAgent; this is the routine-lane-specific overlay on top of it.)
  async function assertRoutineAssigneeLaneAllowed(companyId: string, agentId: string | null | undefined) {
    if (!agentId) return;
    const mode = (process.env.ROUTINE_GUARDRAIL_WINDOWED_CLAUDE ?? "enforce").toLowerCase();
    if (mode === "off") return;
    const agent = await db
      .select({ id: agents.id, adapterType: agents.adapterType, role: agents.role })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) return;
    const adapter = (agent.adapterType ?? "").toLowerCase();
    const role = (agent.role ?? "").toLowerCase();
    if (adapter !== "claude_local" || (role !== "ceo" && role !== "cto")) return;
    const company = await db
      .select({ activityWindow: companies.activityWindow })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    // A null activity_window means always-on (e.g. TSMC) -> never windowed-out -> allowed.
    if (!company || company.activityWindow == null) return;
    const message =
      `Routine assignee ${agent.id} is a windowed Claude ${role.toUpperCase()}: claude-window-flip ` +
      `parks it outside the sprint window, so routines on it fail off-window. Assign the routine ` +
      `to the always-on codex sister or a shell handler instead.`;
    if (mode === "enforce" || mode === "block") {
      throw unprocessable(message);
    }
    logger.warn(`routine-guardrail(windowed-claude): company=${companyId} agent=${agent.id} role=${role} — ${message}`);
  }

  // Routine-assignment validation chokepoint: shared assignability (org-chain/lifecycle)
  // plus our routine-lane guardrail. Use this for every routine assignee mutation.
  async function assertRoutineAssignableAgent(companyId: string, agentId: string | null | undefined) {
    await assertAssignableAgent(db, companyId, agentId, { kind: "routine" });
    await assertRoutineAssigneeLaneAllowed(companyId, agentId);
  }

  async function assertRestorableAssignee(
    companyId: string,
    assigneeAgentId: string | null | undefined,
    actor: Actor,
  ) {
    await assertRoutineAssignableAgent(companyId, assigneeAgentId);
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
        deliveryReceipt: routineRuns.deliveryReceipt,
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
      map.set(row.routineId, withLegacyRoutineRunIssueId({
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
        deliveryReceipt: row.deliveryReceipt,
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
    idempotencyKey?: string | null;
    rejectIdempotencyReplay?: boolean;
  }) {
    const triggeredAt = new Date();
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${input.routine.id} and ${routines.companyId} = ${input.routine.companyId} for update`,
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
              eq(routineRuns.triggerId, input.trigger.id),
            ),
          )
          .orderBy(desc(routineRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) {
          if (input.rejectIdempotencyReplay) {
            throw conflict("Webhook replay detected");
          }
          return existing;
        }
      }

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
          idempotencyKey: input.idempotencyKey ?? null,
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

    return withLegacyRoutineRunIssueId(run);
  }

  async function recordFailedScheduleDispatch(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect;
    error: unknown;
    nextRunAt: Date | null;
  }) {
    const triggeredAt = new Date();
    const failureReason = input.error instanceof Error ? input.error.message : String(input.error);
    const resultStatus = input.nextRunAt ? "failed_retry_scheduled" : "failed";
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: "schedule",
          status: "failed",
          triggeredAt,
          failureReason,
          completedAt: triggeredAt,
          linkedIssueId: null,
          routineRevisionId: input.routine.latestRevisionId,
        })
        .returning();
      await updateRoutineTouchedState({
        routineId: input.routine.id,
        triggerId: input.trigger.id,
        triggeredAt,
        status: resultStatus,
        nextRunAt: input.nextRunAt,
      }, txDb);
      return createdRun;
    });

    logger.error(
      {
        err: input.error,
        routineId: input.routine.id,
        triggerId: input.trigger.id,
        runId: run.id,
      },
      "scheduled routine dispatch failed after trigger claim",
    );

    try {
      await logActivity(db, {
        companyId: input.routine.companyId,
        actorType: "system",
        actorId: "routine-scheduler",
        action: "routine.run_failed",
        entityType: "routine_run",
        entityId: run.id,
        details: {
          routineId: input.routine.id,
          triggerId: input.trigger.id,
          source: "schedule",
          status: "failed",
          failureReason,
        },
      });
    } catch (err) {
      logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log failed routine run");
    }

    return withLegacyRoutineRunIssueId(run);
  }


  async function recordIgnoredWebhookRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect;
    payload: Record<string, unknown> | null;
    reason: NonActionableWebhookPayloadKind;
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
          source: "webhook",
          status: "skipped",
          triggeredAt,
          triggerPayload: input.payload,
          failureReason: input.reason,
          completedAt: triggeredAt,
          linkedIssueId: null,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId: input.routine.responsibleUserId ?? null,
        })
        .returning();
      await updateRoutineTouchedState({
        routineId: input.routine.id,
        triggerId: input.trigger.id,
        triggeredAt,
        status: "skipped",
      }, txDb);
      return createdRun;
    });
    return withLegacyRoutineRunIssueId(run);
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

  async function findOpenExecutionIssue(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
    dispatchFingerprint?: string | null,
    origin?: { kind: string; id: string | null },
    options?: { ignoreFingerprint?: boolean },
  ) {
    const fingerprintCondition = options?.ignoreFingerprint
      ? null
      : routineExecutionFingerprintCondition(dispatchFingerprint);
    const originKind = origin?.kind ?? "routine_execution";
    const originId = origin?.id ?? routine.id;
    const baseConditions = and(
      eq(issues.companyId, routine.companyId),
      eq(issues.originKind, originKind),
      eq(issues.originId, originId),
      isNotNull(issues.originRunId),
      inArray(issues.status, OPEN_ISSUE_STATUSES),
      isNull(issues.hiddenAt),
      ...(fingerprintCondition ? [fingerprintCondition] : []),
    );
    const selectShape = {
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      updatedAt: issues.updatedAt,
      originRunId: issues.originRunId,
    };

    // A routine's open execution card remains its concurrency anchor even
    // after the originating heartbeat ends. In particular, a blocked/todo/
    // in_review card represents work that needs resolution, not permission to
    // mint another scheduled sibling (TSMC-20875).
    return executor
      .select({
        ...selectShape,
      })
      .from(issues)
      .where(baseConditions)
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function addScheduledCoalesceNote(input: {
    routine: typeof routines.$inferSelect;
    issue: { id: string; identifier: string | null; status: string; updatedAt: Date; };
    triggeredAt: Date;
    executor?: Db;
  }) {
    const issueLabel = input.issue.identifier ?? input.issue.id;
    await (input.executor ?? db).insert(issueComments).values({
      companyId: input.routine.companyId,
      issueId: input.issue.id,
      body: `Routine beat skipped at ${input.triggeredAt.toISOString()}: ${issueLabel} remains ${input.issue.status} (last updated ${input.issue.updatedAt.toISOString()}). The existing open instance remains the routine's concurrency anchor.`,
    });
  }

  async function findReusableTerminalExecutionIssue(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
    dispatchFingerprint?: string | null,
    origin?: { kind: string; id: string | null },
    options?: { ignoreFingerprint?: boolean },
  ) {
    const fingerprintCondition = options?.ignoreFingerprint
      ? null
      : routineExecutionFingerprintCondition(dispatchFingerprint);
    const originKind = origin?.kind ?? "routine_execution";
    const originId = origin?.id ?? routine.id;
    return executor
      .select({
        id: issues.id,
        identifier: issues.identifier,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        updatedAt: issues.updatedAt,
        originKind: issues.originKind,
        originId: issues.originId,
        originRunId: issues.originRunId,
        originFingerprint: issues.originFingerprint,
        billingCode: issues.billingCode,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        hiddenAt: issues.hiddenAt,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          isNotNull(issues.originRunId),
          inArray(issues.status, ["done", "cancelled"]),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function readTerminalParentIssueStatus(
    companyId: string,
    parentIssueId: string | null | undefined,
    executor: Db = db,
  ) {
    if (!parentIssueId) return null;
    const parent = await executor
      .select({ status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, parentIssueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return parent && TERMINAL_ISSUE_STATUSES.has(parent.status) ? parent.status : null;
  }

  async function restoreReusedTerminalExecutionIssue(
    issue: Awaited<ReturnType<typeof findReusableTerminalExecutionIssue>>,
    executor: Db = db,
  ) {
    if (!issue) return;

    await executor
      .update(issues)
      .set({
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        originKind: issue.originKind,
        originId: issue.originId,
        originRunId: issue.originRunId,
        originFingerprint: issue.originFingerprint,
        billingCode: issue.billingCode,
        executionWorkspaceId: issue.executionWorkspaceId,
        executionWorkspacePreference: issue.executionWorkspacePreference,
        executionWorkspaceSettings: issue.executionWorkspaceSettings,
        completedAt: issue.completedAt,
        cancelledAt: issue.cancelledAt,
        hiddenAt: issue.hiddenAt,
        checkoutRunId: issue.checkoutRunId,
        executionRunId: issue.executionRunId,
        executionLockedAt: issue.executionLockedAt,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));
  }

  async function shouldAutoHideCompletedRoutineExecutionIssue(
    issueId: string,
    executor: Db = db,
  ) {
    const comments = await executor
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)))
      .orderBy(desc(issueComments.createdAt))
      .limit(2);
    if (comments.length === 0) return true;
    if (comments.length > 1) return false;
    const body = comments[0]?.body.trim() ?? "";
    return ROUTINE_EXECUTION_AUTO_HIDE_COMMENT_PATTERNS.some((pattern) => pattern.test(body));
  }

  async function hideCompletedRoutineExecutionIssue(issueId: string, executor: Db = db) {
    await executor
      .update(issues)
      .set({
        hiddenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(issues.id, issueId), isNull(issues.hiddenAt)));
  }

  async function clearTerminalExecutionIssueLocks(
    routine: typeof routines.$inferSelect,
    executor: Db = db,
    dispatchFingerprint?: string | null,
    origin?: { kind: string; id: string | null },
    options?: { ignoreFingerprint?: boolean },
  ) {
    const fingerprintCondition = options?.ignoreFingerprint
      ? null
      : routineExecutionFingerprintCondition(dispatchFingerprint);
    const originKind = origin?.kind ?? "routine_execution";
    const originId = origin?.id ?? routine.id;
    const staleRows = await executor
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, TERMINAL_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, originKind),
          eq(issues.originId, originId),
          isNotNull(issues.executionRunId),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          visibleIssueCondition(),
          ...(fingerprintCondition ? [fingerprintCondition] : []),
        ),
      );
    const staleIssueIds = staleRows.map((row) => row.id);
    if (staleIssueIds.length === 0) return;

    await executor
      .update(issues)
      .set({
        checkoutRunId: null,
        executionRunId: null,
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

  /**
   * Board-noise cleanup. Each routine fire creates a routine_execution issue; when a fire's
   * run is lost/fails, recovery leaves that issue `blocked`, and the next fire's
   * clearTerminalExecutionIssueLocks() only releases the execution lock — it never closes the
   * stale issue. Those superseded blocked fires then pile up on the board (they were the
   * dominant source of manual cleanup). This cancels a blocked routine_execution issue ONLY
   * when it is definitively dead: its routine is still active AND has fired a newer execution
   * since (superseded) AND it has no active first-class blocker (a real dependency would keep
   * it legitimately blocked). Terminal-only (status -> cancelled), so it cannot loop —
   * stranded-issue recovery ignores cancelled issues, and the routine keeps firing fresh
   * executions on schedule.
   */
  async function cancelSupersededRoutineExecutionIssues() {
    const blocked = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        originId: issues.originId,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.originKind, "routine_execution"),
          eq(issues.status, "blocked"),
          isNull(issues.hiddenAt),
          isNotNull(issues.originId),
        ),
      );

    const cancelled: string[] = [];
    for (const iss of blocked) {
      if (!iss.originId) continue;

      // Routine must still be active (paused/archived routines are left alone).
      const routine = await db
        .select({ status: routines.status })
        .from(routines)
        .where(eq(routines.id, iss.originId))
        .then((rows) => rows[0] ?? null);
      if (!routine || routine.status !== "active") continue;

      // Must be superseded by a newer visible execution path of the same routine.
      // Failed/stuck blocked fires are not replacements for a manual catch-up.
      const newerFire = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.originKind, "routine_execution"),
            eq(issues.originId, iss.originId),
            gt(issues.createdAt, iss.createdAt),
            inArray(issues.status, LIVE_SUPERSEDING_ROUTINE_EXECUTION_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!newerFire) continue;

      // Must carry NO active first-class blocker (an unresolved dependency would keep it
      // legitimately blocked — never cancel those).
      const activeBlocker = await db
        .select({ id: issueRelations.issueId })
        .from(issueRelations)
        .innerJoin(issues, eq(issues.id, issueRelations.issueId))
        .where(
          and(
            eq(issueRelations.relatedIssueId, iss.id),
            eq(issueRelations.type, "blocks"),
            not(inArray(issues.status, ["done", "cancelled"])),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (activeBlocker) continue;

      await db
        .update(issues)
        .set({
          status: "cancelled",
          checkoutRunId: null,
          executionRunId: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, iss.id));

      await db.insert(issueComments).values({
        companyId: iss.companyId,
        issueId: iss.id,
        body:
          "Auto-cancelled: superseded routine execution. This routine has fired a newer execution since this instance was blocked, and it carries no active blocker — clearing the stale fire to keep the board clean. The routine continues to fire fresh executions on schedule.",
      });

      cancelled.push(iss.id);
    }

    if (cancelled.length > 0) {
      logger.info(
        { cancelled: cancelled.length, issueIds: cancelled },
        "cancelled superseded routine-execution issues",
      );
    }
    return { cancelled: cancelled.length, issueIds: cancelled };
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

  async function createWebhookSecret(
    companyId: string,
    routineId: string,
    actor: Actor,
    executor?: Db,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const providerId = getConfiguredSecretProvider();
    const input = {
      name: `routine-${routineId}-${crypto.randomBytes(6).toString("hex")}`,
      provider: providerId,
      value: secretValue,
      description: `Webhook auth for routine ${routineId}`,
    };
    const provider = getSecretProvider(input.provider);
    const prepared = await provider.createSecret({
      value: input.value,
      externalRef: null,
      context: {
        companyId,
        secretKey: input.name,
        secretName: input.name,
        version: 1,
      },
    });

    const insertSecret = async (secretDb: Db) => {
      const secret = await secretDb
        .insert(companySecrets)
        .values({
          companyId,
          key: input.name,
          name: input.name,
          provider: input.provider,
          status: "active",
          managedMode: "paperclip_managed",
          externalRef: prepared.externalRef,
          providerMetadata: null,
          latestVersion: 1,
          description: input.description,
          lastRotatedAt: new Date(),
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      await secretDb.insert(companySecretVersions).values({
        secretId: secret.id,
        version: 1,
        material: prepared.material,
        valueSha256: prepared.valueSha256,
        fingerprintSha256: prepared.fingerprintSha256 ?? prepared.valueSha256,
        providerVersionRef: prepared.providerVersionRef ?? null,
        status: "current",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      });

      await secretDb.insert(companySecretBindings).values({
        companyId,
        secretId: secret.id,
        targetType: "routine",
        targetId: routineId,
        configPath: routineWebhookSecretConfigPath(secret.id),
      });

      return secret;
    };

    const secret = executor
      ? await insertSecret(executor)
      : await db.transaction(async (tx) => insertSecret(tx as unknown as Db));
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
    const configPath = routineWebhookSecretConfigPath(trigger.secretId);
    const context = {
      consumerType: "routine" as const,
      consumerId: trigger.routineId,
      actorType: "system" as const,
      actorId: null,
      configPath,
    };
    try {
      return await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest", context);
    } catch (err) {
      // Self-heal (THIAAAAAA-203): the (company_id, target_type='routine',
      // target_id, config_path='webhookSecret:<id>') binding row has been
      // observed vanishing from company_secret_bindings, which 422-rejects
      // OpCo webhook callbacks and has twice forced manual SQL restores. When
      // the underlying secret is still live and in-company, transparently
      // recreate the missing binding and retry the resolve exactly once rather
      // than failing the fire. Root-cause of the deletion continues on
      // THIAAAAAA-203 / THIAAAAAA-206 and is independent of this recovery.
      if (!isBindingMissingError(err) || secret.status !== "active") throw err;
      logger.warn(
        {
          event: "webhook_binding_auto_repair",
          companyId,
          routineId: trigger.routineId,
          triggerId: trigger.id,
          triggerPublicId: trigger.publicId,
          secretId: trigger.secretId,
          configPath,
        },
        "recreating missing webhook secret binding before retrying trigger fire (THIAAAAAA-203 self-heal)",
      );
      try {
        await secretsSvc.createBinding({
          companyId,
          secretId: trigger.secretId,
          targetType: "routine",
          targetId: trigger.routineId,
          configPath,
        });
      } catch (repairErr) {
        // A concurrent fire may have already recreated the binding (409) — that
        // is success for our purposes. Any other repair failure means we cannot
        // safely recover, so surface the original binding_missing error.
        if (!isConflictError(repairErr)) {
          logger.error(
            {
              event: "webhook_binding_auto_repair_failed",
              err: repairErr,
              companyId,
              routineId: trigger.routineId,
              triggerId: trigger.id,
            },
            "webhook binding auto-repair failed; surfacing original binding_missing error",
          );
          throw err;
        }
      }
      return await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest", context);
    }
  }

  /**
   * Eager companion to the resolveTriggerSecret self-heal (THIAAAAAA-203): rather than
   * waiting for a fire to hit the missing binding, this sweep proactively restores any
   * webhook trigger whose company_secret_bindings row has gone missing while its secret is
   * still live. The trigger's `secretId` is the authoritative ownership record, so recreating
   * the derived binding from it is safe — the same operation the fire-path self-heal performs.
   * Runs on the scheduler tick; toggle WEBHOOK_BINDING_RECONCILE=false.
   */
  async function reconcileWebhookSecretBindings() {
    const missing = await db
      .select({
        triggerId: routineTriggers.id,
        routineId: routineTriggers.routineId,
        secretId: routineTriggers.secretId,
        companyId: routines.companyId,
      })
      .from(routineTriggers)
      .innerJoin(routines, eq(routines.id, routineTriggers.routineId))
      .leftJoin(
        companySecretBindings,
        and(
          eq(companySecretBindings.companyId, routines.companyId),
          eq(companySecretBindings.secretId, routineTriggers.secretId),
          eq(companySecretBindings.targetType, "routine"),
          // target_id is text; routine_id is uuid — cast for the comparison.
          sql`${companySecretBindings.targetId} = ${routineTriggers.routineId}::text`,
        ),
      )
      .where(
        and(
          eq(routineTriggers.kind, "webhook"),
          isNotNull(routineTriggers.secretId),
          isNull(companySecretBindings.id),
        ),
      );

    const repaired: string[] = [];
    for (const t of missing) {
      if (!t.secretId) continue;
      // Only restore when the underlying secret is still live and in-company — never paper
      // over a genuinely deleted or foreign secret.
      const secret = await db
        .select({ status: companySecrets.status, companyId: companySecrets.companyId })
        .from(companySecrets)
        .where(eq(companySecrets.id, t.secretId))
        .then((rows) => rows[0] ?? null);
      if (!secret || secret.companyId !== t.companyId || secret.status !== "active") continue;

      const configPath = routineWebhookSecretConfigPath(t.secretId);
      try {
        await secretsSvc.createBinding({
          companyId: t.companyId,
          secretId: t.secretId,
          targetType: "routine",
          targetId: t.routineId,
          configPath,
        });
        repaired.push(t.triggerId);
        logger.warn(
          {
            event: "webhook_binding_reconcile",
            companyId: t.companyId,
            routineId: t.routineId,
            triggerId: t.triggerId,
            secretId: t.secretId,
            configPath,
          },
          "eagerly recreated missing webhook secret binding (THIAAAAAA-203 reconcile)",
        );
      } catch (err) {
        // A concurrent fire-path self-heal may have just recreated it (409) — treat as success.
        if (!isConflictError(err)) {
          logger.error(
            { event: "webhook_binding_reconcile_failed", err, triggerId: t.triggerId },
            "eager webhook binding reconcile failed",
          );
        }
      }
    }

    if (repaired.length > 0) {
      logger.info({ repaired: repaired.length, triggerIds: repaired }, "reconciled missing webhook secret bindings");
    }
    return { repaired: repaired.length, triggerIds: repaired };
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
    rejectIdempotencyReplay?: boolean;
    executionWorkspaceId?: string | null;
    executionWorkspacePreference?: string | null;
    executionWorkspaceSettings?: Record<string, unknown> | null;
    descriptionAppendix?: string | null;
    courierDelivery?: boolean;
    nextRunAtOverride?: Date | null;
    actor?: Actor;
  }) {
    const projectId = input.projectId ?? input.routine.projectId ?? null;
    const projectWorkspaceId = input.projectWorkspaceId ?? null;
    const assigneeAgentId = input.assigneeAgentId ?? input.routine.assigneeAgentId ?? null;
    if (!assigneeAgentId) {
      throw unprocessable("Default agent required");
    }
    await assertRoutineAssignableAgent(input.routine.companyId, assigneeAgentId);
    const assignee = await db
      .select({ role: agents.role })
      .from(agents)
      .where(and(eq(agents.id, assigneeAgentId), eq(agents.companyId, input.routine.companyId)))
      .then((rows) => rows[0] ?? null);
    const automaticVariables: Record<string, string | number | boolean> = {};
    if (input.executionWorkspaceId && routineUsesWorkspaceBranch(input.routine)) {
      const workspace = await db
        .select({
          branchName: executionWorkspaces.branchName,
          mode: executionWorkspaces.mode,
        })
        .from(executionWorkspaces)
        .where(
          and(
            eq(executionWorkspaces.id, input.executionWorkspaceId),
            eq(executionWorkspaces.companyId, input.routine.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const branchName = workspace?.branchName?.trim();
      if (workspace && workspace.mode !== "shared_workspace" && branchName) {
        automaticVariables[WORKSPACE_BRANCH_ROUTINE_VARIABLE] = branchName;
      }
    }
    const resolvedVariables = resolveRoutineVariableValues(input.routine.variables ?? [], {
      ...input,
      automaticVariables,
    });
    const allVariables = { ...getBuiltinRoutineVariableValues(), ...automaticVariables, ...resolvedVariables };
    const title = interpolateRoutineTemplate(input.routine.title, allVariables) ?? input.routine.title;
    // Moved down from above the `title` declaration (2026-08-05): it read `title` before the
    // const was initialised, which is a temporal-dead-zone error -- `tsc` flagged TS2448/TS2454 and
    // it would have thrown at runtime on every routine execution. Only consumed further below
    // (allowDuplicate), so evaluating it here is equivalent and safe.
    const isFallbackMonitorExecution =
      title.trim().replace(/\s+/g, " ").toLowerCase() === "fallback-monitor";
    const baseDescription = interpolateRoutineTemplate(input.routine.description, allVariables);
    const description = [baseDescription, input.descriptionAppendix]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n\n");
    const triggerPayload = mergeRoutineRunPayload(input.payload, { ...automaticVariables, ...resolvedVariables });
    const managedRoutineBinding = await getManagedRoutineBinding(input.routine);
    const managedIssueTemplate = readManagedRoutineIssueTemplate(managedRoutineBinding?.defaultsJson);
    const issueOriginKind = managedIssueTemplate?.surfaceVisibility === "plugin_operation" && managedRoutineBinding
      ? pluginOperationIssueOriginKind(managedRoutineBinding.pluginKey)
      : "routine_execution";
    const issueOriginId = managedIssueTemplate?.originId ?? input.routine.id;
    const issueBillingCode = managedIssueTemplate?.billingCode ?? null;
    const shouldAlwaysEnqueue = input.routine.concurrencyPolicy === "always_enqueue";
    const automatedCoalesce = input.source !== "manual";
    // Origin-only coalesce folds any new automated fire into the oldest open
    // execution issue regardless of payload. That is fine for skip_if_active /
    // coalesce_if_active (they want to suppress while *any* anchor is active),
    // but for always_enqueue it silently absorbs heterogeneous fires behind a
    // stale blocked/in_review anchor — see TSMC-10038. For always_enqueue we
    // fall back to fingerprint-based coalesce so genuinely duplicate retries
    // still fold while cross-OpCo Portfolio Intake traffic spawns fresh
    // execution issues.
    const coalesceByOriginOnly = automatedCoalesce && !shouldAlwaysEnqueue;
    const dispatchFingerprint = createRoutineDispatchFingerprint({
      payload: triggerPayload,
      projectId,
      projectWorkspaceId,
      assigneeAgentId,
      routineRevisionId: input.routine.latestRevisionId,
      routineEnvFingerprint: createRoutineEnvFingerprint(input.routine.env),
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      executionWorkspacePreference: input.executionWorkspacePreference ?? null,
      executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
      title,
      description,
    });
    const persistedOriginFingerprint = shouldAlwaysEnqueue && !automatedCoalesce
      ? null
      : dispatchFingerprint;
    const canReuseTerminalExecutionIssue =
      input.source === "schedule" && routineReusesTerminalExecutionIssue(input.routine);
    // Held in a ref cell: the assignment happens inside the transaction callback, and
    // control-flow analysis does not track closure writes to a plain `let`, so a bare
    // local would narrow to `null` at the post-commit read below.
    const deferredReuseWake: {
      current:
        | { issue: { id: string; assigneeAgentId: string | null; status: string } }
        | null;
    } = { current: null };
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const lockTimeoutMs = input.source === "schedule" ? readScheduleDispatchLockTimeoutMs() : 0;
      if (lockTimeoutMs > 0) {
        await tx.execute(sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`);
      }
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${input.routine.id} and ${routines.companyId} = ${input.routine.companyId} for update`,
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
        if (existing) {
          if (input.rejectIdempotencyReplay) {
            throw conflict("Webhook replay detected");
          }
          // A failed create/receipt callback is retryable.  Do not replay its
          // failed run forever; the destination issue create key below prevents
          // a later attempt from creating a second destination issue.
          if (existing.status !== "failed") return existing;
        }
      }

      const triggeredAt = new Date();
      const manualRunnerUserId = input.source === "manual" ? input.actor?.userId ?? null : null;
      const latestRevisionResponsibleUserId = input.routine.latestRevisionId
        ? await txDb
            .select({
              responsibleUserId: routineRevisions.responsibleUserId,
              snapshot: routineRevisions.snapshot,
            })
            .from(routineRevisions)
            .where(and(
              eq(routineRevisions.companyId, input.routine.companyId),
              eq(routineRevisions.routineId, input.routine.id),
              eq(routineRevisions.id, input.routine.latestRevisionId),
            ))
            .then((rows) => {
              const row = rows[0] ?? null;
              const snapshot = row?.snapshot as RoutineRevisionSnapshotV1 | undefined;
              return row?.responsibleUserId ?? snapshot?.routine.responsibleUserId ?? null;
            })
        : null;
      const responsibleUserId =
        manualRunnerUserId ?? latestRevisionResponsibleUserId ?? input.routine.responsibleUserId ?? null;
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
          dispatchFingerprint,
          routineRevisionId: input.routine.latestRevisionId,
          responsibleUserId,
        })
        .returning();

      const nextRunAt = input.nextRunAtOverride !== undefined
        ? input.nextRunAtOverride
        : input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
          ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, triggeredAt)
          : undefined;

      if (input.source === "schedule" && input.routine.parentIssueId && routineBindsToParentLifecycle(input.routine)) {
        const parentIssue = await txDb
          .select({ status: issues.status })
          .from(issues)
          .where(
            and(
              eq(issues.id, input.routine.parentIssueId),
              eq(issues.companyId, input.routine.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (parentIssue && (parentIssue.status === "done" || parentIssue.status === "cancelled")) {
          const updated = await finalizeRun(createdRun.id, {
            status: "skipped",
            completedAt: triggeredAt,
            failureReason: `parent_issue_terminal_${parentIssue.status}`,
          }, txDb);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status: "skipped",
            nextRunAt,
          }, txDb);
          return withLegacyRoutineRunIssueId(updated ?? createdRun);
        }
      }

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      let executionIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      let reusedIssueSnapshot: Awaited<ReturnType<typeof findReusableTerminalExecutionIssue>> | null = null;
      let dispatchStatus = "issue_created";
      try {
        await clearTerminalExecutionIssueLocks(input.routine, txDb, dispatchFingerprint, {
          kind: issueOriginKind,
          id: issueOriginId,
        }, { ignoreFingerprint: coalesceByOriginOnly });
        const activeIssue = await findOpenExecutionIssue(input.routine, txDb, dispatchFingerprint, {
          kind: issueOriginKind,
          id: issueOriginId,
        }, { ignoreFingerprint: coalesceByOriginOnly });
        const shouldReuseActiveIssue = activeIssue && (!shouldAlwaysEnqueue || automatedCoalesce);
        if (shouldReuseActiveIssue) {
          const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          if (manualRunnerUserId) {
            await touchIssueForUserInbox(txDb, {
              companyId: input.routine.companyId,
              issueId: activeIssue.id,
              userId: manualRunnerUserId,
              touchedAt: triggeredAt,
            });
          }
          if (input.source === "schedule") {
            await addScheduledCoalesceNote({ routine: input.routine, issue: activeIssue, triggeredAt, executor: txDb });
          }
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: activeIssue.id,
            coalescedIntoRunId: activeIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: activeIssue.id,
            nextRunAt,
          }, txDb);
          return withLegacyRoutineRunIssueId(updated ?? createdRun);
        }

        let cancelledReuseSource: Awaited<ReturnType<typeof findReusableTerminalExecutionIssue>> | null = null;
        if (canReuseTerminalExecutionIssue && persistedOriginFingerprint) {
          const reusableIssue = await findReusableTerminalExecutionIssue(input.routine, txDb, dispatchFingerprint, {
            kind: issueOriginKind,
            id: issueOriginId,
          }, { ignoreFingerprint: coalesceByOriginOnly });
          if (reusableIssue) {
            const reusableParentTerminalStatus = await readTerminalParentIssueStatus(
              input.routine.companyId,
              reusableIssue.parentId,
              txDb,
            );
            if (reusableParentTerminalStatus && routineBindsToParentLifecycle(input.routine)) {
              const updated = await finalizeRun(createdRun.id, {
                status: "skipped",
                completedAt: triggeredAt,
                failureReason: `parent_issue_terminal_${reusableParentTerminalStatus}`,
              }, txDb);
              await updateRoutineTouchedState({
                routineId: input.routine.id,
                triggerId: input.trigger?.id ?? null,
                triggeredAt,
                status: "skipped",
                nextRunAt,
              }, txDb);
              return withLegacyRoutineRunIssueId(updated ?? createdRun);
            }
            // A cancelled execution is an audit decision, not reusable scheduler
            // capacity. Re-opening it loses the cancellation history and was the
            // direct cause of the fallback-monitor duplicate rail recurrence.
            // Keep it terminal and create a new, explicitly linked execution below.
            if (reusableIssue.status === "cancelled") {
              cancelledReuseSource = reusableIssue;
            } else {
              reusedIssueSnapshot = reusableIssue;
              executionIssue = await issueSvc.update(reusableIssue.id, {
                projectId,
                goalId: input.routine.goalId,
                parentId: input.routine.parentIssueId,
                title,
                description,
                status: "todo",
                priority: input.routine.priority,
                assigneeAgentId,
                assigneeUserId: null,
                originKind: issueOriginKind,
                originId: issueOriginId,
                originRunId: createdRun.id,
                originFingerprint: persistedOriginFingerprint,
                billingCode: issueBillingCode,
                executionWorkspaceId: input.executionWorkspaceId ?? null,
                executionWorkspacePreference: input.executionWorkspacePreference ?? null,
                executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
              }, txDb);
              if (executionIssue) {
                if (reusableIssue.hiddenAt) {
                  await txDb
                    .update(issues)
                    .set({ hiddenAt: null, updatedAt: new Date() })
                    .where(eq(issues.id, reusableIssue.id));
                }
                dispatchStatus = "issue_reused";
              }
            }
          }
        }

        if (!executionIssue) {
          let deduplicatedFallbackMonitorCreate = false;
          try {
            // Unlike issueSvc.update, issueSvc.create takes no tx handle: it runs on the
            // pool. That is load-bearing here — the 23505 recovery below keeps querying
            // txDb after the conflict, which Postgres would refuse had the failing insert
            // run inside this transaction. The catch block compensates by deleting
            // createdIssue instead.
            createdIssue = await issueSvc.create(input.routine.companyId, {
              projectId,
              projectWorkspaceId,
              goalId: input.routine.goalId,
              parentId: input.routine.parentIssueId,
              title,
              description: cancelledReuseSource
                ? [
                    description ?? "",
                    "",
                    `Replacement for cancelled routine execution ${cancelledReuseSource.identifier}.`,
                  ].join("\n").trim()
                : description,
              status: "todo",
              priority: input.routine.priority,
              assigneeAgentId,
              createdByAgentId: input.source === "manual" ? input.actor?.agentId ?? null : null,
              createdByUserId: manualRunnerUserId,
              responsibleUserId,
              trustExplicitResponsibleUserId: true,
              originKind: issueOriginKind,
              originId: issueOriginId,
              originRunId: createdRun.id,
              // The DB guard is portfolio-facing, but service callers bypass
              // the HTTP route's default `allowDuplicate: false`. Preserve the
              // existing open monitor as the coalesced target rather than
              // falling through to a unique-index failure on a scheduled fire.
              allowDuplicate: isFallbackMonitorExecution ? false : undefined,
              onDeduplicated: () => {
                deduplicatedFallbackMonitorCreate = true;
              },
              // Tie an actionable public courier to the platform's durable
              // issue-create idempotency guard.  A retry after a receipt
              // persistence/callback failure therefore recovers the same
              // destination issue rather than creating another one.
              idempotencyKey: input.courierDelivery && input.idempotencyKey
                ? `courier:${input.routine.id}:${input.idempotencyKey}`
                : null,
              // Manual always_enqueue runs store a per-run-unique fingerprint so
              // re-runs from the same user can coexist. Automated always_enqueue
              // fires must persist the raw dispatchFingerprint so the next fire's
              // fingerprint-based coalesce can see them (TSMC-10038).
              originFingerprint: shouldAlwaysEnqueue && !automatedCoalesce
                ? `${dispatchFingerprint}:${createdRun.id}`
                : dispatchFingerprint,
              billingCode: issueBillingCode,
              executionWorkspaceId: input.executionWorkspaceId ?? null,
              executionWorkspacePreference: input.executionWorkspacePreference ?? null,
              executionWorkspaceSettings: input.executionWorkspaceSettings ?? null,
            });
            executionIssue = createdIssue;
            if (deduplicatedFallbackMonitorCreate) {
              dispatchStatus = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
            }
          } catch (error) {
            const isOpenExecutionConflict =
              !!error &&
              typeof error === "object" &&
              "code" in error &&
              (error as { code?: string }).code === "23505" &&
              "constraint" in error &&
              (error as { constraint?: string }).constraint === "issues_open_routine_execution_uq";
            if (!isOpenExecutionConflict || (shouldAlwaysEnqueue && !automatedCoalesce)) {
              throw error;
            }

            await clearTerminalExecutionIssueLocks(input.routine, txDb, dispatchFingerprint, {
              kind: issueOriginKind,
              id: issueOriginId,
            }, { ignoreFingerprint: coalesceByOriginOnly });
            const existingIssue = await findOpenExecutionIssue(input.routine, txDb, dispatchFingerprint, {
              kind: issueOriginKind,
              id: issueOriginId,
            }, { ignoreFingerprint: coalesceByOriginOnly });
            if (!existingIssue) throw error;
            const status = input.routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
            if (manualRunnerUserId) {
              await touchIssueForUserInbox(txDb, {
                companyId: input.routine.companyId,
                issueId: existingIssue.id,
                userId: manualRunnerUserId,
                touchedAt: triggeredAt,
              });
            }
            if (input.source === "schedule") {
              await addScheduledCoalesceNote({ routine: input.routine, issue: existingIssue, triggeredAt, executor: txDb });
            }
            const updated = await finalizeRun(createdRun.id, {
              status,
              linkedIssueId: existingIssue.id,
              coalescedIntoRunId: existingIssue.originRunId,
              completedAt: triggeredAt,
            }, txDb);
            await updateRoutineTouchedState({
              routineId: input.routine.id,
              triggerId: input.trigger?.id ?? null,
              triggeredAt,
              status,
              issueId: existingIssue.id,
              nextRunAt,
            }, txDb);
            return withLegacyRoutineRunIssueId(updated ?? createdRun);
          }
        }

        if (!executionIssue) {
          throw new Error("Routine dispatch did not produce an execution issue");
        }

        // MC inbound payloads assigned to the CTO are filtered from the
        // persisted originating routine run, never from the issue title/body.
        // Do this before queueing the CTO wake so liveness probes cannot create
        // CEO noise and actionable traffic gets one durable CEO handoff.
        const mcInbound = assignee?.role === "cto" && executionIssue.originKind === "routine_execution"
          ? evaluateMcInboundTriggerPayloadFilter({
              triggerPayload: createdRun.triggerPayload,
              sourceExecutionIssueId: executionIssue.id,
              sourceExecutionIssueIdentifier: executionIssue.identifier,
            })
          : null;
        if (mcInbound?.classification.route === "liveness_done") {
          executionIssue = (await issueSvc.update(executionIssue.id, { status: "done" }, txDb)) ?? executionIssue;
          dispatchStatus = "issue_created";
        } else if (mcInbound?.ceoHandoff) {
          const ceo = await txDb
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.companyId, input.routine.companyId), eq(agents.role, "ceo")))
            .orderBy(asc(agents.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          const plan = mcInbound.ceoHandoff;
          const handoff = await issueSvc.create(input.routine.companyId, {
            projectId,
            goalId: input.routine.goalId,
            parentId: executionIssue.id,
            title: plan.titleHint || "MC inbound CEO handoff",
            description: [
              `MC inbound ${plan.payloadType} requires CEO handling.`,
              `Source CTO execution issue: ${plan.sourceExecutionIssueIdentifier ?? plan.sourceExecutionIssueId ?? "unknown"}.`,
              "",
              "Sanitized operational content:",
              "```json",
              JSON.stringify(plan.sanitizedContent, null, 2),
              "```",
            ].join("\n"),
            status: "todo",
            priority: input.routine.priority,
            assigneeAgentId: ceo?.id ?? null,
            responsibleUserId,
            trustExplicitResponsibleUserId: true,
            originKind: MC_INBOUND_CEO_HANDOFF_ORIGIN_KIND,
            originId: executionIssue.id,
            originRunId: createdRun.id,
            idempotencyKey: `mc-inbound-ceo-handoff:${executionIssue.id}`,
          });
          if (handoff.assigneeAgentId) {
            await queueIssueAssignmentWakeup({
              heartbeat,
              issue: handoff,
              reason: "issue_assigned",
              mutation: "create",
              contextSource: "routine.mc_inbound_ceo_handoff",
              requestedByActorType: "system",
              rethrowOnError: true,
            });
          }
          executionIssue = (await issueSvc.update(executionIssue.id, { status: "done" }, txDb)) ?? executionIssue;
          dispatchStatus = "issue_created";
        }

        // Scheduled terminal-issue reuse must enqueue after commit so the wakeup
        // service reads the reused issue as todo instead of the stale pre-commit
        // terminal row. Fresh issue creation keeps the in-transaction fast path.
        if (executionIssue.status !== "done" && input.source === "schedule" && dispatchStatus === "issue_reused") {
          deferredReuseWake.current = {
            issue: {
              id: executionIssue.id,
              assigneeAgentId: executionIssue.assigneeAgentId,
              status: executionIssue.status,
            },
          };
        } else if (executionIssue.status !== "done") {
          await queueIssueAssignmentWakeup({
            heartbeat,
            issue: executionIssue,
            reason: "issue_assigned",
            mutation: dispatchStatus === "issue_reused" ? "update" : "create",
            contextSource: "routine.dispatch",
            requestedByActorType: input.source === "schedule" ? "system" : undefined,
            rethrowOnError: true,
          });
        }
        const deliveryReceipt = input.courierDelivery && input.idempotencyKey
          ? makeCourierDeliveryReceipt({
              runId: createdRun.id,
              idempotencyKey: input.idempotencyKey,
              issue: executionIssue,
            })
          : null;
        // The receipt write is deliberately part of the dispatch transaction.
        // A run cannot be recorded as delivered/issue_created without it.
        const updated = await finalizeRun(createdRun.id, {
          status: dispatchStatus,
          linkedIssueId: executionIssue.id,
          deliveryReceipt,
        }, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: dispatchStatus,
          issueId: executionIssue.id,
          nextRunAt,
        }, txDb);
        return withLegacyRoutineRunIssueId(updated ?? createdRun);
      } catch (error) {
        if (createdIssue) {
          await txDb.delete(issues).where(eq(issues.id, createdIssue.id));
        }
        if (reusedIssueSnapshot) {
          await restoreReusedTerminalExecutionIssue(reusedIssueSnapshot, txDb);
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
        return withLegacyRoutineRunIssueId(failed ?? createdRun);
      }
    });

    if (deferredReuseWake.current) {
      await queueIssueAssignmentWakeup({
        heartbeat,
        issue: deferredReuseWake.current.issue,
        reason: "issue_assigned",
        mutation: "update",
        contextSource: "routine.dispatch",
        requestedByActorType: "system",
        rethrowOnError: false,
      });
    }

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

    await surfaceRoutineDeadFire({
      routine: input.routine,
      run,
    });

    // Evaluate the run ceiling after the dispatch transaction commits so a hard
    // stop pauses future fires without creating another recovery or courier path.
    await budgetService(db).evaluateRoutineRun(run);

    return withLegacyRoutineRunIssueId(run);
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
          ? getRoutineAgentSummary(row.companyId, row.assigneeAgentId)
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
            deliveryReceipt: routineRuns.deliveryReceipt,
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
            runs.map((run) => withLegacyRoutineRunIssueId({
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
              deliveryReceipt: run.deliveryReceipt,
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
        findOpenExecutionIssue(row),
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
      const parentProjectId = input.projectId == null && input.parentIssueId
        ? await db
          .select({ projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.id, input.parentIssueId)))
          .then((rows) => rows[0]?.projectId ?? null)
        : null;
      const projectId = input.projectId ?? parentProjectId ?? await resolveCompanyPrimaryProjectId(companyId, db);
      if (!projectId) {
        throw unprocessable("Routine requires a project; create an active project before creating a routine");
      }
      await assertProject(companyId, projectId);
      await assertRoutineFolder(companyId, input.folderId ?? null);
      await assertRoutineAssignableAgent(companyId, input.assigneeAgentId ?? null);
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
        const [created] = await txDb
          .insert(routines)
          .values({
            companyId,
            projectId,
            folderId: input.folderId ?? null,
            goalId: input.goalId ?? null,
            parentIssueId: input.parentIssueId ?? null,
            title: input.title,
            description: input.description ?? null,
            assigneeAgentId: input.assigneeAgentId ?? null,
            priority: input.priority,
            status,
            pauseReason: status === "paused" ? input.pauseReason ?? "manual" : null,
            pausedAt: status === "paused" ? new Date() : null,
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
      const nextPauseState = normalizeRoutinePauseState({
        currentStatus: existing.status,
        nextStatus,
        currentPauseReason: existing.pauseReason ?? null,
        requestedPauseReason: patch.pauseReason ?? undefined,
        currentPausedAt: existing.pausedAt,
        now: new Date(),
      });
      const nextVariables = syncRoutineVariablesWithTemplate(
        [nextTitle, nextDescription],
        patch.variables === undefined ? existing.variables : sanitizeRoutineVariableInputs(patch.variables),
      );
      if (patch.projectId !== undefined) await assertProject(existing.companyId, nextProjectId);
      if (patch.folderId !== undefined) await assertRoutineFolder(existing.companyId, nextFolderId);
      if (patch.assigneeAgentId !== undefined || patch.status === "active") {
        await assertRoutineAssignableAgent(existing.companyId, nextAssigneeAgentId);
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
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, id))
          .then((rows) => rows[0] ?? null);
        if (!locked) return null;

        if (patch.baseRevisionId && patch.baseRevisionId !== locked.latestRevisionId) {
          throw conflict("Routine was updated by someone else", {
            currentRevisionId: locked.latestRevisionId,
          });
        }

        const candidate: RoutineRow = {
          ...locked,
          projectId: nextProjectId,
          folderId: nextFolderId,
          goalId: patch.goalId === undefined ? locked.goalId : patch.goalId,
          parentIssueId: patch.parentIssueId === undefined ? locked.parentIssueId : patch.parentIssueId,
          title: nextTitle,
          description: nextDescription,
          assigneeAgentId: nextAssigneeAgentId,
          priority: patch.priority ?? locked.priority,
          status: nextStatus,
          pauseReason: nextPauseState.pauseReason,
          pausedAt: nextPauseState.pausedAt,
          concurrencyPolicy: patch.concurrencyPolicy ?? locked.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? locked.catchUpPolicy,
          activityGatePolicy: patch.activityGatePolicy ?? locked.activityGatePolicy,
          activityGateScope: patch.activityGateScope ?? locked.activityGateScope,
          variables: nextVariables,
          env: nextEnv,
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
            pauseReason: candidate.pauseReason,
            pausedAt: candidate.pausedAt,
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
        await assertScheduleMeetsCadenceFloor(routine, input.cronExpression, timeZone);
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

      const { trigger, revision } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${routine.id} for update`);
        const [createdTrigger] = await txDb
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
        const latestRoutine = await txDb.select().from(routines).where(eq(routines.id, routine.id)).then((rows) => rows[0] ?? routine);
        const appended = await appendRoutineRevision(txDb, latestRoutine, actor, {
          changeSummary: `Created ${input.kind} trigger`,
        });
        return { trigger: createdTrigger, revision: appended.revision };
      });

      return {
        trigger: trigger as RoutineTrigger,
        secretMaterial,
        revision,
      };
    },

    updateTrigger: async (
      id: string,
      patch: UpdateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; revision: RoutineRevision } | null> => {
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
          await assertScheduleMeetsCadenceFloor(routine, cronExpression, timezone);
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
        if ((patch.enabled ?? existing.enabled) === true) {
          assertScheduleCompatibleVariables(routine.variables ?? []);
        }
      }

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        const [updated] = await txDb
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
        if (!updated) return null;
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
        const appended = await appendRoutineRevision(txDb, routine, actor, {
          changeSummary: `Updated ${existing.kind} trigger`,
        });
        return { trigger: updated as RoutineTrigger, revision: appended.revision };
      });
      return result;
    },

    deleteTrigger: async (id: string, actor: Actor = {}): Promise<{ deleted: boolean; revision: RoutineRevision | null }> => {
      const existing = await getTriggerById(id);
      if (!existing) return { deleted: false, revision: null };
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existing.routineId} for update`);
        await txDb.delete(routineTriggers).where(eq(routineTriggers.id, id));
        const routine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existing.routineId))
          .then((rows) => rows[0] ?? null);
        if (!routine) throw notFound("Routine not found");
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

      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(sql`select id from ${routines} where ${routines.id} = ${existingRoutine.id} for update`);
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, existingRoutine.id))
          .then((rows) => rows[0] ?? null);
        if (!locked) throw notFound("Routine not found");
        if (locked.latestRevisionId === targetRevision.id) {
          throw conflict("Selected revision is already the latest revision", {
            currentRevisionId: locked.latestRevisionId,
          });
        }

        const currentTriggers = await txDb
          .select({ id: routineTriggers.id })
          .from(routineTriggers)
          .where(and(eq(routineTriggers.companyId, locked.companyId), eq(routineTriggers.routineId, locked.id)));
        const currentTriggerIds = new Set(currentTriggers.map((trigger) => trigger.id));
        const missingWebhookTriggers = snapshot.triggers
          .filter((trigger) => trigger.kind === "webhook" && !currentTriggerIds.has(trigger.id));
        const recreatedWebhookSecrets = new Map<string, { publicId: string; secretId: string; secretMaterial: RoutineTriggerSecretRestoreMaterial }>();
        for (const trigger of missingWebhookTriggers) {
          const publicId = crypto.randomBytes(12).toString("hex");
          const created = await createWebhookSecret(locked.companyId, locked.id, actor, txDb);
          recreatedWebhookSecrets.set(trigger.id, {
            publicId,
            secretId: created.secret.id,
            secretMaterial: {
              triggerId: trigger.id,
              webhookUrl: `${process.env.PAPERCLIP_API_URL}/api/routine-triggers/public/${publicId}/fire`,
              webhookSecret: created.secretValue,
            },
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

        const snapshotTriggerIds = new Set(snapshot.triggers.map((trigger) => trigger.id));
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

        const appended = await appendRoutineRevision(txDb, restoredRoutine ?? locked, actor, {
          changeSummary: `Restored from revision ${targetRevision.revisionNumber}`,
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
    },

    runRoutine: async (id: string, input: RunRoutine, actor?: Actor) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      await assertProject(routine.companyId, input.projectId ?? null);
      const assigneeAgentId = input.assigneeAgentId ?? routine.assigneeAgentId ?? null;
      await assertRoutineAssignableAgent(routine.companyId, assigneeAgentId);
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

      let hmacReplayKey: string | null = null;
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
        hmacReplayKey = `webhook-hmac:${crypto
          .createHash("sha256")
          .update(`${trigger.id}:${providedTimestamp}:${expectedHmac}`)
          .digest("hex")}`;
      }

      const ignoredKind = classifyNonActionableWebhookPayload(input.payload ?? null);
      // CTO-targeted MC inbound liveness must create and close the execution
      // issue in dispatchRoutineRun. That runtime path records the originating
      // triggerPayload and runs before any CEO handoff; short-circuiting here
      // would leave no terminal execution issue to audit.
      const isCtoTarget = routine.assigneeAgentId
        ? await db
            .select({ role: agents.role })
            .from(agents)
            .where(and(eq(agents.id, routine.assigneeAgentId), eq(agents.companyId, routine.companyId)))
            .then((rows) => rows[0]?.role === "cto")
        : false;
      if (ignoredKind && !isCtoTarget) {
        return recordIgnoredWebhookRun({
          routine,
          trigger,
          payload: input.payload ?? null,
          reason: ignoredKind,
        });
      }

      // TSMC-19355 requires a courier retry to create exactly ONE destination
      // task, and the idempotency key is how that is enforced. Requiring the
      // CALLER to supply one was a breaking wire-contract change: no existing
      // sender does, so every actionable portfolio_directive began 422-ing and
      // the TSMC-10038 coalescing contract broke.
      //
      // Derive one instead. A courier envelope is self-identifying -- it must
      // name its sourceIssue to classify as a courier at all -- so the hash of
      // its canonical payload is stable across retries. That IS the idempotency
      // contract, without breaking any sender. An explicit caller-supplied key
      // still wins, so a sender can scope retries more narrowly than the payload.
      const courierDelivery = isCourierDeliveryPayload(input.payload);
      const effectiveIdempotencyKey = input.idempotencyKey?.trim()
        || (courierDelivery ? deriveCourierIdempotencyKey(input.payload) : input.idempotencyKey);

      const eligibility = await getAutomaticRoutineDispatchEligibility(routine);
      if (!eligibility.eligible) {
        return recordSuppressedAutomaticRun({
          routine,
          trigger,
          source: "webhook",
          reason: "worktree_execution_cutoff",
          idempotencyKey: hmacReplayKey ?? input.idempotencyKey,
          rejectIdempotencyReplay: hmacReplayKey !== null,
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
        idempotencyKey: hmacReplayKey ?? effectiveIdempotencyKey,
        courierDelivery,
        rejectIdempotencyReplay: hmacReplayKey !== null,
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
          deliveryReceipt: routineRuns.deliveryReceipt,
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

      return rows.map((row) => withLegacyRoutineRunIssueId({
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
        deliveryReceipt: row.deliveryReceipt,
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

    cancelSupersededRoutineExecutionIssues,
    reconcileWebhookSecretBindings,

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
          try {
            await dispatchRoutineRun({
              routine: row.routine,
              trigger: row.trigger,
              source: "schedule",
              nextRunAtOverride: claimedNextRunAt,
            });
            triggered += 1;
          } catch (err) {
            const retryAt = computeScheduleDispatchRetryAt(new Date(), claimedNextRunAt);
            await recordFailedScheduleDispatch({
              routine: row.routine,
              trigger: row.trigger,
              error: err,
              nextRunAt: retryAt,
            });
          }
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
          hiddenAt: issues.hiddenAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;

      // Map the execution issue's status onto the routine run's lifecycle.
      // A cancelled execution issue is NOT a run failure: it is almost always a
      // superseded duplicate folded in by inbound coalescing (the auto-cancel
      // cleanup). Recording it as "cancelled" rather than "failed" keeps that
      // benign churn out of the failed-run surfaces and drops the misleading
      // "Execution issue moved to cancelled" failure reason.
      // OPEN_ISSUE_STATUSES already includes "blocked", so a still-open issue of
      // any open status maps back to the active "issue_created" run state.
      let desiredStatus: string;
      let terminal: boolean;
      if (issue.status === "done") {
        desiredStatus = "completed";
        terminal = true;
      } else if (issue.status === "cancelled") {
        desiredStatus = "cancelled";
        terminal = true;
      } else if (OPEN_ISSUE_STATUSES.includes(issue.status)) {
        desiredStatus = "issue_created";
        terminal = false;
      } else {
        return null;
      }

      const current = await db
        .select({
          id: routineRuns.id,
          status: routineRuns.status,
          failureReason: routineRuns.failureReason,
          completedAt: routineRuns.completedAt,
          triggerPayload: routineRuns.triggerPayload,
        })
        .from(routineRuns)
        .where(eq(routineRuns.id, issue.originRunId))
        .then((rows) => rows[0] ?? null);
      if (!current) return null;

      const shouldHide = issue.status === "done"
        && issue.hiddenAt === null
        && await shouldAutoHideCompletedRoutineExecutionIssue(issue.id);

      // Upstream transient-failure bookkeeping (execution_issue_status): a run
      // that an earlier build marked failed because its issue was blocked or
      // cancelled (payload marker or legacy failureReason) gets a clearedAt
      // stamp when the issue completes or returns to an open status. The
      // lifecycle mapping above stays authoritative: blocked stays active and
      // cancelled is recorded as cancelled, never as a run failure.
      const transientFailureStatus = desiredStatus === "cancelled"
        ? null
        : executionIssueTransientFailureStatusFromPayload(current.triggerPayload)
          ?? legacyExecutionIssueTransientFailureStatus(current.failureReason);
      const transientFailureClearedAt = executionIssueTransientFailureClearedAtFromPayload(current.triggerPayload);
      const transientFailurePatch = transientFailureStatus
        ? {
          triggerPayload: {
            ...(current.triggerPayload ?? {}),
            transientFailure: {
              code: EXECUTION_ISSUE_TRANSIENT_FAILURE_CODE,
              status: transientFailureStatus,
              reason: executionIssueTransientFailureReason(transientFailureStatus),
              clearedAt: transientFailureClearedAt ?? new Date().toISOString(),
            },
          },
        }
        : {};
      const transientFailureSettled = !transientFailureStatus || transientFailureClearedAt !== null;

      // Idempotent: skip the write (and its updatedAt churn) when the run already
      // reflects the issue's state. Still re-writes when failure metadata is stale
      // so a reopened/closed issue clears its old failureReason.
      const completedAtSatisfied = terminal ? current.completedAt !== null : current.completedAt === null;
      if (
        current.status === desiredStatus
        && current.failureReason === null
        && completedAtSatisfied
        && transientFailureSettled
      ) {
        if (shouldHide) {
          await hideCompletedRoutineExecutionIssue(issue.id);
        }
        return current;
      }

      const synced = await finalizeRun(issue.originRunId, {
        status: desiredStatus,
        failureReason: null,
        completedAt: terminal ? current.completedAt ?? new Date() : null,
        ...transientFailurePatch,
      });
      if (shouldHide) {
        await hideCompletedRoutineExecutionIssue(issue.id);
      }
      return synced;
    },
  };
}
