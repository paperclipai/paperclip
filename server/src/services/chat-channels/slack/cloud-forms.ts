import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { chatActions, chatConversations, chatPublications, type Db } from "@paperclipai/db";
import type { ResolvedChatQuestionFormOpen } from "../../chat-question-forms.js";
import { slackThreadChannelId } from "./messages.js";
import { SlackCloudReceiptError, type SlackCloudEvent } from "./cloud-event.js";

export type SlackFormBinding = {
  version: 1; instanceId: string; companyId: string; endpointId: string; publicId: string;
  connectionId: string; runtimeGeneration: number; teamId: string; appId: string;
  eventBindingId: string; credentialFingerprint: string;
};
export type SlackFormPublicEnrollment = Omit<SlackFormBinding, "eventBindingId" | "credentialFingerprint"> & { bindingId: string };
export function parseSlackFormPublicEnrollment(value: unknown): SlackFormPublicEnrollment {
  const v = record(value, ["version", "instanceId", "companyId", "endpointId", "publicId", "connectionId", "runtimeGeneration", "teamId", "appId", "bindingId"]);
  if (v.version !== 1 || !Number.isSafeInteger(v.runtimeGeneration) || Number(v.runtimeGeneration) < 1
    || ["instanceId", "companyId", "endpointId", "publicId", "connectionId", "teamId", "appId", "bindingId"].some(k => typeof v[k] !== "string" || !String(v[k]).length || String(v[k]).length > 200)
    || !/^[A-Za-z0-9_-]{43}$/.test(String(v.publicId)) || !/^T[A-Z0-9]+$/.test(String(v.teamId)) || !/^A[A-Z0-9]+$/.test(String(v.appId))
    || !/^slack-event:[a-f0-9]{64}$/.test(String(v.bindingId))) throw new SlackCloudReceiptError("invalid_form_enrollment", "invalid");
  return v as unknown as SlackFormPublicEnrollment;
}
export type SlackIssuedFormGrant = {
  version: 1; binding: SlackFormBinding; grantId: string;
  conversationId: string; conversationGeneration: number; publicationId: string; interactionId: string;
  openActionRowId: string; openActionDigest: string; submitActionRowId: string; submitActionDigest: string;
  expiresAt: string; channelId: string; threadTs: string | null; providerMessageId: string;
};
export type SlackFormView = { id: string; hash: string; externalId: string };
export type SlackFormOperation = {
  version: 1; binding: SlackFormBinding; grantId: string; id: string; externalId: string;
  deliveryId: string; requestDigest: string; triggerDigest: string; userId: string;
  acceptedAt: string; triggerDeadline: string;
  phase: "reserved" | "attempted" | "confirmed" | "rejected" | "ambiguous" | "terminal_proven" | "acknowledged";
  view: SlackFormView | null;
  closed: { kind: "closed" | "submitted"; view: SlackFormView; acceptedAt: string; requestDigest: string; evidence: {
    version: 1; kind: "close" | "submission"; submitReceiptId: string | null; instanceId: string; environment: string; operationId: string; binding: SlackFormBinding;
    acceptedAt: string; rawBody: string; timestamp: string; signature: string;
  } } | null;
  acknowledgement: { appReceiptId: string; acceptedAt: string } | null;
  rejection: { code: "expired_before_spend" | "expired_trigger_id" | "invalid_auth" | "token_revoked" | "not_authed" | "invalid_arguments";
    observedAt: string; responseDigest: string; evidence: Record<string, unknown> } | null;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join())
    throw new SlackCloudReceiptError("invalid_form_receipt", "invalid");
  return value as Record<string, unknown>;
}
export function parseSlackFormBinding(value: unknown): SlackFormBinding {
  const v = record(value, ["version", "instanceId", "companyId", "endpointId", "publicId", "connectionId", "runtimeGeneration", "teamId", "appId", "eventBindingId", "credentialFingerprint"]);
  if (v.version !== 1 || !Number.isSafeInteger(v.runtimeGeneration) || Number(v.runtimeGeneration) < 1
    || ["instanceId", "companyId", "endpointId", "publicId", "connectionId", "teamId", "appId", "eventBindingId", "credentialFingerprint"].some(k => typeof v[k] !== "string" || !(v[k] as string).length || (v[k] as string).length > 200)
    || !/^[A-Za-z0-9_-]{43}$/.test(String(v.publicId)) || !/^T[A-Z0-9]+$/.test(String(v.teamId)) || !/^A[A-Z0-9]+$/.test(String(v.appId))
    || !/^slack-event:[a-f0-9]{64}$/.test(String(v.eventBindingId)) || !/^[a-f0-9]{64}$/.test(String(v.credentialFingerprint)))
    throw new SlackCloudReceiptError("invalid_form_binding", "invalid");
  return v as unknown as SlackFormBinding;
}
export function slackFormSetupRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SlackCloudReceiptError("form_setup_invalid", "attention");
  const setup: Record<string, unknown> = { ...value };
  return setup;
}
export function currentSlackFormOwnerBinding(setup: Record<string, unknown>): SlackFormBinding | null {
  if (setup.slackCloudForms === undefined) return null;
  return parseSlackFormBinding(setup.slackCloudForms);
}
export const sameSlackFormBinding = (a: SlackFormBinding, b: SlackFormBinding) => Object.keys(a).every(k => Reflect.get(a, k) === Reflect.get(b, k));
function view(value: unknown): SlackFormView {
  const v = record(value, ["id", "hash", "externalId"]);
  if (!/^V[A-Z0-9]+$/.test(String(v.id)) || typeof v.hash !== "string" || !v.hash.length || v.hash.length > 200
    || typeof v.externalId !== "string" || !/^pc-form-[a-f0-9]{64}$/.test(v.externalId)) throw new SlackCloudReceiptError("invalid_form_view", "invalid");
  return v as unknown as SlackFormView;
}
export function parseSlackFormOperation(value: unknown): SlackFormOperation {
  const v = record(value, ["version", "binding", "grantId", "id", "externalId", "deliveryId", "requestDigest", "triggerDigest", "userId", "acceptedAt", "triggerDeadline", "phase", "view", "closed", "acknowledgement", "rejection"]);
  parseSlackFormBinding(v.binding);
  if (v.version !== 1 || ![v.id, v.grantId, v.requestDigest, v.triggerDigest].every(x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x))
    || v.externalId !== `pc-form-${v.id}` || v.deliveryId !== `slack_form_${v.id}`
    || !/^[UW][A-Z0-9]+$/.test(String(v.userId)) || typeof v.acceptedAt !== "string" || !Number.isFinite(Date.parse(v.acceptedAt))
    || typeof v.triggerDeadline !== "string" || !Number.isFinite(Date.parse(v.triggerDeadline))
    || !["reserved", "attempted", "confirmed", "rejected", "ambiguous", "terminal_proven", "acknowledged"].includes(String(v.phase)))
    throw new SlackCloudReceiptError("invalid_form_operation", "invalid");
  if (v.view !== null) view(v.view);
  if (v.closed !== null) {
    const c = record(v.closed, ["kind", "view", "acceptedAt", "requestDigest", "evidence"]); view(c.view);
    const e = record(c.evidence, ["version", "kind", "submitReceiptId", "instanceId", "environment", "operationId", "binding", "acceptedAt", "rawBody", "timestamp", "signature"]);
    parseSlackFormBinding(e.binding);
    if (e.version !== 1 || !["close", "submission"].includes(String(e.kind)) || (e.kind === "close" ? e.submitReceiptId !== null : typeof e.submitReceiptId !== "string") || typeof e.instanceId !== "string" || typeof e.environment !== "string" || typeof e.operationId !== "string"
      || typeof e.acceptedAt !== "string" || !Number.isFinite(Date.parse(e.acceptedAt)) || typeof e.rawBody !== "string" || e.rawBody.length > 1398104
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.rawBody)
      || typeof e.timestamp !== "string" || !/^[0-9]{1,16}$/.test(e.timestamp) || typeof e.signature !== "string" || !/^v0=[a-f0-9]{64}$/.test(e.signature))
      throw new SlackCloudReceiptError("invalid_form_close_evidence", "invalid");
    if (!["closed", "submitted"].includes(String(c.kind)) || typeof c.acceptedAt !== "string" || !Number.isFinite(Date.parse(c.acceptedAt)) || typeof c.requestDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(c.requestDigest)) throw new SlackCloudReceiptError("invalid_form_close", "invalid");
  }
  if (v.rejection !== null) {
    const n = record(v.rejection, ["code", "observedAt", "responseDigest", "evidence"]);
    if (!["expired_before_spend", "expired_trigger_id", "invalid_auth", "token_revoked", "not_authed", "invalid_arguments"].includes(String(n.code))
      || typeof n.observedAt !== "string" || !Number.isFinite(Date.parse(n.observedAt)) || typeof n.responseDigest !== "string" || !/^[a-f0-9]{64}$/.test(n.responseDigest)
      || !n.evidence || typeof n.evidence !== "object" || Array.isArray(n.evidence)) throw new SlackCloudReceiptError("invalid_form_no_effect", "invalid");
    const e = record(n.evidence, ["version", "kind", "instanceId", "environment", "operationId", "binding", "observedAt", "code", "responseDigest", "observation"]);
    parseSlackFormBinding(e.binding);
    if (e.version !== 1 || e.kind !== "rejection" || typeof e.instanceId !== "string" || typeof e.environment !== "string" || typeof e.operationId !== "string"
      || !e.observation || typeof e.observation !== "object" || Array.isArray(e.observation)) throw new SlackCloudReceiptError("invalid_form_no_effect", "invalid");
  }
  if ((v.phase === "rejected" && !v.rejection) || (v.rejection && (v.closed || v.view || !["rejected", "terminal_proven", "acknowledged"].includes(String(v.phase))))) throw new SlackCloudReceiptError("invalid_form_no_effect", "invalid");
  if (v.acknowledgement !== null) {
    const a = record(v.acknowledgement, ["appReceiptId", "acceptedAt"]);
    if (typeof a.appReceiptId !== "string" || !/^[a-f0-9-]{36}$/i.test(a.appReceiptId) || typeof a.acceptedAt !== "string" || !Number.isFinite(Date.parse(a.acceptedAt)))
      throw new SlackCloudReceiptError("invalid_form_acknowledgement", "invalid");
  }
  const op = v as unknown as SlackFormOperation;
  if (["terminal_proven", "acknowledged"].includes(op.phase) !== (op.acknowledgement !== null) || (["terminal_proven", "acknowledged"].includes(op.phase) && !op.closed && !op.rejection))
    throw new SlackCloudReceiptError("invalid_form_acknowledgement", "invalid");
  if (((op.phase === "confirmed" || ["terminal_proven", "acknowledged"].includes(op.phase) && op.closed) && !op.view) || (op.view && op.view.externalId !== op.externalId)
    || (op.closed && (op.closed.view.externalId !== op.externalId || (op.view && op.view.id !== op.closed.view.id))))
    throw new SlackCloudReceiptError("form_view_changed", "attention");
  return op;
}
export function slackIssuedFormGrantId(binding: SlackFormBinding, openActionRowId: string, submitActionRowId: string, publicationId: string, interactionId: string): string {
  return hash(JSON.stringify([[binding.instanceId, binding.companyId, binding.endpointId, binding.publicId, binding.connectionId, binding.runtimeGeneration,
    binding.teamId, binding.appId, binding.eventBindingId, binding.credentialFingerprint], openActionRowId, submitActionRowId, publicationId, interactionId]));
}
export async function projectSlackIssuedFormGrant(db: Pick<Db, "select">, binding: SlackFormBinding,
  resolved: ResolvedChatQuestionFormOpen): Promise<SlackIssuedFormGrant | null> {
  const [publication] = await db.select().from(chatPublications).where(and(eq(chatPublications.id, resolved.publicationId),
    eq(chatPublications.companyId, binding.companyId), eq(chatPublications.endpointId, binding.endpointId), eq(chatPublications.state, "published"))).limit(1);
  if (!publication?.providerMessageId || !publication.publishedAt) return null;
  const [conversation] = await db.select().from(chatConversations).where(and(eq(chatConversations.id, publication.conversationId),
    eq(chatConversations.companyId, binding.companyId), eq(chatConversations.endpointId, binding.endpointId), eq(chatConversations.state, "active"))).limit(1);
  if (!conversation) return null;
  const channelId = slackThreadChannelId(conversation.externalThreadId);
  const thread = /^slack:[^:]+:([0-9]+[.][0-9]+)?$/.exec(conversation.externalThreadId);
  if (!channelId || !thread || conversation.externalConversationId !== `slack:${channelId}`) return null;
  const rows = await db.select().from(chatActions).where(and(eq(chatActions.companyId, binding.companyId), eq(chatActions.endpointId, binding.endpointId), eq(chatActions.conversationId, conversation.id), inArray(chatActions.id, [resolved.openActionRowId, resolved.submitActionRowId])));
  const open = rows.find(a => a.id === resolved.openActionRowId && a.kind === "question_form_open" && a.status === "issued" && a.providerActionId === resolved.openActionId);
  const submit = rows.find(a => a.id === resolved.submitActionRowId && a.kind === "question_form_submit" && a.status === "issued" && a.providerActionId === resolved.submitActionId);
  if (!open || !submit || open.payload.version !== 1 || submit.payload.version !== 1
    || open.payload.interactionId !== resolved.interactionId || submit.payload.interactionId !== resolved.interactionId
    || open.payload.publicationId !== resolved.publicationId || submit.payload.publicationId !== resolved.publicationId
    || open.payload.formActionId !== submit.providerActionId || submit.payload.formActionId !== submit.providerActionId
    || typeof open.payload.expiresAt !== "string" || open.payload.expiresAt !== submit.payload.expiresAt) return null;
  const grantId = slackIssuedFormGrantId(binding, resolved.openActionRowId, resolved.submitActionRowId, resolved.publicationId, resolved.interactionId);
  return { version: 1, binding, grantId, conversationId: conversation.id, conversationGeneration: conversation.sessionGeneration,
    publicationId: publication.id, interactionId: resolved.interactionId, openActionRowId: open.id, openActionDigest: hash(open.providerActionId),
    submitActionRowId: submit.id, submitActionDigest: hash(submit.providerActionId), expiresAt: open.payload.expiresAt,
    channelId, threadTs: thread[1] || null, providerMessageId: publication.providerMessageId };
}
export type SlackFormLookup = (values: { binding: SlackFormBinding; operationId: string; deliveryId: string }) => Promise<unknown>;
export type SlackFormDeliveryAuthority = { binding: SlackFormBinding; instanceId: string; environment: string } &
  ({ kind: "current"; signingSecret: string } | { kind: "retained" });
export async function lookupSlackFormDelivery(event: SlackCloudEvent, current: SlackFormDeliveryAuthority,
  lookup: SlackFormLookup, now = Date.now()): Promise<{ operation: SlackFormOperation; originalPayload: Record<string, unknown>; authority: "current" | "retained" }> {
  if (event.provider !== "slack" || event.event !== "form_open") throw new SlackCloudReceiptError("unsupported_form_receipt", "attention");
  const packet = record(event.payload.slackFormOpen, ["version", "instanceId", "environment", "operation", "acceptedAt", "rawBody", "timestamp", "signature"]);
  const op = parseSlackFormOperation(packet.operation);
  if (packet.version !== 1 || current.binding.instanceId !== current.instanceId || !sameSlackFormBinding(op.binding, current.binding) || packet.instanceId !== current.instanceId || packet.environment !== current.environment
    || event.id !== op.deliveryId || event.createdAt !== packet.acceptedAt || event.installationId !== `slack-form-open:${op.id}`
    || !event.bindingIds.includes(`slack-form-open:${op.id}`)) throw new SlackCloudReceiptError("form_binding_changed", "attention");
  const acceptedAt = typeof packet.acceptedAt === "string" ? Date.parse(packet.acceptedAt) : Number.NaN;
  if (typeof packet.rawBody !== "string" || packet.rawBody.length > 1398104 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.rawBody)
    || typeof packet.timestamp !== "string" || !/^[0-9]{1,16}$/.test(packet.timestamp) || typeof packet.signature !== "string" || !/^v0=[a-f0-9]{64}$/.test(packet.signature)
    || !Number.isFinite(acceptedAt) || acceptedAt > now + 300000 || now - acceptedAt >= 30 * 24 * 60 * 60000 || Math.abs(Math.floor(acceptedAt / 1000) - Number(packet.timestamp)) > 300)
    throw new SlackCloudReceiptError("form_original_evidence_invalid", "attention");
  const raw = Buffer.from(packet.rawBody, "base64");
  if (raw.byteLength > 1048576) throw new SlackCloudReceiptError("form_original_too_large", "invalid");
  if (packet.acceptedAt !== op.acceptedAt || hash(JSON.stringify([packet.rawBody, packet.timestamp, packet.signature])) !== op.requestDigest)
    throw new SlackCloudReceiptError("form_original_authentication_failed", "attention");
  if (current.kind === "current") {
    const signature = createHmac("sha256", current.signingSecret).update(`v0:${packet.timestamp}:`).update(raw).digest();
    if (!timingSafeEqual(signature, Buffer.from(packet.signature.slice(3), "hex"))) throw new SlackCloudReceiptError("form_original_authentication_failed", "attention");
  }
  let original: unknown;
  try { original = JSON.parse(new URLSearchParams(raw.toString("utf8")).get("payload") ?? "null"); }
  catch { throw new SlackCloudReceiptError("form_original_payload_invalid", "invalid"); }
  if (!original || typeof original !== "object" || Array.isArray(original)) throw new SlackCloudReceiptError("form_original_payload_invalid", "invalid");
  const body = original as Record<string, unknown>;
  if (body.type !== "block_actions" || typeof body.trigger_id !== "string" || hash(body.trigger_id) !== op.triggerDigest
    || !body.user || typeof body.user !== "object" || Reflect.get(body.user, "id") !== op.userId
    || !body.team || typeof body.team !== "object" || Reflect.get(body.team, "id") !== current.binding.teamId
    || body.api_app_id !== current.binding.appId) throw new SlackCloudReceiptError("form_original_identity_changed", "attention");
  const receipt = record(await lookup({ binding: current.binding, operationId: op.id, deliveryId: op.deliveryId }), ["version", "instanceId", "environment", "operation"]);
  let latest = parseSlackFormOperation(receipt.operation);
  if (receipt.version !== 1 || receipt.instanceId !== current.instanceId || receipt.environment !== current.environment
    || !sameSlackFormBinding(latest.binding, op.binding)
    || ["id", "grantId", "externalId", "deliveryId", "requestDigest", "triggerDigest", "userId", "acceptedAt", "triggerDeadline"].some(k => Reflect.get(latest, k) !== Reflect.get(op, k)))
    throw new SlackCloudReceiptError("form_lookup_identity_changed", "attention");
  if (latest.rejection) {
    const n = latest.rejection, evidence = n.evidence;
    if (evidence.instanceId !== current.instanceId || evidence.environment !== current.environment || evidence.operationId !== op.id
      || !sameSlackFormBinding(parseSlackFormBinding(evidence.binding), op.binding) || evidence.observedAt !== n.observedAt || evidence.code !== n.code
      || evidence.responseDigest !== n.responseDigest || hash(JSON.stringify([op.id, n.code, evidence.observation])) !== n.responseDigest)
      throw new SlackCloudReceiptError("form_no_effect_evidence_changed", "attention");
  }
  if (latest.closed) {
    const c = latest.closed, evidence = c.evidence;
    if (evidence.instanceId !== current.instanceId || evidence.environment !== current.environment || evidence.operationId !== op.id
      || !sameSlackFormBinding(evidence.binding, op.binding) || evidence.acceptedAt !== c.acceptedAt
      || Math.abs(Math.floor(Date.parse(evidence.acceptedAt) / 1000) - Number(evidence.timestamp)) > 300
      || hash(JSON.stringify([evidence.rawBody, evidence.timestamp, evidence.signature])) !== c.requestDigest)
      throw new SlackCloudReceiptError("form_close_evidence_changed", "attention");
    const closeRaw = Buffer.from(evidence.rawBody, "base64");
    if (closeRaw.length > 1048576) throw new SlackCloudReceiptError("form_close_evidence_invalid", "invalid");
    if (current.kind === "current") {
      const signature = createHmac("sha256", current.signingSecret).update(`v0:${evidence.timestamp}:`).update(closeRaw).digest();
      if (!timingSafeEqual(signature, Buffer.from(evidence.signature.slice(3), "hex"))) throw new SlackCloudReceiptError("form_close_authentication_failed", "attention");
    }
    let closeBody: unknown;
    try { closeBody = JSON.parse(new URLSearchParams(closeRaw.toString("utf8")).get("payload") ?? "null"); }
    catch { throw new SlackCloudReceiptError("form_close_evidence_invalid", "invalid"); }
    if (!closeBody || typeof closeBody !== "object" || Array.isArray(closeBody)) throw new SlackCloudReceiptError("form_close_evidence_invalid", "invalid");
    const v = Reflect.get(closeBody, "view"), user = Reflect.get(closeBody, "user"), team = Reflect.get(closeBody, "team");
    if (Reflect.get(closeBody, "type") !== (c.kind === "submitted" ? "view_submission" : "view_closed")
      || evidence.kind !== (c.kind === "submitted" ? "submission" : "close") || Reflect.get(closeBody, "api_app_id") !== op.binding.appId
      || !v || typeof v !== "object" || !user || typeof user !== "object" || !team || typeof team !== "object"
      || Reflect.get(user, "id") !== op.userId || Reflect.get(team, "id") !== op.binding.teamId || Reflect.get(v, "id") !== c.view.id
      || Reflect.get(v, "external_id") !== op.externalId || Reflect.get(v, "hash") !== c.view.hash || Reflect.get(v, "app_id") !== op.binding.appId)
      throw new SlackCloudReceiptError("form_close_identity_changed", "attention");
  }
  if (current.kind === "retained" && !latest.closed && !latest.rejection) throw new SlackCloudReceiptError("form_retained_resource_unresolved", "attention");
  if (["reserved", "attempted"].includes(latest.phase) && !latest.closed) throw new SlackCloudReceiptError("form_receipt_pending", "retry");
  return { operation: latest, originalPayload: body, authority: current.kind };
}

export function assertSlackFormTerminalAck(operation: SlackFormOperation, appReceiptId: string): void {
  if (["terminal_proven", "acknowledged"].includes(operation.phase) && operation.acknowledgement?.appReceiptId === appReceiptId && (operation.closed || operation.rejection)) return;
  throw new SlackCloudReceiptError(operation.phase === "confirmed" ? "form_view_active" : "form_resource_unresolved",
    operation.phase === "confirmed" || operation.closed ? "retry" : "attention");
}

export type SlackFormSubmissionEvidence = Readonly<{ endpointId: string; acceptedAt: string; rawBody: string; timestamp: string; signature: string }>;
const submissions = new AsyncLocalStorage<SlackFormSubmissionEvidence>();
export const slackFormSubmissionEvidence = (): SlackFormSubmissionEvidence | undefined => submissions.getStore();
export async function withSlackFormSubmissionEvidence<T>(request: Request, endpointId: string, enabled: boolean, work: () => Promise<T>): Promise<T> {
  if (!enabled) return work();
  const acceptedAt = new Date().toISOString(), copy = request.clone();
  if (!copy.body) return work();
  const reader = copy.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 1048576) throw new SlackCloudReceiptError("form_submission_too_large", "invalid");
      chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks), encoded = new URLSearchParams(bytes.toString("utf8"));
  if (encoded.getAll("payload").length !== 1) return work();
  let body: unknown;
  try { body = JSON.parse(encoded.get("payload")!); } catch { return work(); }
  if (!body || typeof body !== "object" || Reflect.get(body, "type") !== "view_submission") return work();
  const view = Reflect.get(body, "view");
  if (!view || typeof view !== "object" || typeof Reflect.get(view, "external_id") !== "string" || !/^pc-form-[a-f0-9]{64}$/.test(Reflect.get(view, "external_id"))) return work();
  const timestamp = request.headers.get("x-slack-request-timestamp"), signature = request.headers.get("x-slack-signature");
  if (!timestamp || !/^[0-9]{1,16}$/.test(timestamp) || !signature || !/^v0=[a-f0-9]{64}$/.test(signature)) return work();
  return submissions.run(Object.freeze({ endpointId, acceptedAt, rawBody: bytes.toString("base64"), timestamp, signature }), work);
}

export type SlackFormOpenContext = { operation: SlackFormOperation; currentBinding: SlackFormBinding; environment?: string;
  sessionActionId?: string; updateAttempted?: boolean; updatedView?: SlackFormView };
const formOpens = new AsyncLocalStorage<SlackFormOpenContext>();
export const slackFormOpenContext = (): SlackFormOpenContext | undefined => formOpens.getStore();
export function withSlackFormOpenContext<T>(operation: SlackFormOperation, currentBinding: SlackFormBinding, work: () => Promise<T>, environment?: string): Promise<T> {
  if (operation.phase !== "confirmed" || !operation.view || operation.closed || operation.rejection || !sameSlackFormBinding(operation.binding, currentBinding))
    throw new SlackCloudReceiptError("form_new_use_not_current", "attention");
  return formOpens.run({ operation, currentBinding, environment }, work);
}
