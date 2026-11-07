import { replaceSlackFormReceiptSignature } from "./form-signature-refresh.js";
import { parseSlackFormRetirementReceipt } from "./ack-retirement-receipt.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { verifySlackFormRetirementReceipt } from "./receipt-authority.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { parseSlackFormPublicEnrollment, parseSlackFormBinding, sameSlackFormBinding } from "./cloud-forms.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import type { SlackFormConnectorIdentity } from "./cloud-consumer.js";
import type { SlackFormProtocol } from "./form-owner.js";
import type { SlackFormRetirementReceipt } from "./ack-retirement-receipt.js";
type Row = typeof chatActions.$inferSelect;
function retry(code: string): never { throw new SlackCloudReceiptError(code, "retry"); }
export function assertSlackFormRetirementWorkAuthority(row: Row, identity: SlackFormConnectorIdentity, receipt: SlackFormRetirementReceipt): void {
  const enrollment = parseSlackFormPublicEnrollment(row.payload.enrollment), binding = receipt.binding;
  if (row.kind !== "slack_form_owner" || row.companyId !== binding.companyId || row.endpointId !== binding.endpointId
    || row.payload.subject !== receipt.subject || row.payload.environment !== receipt.environment || receipt.environment !== identity.environment
    || binding.instanceId !== identity.instanceId || enrollment.bindingId !== binding.eventBindingId
    || ["instanceId", "companyId", "endpointId", "publicId", "connectionId", "runtimeGeneration", "teamId", "appId"].some(key => Reflect.get(binding, key) !== Reflect.get(enrollment, key)))
    throw new SlackCloudReceiptError("form_retirement_authority_changed", "attention");
  if (row.payload.binding !== undefined && !sameSlackFormBinding(parseSlackFormBinding(row.payload.binding), binding))
    throw new SlackCloudReceiptError("form_retirement_fingerprint_changed", "attention");
  if (row.result?.retirementReceipt !== undefined && !isDeepStrictEqual(row.result.retirementReceipt, receipt))
    throw new SlackCloudReceiptError("form_retirement_receipt_changed", "attention");
  const expectedAction = `slack-form-owner:${createHash("sha256").update(JSON.stringify(enrollment)).digest("hex")}`;
  if (row.providerActionId !== expectedAction) throw new SlackCloudReceiptError("form_retirement_owner_changed", "attention");
}
export function verifyRetainedSlackFormRetirement(compactJws: string) {
  try { return verifySlackFormRetirementReceipt({ compactJws }); }
  catch (error) {
    if (error instanceof Error && ["PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS is not configured", "PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS is invalid",
      "Cloud runtime identity uses an unknown signing key"].includes(error.message)) return retry("form_retirement_verifier_unavailable");
    throw new SlackCloudReceiptError("form_retirement_receipt_invalid", "attention");
  }
}
export async function acceptSlackFormRetirementLocally(db: Db, row: Row, identity: SlackFormConnectorIdentity, compactJws: string): Promise<void> {
  const receipt = verifyRetainedSlackFormRetirement(compactJws); assertSlackFormRetirementWorkAuthority(row, identity, receipt);
  await db.transaction(async tx => {
    const [current] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId))).for("update");
    if (!current || current.status !== row.status || !isDeepStrictEqual(current.payload, row.payload) || !isDeepStrictEqual(current.result, row.result)) return retry("form_retirement_acceptance_changed");
    if (["transferred", "retirement_accepted", "retirement_gc_pending"].includes(String(current.result?.phase))) return;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const updated = await tx.update(chatActions).set({ status: "issued", result: { ...current.result, phase: "retirement_accepted",
      retirementReceiptJws: compactJws, retirementReceipt: receipt, nextAttemptAt: new Date().toISOString() }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId), eq(chatActions.status, row.status),
        sql`${chatActions.payload} = ${JSON.stringify(current.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(current.result)}::jsonb`)).returning({ id: chatActions.id });
    if (updated.length !== 1) return retry("form_retirement_acceptance_changed");
  });
}
export async function transferSlackFormRetirement(db: Db, snapshot: Row, identity: SlackFormConnectorIdentity, protocol: SlackFormProtocol): Promise<void> {
  let row = snapshot;
  if (row.result?.phase === "retirement_gc_pending") return releaseSlackRetirementFact(db, row, identity, protocol);
  if (row.result?.phase !== "retirement_accepted" || typeof row.result.retirementReceiptJws !== "string") return retry("form_retirement_acceptance_missing");
  const receipt = parseSlackFormRetirementReceipt(row.result.retirementReceipt); assertSlackFormRetirementWorkAuthority(row, identity, receipt);
  const refreshed = await protocol({ subject: receipt.subject, companyId: row.companyId, operation: { kind: "cleanup", binding: receipt.binding,
    refreshRetirementReceipt: { receiptId: receipt.receiptId, ownerId: receipt.ownerId } } });
  if (!refreshed || typeof refreshed !== "object" || Array.isArray(refreshed) || Object.keys(refreshed).join() !== "retirementReceiptJws"
    || typeof Reflect.get(refreshed, "retirementReceiptJws") !== "string") return retry("form_signature_refresh_unconfirmed");
  const compactJws = Reflect.get(refreshed, "retirementReceiptJws");
  if (typeof compactJws !== "string" || !isDeepStrictEqual(verifyRetainedSlackFormRetirement(compactJws), receipt))
    throw new SlackCloudReceiptError("form_signature_canonical_changed", "attention");
  row = await replaceSlackFormReceiptSignature(db, row, "retirementReceiptJws", compactJws);
  const response = await protocol({ subject: receipt.subject, companyId: row.companyId,
    operation: { kind: "cleanup", binding: receipt.binding, acceptedRetirementReceipt: compactJws } });
  if (!response || typeof response !== "object" || Array.isArray(response) || Object.keys(response).join() !== "acceptedRetirementDigest"
    || Reflect.get(response, "acceptedRetirementDigest") !== receipt.receiptId) return retry("form_retirement_transfer_unconfirmed");
  await db.transaction(async tx => {
    const [current] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId))).for("update");
    if (!current || current.status !== row.status || !isDeepStrictEqual(current.payload, row.payload) || !isDeepStrictEqual(current.result, row.result)) return retry("form_retirement_transfer_changed");
    const result = current.result ?? {};
    const retirement = { version: 1, binding: receipt.binding, instanceId: identity.instanceId, environment: identity.environment,
      subject: receipt.subject, receiptDigest: receipt.receiptId, receipt };
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const updated = await tx.update(chatActions).set({ status: "issued", result: { ...result, phase: "retirement_gc_pending", nextAttemptAt: new Date().toISOString(), retirement }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId), eq(chatActions.status, row.status),
        sql`${chatActions.payload} = ${JSON.stringify(current.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(current.result)}::jsonb`)).returning({ id: chatActions.id });
    if (updated.length !== 1) return retry("form_retirement_transfer_changed");
    const grants = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId),
      eq(chatActions.kind, "slack_form_grant"), sql`${chatActions.payload}->'binding' = ${JSON.stringify(receipt.binding)}::jsonb`)).for("update");
    for (const grant of grants) {
      if (grant.payload.environment !== identity.environment || grant.payload.subject !== receipt.subject)
        throw new SlackCloudReceiptError("form_grant_retirement_identity_changed", "attention");
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
      const cancelled = await tx.update(chatActions).set({ status: "cancelled", result: { ...grant.result, phase: "transferred", nextAttemptAt: null, retirement }, updatedAt: new Date() })
        .where(and(eq(chatActions.id, grant.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId), eq(chatActions.status, grant.status),
          sql`${chatActions.payload} = ${JSON.stringify(grant.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(grant.result)}::jsonb`)).returning({ id: chatActions.id });
      if (cancelled.length !== 1) return retry("form_grant_retirement_changed");
    }
  });
}

export function assertSlackRetirementGCWork(row: Row, identity: SlackFormConnectorIdentity): SlackFormRetirementReceipt {
  if (row.result?.phase !== "retirement_gc_pending") throw new SlackCloudReceiptError("form_retirement_gc_missing", "attention");
  const receipt = parseSlackFormRetirementReceipt(row.result.retirementReceipt);
  assertSlackFormRetirementWorkAuthority(row, identity, receipt);
  const expected = { version: 1, binding: receipt.binding, instanceId: identity.instanceId, environment: identity.environment,
    subject: receipt.subject, receiptDigest: receipt.receiptId, receipt };
  if (!isDeepStrictEqual(row.result.retirement, expected)) throw new SlackCloudReceiptError("form_retirement_gc_authority_changed", "attention");
  return receipt;
}
async function releaseSlackRetirementFact(db: Db, row: Row, identity: SlackFormConnectorIdentity, protocol: SlackFormProtocol): Promise<void> {
  const receipt = assertSlackRetirementGCWork(row, identity);
  const response = await protocol({ subject: receipt.subject, companyId: row.companyId,
    operation: { kind: "cleanup", binding: receipt.binding, releaseRetirementFact: { receiptId: receipt.receiptId } } });
  if (!response || typeof response !== "object" || Array.isArray(response) || Object.keys(response).join() !== "releasedRetirementDigest"
    || Reflect.get(response, "releasedRetirementDigest") !== receipt.receiptId) return retry("form_retirement_gc_unconfirmed");
  await db.transaction(async tx => {
    const [current] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId))).for("update");
    if (!current || current.status !== row.status || !isDeepStrictEqual(current.payload, row.payload) || !isDeepStrictEqual(current.result, row.result)) return retry("form_retirement_gc_changed");
    const { retirementReceiptJws: _, ...result } = current.result ?? {};
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const rows = await tx.update(chatActions).set({ status: "processed", result: { ...result, phase: "transferred", nextAttemptAt: null }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId), eq(chatActions.status, row.status),
        sql`${chatActions.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
    if (rows.length !== 1) return retry("form_retirement_gc_changed");
  });
}
