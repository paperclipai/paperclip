import { and, asc, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { cloudProductEvents, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { isCloudManagedInstance, type CloudInstanceEnv } from "./cloud-instance.js";

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
] as const;

export type CloudProductEventName = (typeof CLOUD_PRODUCT_EVENT_NAMES)[number];

export type CloudProductEventPropertyValue = string | number | boolean;

export const CLOUD_PRODUCT_EVENT_PAGE_DEFAULT = 200;
export const CLOUD_PRODUCT_EVENT_PAGE_MAX = 500;

export const cloudProductEventQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
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
  nextAfter: number;
  hasMore: boolean;
}

const CLOUD_CONTROL_ACTOR_ID = "paperclip-cloud";
const FIXED_VALUE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPrunedAt = 0;

export function resetCloudProductEventPruneClockForTests() {
  lastPrunedAt = 0;
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

function previousStatus(details: Record<string, unknown>): unknown {
  const previous = details._previous;
  return previous && typeof previous === "object" ? (previous as Record<string, unknown>).status : undefined;
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
      return details.status === "done" && previousStatus(details) !== "done"
        ? { name: "task.completed", properties: {}, describesIssue: true }
        : null;
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
    .select({ originKind: issues.originKind, parentId: issues.parentId })
    .from(issues)
    .where(and(eq(issues.companyId, source.companyId), eq(issues.id, source.entityId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) return {};
  return { ...fixedValues({ origin: issue.originKind }), isSubtask: issue.parentId !== null };
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

export async function listCloudProductEvents(
  db: Db,
  input: { companyId: string; after: number; limit: number },
): Promise<CloudProductEventPage> {
  const rows = await db
    .select()
    .from(cloudProductEvents)
    .where(and(eq(cloudProductEvents.companyId, input.companyId), gt(cloudProductEvents.id, input.after)))
    .orderBy(asc(cloudProductEvents.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
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
    nextAfter: events.length > 0 ? events[events.length - 1]!.sequence : input.after,
    hasMore: rows.length > input.limit,
  };
}
