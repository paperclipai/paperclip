import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentApiKeys, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { isUuidLike, PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_pluginEventBus) return;
  void _pluginEventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error } of errors) {
      logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
    }
  }).catch(() => {});
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
  issueId?: string | null;
  details?: Record<string, unknown> | null;
  responsibleUserIdOverride?: string | null;
}

export interface ActivityPublication {
  companyId: string;
  payload: Record<string, unknown>;
  pluginEvent: PluginEvent | null;
}

export async function createActivityDetailsRedactor(db: Db) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  return (details: Record<string, unknown> | null) => (
    details ? redactCurrentUserValue(sanitizeRecord(details), currentUserRedactionOptions) : null
  );
}

export async function redactActivityDetails(db: Db, details: Record<string, unknown> | null) {
  if (!details) return null;
  return (await createActivityDetailsRedactor(db))(details);
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolves the heartbeat run alongside its responsible user.
 *
 * The returned `runFound` flag indicates whether the provided `runId` exists in
 * `heartbeat_runs`. Callers that need to satisfy the FK constraint on
 * `activity_log.run_id` (a nullable FK to `heartbeat_runs.id`) must use this to
 * decide whether to persist the run id or null it out. Returning this from the
 * same lookup that already resolves `responsibleUserId` avoids an extra DB round
 * trip on the hot path.
 */
async function resolveHeartbeatRunForActivity(
  db: Db,
  input: LogActivityInput,
): Promise<{ responsibleUserId: string | null; runFound: boolean }> {
  const runId = readNonEmptyString(input.runId);
  if (!runId || !isUuidLike(runId)) return { responsibleUserId: null, runFound: false };

  const run = await db
    .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId)))
    .then((rows) => rows[0] ?? null);

  if (!run) return { responsibleUserId: null, runFound: false };
  return { responsibleUserId: readNonEmptyString(run.responsibleUserId), runFound: true };
}

interface ResolveResponsibleOptions {
  /** Pre-resolved heartbeat run, used to skip an additional DB lookup. */
  preResolvedRun?: { responsibleUserId: string | null; runFound: boolean } | null;
}

export async function resolveResponsibleUserIdForActivity(
  db: Db,
  input: LogActivityInput,
  options: ResolveResponsibleOptions = {},
) {
  if (input.responsibleUserIdOverride !== undefined) {
    return readNonEmptyString(input.responsibleUserIdOverride);
  }
  if (input.actorType === "user") return readNonEmptyString(input.actorId);

  const runInfo = options.preResolvedRun ?? (await resolveHeartbeatRunForActivity(db, input));
  const runResponsibleUserId = runInfo.responsibleUserId;
  if (runResponsibleUserId) return runResponsibleUserId;

  const issueIdCandidate = readNonEmptyString(input.issueId)
    ?? (input.entityType === "issue" ? readNonEmptyString(input.entityId) : null);
  const issueId = isUuidLike(issueIdCandidate) ? issueIdCandidate : null;
  if (issueId) {
    const issue = await db
      .select({
        responsibleUserId: issues.responsibleUserId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, issueId)))
      .then((rows) => rows[0] ?? null);
    const issueResponsibleUserId = readNonEmptyString(issue?.responsibleUserId)
      ?? readNonEmptyString(issue?.createdByUserId);
    if (issueResponsibleUserId) return issueResponsibleUserId;
  }

  const agentApiKeyId = readNonEmptyString(input.agentApiKeyId);
  const agentId = readNonEmptyString(input.agentId);
  if (agentApiKeyId && isUuidLike(agentApiKeyId)) {
    const apiKey = await db
      .select({ responsibleUserId: agentApiKeys.responsibleUserId })
      .from(agentApiKeys)
      .where(and(
        eq(agentApiKeys.companyId, input.companyId),
        eq(agentApiKeys.id, agentApiKeyId),
        ...(agentId && isUuidLike(agentId) ? [eq(agentApiKeys.agentId, agentId)] : []),
      ))
      .then((rows) => rows[0] ?? null);
    const apiKeyResponsibleUserId = readNonEmptyString(apiKey?.responsibleUserId);
    if (apiKeyResponsibleUserId) return apiKeyResponsibleUserId;
  }

  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  return readNonEmptyString(company?.defaultResponsibleUserId);
}

export function publishActivity(publication: ActivityPublication) {
  publishLiveEvent({
    companyId: publication.companyId,
    type: "activity.logged",
    payload: publication.payload,
  });
  if (publication.pluginEvent) publishPluginDomainEvent(publication.pluginEvent);
}

export async function persistActivity(db: Db, input: LogActivityInput) {
  const redactedDetails = await redactActivityDetails(db, input.details ?? null);

  // The activity_log.run_id column is a nullable FK to heartbeat_runs.id.
  // When a caller passes a run id that is not registered (e.g. an out-of-band
  // JWT or an isolated worktree without a heartbeat-run row), the INSERT would
  // fail with a FK violation and surface as a false 500 to the client even
  // when the primary mutation succeeded. Validate the run id here and fall back
  // to null so the activity row is still recorded.
  const resolvedRunInfo = await resolveHeartbeatRunForActivity(db, input);
  const requestedRunId = readNonEmptyString(input.runId);
  let resolvedRunId: string | null = null;
  if (requestedRunId && isUuidLike(requestedRunId)) {
    if (resolvedRunInfo.runFound) {
      resolvedRunId = requestedRunId;
    } else {
      logger.warn(
        {
          companyId: input.companyId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          runId: requestedRunId,
        },
        "activity log runId is not registered as heartbeat_run; storing with null run_id",
      );
    }
  }

  const responsibleUserId = await resolveResponsibleUserIdForActivity(
    db,
    { ...input, runId: resolvedRunId },
    { preResolvedRun: resolvedRunInfo },
  );
  const [activity] = await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: resolvedRunId,
    responsibleUserId,
    details: redactedDetails,
  }).returning({ id: activityLog.id });

  const payload = {
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: resolvedRunId,
    responsibleUserId,
    details: redactedDetails,
  };
  const pluginEventType = eventTypeForActivityAction(input.action);
  const pluginEvent: PluginEvent | null = pluginEventType
    ? {
        eventId: randomUUID(),
        eventType: pluginEventType,
        occurredAt: new Date().toISOString(),
        actorId: input.actorId,
        actorType: input.actorType,
        entityId: input.entityId,
        entityType: input.entityType,
        companyId: input.companyId,
        payload: {
          ...redactedDetails,
          agentId: input.agentId ?? null,
          runId: resolvedRunId,
          responsibleUserId,
        },
      }
    : null;

  return {
    activity,
    publication: {
      companyId: input.companyId,
      payload,
      pluginEvent,
    } satisfies ActivityPublication,
  };
}

export async function logActivity(
  db: Db,
  input: LogActivityInput,
  postCommitPublications?: ActivityPublication[],
) {
  const { activity, publication } = await persistActivity(db, input);
  if (postCommitPublications) {
    postCommitPublications.push(publication);
  } else {
    publishActivity(publication);
  }
  return activity;
}
