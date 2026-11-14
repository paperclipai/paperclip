import { isSlackFormEnrollmentActionId } from "./form-enrollment-identity.js";
import { parseSlackFormRetirementReceipt, slackFormRetirementHistoryReceipt } from "./ack-retirement-receipt.js";
import { createHash } from "node:crypto";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { createLocalEncryptedCipher } from "../../../secrets/local-encrypted-provider.js";
import type { StoredSecretVersionMaterial } from "../../../secrets/types.js";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, chatExternalPrincipals, chatPublications, type Db } from "@paperclipai/db";
import type { ResolvedChatQuestionFormOpen } from "../../chat-question-forms.js";
import type { CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import { assertSlackFormTerminalAck, parseSlackFormPublicEnrollment, parseSlackFormOperation, currentSlackFormOwnerBinding, parseSlackFormBinding, slackFormSubmissionEvidence, slackIssuedFormGrantId, projectSlackIssuedFormGrant, sameSlackFormBinding, type SlackFormBinding, type SlackFormOperation, type SlackFormView } from "./cloud-forms.js";

type FormTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type SlackFormSessionScope = { companyId: string; endpointId: string; principalId: string; operationId: string };
function fail(code: string): never { throw new SlackCloudReceiptError(code, "attention"); }
export async function stageSlackFormSession(tx: FormTx, input: {
  operation: SlackFormOperation; currentBinding: SlackFormBinding; principalId: string;
  resolved: ResolvedChatQuestionFormOpen; lease: CredentialMutationLeaseGuard; environment: string;
}): Promise<{ kind: "update"; actionId: string; view: SlackFormView } | { kind: "closed" | "retained"; actionId: string }> {
  const { operation: op, currentBinding: binding, resolved } = input;
  await input.lease.assertOwned(tx);
  const [endpoint] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, binding.companyId), eq(chatEndpoints.id, binding.endpointId))).for("update");
  const setup: Record<string, unknown> | undefined = endpoint?.setup && typeof endpoint.setup === "object" && !Array.isArray(endpoint.setup) ? { ...endpoint.setup } : undefined;
  if (!endpoint || endpoint.provider !== "slack" || !["active", "verifying", "attention"].includes(endpoint.status)
    || endpoint.publicId !== binding.publicId || endpoint.connectionId !== binding.connectionId
    || endpoint.providerAccountId !== binding.teamId || setup?.runtimeGeneration !== binding.runtimeGeneration
    || !sameSlackFormBinding(binding, op.binding)) fail("form_current_endpoint_changed");
  const localOwner = currentSlackFormOwnerBinding(setup ?? {});
  if (!localOwner || !sameSlackFormBinding(localOwner, binding)) fail("form_current_enrollment_changed");
  const [principal] = await tx.select().from(chatExternalPrincipals).where(and(eq(chatExternalPrincipals.id, input.principalId),
    eq(chatExternalPrincipals.companyId, binding.companyId), eq(chatExternalPrincipals.provider, "slack"))).limit(1);
  if (!principal || principal.externalId !== op.userId || principal.providerAccountId !== binding.teamId) fail("form_current_principal_changed");
  const grant = await projectSlackIssuedFormGrant(tx, binding, resolved);
  if (!grant || grant.grantId !== op.grantId || grant.interactionId !== resolved.interactionId) fail("form_current_issued_authority_changed");
  const providerActionId = `slack-form-session:${op.id}`;
  const [old] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
    eq(chatActions.providerActionId, providerActionId))).for("update");
  const payload = { version: 1, binding, environment: input.environment, operationId: op.id, grantId: op.grantId, requestDigest: op.requestDigest,
    userId: op.userId, publicationId: grant.publicationId, interactionId: grant.interactionId,
    openActionRowId: grant.openActionRowId, submitActionRowId: grant.submitActionRowId,
    view: op.view ?? op.closed?.view ?? null };
  if (old) {
    if (old.kind !== "slack_form_session" || old.principalId !== principal.id || old.conversationId !== grant.conversationId
      || !isDeepStrictEqual(old.payload, payload)) fail("form_session_identity_changed");
    if (op.closed) {
      await closeSlackFormSession(tx, { companyId: binding.companyId, endpointId: binding.endpointId, principalId: principal.id, operationId: op.id }, op.closed.view);
      return { kind: "closed", actionId: old.id };
    }
    if (old.status === "processing" && old.result?.phase === "update_attempted" && op.phase === "confirmed" && op.view
      && isDeepStrictEqual(old.result.view, op.view)) {
      await input.lease.assertOwned(tx);
      return { kind: "update", actionId: old.id, view: op.view };
    }
    return { kind: old.status === "cancelled" ? "closed" : "retained", actionId: old.id };
  }
  if (["reserved", "attempted"].includes(op.phase) && !op.closed) throw new SlackCloudReceiptError("form_receipt_pending", "retry");
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const [row] = await tx.insert(chatActions).values({ companyId: binding.companyId, endpointId: binding.endpointId, principalId: principal.id,
    conversationId: grant.conversationId, kind: "slack_form_session", providerActionId, payload,
    status: op.closed ? "cancelled" : op.phase === "confirmed" ? "processing" : "attention",
    result: op.closed ? { phase: "closed", view: op.closed.view } : op.phase === "confirmed"
      ? { phase: "update_attempted", view: op.view } : { phase: "provider_outcome_unresolved" } })
    .onConflictDoNothing().returning({ id: chatActions.id });
  if (!row) throw new SlackCloudReceiptError("form_session_claim_changed", "retry");
  await input.lease.assertOwned(tx);
  if (op.closed) await closeSlackFormSession(tx, { companyId: binding.companyId, endpointId: binding.endpointId, principalId: principal.id, operationId: op.id }, op.closed.view);
  return op.closed ? { kind: "closed", actionId: row.id } : op.phase === "confirmed" && op.view
    ? { kind: "update", actionId: row.id, view: op.view } : { kind: "retained", actionId: row.id };
}
export async function confirmSlackFormSessionUpdate(tx: FormTx, scope: SlackFormSessionScope, view: SlackFormView, newHash: string): Promise<boolean> {
  if (!newHash || newHash.length > 200) fail("form_updated_hash_invalid");
  const [row] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, scope.companyId), eq(chatActions.endpointId, scope.endpointId),
    eq(chatActions.principalId, scope.principalId), eq(chatActions.providerActionId, `slack-form-session:${scope.operationId}`), eq(chatActions.kind, "slack_form_session"))).for("update");
  if (!row || row.status !== "processing" || row.result?.phase !== "update_attempted") return false;
  const expected = row.result.view;
  if (!expected || typeof expected !== "object" || Array.isArray(expected) || Reflect.get(expected, "id") !== view.id
    || Reflect.get(expected, "hash") !== view.hash || Reflect.get(expected, "externalId") !== view.externalId) fail("form_updated_view_changed");
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const updated = await tx.update(chatActions).set({ result: { phase: "ready", view: { ...view, hash: newHash } }, updatedAt: new Date() }).where(and(
    eq(chatActions.id, row.id), eq(chatActions.companyId, scope.companyId), eq(chatActions.status, "processing"), sql`${chatActions.result}->>'phase' = 'update_attempted'`)).returning({ id: chatActions.id });
  return updated.length === 1;
}
export async function closeSlackFormSession(tx: FormTx, scope: SlackFormSessionScope, view: SlackFormView): Promise<boolean> {
  const [row] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, scope.companyId), eq(chatActions.endpointId, scope.endpointId),
    eq(chatActions.principalId, scope.principalId), eq(chatActions.providerActionId, `slack-form-session:${scope.operationId}`), eq(chatActions.kind, "slack_form_session"))).for("update");
  if (!row) return false;
  const current = row.result?.view;
  if (!current || typeof current !== "object" || Array.isArray(current) || Reflect.get(current, "id") !== view.id
    || Reflect.get(current, "externalId") !== view.externalId
    || (Reflect.get(current, "hash") !== view.hash && !(row.status === "processing" && row.result?.phase === "update_attempted"))) fail("form_close_view_changed");
  if (row.status === "cancelled" && row.result?.phase === "closed" && row.result.terminalIntent) return true;
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const identity = holdIdentity(row);
  const terminalIntent: SlackFormTerminalIntent = { ...identity, view, outcome: "closed", submitReceiptId: null, rejectionDigest: null, encryptedEvidence: null };
  await tx.update(chatActions).set({ status: "cancelled", result: { phase: "closed", view, terminalIntent }, updatedAt: new Date() }).where(and(
    eq(chatActions.id, row.id), eq(chatActions.companyId, scope.companyId), eq(chatActions.endpointId, scope.endpointId), eq(chatActions.principalId, scope.principalId)));
  return true;
}

export async function slackFormSessionsRequireDelivery(db: Pick<Db, "select">): Promise<boolean> {
  const rows = await db.select({ id: chatActions.id }).from(chatActions).where(and(eq(chatActions.kind, "slack_form_session"),
    sql`(${chatActions.status} in ('processing','attention') OR (${chatActions.result}->'terminalIntent' is not null AND ${chatActions.result}->'cloudProofAcceptance' is null))`)).limit(1);
  return rows.length > 0;
}

export type SlackFormTerminalIntent = {
  version: 1; binding: SlackFormBinding; operationId: string; deliveryId: string; userId: string; grantId: string;
  publicationId: string; interactionId: string; view: SlackFormView | null; appReceiptId: string;
  outcome: "closed" | "submitted" | "no_effect"; submitReceiptId: string | null; rejectionDigest: string | null;
  encryptedEvidence: StoredSecretVersionMaterial | null;
};
export type SlackFormEvidenceCipher = ReturnType<typeof createLocalEncryptedCipher>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("form_terminal_invalid");
  return value as Record<string, unknown>;
}
function holdIdentity(row: Pick<typeof chatActions.$inferSelect, "id" | "payload" | "companyId" | "endpointId" | "providerActionId">) {
  const p = row.payload, binding = parseSlackFormBinding(p.binding);
  if (binding.companyId !== row.companyId || binding.endpointId !== row.endpointId || typeof p.operationId !== "string"
    || !/^[a-f0-9]{64}$/.test(p.operationId) || row.providerActionId !== `slack-form-session:${p.operationId}`
    || ["userId", "grantId", "publicationId", "interactionId"].some(k => typeof p[k] !== "string" || !(p[k] as string).length)) fail("form_hold_identity_changed");
  return { version: 1 as const, binding, operationId: p.operationId, deliveryId: `slack_form_${p.operationId}`, userId: String(p.userId),
    grantId: String(p.grantId), publicationId: String(p.publicationId), interactionId: String(p.interactionId), appReceiptId: row.id };
}
type TerminalIdentity = Pick<SlackFormTerminalIntent, "version" | "binding" | "operationId" | "deliveryId" | "userId" | "grantId" | "publicationId" | "interactionId" | "appReceiptId">;
export function prepareSlackFormSubmissionIntent(identity: TerminalIdentity, view: SlackFormView, submitReceiptId: string,
  original: NonNullable<ReturnType<typeof slackFormSubmissionEvidence>>, cipher: SlackFormEvidenceCipher): SlackFormTerminalIntent {
  let encryptedEvidence: StoredSecretVersionMaterial;
  try { encryptedEvidence = cipher.encrypt(JSON.stringify({ ...identity, kind: "submission", view, submitReceiptId, original })); }
  catch { return fail("form_submission_cipher_unavailable"); }
  return { ...identity, view, outcome: "submitted", submitReceiptId, rejectionDigest: null, encryptedEvidence };
}
export function openSlackFormSubmissionIntent(intent: SlackFormTerminalIntent, cipher: SlackFormEvidenceCipher): {
  acceptedAt: string; rawBody: string; timestamp: string; signature: string;
} {
  let decrypted: Record<string, unknown>;
  try { decrypted = bodyRecord(JSON.parse(cipher.decrypt(bodyRecord(intent.encryptedEvidence)))); }
  catch { return fail("form_submission_cipher_unavailable"); }
  if (intent.outcome !== "submitted" || decrypted.version !== 1 || decrypted.kind !== "submission"
    || ["appReceiptId", "operationId", "deliveryId", "userId", "grantId", "publicationId", "interactionId", "submitReceiptId"].some(k => decrypted[k] !== Reflect.get(intent, k))
    || !sameSlackFormBinding(parseSlackFormBinding(decrypted.binding), intent.binding) || !isDeepStrictEqual(decrypted.view, intent.view)) fail("form_submission_cipher_binding_changed");
  const original = bodyRecord(decrypted.original);
  if (original.endpointId !== intent.binding.endpointId || ["acceptedAt", "rawBody", "timestamp", "signature"].some(k => typeof original[k] !== "string"))
    fail("form_submission_cipher_binding_changed");
  return { acceptedAt: String(original.acceptedAt), rawBody: String(original.rawBody), timestamp: String(original.timestamp), signature: String(original.signature) };
}
export async function stageSlackFormSubmission(tx: FormTx, args: {
  companyId: string; endpointId: string; conversationId: string; principalId: string; authorizedUserId: string; runtimeGeneration: number;
  submitReceiptId: string; publicationId: string; resolved: IssueThreadInteraction; cipher?: SlackFormEvidenceCipher;
}): Promise<string | null> {
  const original = slackFormSubmissionEvidence();
  if (!original) return null;
  if (original.endpointId !== args.endpointId) fail("form_submission_endpoint_changed");
  const payload = bodyRecord(JSON.parse(new URLSearchParams(Buffer.from(original.rawBody, "base64").toString("utf8")).get("payload") ?? "null"));
  const view = bodyRecord(payload.view), user = bodyRecord(payload.user), team = bodyRecord(payload.team);
  if (payload.type !== "view_submission" || typeof view.external_id !== "string" || !/^pc-form-[a-f0-9]{64}$/.test(view.external_id)) fail("form_submission_identity_changed");
  const operationId = view.external_id.slice("pc-form-".length);
  const [hold] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, args.companyId), eq(chatActions.endpointId, args.endpointId),
    eq(chatActions.conversationId, args.conversationId), eq(chatActions.principalId, args.principalId), eq(chatActions.kind, "slack_form_session"),
    eq(chatActions.providerActionId, `slack-form-session:${operationId}`))).for("update");
  if (!hold) fail("form_submission_hold_missing");
  const identity = holdIdentity(hold), expectedView = bodyRecord(hold.result?.view);
  const [endpoint] = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, args.endpointId), eq(chatEndpoints.companyId, args.companyId))).limit(1);
  const setup: Record<string, unknown> | undefined = endpoint?.setup && typeof endpoint.setup === "object" && !Array.isArray(endpoint.setup) ? { ...endpoint.setup } : undefined, owner = setup ? currentSlackFormOwnerBinding(setup) : null;
  if (!endpoint || !owner || !sameSlackFormBinding(owner, identity.binding) || args.runtimeGeneration !== identity.binding.runtimeGeneration
    || setup?.runtimeGeneration !== args.runtimeGeneration || endpoint.connectionId !== identity.binding.connectionId || endpoint.publicId !== identity.binding.publicId)
    fail("form_submission_current_generation_changed");
  const [receipt] = await tx.select().from(chatActions).where(and(eq(chatActions.id, args.submitReceiptId), eq(chatActions.companyId, args.companyId),
    eq(chatActions.endpointId, args.endpointId), eq(chatActions.conversationId, args.conversationId), eq(chatActions.principalId, args.principalId),
    eq(chatActions.kind, "question_form_submit"), eq(chatActions.status, "processed"))).limit(1);
  if (!receipt || receipt.result?.code !== "question_form_answered" || receipt.result.interactionId !== args.resolved.id
    || receipt.payload.publicationId !== args.publicationId || receipt.providerActionId !== view.callback_id || hold.payload.submitActionRowId !== receipt.id
    || args.resolved.companyId !== args.companyId || args.resolved.id !== identity.interactionId || args.resolved.status !== "answered"
    || args.resolved.resolvedByUserId !== args.authorizedUserId || args.publicationId !== identity.publicationId
    || user.id !== identity.userId || team.id !== identity.binding.teamId || payload.api_app_id !== identity.binding.appId || view.app_id !== identity.binding.appId
    || view.id !== expectedView.id || view.external_id !== expectedView.externalId || typeof view.hash !== "string"
    || (view.hash !== expectedView.hash && hold.result?.phase !== "update_attempted")) fail("form_submission_receipt_changed");
  if (hold.status === "processed" && hold.result?.phase === "submitted") {
    const old = bodyRecord(hold.result.terminalIntent);
    if (old.submitReceiptId !== receipt.id || old.appReceiptId !== hold.id || old.operationId !== operationId) fail("form_submission_receipt_changed");
    return hold.id;
  }
  if (hold.status !== "processing" || !["ready", "update_attempted"].includes(String(hold.result?.phase))) fail("form_submission_hold_changed");
  const currentView = { id: String(view.id), hash: String(view.hash), externalId: String(view.external_id) };
  let intent: SlackFormTerminalIntent;
  try { intent = prepareSlackFormSubmissionIntent(identity, currentView, receipt.id, original, args.cipher ?? createLocalEncryptedCipher("read")); }
  catch { return fail("form_submission_cipher_unavailable"); }
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  await tx.update(chatActions).set({ status: "processed", result: { phase: "submitted", view: currentView, terminalIntent: intent }, updatedAt: new Date() }).where(and(
    eq(chatActions.id, hold.id), eq(chatActions.companyId, args.companyId), eq(chatActions.status, "processing")));
  return hold.id;
}
export async function acceptSlackFormNoEffect(tx: FormTx, operation: SlackFormOperation, originalActionId: string, environment?: string): Promise<string> {
  if (operation.phase !== "rejected" || !operation.rejection || operation.view || operation.closed) fail("form_no_effect_unproven");
  const binding = operation.binding;
  const [open] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
    eq(chatActions.kind, "question_form_open"), eq(chatActions.providerActionId, originalActionId))).limit(1);
  const [submit] = open ? await tx.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
    eq(chatActions.kind, "question_form_submit"), eq(chatActions.providerActionId, String(open.payload.formActionId)), eq(chatActions.conversationId, open.conversationId!))).limit(1) : [];
  if (!open || !submit || !open.conversationId || open.payload.version !== 1 || submit.payload.version !== 1
    || typeof open.payload.publicationId !== "string" || typeof open.payload.interactionId !== "string"
    || submit.payload.publicationId !== open.payload.publicationId || submit.payload.interactionId !== open.payload.interactionId
    || slackIssuedFormGrantId(binding, open.id, submit.id, open.payload.publicationId, open.payload.interactionId) !== operation.grantId)
    fail("form_no_effect_issued_authority_changed");
  const [publication] = await tx.select().from(chatPublications).where(and(eq(chatPublications.id, open.payload.publicationId),
    eq(chatPublications.companyId, binding.companyId), eq(chatPublications.endpointId, binding.endpointId), eq(chatPublications.conversationId, open.conversationId))).limit(1);
  if (!publication?.providerMessageId) fail("form_no_effect_publication_changed");
  const [old] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
    eq(chatActions.providerActionId, `slack-form-session:${operation.id}`))).for("update");
  if (old) {
    const intent = bodyRecord(old.result?.terminalIntent);
    if (old.status !== "failed" || old.result?.phase !== "not_opened" || intent.rejectionDigest !== operation.rejection.responseDigest
      || intent.operationId !== operation.id || intent.appReceiptId !== old.id) fail("form_no_effect_conflicts_custody");
    return old.id;
  }
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const [row] = await tx.insert(chatActions).values({ companyId: binding.companyId, endpointId: binding.endpointId, conversationId: open.conversationId,
    kind: "slack_form_session", providerActionId: `slack-form-session:${operation.id}`, status: "failed", payload: { version: 1, binding, environment, operationId: operation.id,
      grantId: operation.grantId, requestDigest: operation.requestDigest, userId: operation.userId, publicationId: open.payload.publicationId,
      interactionId: open.payload.interactionId, openActionRowId: open.id, submitActionRowId: submit.id, view: null }, result: { phase: "not_opened" } })
    .onConflictDoNothing().returning({ id: chatActions.id });
  if (!row) throw new SlackCloudReceiptError("form_no_effect_claim_changed", "retry");
  const intent: SlackFormTerminalIntent = { version: 1, binding, operationId: operation.id, deliveryId: operation.deliveryId, userId: operation.userId,
    grantId: operation.grantId, publicationId: open.payload.publicationId, interactionId: open.payload.interactionId, appReceiptId: row.id,
    outcome: "no_effect", submitReceiptId: null, rejectionDigest: operation.rejection.responseDigest, view: null, encryptedEvidence: null };
  await tx.update(chatActions).set({ result: { phase: "not_opened", terminalIntent: intent }, updatedAt: new Date() }).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId)));
  const credentialFailure = ["invalid_auth", "token_revoked", "not_authed", "invalid_arguments"].includes(operation.rejection.code);
  const lastError = credentialFailure ? "Slack could not open the form. Repair the connection, then open the form again."
    : "The Slack form request expired before opening. Open the form again to create a fresh request.";
  await tx.update(chatEndpoints).set({ ...(credentialFailure ? { status: "attention" } : {}), lastError, updatedAt: new Date() }).where(and(
    eq(chatEndpoints.id, binding.endpointId), eq(chatEndpoints.companyId, binding.companyId), eq(chatEndpoints.connectionId, binding.connectionId),
    eq(chatEndpoints.publicId, binding.publicId), inArray(chatEndpoints.status, ["active", "verifying", "attention"]),
    sql`${chatEndpoints.setup}->'slackCloudForms' = ${JSON.stringify(binding)}::jsonb`));
  return row.id;
}
export async function readSlackFormTerminalRequest(db: Pick<Db, "select">, binding: SlackFormBinding, operationId: string,
  cipher?: SlackFormEvidenceCipher): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
    eq(chatActions.kind, "slack_form_session"), eq(chatActions.providerActionId, `slack-form-session:${operationId}`))).limit(1);
  if (!row || !["closed", "submitted", "not_opened"].includes(String(row.result?.phase))) return null;
  const identity = holdIdentity(row), intent = bodyRecord(row.result?.terminalIntent);
  if (!sameSlackFormBinding(identity.binding, binding) || intent.appReceiptId !== row.id || intent.operationId !== operationId
    || intent.grantId !== identity.grantId || intent.publicationId !== identity.publicationId || intent.interactionId !== identity.interactionId
    || intent.userId !== identity.userId || !sameSlackFormBinding(parseSlackFormBinding(intent.binding), binding)) fail("form_terminal_intent_changed");
  const view = intent.view === null ? null : bodyRecord(intent.view);
  let terminal: Record<string, unknown>;
  if (intent.outcome === "submitted") {
    if (intent.submitReceiptId !== row.payload.submitActionRowId) fail("form_submission_cipher_binding_changed");
    let original: ReturnType<typeof openSlackFormSubmissionIntent>;
    try { original = openSlackFormSubmissionIntent(intent as unknown as SlackFormTerminalIntent, cipher ?? createLocalEncryptedCipher("read")); }
    catch (error) { if (error instanceof SlackCloudReceiptError) throw error; return fail("form_submission_cipher_unavailable"); }
    terminal = { kind: "submitted", submitReceiptId: intent.submitReceiptId, evidence: original };
  } else if (intent.outcome === "no_effect") {
    if (typeof intent.rejectionDigest !== "string" || !/^[a-f0-9]{64}$/.test(intent.rejectionDigest)) fail("form_terminal_intent_changed");
    terminal = { kind: "no_effect", responseDigest: intent.rejectionDigest };
  } else if (intent.outcome === "closed") terminal = { kind: "closed" };
  else fail("form_terminal_intent_changed");
  return { kind: "terminal-ack", binding, operationId, deliveryId: identity.deliveryId, userId: identity.userId, grantId: identity.grantId,
    publicationId: identity.publicationId, interactionId: identity.interactionId, viewId: view?.id ?? null, viewHash: view?.hash ?? null,
    externalId: view?.externalId ?? `pc-form-${operationId}`, appReceiptId: row.id, terminal: terminal! };
}

export type SlackFormProofAcceptance = { version: 1; binding: SlackFormBinding; operationId: string; appReceiptId: string;
  outcome: SlackFormTerminalIntent["outcome"]; terminalDigest: string; acceptedAt: string };
export function parseSlackFormProofAcceptance(value: unknown): SlackFormProofAcceptance {
  const v = bodyRecord(value);
  if (Object.keys(v).sort().join() !== ["version", "binding", "operationId", "appReceiptId", "outcome", "terminalDigest", "acceptedAt"].sort().join()
    || v.version !== 1 || typeof v.operationId !== "string" || !/^[a-f0-9]{64}$/.test(v.operationId)
    || typeof v.appReceiptId !== "string" || !/^[a-f0-9-]{36}$/i.test(v.appReceiptId)
    || typeof v.terminalDigest !== "string" || !/^[a-f0-9]{64}$/.test(v.terminalDigest)
    || typeof v.acceptedAt !== "string" || !Number.isFinite(Date.parse(v.acceptedAt))
    || v.outcome !== "closed" && v.outcome !== "submitted" && v.outcome !== "no_effect") fail("form_proof_acceptance_invalid");
  return { version: 1, binding: parseSlackFormBinding(v.binding), operationId: v.operationId, appReceiptId: v.appReceiptId,
    outcome: v.outcome, terminalDigest: v.terminalDigest, acceptedAt: v.acceptedAt };
}
export function prepareSlackFormProofAcceptance(intent: SlackFormTerminalIntent, value: unknown, currentInstanceId: string,
  cipher?: SlackFormEvidenceCipher): SlackFormProofAcceptance {
  const op = parseSlackFormOperation(value);
  if (op.binding.instanceId !== currentInstanceId || !sameSlackFormBinding(op.binding, intent.binding)
    || op.id !== intent.operationId || op.deliveryId !== intent.deliveryId || op.grantId !== intent.grantId || op.userId !== intent.userId)
    fail("form_proof_identity_changed");
  assertSlackFormTerminalAck(op, intent.appReceiptId);
  let terminalDigest: string;
  if (intent.outcome === "no_effect") {
    if (!op.rejection || op.closed || op.view || intent.view || op.rejection.responseDigest !== intent.rejectionDigest) fail("form_proof_outcome_changed");
    terminalDigest = op.rejection.responseDigest;
  } else {
    if (!op.closed || op.rejection || !intent.view || !isDeepStrictEqual(op.closed.view, intent.view)
      || op.closed.kind !== (intent.outcome === "submitted" ? "submitted" : "closed")) fail("form_proof_outcome_changed");
    if (intent.outcome === "submitted") {
      if (op.closed.evidence.submitReceiptId !== intent.submitReceiptId) fail("form_proof_submission_changed");
      const original = openSlackFormSubmissionIntent(intent, cipher ?? createLocalEncryptedCipher("read"));
      if (digest(JSON.stringify([original.rawBody, original.timestamp, original.signature])) !== op.closed.requestDigest)
        fail("form_proof_submission_changed");
    }
    terminalDigest = op.closed.requestDigest;
  }
  if (!op.acknowledgement) fail("form_proof_missing");
  return { version: 1, binding: intent.binding, operationId: op.id, appReceiptId: intent.appReceiptId, outcome: intent.outcome,
    terminalDigest, acceptedAt: op.acknowledgement.acceptedAt };
}
export async function acceptSlackFormTerminalProof(tx: FormTx, input: { intent: SlackFormTerminalIntent; operation: unknown;
  currentInstanceId: string; cipher?: SlackFormEvidenceCipher }): Promise<SlackFormProofAcceptance> {
  const { intent } = input;
  const [row] = await tx.select().from(chatActions).where(and(eq(chatActions.id, intent.appReceiptId), eq(chatActions.companyId, intent.binding.companyId),
    eq(chatActions.endpointId, intent.binding.endpointId), eq(chatActions.kind, "slack_form_session"),
    eq(chatActions.providerActionId, `slack-form-session:${intent.operationId}`))).for("update");
  if (!row || !["closed", "submitted", "not_opened"].includes(String(row.result?.phase))
    || !isDeepStrictEqual(row.result?.terminalIntent, intent)) fail("form_proof_intent_changed");
  const identity = holdIdentity(row);
  if (identity.appReceiptId !== intent.appReceiptId || !sameSlackFormBinding(identity.binding, intent.binding)
    || identity.grantId !== intent.grantId || identity.userId !== intent.userId || identity.publicationId !== intent.publicationId
    || identity.interactionId !== intent.interactionId) fail("form_proof_intent_changed");
  const accepted = prepareSlackFormProofAcceptance(intent, input.operation, input.currentInstanceId, input.cipher);
  if (row.result?.cloudProofAcceptance !== undefined) {
    if (!isDeepStrictEqual(parseSlackFormProofAcceptance(row.result.cloudProofAcceptance), accepted)) fail("form_proof_acceptance_changed");
    return accepted;
  }
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const updated = await tx.update(chatActions).set({ result: { ...row.result, cloudProofAcceptance: accepted }, updatedAt: new Date() }).where(and(
    eq(chatActions.id, row.id), eq(chatActions.companyId, intent.binding.companyId),
    sql`${chatActions.result}->'terminalIntent' = ${JSON.stringify(intent)}::jsonb`)).returning({ id: chatActions.id });
  if (updated.length !== 1) throw new SlackCloudReceiptError("form_proof_acceptance_changed", "retry");
  return accepted;
}
export type SlackFormRetainedRow = Pick<typeof chatActions.$inferSelect, "id" | "companyId" | "endpointId" | "kind" | "providerActionId" | "payload" | "result" | "status">;
export function projectSlackFormRetainedOwner(row: SlackFormRetainedRow, currentInstanceId: string, currentEnvironment?: string): {
  subject: "github-bot-events"; companyId: string; binding: SlackFormBinding | null; requiresDelivery: boolean;
} | null {
  if (["slack_form_owner", "slack_form_grant"].includes(row.kind) && row.result?.phase === "transferred"
    && row.result.retirement && typeof row.result.retirement === "object" && Reflect.get(row.result.retirement, "receipt") !== undefined) {
    if (!slackFormRetirementHistoryReceipt(row)) fail("form_retained_owner_changed");
    return null;
  }
  if (row.kind === "slack_form_owner" && (row.result?.phase === "retirement_accepted" || row.result?.phase === "retirement_gc_pending")) {
    const receipt = parseSlackFormRetirementReceipt(row.result.retirementReceipt), enrollment = parseSlackFormPublicEnrollment(row.payload.enrollment), binding = receipt.binding;
    if (receipt.binding.instanceId !== currentInstanceId || currentEnvironment !== undefined && receipt.environment !== currentEnvironment) return null;
    if (row.companyId !== binding.companyId || row.endpointId !== binding.endpointId || row.payload.subject !== receipt.subject
      || !isSlackFormEnrollmentActionId(row.providerActionId, enrollment)
      || row.payload.environment !== receipt.environment || typeof row.result.retirementReceiptJws !== "string"
      || Buffer.byteLength(row.result.retirementReceiptJws, "ascii") > 12000
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(row.result.retirementReceiptJws)
      || enrollment.bindingId !== binding.eventBindingId
      || ["instanceId", "companyId", "endpointId", "publicId", "connectionId", "runtimeGeneration", "teamId", "appId"].some(key => Reflect.get(enrollment, key) !== Reflect.get(binding, key))
      || row.payload.binding !== undefined && !sameSlackFormBinding(parseSlackFormBinding(row.payload.binding), binding)) fail("form_retained_owner_changed");
    return { subject: "github-bot-events", companyId: row.companyId, binding, requiresDelivery: false };
  }
  if (row.kind === "slack_form_owner" && row.payload.binding === undefined) {
    const rawEnrollment = row.payload.enrollment;
    if (!rawEnrollment || typeof rawEnrollment !== "object" || Array.isArray(rawEnrollment) || Reflect.get(rawEnrollment, "instanceId") !== currentInstanceId) return null;
    const enrollment = parseSlackFormPublicEnrollment(rawEnrollment);
    if (currentEnvironment !== undefined && row.payload.environment !== currentEnvironment) fail("form_retained_environment_changed");
    if (enrollment.companyId !== row.companyId || enrollment.endpointId !== row.endpointId
      || typeof row.payload.subject !== "string" || !row.payload.subject.length
      || row.result?.phase !== "staged") fail("form_retained_owner_changed");
    return { subject: "github-bot-events", companyId: row.companyId, binding: null, requiresDelivery: true };
  }
  const raw = row.payload.binding;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Reflect.get(raw, "instanceId") !== currentInstanceId) return null;
  if (currentEnvironment !== undefined && row.payload.environment !== currentEnvironment) fail("form_retained_environment_changed");
  const binding = parseSlackFormBinding(raw);
  if (binding.companyId !== row.companyId || binding.endpointId !== row.endpointId) fail("form_retained_owner_changed");
  if (row.kind === "slack_form_session") {
    const identity = holdIdentity(row);
    if (!sameSlackFormBinding(identity.binding, binding)) fail("form_retained_owner_changed");
    if (row.result?.cloudProofAcceptance !== undefined) {
      const accepted = parseSlackFormProofAcceptance(row.result.cloudProofAcceptance), intent = bodyRecord(row.result.terminalIntent);
      if (accepted.appReceiptId !== row.id || accepted.operationId !== identity.operationId || intent.appReceiptId !== row.id
        || intent.operationId !== identity.operationId || !sameSlackFormBinding(parseSlackFormBinding(accepted.binding), binding)
        || !["closed", "submitted", "not_opened"].includes(String(row.result.phase))) fail("form_retained_owner_changed");
    }
    return { subject: "github-bot-events", companyId: row.companyId, binding, requiresDelivery: row.result?.cloudProofAcceptance === undefined };
  }
  if (row.kind === "slack_form_grant") {
    const grant = bodyRecord(row.payload.grant);
    if (!sameSlackFormBinding(parseSlackFormBinding(grant.binding), binding) || typeof row.payload.subject !== "string"
      || !["staged", "published"].includes(String(row.result?.phase))) fail("form_retained_grant_changed");
    return { subject: "github-bot-events", companyId: row.companyId, binding, requiresDelivery: row.result?.phase === "staged" };
  }
  if (row.kind !== "slack_form_owner" || typeof row.payload.subject !== "string" || !row.payload.subject.length
    || !["staged", "enrolled", "retired_cleanup", "transferred"].includes(String(row.result?.phase))) fail("form_retained_owner_changed");
  return { subject: "github-bot-events", companyId: row.companyId, binding, requiresDelivery: row.result?.phase !== "transferred" };
}
export async function readSlackFormRetainedOwner(db: Pick<Db, "select">, currentInstanceId: string) {
  const [row] = await db.select().from(chatActions).where(and(inArray(chatActions.kind, ["slack_form_session", "slack_form_owner"]),
    sql`${chatActions.payload}->'binding'->>'instanceId' = ${currentInstanceId}`,
    sql`${chatActions.payload}->'binding'->>'companyId' = ${chatActions.companyId}::text`,
    sql`${chatActions.payload}->'binding'->>'endpointId' = ${chatActions.endpointId}::text`))
    .orderBy(sql`case when ${chatActions.result}->'cloudProofAcceptance' is null and coalesce(${chatActions.result}->>'phase','') <> 'transferred' then 0 else 1 end`, chatActions.id).limit(1);
  return row ? projectSlackFormRetainedOwner(row, currentInstanceId) : null;
}

export async function acceptSlackFormClosed(tx: FormTx, operation: SlackFormOperation, originalActionId: string, environment: string): Promise<string> {
  if (!operation.closed || operation.closed.kind !== "closed" || operation.rejection) fail("form_close_unproven");
  const binding = operation.binding;
  const [old] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
    eq(chatActions.kind, "slack_form_session"), eq(chatActions.providerActionId, `slack-form-session:${operation.id}`))).for("update");
  if (old) {
    if (!sameSlackFormBinding(parseSlackFormBinding(old.payload.binding), binding) || old.payload.userId !== operation.userId) fail("form_close_owner_changed");
    if (old.principalId) {
      await closeSlackFormSession(tx, { companyId: binding.companyId, endpointId: binding.endpointId, principalId: old.principalId, operationId: operation.id }, operation.closed.view);
      return old.id;
    }
    if (old.status !== "cancelled" || old.result?.phase !== "closed" || !isDeepStrictEqual(old.result.view, operation.closed.view)) fail("form_close_owner_changed");
    return old.id;
  }
  const [open] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
    eq(chatActions.kind, "question_form_open"), eq(chatActions.providerActionId, originalActionId))).limit(1);
  const [submit] = open?.conversationId ? await tx.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId),
    eq(chatActions.kind, "question_form_submit"), eq(chatActions.providerActionId, String(open.payload.formActionId)), eq(chatActions.conversationId, open.conversationId))).limit(1) : [];
  if (!open || !submit || !open.conversationId || typeof open.payload.publicationId !== "string" || typeof open.payload.interactionId !== "string"
    || submit.payload.publicationId !== open.payload.publicationId || submit.payload.interactionId !== open.payload.interactionId
    || slackIssuedFormGrantId(binding, open.id, submit.id, open.payload.publicationId, open.payload.interactionId) !== operation.grantId) fail("form_close_issued_authority_changed");
  const [publication] = await tx.select().from(chatPublications).where(and(eq(chatPublications.id, open.payload.publicationId), eq(chatPublications.companyId, binding.companyId),
    eq(chatPublications.endpointId, binding.endpointId), eq(chatPublications.conversationId, open.conversationId))).limit(1);
  if (!publication?.providerMessageId) fail("form_close_publication_changed");
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const [row] = await tx.insert(chatActions).values({ companyId: binding.companyId, endpointId: binding.endpointId, conversationId: open.conversationId,
    kind: "slack_form_session", providerActionId: `slack-form-session:${operation.id}`, status: "cancelled", payload: { version: 1, binding, environment,
      operationId: operation.id, grantId: operation.grantId, requestDigest: operation.requestDigest, userId: operation.userId,
      publicationId: open.payload.publicationId, interactionId: open.payload.interactionId, openActionRowId: open.id, submitActionRowId: submit.id, view: operation.closed.view },
    result: { phase: "closed", view: operation.closed.view } }).onConflictDoNothing().returning({ id: chatActions.id });
  if (!row) throw new SlackCloudReceiptError("form_close_claim_changed", "retry");
  const intent: SlackFormTerminalIntent = { version: 1, binding, operationId: operation.id, deliveryId: operation.deliveryId, userId: operation.userId,
    grantId: operation.grantId, publicationId: open.payload.publicationId, interactionId: open.payload.interactionId, appReceiptId: row.id,
    outcome: "closed", view: operation.closed.view, submitReceiptId: null, rejectionDigest: null, encryptedEvidence: null };
  await tx.update(chatActions).set({ result: { phase: "closed", view: operation.closed.view, terminalIntent: intent }, updatedAt: new Date() }).where(eq(chatActions.id, row.id));
  return row.id;
}
export async function readSlackFormTerminalIntent(db: Pick<Db, "select">, operation: SlackFormOperation): Promise<SlackFormTerminalIntent | null> {
  const [row] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, operation.binding.companyId), eq(chatActions.endpointId, operation.binding.endpointId),
    eq(chatActions.kind, "slack_form_session"), eq(chatActions.providerActionId, `slack-form-session:${operation.id}`))).limit(1);
  if (!row?.result?.terminalIntent) return null;
  const raw = bodyRecord(row.result.terminalIntent), identity = holdIdentity(row);
  if (!sameSlackFormBinding(identity.binding, operation.binding) || identity.operationId !== operation.id || identity.grantId !== operation.grantId
    || identity.userId !== operation.userId || Object.keys(identity).some(k => !isDeepStrictEqual(raw[k], Reflect.get(identity, k)))) fail("form_terminal_intent_changed");
  if (!["closed", "submitted", "no_effect"].includes(String(raw.outcome)) || (raw.submitReceiptId !== null && typeof raw.submitReceiptId !== "string")
    || (raw.rejectionDigest !== null && typeof raw.rejectionDigest !== "string")) fail("form_terminal_intent_changed");
  const view = raw.view === null ? null : bodyRecord(raw.view);
  if (view && (typeof view.id !== "string" || typeof view.hash !== "string" || typeof view.externalId !== "string")) fail("form_terminal_intent_changed");
  return { ...identity, outcome: raw.outcome as SlackFormTerminalIntent["outcome"], submitReceiptId: raw.submitReceiptId,
    rejectionDigest: raw.rejectionDigest, view: view ? { id: String(view.id), hash: String(view.hash), externalId: String(view.externalId) } : null,
    encryptedEvidence: raw.encryptedEvidence === null ? null : bodyRecord(raw.encryptedEvidence) };
}
