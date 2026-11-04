import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, toolConnections, type Db } from "@paperclipai/db";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv, PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import type { CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";
import type { createChatCredentials } from "../credentials.js";
import type { InternalSetupState } from "../runtime-types.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { logger } from "../../../middleware/logger.js";

type Intent = NonNullable<InternalSetupState["slackCloudIntent"]>;
class SlackEnrollmentFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

type Owner = (endpointId: string) => Promise<void>;
const owners = new WeakMap<Db, Owner>();

export function registerSlackCloudEnrollmentOwner(db: Db, owner: Owner) {
  owners.set(db, owner);
  return () => { if (owners.get(db) === owner) owners.delete(db); };
}

export async function stageSlackCloudEnrollmentIntent(db: Db, endpointId: string, actorUserId: string | null | undefined) {
  let config: ReturnType<typeof paperclipCloudConnectorConfigFromEnv>;
  try { config = paperclipCloudConnectorConfigFromEnv(); } catch { config = null; }
  const [current] = await db.select({ endpoint: chatEndpoints, connection: toolConnections }).from(chatEndpoints)
    .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
    .where(eq(chatEndpoints.id, endpointId)).limit(1);
  if (!current || current.endpoint.provider !== "slack") return;
  const endpoint = current.endpoint, setup = endpoint.setup as InternalSetupState;
  const subject = actorUserId ?? setup.slackCloudSubject ?? setup.slackCloudIntent?.subject;
  const instanceId = setup.slackCloudInstanceId ?? setup.slackCloudIntent?.instanceId ?? config?.instanceId;
  const generation = Number(setup.runtimeGeneration ?? 0);
  if (!instanceId || !subject || !Number.isSafeInteger(generation) || generation < 1) return;
  const active = ["active", "verifying", "attention"].includes(endpoint.status) && current.connection.status === "active" && current.connection.enabled;
  if (setup.slackCloudIntent?.runtimeGeneration === generation && setup.slackCloudIntent.active === active) return;
  if (active ? setup.slackCloudEvents?.runtimeGeneration === generation : setup.slackCloudRetiredGeneration === generation) return;
  const [registration] = active ? await db.select({ appId: chatSlackRegistrations.appId }).from(chatSlackRegistrations)
    .where(and(eq(chatSlackRegistrations.endpointId, endpointId), eq(chatSlackRegistrations.companyId, endpoint.companyId))).limit(1) : [];
  const appId = registration?.appId ?? setup.slackCloudEvents?.appId;
  if (active && (!appId || !endpoint.providerAccountId)) return;
  const intent: Intent = { version: 1, id: randomUUID(), subject, instanceId, companyId: endpoint.companyId, endpointId,
    publicId: endpoint.publicId, connectionId: endpoint.connectionId, runtimeGeneration: generation, active,
    ...(active ? { appId: appId!, teamId: endpoint.providerAccountId! } : {}), attempts: 0, nextAttemptAt: config ? new Date().toISOString() : null,
    ...(!config ? { failureCode: "connector_configuration_unavailable" } : {}) };
  await notifyDeliveryWork(db, DELIVERY_QUEUES.connectionEvents);
  await db.update(chatEndpoints).set({
    lastError: config ? sql`${chatEndpoints.lastError}` : "Slack Cloud event registration requires attention",
    setup: sql`jsonb_set(jsonb_set(jsonb_set(${chatEndpoints.setup}, '{slackCloudIntent}', ${JSON.stringify(intent)}::jsonb), '{slackCloudSubject}', ${JSON.stringify(subject)}::jsonb), '{slackCloudInstanceId}', ${JSON.stringify(instanceId)}::jsonb)` })
    .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, endpoint.companyId)));
}

export async function reconcilePendingSlackCloudEnrollments(db: Db, now: Date): Promise<number | null> {
  if (!paperclipCloudConnectorConfigFromEnv()) return null;
  const scheduled = and(eq(chatEndpoints.provider, "slack"), sql`${chatEndpoints.setup}->'slackCloudIntent'->>'nextAttemptAt' is not null`);
  const order = sql`${chatEndpoints.setup}->'slackCloudIntent'->>'nextAttemptAt'`;
  const pending = await db.select().from(chatEndpoints).where(scheduled).orderBy(order).limit(1);
  const owner = owners.get(db);
  let next = Number.POSITIVE_INFINITY;
  for (const endpoint of pending) {
    const intent = (endpoint.setup as InternalSetupState).slackCloudIntent!;
    if (intent.nextAttemptAt === null) continue;
    let due = Date.parse(intent.nextAttemptAt);
    if (!Number.isFinite(due)) due = now.getTime();
    if (due <= now.getTime()) {
      if (owner) await owner(endpoint.id);
      else logger.warn({ endpointId: endpoint.id, reason: "slack_enrollment_owner_not_ready" }, "Slack enrollment responsibility retained");
      const [updated] = await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)).limit(1);
      const retained = (updated?.setup as InternalSetupState | undefined)?.slackCloudIntent;
      due = retained?.nextAttemptAt ? Date.parse(retained.nextAttemptAt) : Number.POSITIVE_INFINITY;
      if (!owner) due = now.getTime() + 5_000;
    }
    next = Math.min(next, due);
  }
  if (pending.length > 0) {
    const [earliest] = await db.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(scheduled).orderBy(order).limit(1);
    const due = (earliest?.setup as InternalSetupState | undefined)?.slackCloudIntent?.nextAttemptAt;
    if (due) next = Math.min(next, Number.isFinite(Date.parse(due)) ? Date.parse(due) : now.getTime());
  }
  return Number.isFinite(next) ? next : null;
}

export function createSlackCloudEnrollment(db: Db, options: {
  resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
  runtimeGeneration(setup: InternalSetupState): number;
  connector?: Pick<PaperclipCloudConnector, "slackEventsAvailable" | "slackEventEnrollment">;
}) {
  return async (endpointId: string, _actorUserId: string | null | undefined, lease: CredentialMutationLeaseGuard) => {
    const [current] = await db.select({ endpoint: chatEndpoints, connection: toolConnections }).from(chatEndpoints)
      .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
      .where(eq(chatEndpoints.id, endpointId)).limit(1);
    if (!current || current.endpoint.provider !== "slack") return;
    const endpoint = current.endpoint, setup = endpoint.setup as InternalSetupState, intent = setup.slackCloudIntent;
    const config = paperclipCloudConnectorConfigFromEnv();
    if (!config || !intent) return;
    const identity = { companyId: intent.companyId, endpointId: intent.endpointId, publicId: intent.publicId,
      connectionId: intent.connectionId, runtimeGeneration: intent.runtimeGeneration };
    const active = ["active", "verifying", "attention"].includes(endpoint.status) && current.connection.status === "active" && current.connection.enabled;
    if (identity.companyId !== endpoint.companyId || identity.endpointId !== endpoint.id || identity.publicId !== endpoint.publicId
      || identity.connectionId !== endpoint.connectionId || identity.runtimeGeneration !== options.runtimeGeneration(setup) || intent.active !== active) {
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
        await tx.update(chatEndpoints).set({
          setup: sql`jsonb_set(${chatEndpoints.setup}, '{slackCloudIntent}', ${JSON.stringify({ ...intent, nextAttemptAt: null, failureCode: "intent_authority_changed" })}::jsonb)`,
          lastError: "Slack Cloud event registration requires attention",
        }).where(and(eq(chatEndpoints.id, endpoint.id), eq(chatEndpoints.companyId, endpoint.companyId), sql`${chatEndpoints.setup}->'slackCloudIntent'->>'id'=${intent.id}`));
        await lease.assertOwned(tx);
      });
      logger.warn({ endpointId, reason: "intent_authority_changed" }, "Slack enrollment responsibility retained");
      return;
    }
    const connector = options.connector ?? createPaperclipCloudConnector({ config });
    const commit = async (change: { receipt?: Record<string, unknown>; failure?: string; attention?: boolean; retryAt?: number }) => db.transaction(async tx => {
      await lease.assertOwned(tx);
      const next = change.failure ? { ...intent, attempts: Math.min(intent.attempts + 1, 1_000_000), failureCode: change.failure,
        nextAttemptAt: change.attention ? null : new Date(Math.max(Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(intent.attempts, 6)), change.retryAt ?? 0)).toISOString() } : null;
      const field = intent.active ? "slackCloudEvents" : "slackCloudRetiredGeneration";
      const enrolled = intent.active ? { version: 1, bindingId: change.receipt?.bindingId, runtimeGeneration: intent.runtimeGeneration, teamId: intent.teamId, appId: intent.appId } : intent.runtimeGeneration;
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
      const updated = await tx.update(chatEndpoints).set({
        lastError: change.attention ? "Slack Cloud event registration requires attention" : change.receipt
          ? sql`case when ${chatEndpoints.lastError} = 'Slack Cloud event registration requires attention' then null else ${chatEndpoints.lastError} end` : sql`${chatEndpoints.lastError}`,
        setup: next
        ? sql`jsonb_set(${chatEndpoints.setup}, '{slackCloudIntent}', ${JSON.stringify(next)}::jsonb)`
        : sql`jsonb_set(${chatEndpoints.setup} - 'slackCloudIntent', ARRAY[${field}], ${JSON.stringify(enrolled)}::jsonb)` })
        .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, endpoint.companyId),
          sql`${chatEndpoints.setup}->'slackCloudIntent'->>'id'=${intent.id}`,
          sql`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer,0)=${intent.runtimeGeneration}`)).returning({ id: chatEndpoints.id });
      if (updated.length !== 1) throw new Error("Slack configuration changed before event enrollment committed");
      await lease.assertOwned(tx);
    });
    try {
      await lease.assertOwned();
      if (config.instanceId !== intent.instanceId) { await commit({ failure: "instance_authority_changed", attention: true }); return; }
      if (!await connector.slackEventsAvailable()) { await commit({ failure: "unsupported_capability" }); return; }
      const credentials = intent.active ? await options.resolveCredentials(endpoint, db, ["signingSecret"]) : undefined;
      if (intent.active && !credentials?.signingSecret) throw new SlackEnrollmentFailure("signing_credential_unavailable");
      const receipt = await connector.slackEventEnrollment({ subject: intent.subject, companyId: intent.companyId,
        enrollment: { active: intent.active, ...identity, ...(intent.active ? { teamId: intent.teamId, appId: intent.appId, signingSecret: credentials!.signingSecret } : {}) } });
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new SlackEnrollmentFailure("receipt_unconfirmed");
      const value = receipt as Record<string, unknown>;
      if (value.version !== 1 || value.instanceId !== intent.instanceId || Object.entries(identity).some(([key, expected]) => value[key] !== expected)
        || (intent.active && (value.teamId !== intent.teamId || value.appId !== intent.appId || typeof value.bindingId !== "string" || !/^slack-event:[a-f0-9]{64}$/.test(value.bindingId))))
        throw new SlackEnrollmentFailure("receipt_identity_changed");
      await commit({ receipt: value });
    } catch (error) {
      const conflict = error instanceof PaperclipCloudConnectorError && error.status === 409
        && ["SLACK_ENROLLMENT_GENERATION_CHANGED", "SLACK_ENROLLMENT_IDENTITY_CHANGED", "SLACK_ENROLLMENT_CHANGED", "SLACK_ENROLLMENT_UNSETTLED"].includes(error.brokerReason ?? "");
      const attention = error instanceof SlackEnrollmentFailure || conflict || (error instanceof PaperclipCloudConnectorError && [400, 401, 403].includes(error.status ?? 0));
      const code = error instanceof SlackEnrollmentFailure ? error.code : attention ? "authority_required"
        : error instanceof PaperclipCloudConnectorError && error.brokerReason === "SLACK_ENROLLMENT_DISABLED" ? "enrollment_disabled" : "broker_unavailable";
      await commit({ failure: code, attention, retryAt: error instanceof PaperclipCloudConnectorError ? error.retryAt : undefined });
      logger.warn({ endpointId, reason: code }, "Slack enrollment responsibility retained");
    }
  };
}
