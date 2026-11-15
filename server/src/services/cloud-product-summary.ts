import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { AI_PROVIDERS, getConnectableAppDefinition } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { RESTART_CLASS_FAILURE_CODES } from "./continuation-cause.js";

export const CLOUD_PRODUCT_SUMMARY_VERSION = 1;
export const CLOUD_PRODUCT_SUMMARY_COUNT_CAP = 10_000;
export const CLOUD_PRODUCT_SUMMARY_RECENT_RUNS = 20;
export const CLOUD_PRODUCT_SUMMARY_SECTION_TIMEOUT_MS = 2_000;
export const CLOUD_PRODUCT_SUMMARY_BUDGET_MS = 6_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const SETUP_LIST_CAP = 50;
const ACTIVITY_LOOKBACK_DAYS = 90;
const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export const cloudProductSummaryQuerySchema = z.object({
  since: z
    .string()
    .regex(SINCE_PATTERN)
    .refine((value) => Number.isFinite(Date.parse(value)))
    .optional(),
});

export const CLOUD_PRODUCT_CAPABILITIES = [
  "modelConnected",
  "connectorSetUp",
  "agentCreated",
  "secondAgentCreated",
  "planCreated",
  "planApproved",
  "onboardingTaskCompleted",
  "ownTaskCompleted",
  "routineTaskCompleted",
  "artifactCreated",
  "routineCreated",
  "routineRun",
] as const;

export type CloudProductCapability = (typeof CLOUD_PRODUCT_CAPABILITIES)[number];

export const CLOUD_RUN_FAILURE_CLASSES = [
  "missing_access",
  "provider_limit",
  "waiting_on_person",
  "execution_failure",
  "stopped",
  "other",
] as const;

export type CloudRunFailureClass = (typeof CLOUD_RUN_FAILURE_CLASSES)[number];

export type CloudProductSummaryState = "ok" | "unknown";

export interface CloudProductCapabilityState {
  state: "yes" | "no" | "unknown";
  firstAt: string | null;
  beforeSince: boolean;
}

export interface CloudProductRunWindow {
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  failuresByClass: Partial<Record<CloudRunFailureClass, number>>;
}

export interface CloudProductRecentRun {
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  failureClass: CloudRunFailureClass | null;
  endedAt: string;
}

export interface CloudProductSummary {
  version: number;
  generatedAt: string;
  since: string | null;
  capabilities: Record<CloudProductCapability, CloudProductCapabilityState>;
  runs: { state: CloudProductSummaryState; day: CloudProductRunWindow; week: CloudProductRunWindow; recent: CloudProductRecentRun[] };
  waiting: { state: CloudProductSummaryState; blockedTasks: number; oldestBlockedAt: string | null };
  activity: {
    state: CloudProductSummaryState;
    lastPersonActivityAt: string | null;
    tasksCompletedWeek: number;
    tasksCompletedMonth: number;
    routineRunsWeek: number;
    routineRunsMonth: number;
  };
  setup: { state: CloudProductSummaryState; modelProviders: string[]; connectors: string[] };
}

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

export function cloudRunFailureClass(errorCode: string | null | undefined): CloudRunFailureClass {
  return (errorCode ? RUN_FAILURE_CLASS_BY_CODE.get(errorCode) : undefined) ?? "other";
}

const RUN_OUTCOME_BY_STATUS: Readonly<Record<string, CloudProductRecentRun["outcome"]>> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "cancelled",
  timed_out: "timed_out",
};

const FINAL_RUN_STATUSES = sql`('succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out')`;
const CUSTOMER_AGENT = sql`(a.metadata -> 'paperclipBuiltInAgent' ->> 'key') is null`;
const CUSTOMER_ROUTINE = sql`r.origin_kind <> 'built_in_agent_bundle' and not exists (
  select 1 from built_in_managed_resources b where b.resource_kind = 'routine' and b.resource_id = r.id
)`;
const ONBOARDING_TASK = sql`(i.origin_kind = 'onboarding_first_task' or exists (
  select 1 from company_onboarding_seeds s where s.issue_id = i.id
))`;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = Record<string, unknown>;

function iso(expression: SQL): SQL {
  return sql`to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

class CloudProductSummaryDeadlineError extends Error {
  constructor() {
    super("cloud product summary section passed its deadline");
    this.name = "CloudProductSummaryDeadlineError";
  }
}

const sectionDeadlines = new WeakMap<object, () => boolean>();

async function rows(tx: Tx, query: SQL): Promise<Row[]> {
  if (sectionDeadlines.get(tx)?.()) throw new CloudProductSummaryDeadlineError();
  const result = await tx.execute(query);
  return Array.from(result as Iterable<Row>);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), CLOUD_PRODUCT_SUMMARY_COUNT_CAP) : 0;
}

function unknownCapability(): CloudProductCapabilityState {
  return { state: "unknown", firstAt: null, beforeSince: false };
}

function capability(firstAt: string | null, since: Date | null): CloudProductCapabilityState {
  if (!firstAt) return { state: "no", firstAt: null, beforeSince: false };
  if (since && Date.parse(firstAt) < since.getTime()) return { state: "yes", firstAt: null, beforeSince: true };
  return { state: "yes", firstAt, beforeSince: false };
}

function earliest(values: Array<string | null>): string | null {
  const present = values.filter((value): value is string => value !== null);
  return present.length > 0 ? present.reduce((first, value) => (value < first ? value : first)) : null;
}

function emptyWindow(): CloudProductRunWindow {
  return { succeeded: 0, failed: 0, cancelled: 0, timedOut: 0, failuresByClass: {} };
}

function addRun(window: CloudProductRunWindow, outcome: CloudProductRecentRun["outcome"], errorCode: string | null, total: number) {
  const add = (current: number) => Math.min(current + total, CLOUD_PRODUCT_SUMMARY_COUNT_CAP);
  if (outcome === "succeeded") window.succeeded = add(window.succeeded);
  else if (outcome === "cancelled") window.cancelled = add(window.cancelled);
  else if (outcome === "timed_out") window.timedOut = add(window.timedOut);
  else window.failed = add(window.failed);
  if (outcome === "succeeded") return;
  const failureClass = cloudRunFailureClass(errorCode);
  window.failuresByClass[failureClass] = add(window.failuresByClass[failureClass] ?? 0);
}

interface Context {
  companyId: string;
  since: Date | null;
  now: Date;
}

function windowStart(context: Context, days: number): string {
  const start = context.now.getTime() - days * DAY_MS;
  return new Date(context.since ? Math.max(start, context.since.getTime()) : start).toISOString();
}

async function firstAt(tx: Tx, query: SQL): Promise<string | null> {
  return text((await rows(tx, query))[0]?.first_at);
}

type Capabilities = Record<CloudProductCapability, CloudProductCapabilityState>;

async function readConnections(tx: Tx, context: Context): Promise<Partial<Capabilities>> {
  const [row] = await rows(tx, sql`
    select ${iso(sql`min(created_at) filter (where connection_purpose = 'ai' and status <> 'draft')`)} as model_first_at,
           ${iso(sql`min(created_at) filter (where connection_purpose = 'tool' and status <> 'draft')`)} as connector_first_at
    from tool_connections
    where company_id = ${context.companyId}
  `);
  return {
    modelConnected: capability(text(row?.model_first_at), context.since),
    connectorSetUp: capability(text(row?.connector_first_at), context.since),
  };
}

async function readAgents(tx: Tx, context: Context): Promise<Partial<Capabilities>> {
  const created = await rows(tx, sql`
    select ${iso(sql`a.created_at`)} as first_at
    from agents a
    where a.company_id = ${context.companyId}
      and a.status <> 'pending_approval'
      and ${CUSTOMER_AGENT}
      and not exists (select 1 from company_onboarding_seeds s where s.agent_id = a.id)
    order by a.created_at asc, a.id asc
    limit 2
  `);
  return {
    agentCreated: capability(text(created[0]?.first_at), context.since),
    secondAgentCreated: capability(text(created[1]?.first_at), context.since),
  };
}

async function readPlans(tx: Tx, context: Context): Promise<Partial<Capabilities>> {
  const created = await firstAt(tx, sql`
    select ${iso(sql`created_at`)} as first_at
    from issue_documents
    where company_id = ${context.companyId} and key = 'plan'
    order by created_at asc
    limit 1
  `);
  const approved = await firstAt(tx, sql`
    select ${iso(sql`i.resolved_at`)} as first_at
    from issue_thread_interactions i
    where i.company_id = ${context.companyId}
      and i.kind in ('request_confirmation', 'request_checkbox_confirmation')
      and i.status = 'accepted'
      and i.resolved_at is not null
      and i.result ->> 'outcome' = 'accepted'
      and i.payload #>> '{target,type}' = 'issue_document'
      and btrim(i.payload #>> '{target,key}') = 'plan'
      and nullif(btrim(i.payload #>> '{target,revisionId}'), '') is not null
      and coalesce(nullif(btrim(i.payload #>> '{target,issueId}'), ''), i.issue_id::text) = i.issue_id::text
    order by i.resolved_at asc
    limit 1
  `);
  return { planCreated: capability(created, context.since), planApproved: capability(approved, context.since) };
}

async function readTasks(tx: Tx, context: Context): Promise<Partial<Capabilities>> {
  const firstDone = (condition: SQL) => firstAt(tx, sql`
    select ${iso(sql`i.completed_at`)} as first_at
    from issues i
    where i.company_id = ${context.companyId}
      and i.status = 'done'
      and i.completed_at is not null
      and ${condition}
    order by i.completed_at asc
    limit 1
  `);
  const onboarding = await firstDone(ONBOARDING_TASK);
  const own = await firstDone(sql`i.origin_kind = 'manual' and i.parent_id is null and not ${ONBOARDING_TASK}`);
  const routine = await firstDone(sql`i.origin_kind = 'routine_execution' and not ${ONBOARDING_TASK} and exists (
    select 1 from routines r where r.id::text = i.origin_id and ${CUSTOMER_ROUTINE}
  )`);
  return {
    onboardingTaskCompleted: capability(onboarding, context.since),
    ownTaskCompleted: capability(own, context.since),
    routineTaskCompleted: capability(routine, context.since),
  };
}

async function readArtifacts(tx: Tx, context: Context): Promise<Partial<Capabilities>> {
  const workProduct = await firstAt(tx, sql`
    select ${iso(sql`created_at`)} as first_at from issue_work_products
    where company_id = ${context.companyId} order by created_at asc limit 1
  `);
  const attachment = await firstAt(tx, sql`
    select ${iso(sql`created_at`)} as first_at from issue_attachments
    where company_id = ${context.companyId} order by created_at asc limit 1
  `);
  const document = await firstAt(tx, sql`
    select ${iso(sql`created_at`)} as first_at from issue_documents
    where company_id = ${context.companyId}
      and key not in ('plan', 'continuation-summary', 'pipeline-case-body')
      and key not like 'artifact-review-%'
    order by created_at asc limit 1
  `);
  return { artifactCreated: capability(earliest([workProduct, attachment, document]), context.since) };
}

async function readRoutines(tx: Tx, context: Context): Promise<Partial<Capabilities>> {
  const created = await firstAt(tx, sql`
    select ${iso(sql`r.created_at`)} as first_at from routines r
    where r.company_id = ${context.companyId} and ${CUSTOMER_ROUTINE}
    order by r.created_at asc limit 1
  `);
  const run = await firstAt(tx, sql`
    select ${iso(sql`rr.triggered_at`)} as first_at
    from routine_runs rr
    join routines r on r.id = rr.routine_id
    where rr.company_id = ${context.companyId}
      and rr.status in ('issue_created', 'completed')
      and ${CUSTOMER_ROUTINE}
    order by rr.triggered_at asc limit 1
  `);
  return { routineCreated: capability(created, context.since), routineRun: capability(run, context.since) };
}

const ENDED_AT = sql`coalesce(r.finished_at, r.started_at, r.created_at)`;

async function readRuns(tx: Tx, context: Context): Promise<CloudProductSummary["runs"]> {
  const weekStart = windowStart(context, 7);
  const dayStart = windowStart(context, 1);
  const grouped = await rows(tx, sql`
    select x.status, x.error_code, (x.ended_at >= ${dayStart}::timestamptz) as in_day, count(*)::int as total
    from (
      select r.status, r.error_code, ${ENDED_AT} as ended_at
      from heartbeat_runs r
      join agents a on a.id = r.agent_id
      where r.company_id = ${context.companyId}
        and r.created_at >= ${weekStart}::timestamptz - interval '1 day'
        and r.status in ${FINAL_RUN_STATUSES}
        and ${CUSTOMER_AGENT}
      order by r.created_at desc
      limit ${CLOUD_PRODUCT_SUMMARY_COUNT_CAP}
    ) x
    where x.ended_at >= ${weekStart}::timestamptz
    group by 1, 2, 3
  `);
  const day = emptyWindow();
  const week = emptyWindow();
  for (const row of grouped) {
    const outcome = RUN_OUTCOME_BY_STATUS[String(row.status)];
    if (!outcome) continue;
    const total = count(row.total);
    addRun(week, outcome, text(row.error_code), total);
    if (row.in_day === true) addRun(day, outcome, text(row.error_code), total);
  }
  const latest = await rows(tx, sql`
    select x.status, x.error_code, ${iso(sql`x.ended_at`)} as ended_at
    from (
      select r.status, r.error_code, ${ENDED_AT} as ended_at
      from heartbeat_runs r
      join agents a on a.id = r.agent_id
      where r.company_id = ${context.companyId}
        and r.created_at >= ${weekStart}::timestamptz - interval '1 day'
        and r.status in ${FINAL_RUN_STATUSES}
        and ${CUSTOMER_AGENT}
      order by r.created_at desc
      limit ${CLOUD_PRODUCT_SUMMARY_RECENT_RUNS * 5}
    ) x
    where x.ended_at >= ${weekStart}::timestamptz
    order by x.ended_at desc
    limit ${CLOUD_PRODUCT_SUMMARY_RECENT_RUNS}
  `);
  const recent: CloudProductRecentRun[] = [];
  for (const row of latest) {
    const outcome = RUN_OUTCOME_BY_STATUS[String(row.status)];
    const endedAt = text(row.ended_at);
    if (!outcome || !endedAt) continue;
    recent.push({ outcome, failureClass: outcome === "succeeded" ? null : cloudRunFailureClass(text(row.error_code)), endedAt });
  }
  return { state: "ok", day, week, recent };
}

async function readWaiting(tx: Tx, context: Context): Promise<CloudProductSummary["waiting"]> {
  const [blocked] = await rows(tx, sql`
    select count(*)::int as total from (
      select 1 from issues where company_id = ${context.companyId} and status = 'blocked'
      limit ${CLOUD_PRODUCT_SUMMARY_COUNT_CAP}
    ) x
  `);
  const oldest = await firstAt(tx, sql`
    select ${iso(sql`blocked_transition_at`)} as first_at from issues
    where company_id = ${context.companyId} and status = 'blocked' and blocked_transition_at is not null
    order by blocked_transition_at asc limit 1
  `);
  const visible = oldest && context.since && Date.parse(oldest) < context.since.getTime() ? null : oldest;
  return { state: "ok", blockedTasks: count(blocked?.total), oldestBlockedAt: visible };
}

async function readActivity(tx: Tx, context: Context): Promise<CloudProductSummary["activity"]> {
  const weekStart = windowStart(context, 7);
  const monthStart = windowStart(context, 28);
  const activityStart = windowStart(context, ACTIVITY_LOOKBACK_DAYS);
  const lastPerson = await firstAt(tx, sql`
    select ${iso(sql`created_at`)} as first_at from activity_log
    where company_id = ${context.companyId} and actor_type = 'user' and created_at >= ${activityStart}::timestamptz
    order by created_at desc limit 1
  `);
  const [tasks] = await rows(tx, sql`
    select count(*) filter (where x.completed_at >= ${weekStart}::timestamptz)::int as week, count(*)::int as month
    from (
      select i.completed_at from issues i
      where i.company_id = ${context.companyId} and i.status = 'done' and i.completed_at >= ${monthStart}::timestamptz
      limit ${CLOUD_PRODUCT_SUMMARY_COUNT_CAP}
    ) x
  `);
  const [routineRuns] = await rows(tx, sql`
    select count(*) filter (where x.triggered_at >= ${weekStart}::timestamptz)::int as week, count(*)::int as month
    from (
      select rr.triggered_at
      from routine_runs rr
      join routines r on r.id = rr.routine_id
      where rr.company_id = ${context.companyId}
        and rr.status in ('issue_created', 'completed')
        and rr.triggered_at >= ${monthStart}::timestamptz
        and ${CUSTOMER_ROUTINE}
      limit ${CLOUD_PRODUCT_SUMMARY_COUNT_CAP}
    ) x
  `);
  return {
    state: "ok",
    lastPersonActivityAt: lastPerson,
    tasksCompletedWeek: count(tasks?.week),
    tasksCompletedMonth: count(tasks?.month),
    routineRunsWeek: count(routineRuns?.week),
    routineRunsMonth: count(routineRuns?.month),
  };
}

async function readSetup(tx: Tx, context: Context): Promise<CloudProductSummary["setup"]> {
  const connections = await rows(tx, sql`
    select distinct connection_purpose, config -> 'ai' ->> 'provider' as provider, config ->> 'sourceTemplateKey' as template_key
    from tool_connections
    where company_id = ${context.companyId} and status <> 'draft' and connection_purpose in ('ai', 'tool')
    limit ${SETUP_LIST_CAP * 4}
  `);
  const providers = new Set<string>();
  const connectors = new Set<string>();
  for (const row of connections) {
    if (row.connection_purpose === "ai") {
      const provider = text(row.provider);
      if (provider && (AI_PROVIDERS as readonly string[]).includes(provider)) providers.add(provider);
    } else {
      const key = text(row.template_key);
      connectors.add(key && getConnectableAppDefinition(key) ? key : "custom");
    }
  }
  return {
    state: "ok",
    modelProviders: [...providers].sort().slice(0, SETUP_LIST_CAP),
    connectors: [...connectors].sort().slice(0, SETUP_LIST_CAP),
  };
}

const CAPABILITY_SECTIONS: ReadonlyArray<readonly [string, (tx: Tx, context: Context) => Promise<Partial<Capabilities>>]> = [
  ["connections", readConnections],
  ["agents", readAgents],
  ["plans", readPlans],
  ["tasks", readTasks],
  ["artifacts", readArtifacts],
  ["routines", readRoutines],
];

export interface CloudProductSummaryOptions {
  companyId: string;
  since?: Date | null;
  now?: Date;
  sectionTimeoutMs?: number;
  budgetMs?: number;
  clock?: () => number;
}

export async function buildCloudProductSummary(db: Db, options: CloudProductSummaryOptions): Promise<CloudProductSummary> {
  const clock = options.clock ?? Date.now;
  const now = options.now ?? new Date(clock());
  const context: Context = { companyId: options.companyId, since: options.since ?? null, now };
  const sectionTimeoutMs = Math.max(1, Math.floor(options.sectionTimeoutMs ?? CLOUD_PRODUCT_SUMMARY_SECTION_TIMEOUT_MS));
  const deadline = clock() + (options.budgetMs ?? CLOUD_PRODUCT_SUMMARY_BUDGET_MS);

  async function section<T>(name: string, read: (tx: Tx, context: Context) => Promise<T>): Promise<T | null> {
    const remainingMs = deadline - clock();
    if (remainingMs <= 0) return null;
    const statementTimeoutMs = Math.max(1, Math.min(sectionTimeoutMs, Math.floor(remainingMs)));
    const sectionDeadline = Math.min(deadline, clock() + sectionTimeoutMs);
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local statement_timeout = ${statementTimeoutMs}`));
        sectionDeadlines.set(tx, () => clock() >= sectionDeadline);
        return read(tx, context);
      }, { accessMode: "read only" });
    } catch (err) {
      logger.warn({ section: name, reason: err instanceof Error ? err.name : "unknown" }, "cloud product summary section did not finish");
      return null;
    }
  }

  const capabilities = Object.fromEntries(
    CLOUD_PRODUCT_CAPABILITIES.map((key) => [key, unknownCapability()]),
  ) as Capabilities;
  for (const [name, read] of CAPABILITY_SECTIONS) {
    Object.assign(capabilities, await section(name, read));
  }
  const runs = await section("runs", readRuns);
  const waiting = await section("waiting", readWaiting);
  const activity = await section("activity", readActivity);
  const setup = await section("setup", readSetup);

  return {
    version: CLOUD_PRODUCT_SUMMARY_VERSION,
    generatedAt: now.toISOString(),
    since: context.since ? context.since.toISOString() : null,
    capabilities,
    runs: runs ?? { state: "unknown", day: emptyWindow(), week: emptyWindow(), recent: [] },
    waiting: waiting ?? { state: "unknown", blockedTasks: 0, oldestBlockedAt: null },
    activity: activity ?? {
      state: "unknown",
      lastPersonActivityAt: null,
      tasksCompletedWeek: 0,
      tasksCompletedMonth: 0,
      routineRunsWeek: 0,
      routineRunsMonth: 0,
    },
    setup: setup ?? { state: "unknown", modelProviders: [], connectors: [] },
  };
}

const summariesInFlight = new Map<string, Promise<CloudProductSummary>>();

export function sharedCloudProductSummary(db: Db, options: CloudProductSummaryOptions): Promise<CloudProductSummary> {
  const key = `${options.companyId}|${options.since ? options.since.toISOString() : ""}`;
  const inFlight = summariesInFlight.get(key);
  if (inFlight) return inFlight;
  const summary = buildCloudProductSummary(db, options).finally(() => {
    summariesInFlight.delete(key);
  });
  summariesInFlight.set(key, summary);
  return summary;
}
