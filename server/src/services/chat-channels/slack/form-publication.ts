import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, chatPublications, toolConnections, type Db } from "@paperclipai/db";
import type { ChatPublicationPreparationWait } from "../publications/preparation.js";
import { chatInteractionForm } from "../../chat-interaction-forms.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import { parseSlackFormBinding, slackFormSetupRecord } from "./cloud-forms.js";
import { issueThreadInteractionService } from "../../issue-thread-interactions.js";
import type { EndpointRow } from "../runtime-types.js";
import { projectSlackFormPublicEnrollment, stageSlackFormPublication } from "./form-owner.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? slackFormSetupRecord(value) : null;
}
function managedFormsExpected(setup: Record<string, unknown>): boolean {
  return setup.slackCloudIntent !== undefined || setup.slackCloudForms !== undefined
    || setup.slackCloudEvents !== undefined || typeof setup.slackCloudInstanceId === "string";
}
function scheduled(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function unavailable(): never {
  // Inconsistent, stopped and attention custody retains the ordinary failure
  // policy and authorized Retry path; only an actual scheduled owner can wait.
  throw new SlackCloudReceiptError("form_publication_enrollment_pending", "retry");
}
const enrollmentWait: ChatPublicationPreparationWait = {
  kind: "wait", reason: "form_publication_enrollment_pending", retryAfterMs: 2_000,
};
export function createSlackFormPublicationStage(db: Db) {
  return async (endpoint: EndpointRow, publication: typeof chatPublications.$inferSelect): Promise<((tx: Tx) => Promise<void>) | ChatPublicationPreparationWait | null> => {
    if (endpoint.provider !== "slack" || !managedFormsExpected(slackFormSetupRecord(endpoint.setup)) || !publication.issueId
      || typeof publication.payload.interactionId !== "string" || publication.companyId !== endpoint.companyId || publication.endpointId !== endpoint.id) return null;
    const interaction = (await issueThreadInteractionService(db).listForIssue(publication.issueId))
      .find(value => value.id === publication.payload.interactionId && value.companyId === endpoint.companyId && value.status === "pending");
    if (!interaction || !chatInteractionForm(interaction, "slack")) return null;
    const [open] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
      eq(chatActions.companyId, endpoint.companyId), eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.conversationId, publication.conversationId), eq(chatActions.kind, "question_form_open"), eq(chatActions.status, "issued"),
      sql`${chatActions.payload}->>'publicationId' = ${publication.id}`, sql`${chatActions.payload}->>'interactionId' = ${interaction.id}`)).limit(1);
    if (!open) return null;
    const [current] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, endpoint.id), eq(chatEndpoints.companyId, endpoint.companyId))).limit(1);
    if (!current || current.provider !== "slack" || !["active", "verifying", "attention"].includes(current.status)
      || current.connectionId !== endpoint.connectionId || current.publicId !== endpoint.publicId) return unavailable();
    const [connection] = await db.select().from(toolConnections).where(and(eq(toolConnections.id, current.connectionId), eq(toolConnections.companyId, current.companyId))).limit(1);
    if (!connection || connection.status !== "active" || !connection.enabled) return unavailable();
    const setup = slackFormSetupRecord(current.setup), generation = setup.runtimeGeneration;
    if (generation !== slackFormSetupRecord(endpoint.setup).runtimeGeneration || !Number.isSafeInteger(generation) || Number(generation) < 1
      || Number.isSafeInteger(setup.slackCloudRetiredGeneration) && Number(setup.slackCloudRetiredGeneration) >= Number(generation)) return unavailable();
    const binding = setup.slackCloudForms === undefined ? undefined : parseSlackFormBinding(setup.slackCloudForms);
    const mayWait = current.status !== "attention";
    const intent = object(setup.slackCloudIntent);
    if (intent) {
      // This is the initial events-enrollment responsibility, before onCommitted
      // can atomically stage the forms owner. A null deadline means attention.
      if (!mayWait || intent.version !== 1 || typeof intent.id !== "string" || !intent.id || intent.active !== true
        || intent.companyId !== current.companyId || intent.endpointId !== current.id || intent.publicId !== current.publicId
        || intent.connectionId !== current.connectionId || intent.runtimeGeneration !== generation || !/^[A-Za-z0-9_-]{43}$/.test(current.publicId)
        || typeof intent.instanceId !== "string" || !intent.instanceId || typeof intent.subject !== "string" || !intent.subject
        || typeof intent.teamId !== "string" || !/^T[A-Z0-9]+$/.test(intent.teamId) || intent.teamId !== current.providerAccountId
        || typeof intent.appId !== "string" || !/^A[A-Z0-9]+$/.test(intent.appId)
        || !scheduled(intent.nextAttemptAt)) return unavailable();
      return enrollmentWait;
    }
    const enrollment = projectSlackFormPublicEnrollment(current);
    if (!enrollment || enrollment.runtimeGeneration !== generation || enrollment.instanceId !== setup.slackCloudInstanceId
      || typeof setup.slackCloudSubject !== "string" || !setup.slackCloudSubject) return unavailable();
    const owners = await db.select().from(chatActions).where(and(eq(chatActions.companyId, current.companyId), eq(chatActions.endpointId, current.id),
      eq(chatActions.kind, "slack_form_owner"), sql`${chatActions.payload}->'enrollment' = ${JSON.stringify(enrollment)}::jsonb`)).limit(2);
    if (owners.length !== 1) return unavailable();
    const [owner] = owners;
    if (!owner || owner.status !== "issued" || owner.result?.desiredActive === false || owner.payload.subject !== setup.slackCloudSubject
      || typeof owner.payload.environment !== "string" || !["development", "test", "staging", "production"].includes(owner.payload.environment)) return unavailable();
    if (mayWait && owner.result?.phase === "staged" && owner.payload.binding === undefined && scheduled(owner.result.nextAttemptAt)) return enrollmentWait;
    if (owner.result?.phase !== "enrolled" || !binding || !isDeepStrictEqual(owner.payload.binding, binding)
      || !isDeepStrictEqual({ version: binding.version, instanceId: binding.instanceId, companyId: binding.companyId, endpointId: binding.endpointId,
        publicId: binding.publicId, connectionId: binding.connectionId, runtimeGeneration: binding.runtimeGeneration,
        teamId: binding.teamId, appId: binding.appId, bindingId: binding.eventBindingId }, enrollment)) return unavailable();
    return async tx => { await stageSlackFormPublication(tx, publication.id, interaction); };
  };
}
