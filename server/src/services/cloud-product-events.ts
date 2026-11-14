import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents, cloudProductEvents, companyOnboardingSeeds, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { logger } from "../middleware/logger.js";
import { isCloudManagedInstance, type CloudInstanceEnv } from "./cloud-instance.js";
import { RESTART_CLASS_FAILURE_CODES } from "./continuation-cause.js";

export const CLOUD_PRODUCT_EVENT_NAMES = [
  "ai_provider.connected",
  "agent.created",
  "plan.created",
  "task.created",
  "task.completed",
  "connector.connected",
  "artifact.created",
  "routine.created",
  "routine.run_triggered",
  "interaction.resolved",
  "project.created",
  "goal.created",
  "skill.added",
  "run.finished",
  "agent.first_run",
  "connector.used",
  "plan.approved",
] as const;

export type CloudProductEventName = (typeof CLOUD_PRODUCT_EVENT_NAMES)[number];

export const DIRECT_CLOUD_PRODUCT_EVENT_NAMES = [
  "run.finished",
  "agent.first_run",
  "connector.used",
  "plan.approved",
] as const satisfies readonly CloudProductEventName[];

export type DirectCloudProductEventName = (typeof DIRECT_CLOUD_PRODUCT_EVENT_NAMES)[number];

export const CLOUD_RUN_FAILURE_CLASSES = [
  "missing_access",
  "provider_limit",
  "waiting_on_person",
  "execution_failure",
  "stopped",
  "other",
] as const;

export type CloudRunFailureClass = (typeof CLOUD_RUN_FAILURE_CLASSES)[number];

export type CloudProductEventPropertyValue = string | number | boolean;

export const CLOUD_PRODUCT_EVENT_PAGE_DEFAULT = 200;
export const CLOUD_PRODUCT_EVENT_PAGE_MAX = 500;

export const CLOUD_PRODUCT_EVENT_START_CURSOR = "0.0";

export interface CloudProductEventCursor {
  transactionId: bigint;
  id: number;
}

export function parseCloudProductEventCursor(value: string): CloudProductEventCursor {
  const [transactionId, id] = value.split(".");
  return { transactionId: BigInt(transactionId!), id: Number(id) };
}

export function formatCloudProductEventCursor(cursor: CloudProductEventCursor): string {
  return `${cursor.transactionId}.${cursor.id}`;
}

export const cloudProductEventQuerySchema = z.object({
  after: z.string().regex(/^\d{1,18}\.\d{1,15}$/).default(CLOUD_PRODUCT_EVENT_START_CURSOR),
  limit: z.coerce.number().int().min(1).max(CLOUD_PRODUCT_EVENT_PAGE_MAX).default(CLOUD_PRODUCT_EVENT_PAGE_DEFAULT),
});

export type CloudProductEventQuery = z.infer<typeof cloudProductEventQuerySchema>;

export interface CloudProductEvent {
  sequence: number;
  eventId: string;
  name: CloudProductEventName;
  occurredAt: string;
  actorType: string;
  actorId: string;
  responsibleUserId: string | null;
  entityType: string;
  entityId: string;
  properties: Record<string, CloudProductEventPropertyValue>;
}

export interface CloudProductEventPage {
  events: CloudProductEvent[];
  nextAfter: string;
  hasMore: boolean;
}

const CLOUD_CONTROL_ACTOR_ID = "paperclip-cloud";
const FIXED_VALUE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPrunedAt = 0;
let connectorUseDay = "";
const connectorUsesOfDay = new Set<string>();

export function resetCloudProductEventPruneClockForTests() {
  lastPrunedAt = 0;
}

export function resetCloudProductEventConnectorUseGuardForTests() {
  connectorUseDay = "";
  connectorUsesOfDay.clear();
}

export interface CloudProductEventSource {
  companyId: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown> | null;
}

type Properties = Record<string, CloudProductEventPropertyValue>;

interface CloudProductEventDraft {
  name: CloudProductEventName;
  properties: Properties;
  describesIssue?: boolean;
}

const INTERACTION_RESULTS: Readonly<Record<string, string>> = {
  "issue.thread_interaction_accepted": "accepted",
  "issue.thread_interaction_rejected": "rejected",
  "issue.thread_interaction_answered": "answered",
};

const SKILL_SOURCES: Readonly<Record<string, string>> = {
  "company.skill_created": "created",
  "company.skill_catalog_installed": "catalog",
};

function fixedValue(value: unknown): string | null {
  return typeof value === "string" && FIXED_VALUE_RE.test(value) ? value : null;
}

function fixedValues(values: Record<string, unknown>): Properties {
  const properties: Properties = {};
  for (const [key, value] of Object.entries(values)) {
    const fixed = fixedValue(value);
    if (fixed) properties[key] = fixed;
  }
  return properties;
}

function previousStatus(details: Record<string, unknown>): string | null {
  const previous = details._previous;
  const nested = previous && typeof previous === "object" ? (previous as Record<string, unknown>).status : undefined;
  const status = nested ?? details.previousStatus;
  return typeof status === "string" ? status : null;
}

function changedToDone(details: Record<string, unknown>): boolean {
  const previous = previousStatus(details);
  return details.status === "done" && previous !== null && previous !== "done";
}

export function draftCloudProductEvent(source: CloudProductEventSource): CloudProductEventDraft | null {
  if (source.actorId === CLOUD_CONTROL_ACTOR_ID) return null;
  const details = source.details ?? {};
  switch (source.action) {
    case "ai_connection.connected":
      return { name: "ai_provider.connected", properties: fixedValues({ provider: details.provider, method: details.method }) };
    case "agent.created":
    case "agent.hire_created":
      return {
        name: "agent.created",
        properties: { ...fixedValues({ role: details.role }), source: source.action === "agent.created" ? "direct" : "hire" },
      };
    case "issue.document_created":
      return details.key === "plan"
        ? { name: "plan.created", properties: {} }
        : { name: "artifact.created", properties: { kind: "document" } };
    case "issue.work_product_created":
      return { name: "artifact.created", properties: { kind: "work_product", ...fixedValues({ type: details.type }) } };
    case "issue.attachment_added":
      return { name: "artifact.created", properties: { kind: "attachment" } };
    case "issue.created":
      return { name: "task.created", properties: {}, describesIssue: true };
    case "issue.updated":
      return changedToDone(details) ? { name: "task.completed", properties: {}, describesIssue: true } : null;
    case "routine.created":
      return { name: "routine.created", properties: {} };
    case "routine.run_triggered":
      return {
        name: "routine.run_triggered",
        properties: {
          ...fixedValues({ source: details.source, status: details.status }),
          ...(typeof details.routineId === "string" && isUuidLike(details.routineId) ? { routineId: details.routineId } : {}),
        },
      };
    case "tool_connection.created":
      return { name: "connector.connected", properties: fixedValues({ transport: details.transport, status: details.status }) };
    case "project.created":
      return { name: "project.created", properties: {} };
    case "goal.created":
      return { name: "goal.created", properties: {} };
    case "company.skill_created":
    case "company.skill_catalog_installed":
      return { name: "skill.added", properties: { source: SKILL_SOURCES[source.action]! } };
    case "issue.thread_interaction_accepted":
    case "issue.thread_interaction_rejected":
    case "issue.thread_interaction_answered":
      return {
        name: "interaction.resolved",
        properties: { ...fixedValues({ kind: details.interactionKind }), result: INTERACTION_RESULTS[source.action]! },
      };
    default:
      return null;
  }
}

async function issueProperties(db: Db, source: CloudProductEventSource): Promise<Properties> {
  if (source.entityType !== "issue" || !isUuidLike(source.entityId)) return {};
  const issue = await db
    .select({ originKind: issues.originKind, parentId: issues.parentId, seededIssueId: companyOnboardingSeeds.issueId })
    .from(issues)
    .leftJoin(companyOnboardingSeeds, and(
      eq(companyOnboardingSeeds.companyId, issues.companyId),
      eq(companyOnboardingSeeds.issueId, issues.id),
    ))
    .where(and(eq(issues.companyId, source.companyId), eq(issues.id, source.entityId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return {};
  return {
    ...fixedValues({ origin: issue.originKind }),
    isSubtask: issue.parentId !== null,
    isOnboarding: issue.originKind === ONBOARDING_FIRST_TASK_ORIGIN_KIND || issue.seededIssueId !== null,
  };
}

async function pruneCloudProductEvents(db: Db, now: number) {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;
  try {
    await db.transaction(async (tx) => {
      await tx.delete(cloudProductEvents).where(lt(cloudProductEvents.occurredAt, new Date(now - RETENTION_MS)));
    });
  } catch (err) {
    logger.warn({ err }, "cloud product event retention did not run");
  }
}

export function hasCloudProductEvent(source: CloudProductEventSource, env: CloudInstanceEnv = process.env): boolean {
  return isCloudManagedInstance(env) && draftCloudProductEvent(source) !== null;
}

export async function recordCloudProductEvent(
  db: Db,
  source: CloudProductEventSource,
  responsibleUserId: string | null,
  options: { env?: CloudInstanceEnv; now?: number } = {},
): Promise<boolean> {
  if (!isCloudManagedInstance(options.env ?? process.env)) return false;
  const draft = draftCloudProductEvent(source);
  if (!draft) return false;
  const properties = draft.describesIssue
    ? { ...draft.properties, ...(await issueProperties(db, source)) }
    : draft.properties;
  await db.insert(cloudProductEvents).values({
    companyId: source.companyId,
    name: draft.name,
    actorType: source.actorType,
    actorId: source.actorId,
    responsibleUserId,
    entityType: source.entityType,
    entityId: source.entityId,
    properties,
  });
  await pruneCloudProductEvents(db, options.now ?? Date.now());
  return true;
}

export interface DirectCloudProductEvent {
  name: DirectCloudProductEventName;
  companyId: string;
  actorType: string;
  actorId: string;
  responsibleUserId: string | null;
  entityType: string;
  entityId: string;
  properties?: Record<string, unknown>;
}

export interface CloudProductEventRecordOptions {
  env?: CloudInstanceEnv;
  now?: number;
}

export interface CloudProductEventAgent {
  id: string;
  companyId: string;
  role: string;
  adapterType: string;
  metadata: unknown;
}

export interface CloudProductEventConnectorUse {
  companyId: string;
  connectionId: string;
  connectorKey: string;
  status: string;
  actorType: string;
  actorId: string | null;
  runId: string | null;
  issueId: string | null;
}

const RUN_OUTCOMES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

const RUN_FAILURE_CODES_BY_CLASS: Readonly<Record<Exclude<CloudRunFailureClass, "other">, readonly string[]>> = {
  stopped: ["cancelled", "operator_cancelled", "operator_interrupted", "issue_cancelled", "issue_paused", "agent_paused"],
  missing_access: [
    "configuration_incomplete", "slack_configuration_incomplete", "signing_secret_unconfigured",
    "user_secret_missing", "user_secret_definition_missing", "user_secret_definition_inactive",
    "github_access_denied", "github_repo_not_accessible", "github_auth_required", "project_access_denied",
    "permission_denied", "responsible_user_unauthorized", "oauth_access_projection_disabled",
    "acpx_auth_required", "codex_auth_required", "claude_auth_required", "provider_auth_failed", "hermes_gateway_auth_failed",
  ],
  provider_limit: ["provider_quota", "provider_limit_wait", "native_provider_usage_limit"],
  waiting_on_person: [
    "native_provider_model_rejected", "provider_tool_definition_invalid", "turn_limit_exhausted",
    "budget_blocked", "budget_hard_stop", "budget_exceeded",
    "approval_required", "formal_approval_unavailable",
  ],
  execution_failure: [
    ...RESTART_CLASS_FAILURE_CODES,
    "adapter_failed", "setup_failed", "timeout", "native_provider_terminal_failed", "provider_transport_failed",
  ],
};

const RUN_FAILURE_CLASS_BY_CODE: ReadonlyMap<string, CloudRunFailureClass> = new Map(
  Object.entries(RUN_FAILURE_CODES_BY_CLASS).flatMap(([failureClass, codes]) =>
    codes.map((code) => [code, failureClass as CloudRunFailureClass] as const)),
);

const RUN_USAGE_KEYS: Readonly<Record<string, readonly string[]>> = {
  inputTokens: ["inputTokens", "input_tokens", "rawInputTokens", "raw_input_tokens"],
  outputTokens: ["outputTokens", "output_tokens", "rawOutputTokens", "raw_output_tokens"],
  cachedTokens: ["cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens"],
};

export function cloudRunFailureClass(errorCode: string | null | undefined): CloudRunFailureClass {
  return (errorCode ? RUN_FAILURE_CLASS_BY_CODE.get(errorCode) : undefined) ?? "other";
}

function directProperties(values: Record<string, unknown>): Properties {
  const properties: Properties = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) properties[key] = value;
    else if (typeof value === "string" && fixedValue(value)) properties[key] = value;
  }
  return properties;
}

function runUsageProperties(usage: unknown): Properties {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const record = usage as Record<string, unknown>;
  const properties: Properties = {};
  for (const [name, keys] of Object.entries(RUN_USAGE_KEYS)) {
    const value = keys.map((key) => record[key]).find((item) => typeof item === "number" && Number.isFinite(item));
    properties[name] = typeof value === "number" ? Math.max(0, Math.floor(value)) : 0;
  }
  return properties;
}

function runModel(usage: unknown, configuredModel: string | null): string | null {
  const reported = usage && typeof usage === "object" ? (usage as Record<string, unknown>).model : null;
  return typeof reported === "string" && reported.trim().length > 0 ? reported.trim() : configuredModel;
}

function recordsCloudProductEvents(options: CloudProductEventRecordOptions): boolean {
  return isCloudManagedInstance(options.env ?? process.env);
}

async function insertDirectCloudProductEvent(
  db: Db,
  event: DirectCloudProductEvent,
  now: number,
  occurredAt?: Date,
): Promise<boolean> {
  if (event.actorId === CLOUD_CONTROL_ACTOR_ID) return false;
  await db.insert(cloudProductEvents).values({
    companyId: event.companyId,
    name: event.name,
    actorType: event.actorType,
    actorId: event.actorId,
    responsibleUserId: event.responsibleUserId,
    entityType: event.entityType,
    entityId: event.entityId,
    properties: directProperties(event.properties ?? {}),
    ...(occurredAt ? { occurredAt } : {}),
  });
  await pruneCloudProductEvents(db, now);
  return true;
}

async function recordBestEffort(name: DirectCloudProductEventName, record: () => Promise<boolean>): Promise<boolean> {
  try {
    return await record();
  } catch (err) {
    logger.warn({ err, name }, "cloud product event was not recorded");
    return false;
  }
}

export async function recordDirectCloudProductEvent(
  db: Db,
  event: DirectCloudProductEvent,
  options: CloudProductEventRecordOptions = {},
): Promise<boolean> {
  if (!recordsCloudProductEvents(options)) return false;
  return recordBestEffort(event.name, () => insertDirectCloudProductEvent(db, event, options.now ?? Date.now()));
}

export async function recordRunFinishedCloudProductEvent(
  db: Db,
  runId: string,
  options: CloudProductEventRecordOptions = {},
): Promise<boolean> {
  if (!recordsCloudProductEvents(options)) return false;
  return recordBestEffort("run.finished", async () => {
    const now = options.now ?? Date.now();
    const run = await db
      .select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        usageJson: heartbeatRuns.usageJson,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        adapterType: agents.adapterType,
        configuredModel: sql<string | null>`${agents.adapterConfig}->>'model'`,
        agentMetadata: agents.metadata,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || !RUN_OUTCOMES.has(run.status) || readBuiltInAgentMarker(run.agentMetadata)) return false;
    return insertDirectCloudProductEvent(db, {
      name: "run.finished",
      companyId: run.companyId,
      actorType: "agent",
      actorId: run.agentId,
      responsibleUserId: run.responsibleUserId,
      entityType: "heartbeat_run",
      entityId: runId,
      properties: {
        outcome: run.status,
        errorCode: run.errorCode,
        failureClass: run.status === "succeeded" ? null : cloudRunFailureClass(run.errorCode),
        adapterType: run.adapterType,
        model: runModel(run.usageJson, run.configuredModel),
        durationSeconds: run.startedAt
          ? Math.max(0, Math.round(((run.finishedAt?.getTime() ?? now) - run.startedAt.getTime()) / 1000))
          : null,
        ...runUsageProperties(run.usageJson),
      },
    }, now);
  });
}

export async function recordAgentFirstRunCloudProductEvent(
  db: Db,
  agent: CloudProductEventAgent,
  options: CloudProductEventRecordOptions = {},
): Promise<boolean> {
  if (!recordsCloudProductEvents(options) || readBuiltInAgentMarker(agent.metadata)) return false;
  return recordBestEffort("agent.first_run", async () => {
    const firstRun = await db
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return insertDirectCloudProductEvent(db, {
      name: "agent.first_run",
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agent.id,
      responsibleUserId: firstRun?.responsibleUserId ?? null,
      entityType: "agent",
      entityId: agent.id,
      properties: { role: agent.role, adapterType: agent.adapterType },
    }, options.now ?? Date.now());
  });
}

async function connectorUseResponsibleUserId(db: Db, use: CloudProductEventConnectorUse): Promise<string | null> {
  if (use.actorType === "user") return use.actorId;
  if (use.runId) {
    const run = await db
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, use.companyId), eq(heartbeatRuns.id, use.runId)))
      .then((rows) => rows[0] ?? null);
    if (run?.responsibleUserId) return run.responsibleUserId;
  }
  if (!use.issueId) return null;
  const issue = await db
    .select({ responsibleUserId: issues.responsibleUserId, createdByUserId: issues.createdByUserId })
    .from(issues)
    .where(and(eq(issues.companyId, use.companyId), eq(issues.id, use.issueId)))
    .then((rows) => rows[0] ?? null);
  return issue?.responsibleUserId ?? issue?.createdByUserId ?? null;
}

export async function recordConnectorUsedCloudProductEvent(
  db: Db,
  use: CloudProductEventConnectorUse,
  options: CloudProductEventRecordOptions = {},
): Promise<boolean> {
  if (!recordsCloudProductEvents(options)) return false;
  const now = options.now ?? Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const guardKey = `${use.companyId}:${use.connectionId}`;
  if (connectorUseDay !== day) {
    connectorUseDay = day;
    connectorUsesOfDay.clear();
  }
  if (connectorUsesOfDay.has(guardKey)) return false;
  connectorUsesOfDay.add(guardKey);
  return recordBestEffort("connector.used", () => db.transaction(async (tx) => {
    const scoped = tx as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`cloud-product-event:connector.used:${guardKey}:${day}`}, 0))`);
    const recorded = await tx
      .select({ id: cloudProductEvents.id })
      .from(cloudProductEvents)
      .where(and(
        eq(cloudProductEvents.companyId, use.companyId),
        eq(cloudProductEvents.name, "connector.used"),
        eq(cloudProductEvents.entityId, use.connectionId),
        gte(cloudProductEvents.occurredAt, new Date(`${day}T00:00:00.000Z`)),
      ))
      .limit(1);
    if (recorded.length > 0) return false;
    return insertDirectCloudProductEvent(scoped, {
      name: "connector.used",
      companyId: use.companyId,
      actorType: use.actorType,
      actorId: use.actorId ?? use.actorType,
      responsibleUserId: await connectorUseResponsibleUserId(scoped, use),
      entityType: "tool_connection",
      entityId: use.connectionId,
      properties: { connectorKey: use.connectorKey, status: use.status },
    }, now, new Date(now));
  }).catch((err: unknown) => {
    connectorUsesOfDay.delete(guardKey);
    throw err;
  }));
}

export async function listCloudProductEvents(
  db: Db,
  input: { companyId: string; after: string; limit: number },
): Promise<CloudProductEventPage> {
  const after = parseCloudProductEventCursor(input.after);
  const rows = await db
    .select()
    .from(cloudProductEvents)
    .where(and(
      eq(cloudProductEvents.companyId, input.companyId),
      sql`${cloudProductEvents.transactionId} < txid_snapshot_xmin(txid_current_snapshot())`,
      sql`(${cloudProductEvents.transactionId}, ${cloudProductEvents.id}) > (${after.transactionId.toString()}::bigint, ${after.id}::bigint)`,
    ))
    .orderBy(asc(cloudProductEvents.transactionId), asc(cloudProductEvents.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const events: CloudProductEvent[] = page.map((row) => ({
    sequence: row.id,
    eventId: row.eventId,
    name: row.name as CloudProductEventName,
    occurredAt: row.occurredAt.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    responsibleUserId: row.responsibleUserId,
    entityType: row.entityType,
    entityId: row.entityId,
    properties: row.properties,
  }));
  return {
    events,
    nextAfter: last ? formatCloudProductEventCursor({ transactionId: last.transactionId, id: last.id }) : input.after,
    hasMore: rows.length > input.limit,
  };
}
