import { slackFormEnrollmentActionId, slackFormEnrollmentCompatibleActionIds } from "./form-enrollment-identity.js";
import { acceptSlackFormRetirementLocally, transferSlackFormRetirement } from "./form-retirement-work.js";
import { reconcileSlackFormNormalAck } from "./form-ack-work.js";
import { HttpError } from "../../../errors.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv, PaperclipCloudConnectorError } from "../../paperclip-cloud-connector.js";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, chatPublications, issueThreadInteractions, toolConnections, type Db } from "@paperclipai/db";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { resolveChatQuestionFormOpen, type ResolvedChatQuestionFormOpen } from "../../chat-question-forms.js";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { chatInteractionForm } from "../../chat-interaction-forms.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import { slackFormSetupRecord, parseSlackFormBinding, parseSlackFormPublicEnrollment, projectSlackIssuedFormGrant,
  type SlackFormPublicEnrollment, type SlackFormBinding } from "./cloud-forms.js";
import { slackFormConnectorIdentity, type SlackFormConnectorIdentity } from "./cloud-consumer.js";

type Tx = Pick<Db, "select" | "insert" | "update">;
export type SlackFormProtocol = (input: { subject: string; companyId: string; operation: Record<string, unknown> }) => Promise<unknown>;
function attention(code: string): never { throw new SlackCloudReceiptError(code, "attention"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return attention("form_owner_response_invalid");
  return value as Record<string, unknown>;
}
function matches(binding: SlackFormBinding, enrollment: SlackFormPublicEnrollment) {
  const { credentialFingerprint: _, eventBindingId, ...identity } = binding;
  return eventBindingId === enrollment.bindingId && isDeepStrictEqual({ ...identity, bindingId: eventBindingId }, enrollment);
}
export function projectSlackFormPublicEnrollment(endpoint: typeof chatEndpoints.$inferSelect): SlackFormPublicEnrollment | null {
  const setup = slackFormSetupRecord(endpoint.setup), descriptor = setup.slackCloudEvents;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
    || typeof setup.slackCloudInstanceId !== "string") return null;
  return parseSlackFormPublicEnrollment({ version: 1, instanceId: setup.slackCloudInstanceId, companyId: endpoint.companyId,
    endpointId: endpoint.id, publicId: endpoint.publicId, connectionId: endpoint.connectionId,
    runtimeGeneration: Reflect.get(descriptor, "runtimeGeneration"), bindingId: Reflect.get(descriptor, "bindingId"),
    teamId: Reflect.get(descriptor, "teamId"), appId: Reflect.get(descriptor, "appId") });
}
export async function stageSlackFormEnrollment(tx: Tx, input: { enrollment: SlackFormPublicEnrollment; subject: string; environment: string }): Promise<string> {
  const enrollment = parseSlackFormPublicEnrollment(input.enrollment);
  if (!input.subject || !["development", "test", "staging", "production"].includes(input.environment)) return attention("form_owner_subject_invalid");
  const [endpoint] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, enrollment.endpointId), eq(chatEndpoints.companyId, enrollment.companyId))).for("update");
  const setup: Record<string, unknown> | undefined = endpoint ? slackFormSetupRecord(endpoint.setup) : undefined;
  if (!endpoint || endpoint.provider !== "slack" || !["active", "verifying", "attention"].includes(endpoint.status)
    || endpoint.publicId !== enrollment.publicId || endpoint.connectionId !== enrollment.connectionId
    || setup?.runtimeGeneration !== enrollment.runtimeGeneration || setup?.slackCloudInstanceId !== enrollment.instanceId
    || setup?.slackCloudSubject !== input.subject || !isDeepStrictEqual(projectSlackFormPublicEnrollment(endpoint), enrollment)) return attention("form_owner_current_enrollment_changed");
  const providerActionId = slackFormEnrollmentActionId(enrollment);
  const existingRows = await tx.select().from(chatActions).where(and(eq(chatActions.endpointId, endpoint.id), eq(chatActions.companyId, endpoint.companyId),
    inArray(chatActions.providerActionId, [...slackFormEnrollmentCompatibleActionIds(enrollment)]))).for("update");
  if (existingRows.length > 1) return attention("form_owner_identity_ambiguous");
  const [existing] = existingRows;
  const payload = { enrollment, subject: input.subject, environment: input.environment };
  if (existing) {
    if (existing.kind !== "slack_form_owner" || !Object.keys(payload).every(key => isDeepStrictEqual(existing.payload[key], Reflect.get(payload, key)))) return attention("form_owner_custody_changed");
    return existing.id;
  }
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const [row] = await tx.insert(chatActions).values({ companyId: endpoint.companyId, endpointId: endpoint.id, kind: "slack_form_owner", providerActionId,
    payload, status: "issued", result: { phase: "staged", nextAttemptAt: new Date().toISOString() } }).returning({ id: chatActions.id });
  return row.id;
}
export async function reconcileSlackFormEnrollment(db: Db, input: { actionId: string; identity: SlackFormConnectorIdentity;
  protocol: SlackFormProtocol; resolveBotToken(endpointId: string): Promise<string> }): Promise<void> {
  const [row] = await db.select().from(chatActions).where(and(eq(chatActions.id, input.actionId), eq(chatActions.kind, "slack_form_owner"))).limit(1);
  if (!row || row.result?.phase === "transferred") return;
  const enrollment = parseSlackFormPublicEnrollment(row.payload.enrollment), subject = row.payload.subject;
  if (enrollment.companyId !== row.companyId || enrollment.endpointId !== row.endpointId || enrollment.instanceId !== input.identity.instanceId
    || row.payload.environment !== input.identity.environment || typeof subject !== "string" || !subject) return attention("form_owner_identity_changed");
  if (row.result?.phase === "retirement_accepted" || row.result?.phase === "retirement_gc_pending") return transferSlackFormRetirement(db, row, input.identity, input.protocol);
  const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId))).limit(1);
  const endpointSetup: Record<string, unknown> | undefined = endpoint ? slackFormSetupRecord(endpoint.setup) : undefined;
  const live = row.result?.desiredActive !== false && endpoint && ["active", "verifying", "attention"].includes(endpoint.status) && endpointSetup?.runtimeGeneration === enrollment.runtimeGeneration
    && endpointSetup?.slackCloudInstanceId === enrollment.instanceId && endpointSetup?.slackCloudSubject === subject && isDeepStrictEqual(projectSlackFormPublicEnrollment(endpoint), enrollment);
  let binding: SlackFormBinding;
  if (row.payload.binding !== undefined) binding = parseSlackFormBinding(row.payload.binding);
  else {
    const response = object(await input.protocol({ subject, companyId: row.companyId, operation: live
      ? { kind: "enroll", enrollment, botToken: await input.resolveBotToken(row.endpointId) }
      : { kind: "owner-receipt", enrollment } }));
    if (!live && response.kind === "retired-enrollment") {
      if (typeof response.retirementReceiptJws !== "string") throw new SlackCloudReceiptError("form_retirement_receipt_missing", "retry");
      await acceptSlackFormRetirementLocally(db, row, input.identity, response.retirementReceiptJws);
      return;
    }
    binding = parseSlackFormBinding(response.binding);
  }
  if (!matches(binding, enrollment)) return attention("form_owner_binding_changed");
  if (row.payload.binding === undefined) {
    await db.transaction(async tx => {
    const [current] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId))).for("update");
    const [intent] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId))).for("update");
    if (!intent || !isDeepStrictEqual(intent.payload, row.payload) || !isDeepStrictEqual(intent.result, row.result)) throw new SlackCloudReceiptError("form_owner_intent_changed", "retry");
    const currentSetup: Record<string, unknown> | undefined = current ? slackFormSetupRecord(current.setup) : undefined;
    const currentLive = intent.result?.desiredActive !== false && current && ["active", "verifying", "attention"].includes(current.status) && currentSetup?.runtimeGeneration === enrollment.runtimeGeneration
      && currentSetup?.slackCloudInstanceId === enrollment.instanceId && currentSetup?.slackCloudSubject === subject && isDeepStrictEqual(projectSlackFormPublicEnrollment(current), enrollment);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    await tx.update(chatActions).set({ payload: { ...intent.payload, binding }, result: { phase: currentLive ? "enrolled" : "retired_cleanup", nextAttemptAt: currentLive ? null : new Date().toISOString() }, updatedAt: new Date() }).where(eq(chatActions.id, intent.id));
    if (currentLive) await tx.update(chatEndpoints).set({ setup: sql`jsonb_set(${chatEndpoints.setup}, '{slackCloudForms}', ${JSON.stringify(binding)}::jsonb)` }).where(and(eq(chatEndpoints.id, current.id), eq(chatEndpoints.companyId, current.companyId)));
    });
    return;
  }
  if (!live) {
    await input.protocol({ subject, companyId: row.companyId, operation: { kind: "retire", binding } });
    const response = object(await input.protocol({ subject, companyId: row.companyId, operation: { kind: "cleanup", binding } }));
    if (response.cleaned !== true) throw new SlackCloudReceiptError("form_owner_retained_resource", "retry");
    if (response.instanceId !== input.identity.instanceId || response.environment !== input.identity.environment
      || !isDeepStrictEqual(response.binding, binding)) return attention("form_owner_retirement_receipt_changed");
    if (typeof response.retirementReceiptJws !== "string") throw new SlackCloudReceiptError("form_retirement_receipt_missing", "retry");
    await acceptSlackFormRetirementLocally(db, row, input.identity, response.retirementReceiptJws);
  }
}
export async function stageSlackFormGrant(tx: Tx, input: { binding: SlackFormBinding; environment: string; subject: string; resolved: ResolvedChatQuestionFormOpen }) {
  const grant = await projectSlackIssuedFormGrant(tx, input.binding, input.resolved);
  if (!grant) return attention("form_grant_issued_authority_changed");
  const [owner] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, input.binding.companyId), eq(chatActions.endpointId, input.binding.endpointId),
    eq(chatActions.kind, "slack_form_owner"), sql`${chatActions.payload}->'binding' = ${JSON.stringify(input.binding)}::jsonb`, sql`${chatActions.result}->>'phase' = 'enrolled'`)).for("update");
  if (!owner || owner.payload.environment !== input.environment || owner.payload.subject !== input.subject) return attention("form_grant_owner_changed");
  const providerActionId = `slack-form-grant:${grant.grantId}`;
  const [existing] = await tx.select().from(chatActions).where(and(eq(chatActions.endpointId, input.binding.endpointId), eq(chatActions.companyId, input.binding.companyId), eq(chatActions.providerActionId, providerActionId))).for("update");
  if (existing) { if (!isDeepStrictEqual(existing.payload.grant, grant)) return attention("form_grant_custody_changed"); return existing.id; }
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const [row] = await tx.insert(chatActions).values({ companyId: input.binding.companyId, endpointId: input.binding.endpointId, conversationId: grant.conversationId,
    kind: "slack_form_grant", providerActionId, payload: { grant, binding: input.binding, subject: input.subject, environment: input.environment },
    status: "issued", result: { phase: "staged", nextAttemptAt: new Date().toISOString() } }).returning({ id: chatActions.id });
  return row.id;
}
export async function publishSlackFormGrant(db: Db, actionId: string, identity: SlackFormConnectorIdentity, protocol: SlackFormProtocol) {
  const [row] = await db.select().from(chatActions).where(and(eq(chatActions.id, actionId), eq(chatActions.kind, "slack_form_grant"))).limit(1);
  if (!row || ["published", "transferred"].includes(String(row.result?.phase))) return;
  const binding = parseSlackFormBinding(row.payload.binding);
  if (binding.instanceId !== identity.instanceId || row.payload.environment !== identity.environment || binding.companyId !== row.companyId
    || binding.endpointId !== row.endpointId || typeof row.payload.subject !== "string") return attention("form_grant_identity_changed");
  const response = object(await protocol({ subject: row.payload.subject, companyId: row.companyId, operation: { kind: "grant", grant: row.payload.grant } }));
  if (!isDeepStrictEqual(response.grant, row.payload.grant)) return attention("form_grant_receipt_changed");
  await db.transaction(async tx => {
    const [current] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId))).for("update");
    if (!current || !isDeepStrictEqual(current.payload, row.payload)) throw new SlackCloudReceiptError("form_grant_intent_changed", "retry");
    if (current.result?.phase === "transferred") return;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    await tx.update(chatActions).set({ status: "processed", result: { phase: "published", nextAttemptAt: null }, updatedAt: new Date() }).where(eq(chatActions.id, row.id));
  });
}

export async function stageSlackFormOwnerConfiguration(tx: Tx, endpointId: string, active: boolean, subject: string, identity: SlackFormConnectorIdentity) {
  const [endpoint] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)).for("update");
  if (!endpoint || endpoint.provider !== "slack") return;
  const setup = slackFormSetupRecord(endpoint.setup);
  if (active) {
    const enrollment = projectSlackFormPublicEnrollment(endpoint);
    if (!enrollment || enrollment.instanceId !== identity.instanceId || setup.slackCloudSubject !== subject) return attention("form_owner_event_enrollment_unsettled");
    await stageSlackFormEnrollment(tx, { enrollment, subject, environment: identity.environment });
    await rearmSlackFormAttention(tx, { enrollment, subject, environment: identity.environment });
    const previous = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, endpoint.companyId), eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.kind, "slack_form_owner"))).for("update");
    for (const row of previous) {
      const prior = parseSlackFormPublicEnrollment(row.payload.enrollment);
      if (prior.companyId !== endpoint.companyId || prior.endpointId !== endpoint.id || prior.instanceId !== identity.instanceId
        || row.payload.environment !== identity.environment || typeof row.payload.subject !== "string" || !row.payload.subject
        || prior.runtimeGeneration >= enrollment.runtimeGeneration || ["transferred", "retirement_accepted", "retirement_gc_pending"].includes(String(row.result?.phase))) continue;
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
      await tx.update(chatActions).set({ status: "issued", result: { ...row.result, desiredActive: false,
        phase: row.payload.binding ? "retired_cleanup" : "staged", nextAttemptAt: new Date().toISOString() }, updatedAt: new Date() })
        .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, endpoint.companyId), eq(chatActions.endpointId, endpoint.id),
          sql`${chatActions.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`));
    }
    return;
  }
  const [connection] = await tx.select().from(toolConnections).where(and(eq(toolConnections.id, endpoint.connectionId), eq(toolConnections.companyId, endpoint.companyId))).limit(1);
  const rows = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, endpoint.companyId), eq(chatActions.endpointId, endpoint.id),
    eq(chatActions.kind, "slack_form_owner"))).for("update");
  for (const row of rows) {
    const enrollment = parseSlackFormPublicEnrollment(row.payload.enrollment);
    if (enrollment.instanceId !== identity.instanceId || row.payload.environment !== identity.environment || typeof row.payload.subject !== "string"
      || enrollment.runtimeGeneration > Number(setup.runtimeGeneration) || ["transferred", "retirement_accepted", "retirement_gc_pending"].includes(String(row.result?.phase))) continue;
    if (["active", "verifying", "attention"].includes(endpoint.status) && connection?.status === "active" && connection.enabled
      && enrollment.runtimeGeneration === setup.runtimeGeneration && setup.slackCloudRetiredGeneration !== enrollment.runtimeGeneration
      && isDeepStrictEqual(projectSlackFormPublicEnrollment(endpoint), enrollment)) continue;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    await tx.update(chatActions).set({ status: "issued", result: { ...row.result, desiredActive: false,
      phase: row.payload.binding ? "retired_cleanup" : "staged", nextAttemptAt: new Date().toISOString() }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId)));
  }
}
export async function reconcilePendingSlackFormWork(db: Db, input: { identity: SlackFormConnectorIdentity | null; protocol: SlackFormProtocol;
  resolveBotToken(endpointId: string): Promise<string>; connector?(): unknown; report(code: string, actionId: string): void }, now = new Date()): Promise<number | null> {
  if (!input.identity) return null;
  const eligible = and(sql`${chatActions.kind} in ('slack_form_owner','slack_form_grant','slack_form_session')`,
    sql`${chatActions.payload}->>'environment' = ${input.identity.environment}`,
    sql`coalesce(${chatActions.payload}->'binding'->>'instanceId', ${chatActions.payload}->'enrollment'->>'instanceId') = ${input.identity.instanceId}`,
    sql`${chatActions.result}->>'nextAttemptAt' is not null`);
  const [row] = await db.select().from(chatActions).where(eligible).orderBy(sql`${chatActions.result}->>'nextAttemptAt'`, chatActions.id).limit(1);
  if (!row) return null;
  const due = typeof row.result?.nextAttemptAt === "string" ? Date.parse(row.result.nextAttemptAt) : Number.NaN;
  if (Number.isFinite(due) && due > now.getTime()) return due;
  try {
    if (!Number.isFinite(due)) attention("form_owner_deadline_invalid");
    if (row.kind === "slack_form_owner") await reconcileSlackFormEnrollment(db, { ...input, identity: input.identity, actionId: row.id });
    else if (row.kind === "slack_form_grant") await publishSlackFormGrant(db, row.id, input.identity, input.protocol);
    else await reconcileSlackFormNormalAck(db, { companyId: row.companyId, actionId: row.id, instanceId: input.identity.instanceId, connector: input.connector?.(), protocol: input.protocol });
  } catch (error) {
    const credentialAttention = error instanceof HttpError && [400, 401, 403, 404, 422].includes(error.status);
    const permanent = credentialAttention || error instanceof SlackCloudReceiptError && error.disposition !== "retry"
      || error instanceof PaperclipCloudConnectorError && ([400, 401, 403, 404].includes(error.status ?? 0)
        || error.status === 409 && ["SLACK_FORM_CUSTODY_MISSING", "SLACK_FORM_INSTANCE_CHANGED", "SLACK_FORM_SUBJECT_CHANGED", "SLACK_FORM_ENROLLMENT_CHANGED", "SLACK_FORM_CREDENTIAL_CHANGED", "SLACK_FORM_RETIREMENT_CHANGED", "SLACK_FORM_RETIREMENT_PROOF_MISSING", "SLACK_FORM_CUSTODY_CHANGED", "SLACK_FORM_CANONICAL_FACT_CHANGED", "SLACK_FORM_CANONICAL_FACT_BUDGET_CHANGED"].includes(error.brokerReason ?? ""));
    const code = credentialAttention ? "form_bot_credential_unavailable" : error instanceof SlackCloudReceiptError ? error.code : permanent ? "form_owner_authority_unavailable" : "form_owner_broker_unavailable";
    try {
      await db.transaction(async tx => {
        const [current] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId))).for("update");
        if (!current || !isDeepStrictEqual(current.payload, row.payload) || !isDeepStrictEqual(current.result, row.result)) return;
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
        const attempts = typeof current.result?.attempts === "number" ? Math.min(current.result.attempts + 1, 1000000) : 1;
        await tx.update(chatActions).set({ status: permanent ? "attention" : current.status, result: { ...current.result, attempts, failureCode: code,
          failureReason: error instanceof PaperclipCloudConnectorError ? error.brokerReason ?? null : null,
          nextAttemptAt: permanent ? null : new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6))).toISOString() }, updatedAt: new Date() }).where(eq(chatActions.id, current.id));
      });
    } catch (writeError) { throw new AggregateError([error, writeError], "Slack form owner failure and durable retry failure"); }
    input.report(code, row.id);
  }
  const [next] = await db.select({ result: chatActions.result }).from(chatActions).where(eligible).orderBy(sql`${chatActions.result}->>'nextAttemptAt'`, chatActions.id).limit(1);
  const nextDue = typeof next?.result?.nextAttemptAt === "string" ? Date.parse(next.result.nextAttemptAt) : Number.NaN;
  return Number.isFinite(nextDue) ? nextDue : null;
}

export async function stageSlackFormPublication(tx: Tx, publicationId: string, interaction: IssueThreadInteraction): Promise<string | null> {
  const [currentInteraction] = await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, interaction.id),
    eq(issueThreadInteractions.companyId, interaction.companyId), eq(issueThreadInteractions.issueId, interaction.issueId), eq(issueThreadInteractions.status, "pending"))).limit(1);
  if (!currentInteraction || !isDeepStrictEqual(currentInteraction.payload, interaction.payload)) return null;
  const [publication] = await tx.select().from(chatPublications).where(and(eq(chatPublications.id, publicationId), eq(chatPublications.companyId, interaction.companyId), eq(chatPublications.issueId, interaction.issueId))).limit(1);
  if (!publication || publication.state !== "published" || !publication.providerMessageId) return null;
  const [endpoint] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, publication.endpointId), eq(chatEndpoints.companyId, publication.companyId))).limit(1);
  if (!endpoint || endpoint.provider !== "slack" || !["active", "verifying", "attention"].includes(endpoint.status)) return null;
  const rawBinding = slackFormSetupRecord(endpoint.setup).slackCloudForms;
  if (!rawBinding) return null;
  const binding = parseSlackFormBinding(rawBinding), form = chatInteractionForm(interaction, "slack");
  if (!form || form.status !== "pending") return null;
  const [owner] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, endpoint.companyId), eq(chatActions.endpointId, endpoint.id),
    eq(chatActions.kind, "slack_form_owner"), sql`${chatActions.payload}->'binding' = ${JSON.stringify(binding)}::jsonb`, sql`${chatActions.result}->>'phase' = 'enrolled'`)).limit(1);
  if (!owner || typeof owner.payload.environment !== "string" || typeof owner.payload.subject !== "string") return attention("form_grant_owner_missing");
  const [open] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, endpoint.companyId), eq(chatActions.endpointId, endpoint.id),
    eq(chatActions.conversationId, publication.conversationId), eq(chatActions.kind, "question_form_open"), eq(chatActions.status, "issued"),
    sql`${chatActions.payload}->>'publicationId' = ${publication.id}`, sql`${chatActions.payload}->>'interactionId' = ${interaction.id}`)).limit(1);
  if (!open) return null;
  const resolved = await resolveChatQuestionFormOpen(tx, { companyId: endpoint.companyId, endpointId: endpoint.id,
    conversationId: publication.conversationId, interaction: form, openActionId: open.providerActionId });
  if (!resolved) return attention("form_grant_current_question_changed");
  return stageSlackFormGrant(tx, { binding, environment: owner.payload.environment, subject: owner.payload.subject, resolved });
}


export function createSlackFormConnectorAccess() {
  let cached: { config: NonNullable<ReturnType<typeof paperclipCloudConnectorConfigFromEnv>>; connector: ReturnType<typeof createPaperclipCloudConnector> } | undefined;
  const connector = () => {
    let config: ReturnType<typeof paperclipCloudConnectorConfigFromEnv>;
    try { config = paperclipCloudConnectorConfigFromEnv(); } catch { return null; }
    if (!config) { cached = undefined; return null; }
    if (!cached || !isDeepStrictEqual(cached.config, config)) cached = { config, connector: createPaperclipCloudConnector({ config }) };
    return cached.connector;
  };
  const protocol: SlackFormProtocol = async input => {
    const current = connector(), identity = slackFormConnectorIdentity(current);
    if (!current || !identity) return attention("form_connector_unavailable");
    const operation = Reflect.get(current, "slackFormOperation");
    if (typeof operation !== "function") return attention("form_connector_unsupported");
    return Reflect.apply(operation, current, [input]);
  };
  return { connector, protocol, identity: () => slackFormConnectorIdentity(connector()) };
}

const formWorkOwners = new WeakMap<Db, (now: Date) => Promise<number | null>>();
export function registerSlackFormWorkOwner(db: Db, owner: (now: Date) => Promise<number | null>) {
  formWorkOwners.set(db, owner);
  return () => { if (formWorkOwners.get(db) === owner) formWorkOwners.delete(db); };
}
export function reconcileRegisteredSlackFormWork(db: Db, now: Date): Promise<number | null> {
  return formWorkOwners.get(db)?.(now) ?? Promise.resolve(null);
}

export function slackFormAttentionCanRearm(input: { code: unknown; binding: unknown; enrollment: unknown }): boolean {
  const recoverable = ["form_bot_credential_unavailable", "form_opening_cipher_unavailable", "form_submission_cipher_unavailable",
    "form_connector_unsupported", "form_ack_receipts_unsupported", "form_ack_acceptance_missing", "form_owner_broker_unavailable"];
  if (typeof input.code !== "string" || !recoverable.includes(input.code)) return false;
  try {
    const binding = parseSlackFormBinding(input.binding), enrollment = parseSlackFormPublicEnrollment(input.enrollment);
    return matches(binding, enrollment);
  } catch { return false; }
}
export async function rearmSlackFormAttention(tx: Tx, input: { enrollment: SlackFormPublicEnrollment; subject: string; environment: string }): Promise<number> {
  const enrollment = parseSlackFormPublicEnrollment(input.enrollment);
  const [endpoint] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, enrollment.endpointId), eq(chatEndpoints.companyId, enrollment.companyId))).for("update");
  if (!endpoint || endpoint.provider !== "slack" || !isDeepStrictEqual(projectSlackFormPublicEnrollment(endpoint), enrollment)
    || slackFormSetupRecord(endpoint.setup).slackCloudSubject !== input.subject) return 0;
  const rows = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, enrollment.companyId), eq(chatActions.endpointId, enrollment.endpointId),
    eq(chatActions.status, "attention"), sql`${chatActions.kind} in ('slack_form_owner','slack_form_grant','slack_form_session')`)).for("update");
  let count = 0;
  for (const row of rows) {
    if (row.payload.environment !== input.environment || row.result?.nextAttemptAt !== null) continue;
    const binding = row.kind === "slack_form_owner" ? row.payload.binding : row.kind === "slack_form_grant"
      ? row.payload.grant && typeof row.payload.grant === "object" ? Reflect.get(row.payload.grant, "binding") : undefined : row.payload.binding;
    if (row.payload.subject !== undefined && row.payload.subject !== input.subject) continue;
    if (row.kind === "slack_form_owner" && binding === undefined) {
      if (row.result?.failureCode !== "form_bot_credential_unavailable") continue;
      try { if (!isDeepStrictEqual(parseSlackFormPublicEnrollment(row.payload.enrollment), enrollment)) continue; } catch { continue; }
    } else if (!slackFormAttentionCanRearm({ code: row.result?.failureCode, binding, enrollment })) continue;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const phase = row.result?.phase;
    const status = row.kind === "slack_form_session" && phase === "submitted" ? "processed" : row.kind === "slack_form_session" && phase === "not_opened" ? "failed" : row.kind === "slack_form_session" && phase === "closed" ? "cancelled" : "issued";
    const updated = await tx.update(chatActions).set({ status, result: { ...row.result, firstFailureCode: row.result?.firstFailureCode ?? row.result?.failureCode,
      nextAttemptAt: new Date().toISOString() }, updatedAt: new Date() }).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, enrollment.companyId),
      eq(chatActions.endpointId, enrollment.endpointId), sql`${chatActions.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
    count += updated.length;
  }
  return count;
}
