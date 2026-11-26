import { replaceSlackFormReceiptSignature } from "./form-signature-refresh.js";
import { readSlackFormOriginalProofs } from "./form-opening-proof.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { verifySlackFormFinalizedReceipt } from "./receipt-authority.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import { parseSlackFormBinding, sameSlackFormBinding } from "./cloud-forms.js";
import { parseSlackFormProofAcceptance } from "./form-session.js";
import { parseSlackFormFinalizedReceipt, slackFormFinalizedReceiptDigest, type SlackFormFinalizedReceipt } from "./ack-receipt.js";

type Tx = Pick<Db, "select" | "update">;
function fail(code: string): never { throw new SlackCloudReceiptError(code, "attention"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("form_ack_record_invalid");
  return Object.fromEntries(Object.entries(value));
}
export type SlackFormAckWork = Readonly<{
  version: 1; phase: "pending" | "accepted" | "gc_pending" | "transferred"; leaseId: string; deliveryId: string;
  receiptJws: string | null; receipt: SlackFormFinalizedReceipt | null;
}>;
export function parseSlackFormAckWork(value: unknown): SlackFormAckWork {
  const v = record(value);
  if (Object.keys(v).sort().join() !== "deliveryId,leaseId,phase,receipt,receiptJws,version" || v.version !== 1
    || typeof v.leaseId !== "string" || !v.leaseId.length || v.leaseId.length > 200
    || typeof v.deliveryId !== "string" || !/^slack_form_[a-f0-9]{64}$/.test(v.deliveryId)
    || v.phase !== "pending" && v.phase !== "accepted" && v.phase !== "gc_pending" && v.phase !== "transferred"
    || v.receiptJws !== null && (typeof v.receiptJws !== "string" || Buffer.byteLength(v.receiptJws, "ascii") > 12000 || !/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/.test(v.receiptJws))) return fail("form_ack_work_invalid");
  const receipt = v.receipt === null ? null : parseSlackFormFinalizedReceipt(v.receipt);
  if (v.phase === "pending" ? receipt !== null || v.receiptJws !== null : !receipt || typeof v.receiptJws !== "string") return fail("form_ack_work_invalid");
  if (receipt && receipt.deliveryId !== v.deliveryId) return fail("form_ack_delivery_changed");
  return { version: 1, phase: v.phase, leaseId: v.leaseId, deliveryId: v.deliveryId, receiptJws: typeof v.receiptJws === "string" ? v.receiptJws : null, receipt };
}
export function assertSlackFormReceiptHistory(row: Pick<typeof chatActions.$inferSelect, "id" | "companyId" | "endpointId" | "kind" | "payload" | "result">, receipt: SlackFormFinalizedReceipt): void {
  const intent = record(row.result?.terminalIntent), proof = parseSlackFormProofAcceptance(row.result?.cloudProofAcceptance);
  const binding = parseSlackFormBinding(row.payload.binding), view = intent.view;
  let viewDigest: string | null = null;
  if (view !== null) {
    const parsed = record(view);
    if (Object.keys(parsed).sort().join() !== "externalId,hash,id" || typeof parsed.id !== "string" || typeof parsed.hash !== "string" || typeof parsed.externalId !== "string")
      return fail("form_ack_view_changed");
    viewDigest = createHash("sha256").update(JSON.stringify([parsed.id, parsed.hash, parsed.externalId]), "utf8").digest("hex");
  }
  if (row.kind !== "slack_form_session" || row.companyId !== receipt.binding.companyId || row.endpointId !== receipt.binding.endpointId
    || !sameSlackFormBinding(binding, receipt.binding) || !sameSlackFormBinding(proof.binding, binding)
    || row.id !== receipt.appReceiptId || proof.appReceiptId !== row.id || intent.appReceiptId !== row.id
    || receipt.environment !== row.payload.environment || receipt.operationId !== row.payload.operationId || receipt.operationId !== intent.operationId
    || receipt.deliveryId !== intent.deliveryId || receipt.grantId !== row.payload.grantId || receipt.publicationId !== row.payload.publicationId
    || receipt.interactionId !== row.payload.interactionId || receipt.userId !== row.payload.userId || receipt.outcome !== intent.outcome
    || receipt.terminalDigest !== proof.terminalDigest || receipt.outcome !== proof.outcome || receipt.viewDigest !== viewDigest
    || row.result?.phase !== (receipt.outcome === "no_effect" ? "not_opened" : receipt.outcome))
    fail("form_ack_terminal_identity_changed");
}
export async function stageSlackFormNormalAck(tx: Tx, input: { companyId: string; instanceId: string; leaseId: string; deliveryIds: readonly string[] }): Promise<void> {
  const ids = [...new Set(input.deliveryIds.filter(id => /^slack_form_[a-f0-9]{64}$/.test(id)))];
  if (!ids.length) return;
  if (ids.length > 50 || !input.leaseId.length || input.leaseId.length > 200) return fail("form_ack_batch_invalid");
  const rows = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, input.companyId), eq(chatActions.kind, "slack_form_session"),
    inArray(chatActions.providerActionId, ids.map(id => `slack-form-session:${id.slice("slack_form_".length)}`)))).for("update");
  if (rows.length !== ids.length) return fail("form_ack_session_missing");
  for (const row of rows) {
    const intent = record(row.result?.terminalIntent), proof = parseSlackFormProofAcceptance(row.result?.cloudProofAcceptance);
    if (row.companyId !== input.companyId || proof.binding.companyId !== input.companyId || proof.binding.instanceId !== input.instanceId || proof.appReceiptId !== row.id || !ids.includes(String(intent.deliveryId))
      || row.companyId !== proof.binding.companyId || row.endpointId !== proof.binding.endpointId
      || !["submitted", "closed", "not_opened"].includes(String(row.result?.phase))) return fail("form_ack_authority_changed");
    if (row.result?.formAck !== undefined) {
      const old = parseSlackFormAckWork(row.result.formAck);
      if (old.deliveryId !== intent.deliveryId) return fail("form_ack_delivery_changed");
      if (old.phase !== "pending") continue;
    }
    const work: SlackFormAckWork = { version: 1, phase: "pending", leaseId: input.leaseId, deliveryId: String(intent.deliveryId), receiptJws: null, receipt: null };
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const staged = await tx.update(chatActions).set({ result: { ...row.result, formAck: work, nextAttemptAt: new Date().toISOString() }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
    if (staged.length !== 1) return fail("form_ack_stage_changed");
  }
}
export async function acceptSlackFormAckReceipt(tx: Tx, input: { companyId: string; instanceId: string; leaseId: string; receiptJws: string }): Promise<string> {
  const receipt = verifyRetainedSlackAckReceipt(input.receiptJws);
  if (receipt.binding.companyId !== input.companyId) return fail("form_ack_company_changed");
  if (receipt.binding.instanceId !== input.instanceId) return fail("form_ack_instance_changed");
  const [row] = await tx.select().from(chatActions).where(and(eq(chatActions.id, receipt.appReceiptId), eq(chatActions.companyId, input.companyId),
    eq(chatActions.endpointId, receipt.binding.endpointId), eq(chatActions.kind, "slack_form_session"))).for("update");
  if (!row) return fail("form_ack_session_missing");
  assertSlackFormReceiptHistory(row, receipt);
  const old = parseSlackFormAckWork(row.result?.formAck);
  if (old.leaseId !== input.leaseId || old.deliveryId !== receipt.deliveryId) return fail("form_ack_lease_changed");
  if (old.receipt && !isDeepStrictEqual(old.receipt, receipt)) return fail("form_ack_receipt_changed");
  if (old.phase === "transferred" || old.phase === "gc_pending") return row.id;
  const work: SlackFormAckWork = { ...old, phase: "accepted", receiptJws: input.receiptJws, receipt };
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const updated = await tx.update(chatActions).set({ result: { ...row.result, formAck: work, nextAttemptAt: new Date().toISOString() }, updatedAt: new Date() })
    .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
  if (updated.length !== 1) return fail("form_ack_acceptance_changed");
  return row.id;
}
export async function transferSlackFormAckReceipt(db: Db, input: { companyId: string; actionId: string; instanceId: string;
  onSnapshot?(snapshot: typeof chatActions.$inferSelect): void;
  protocol(values: { subject: string; companyId: string; operation: Record<string, unknown> }): Promise<unknown> }): Promise<void> {
  let [row] = await db.select().from(chatActions).where(and(eq(chatActions.id, input.actionId), eq(chatActions.companyId, input.companyId), eq(chatActions.kind, "slack_form_session"))).limit(1);
  if (!row) return fail("form_ack_session_missing");
  if (row.companyId !== input.companyId) return fail("form_ack_company_changed");
  let work = parseSlackFormAckWork(row.result?.formAck);
  if (work.phase === "transferred") return;
  if (work.phase === "gc_pending") return releaseSlackAckFact(db, row, input);
  if (work.phase !== "accepted" || !work.receipt || !work.receiptJws || work.receipt.binding.companyId !== input.companyId || work.receipt.binding.instanceId !== input.instanceId)
    return fail("form_ack_acceptance_missing");
  assertSlackFormReceiptHistory(row, work.receipt);
  const refreshResponse = record(await input.protocol({ subject: "github-bot-events", companyId: row.companyId, operation: {
    kind: "receipt", binding: work.receipt.binding, operationId: work.receipt.operationId, deliveryId: work.deliveryId,
    refreshAckReceipt: { leaseId: work.leaseId, receiptDigest: slackFormFinalizedReceiptDigest(work.receipt), appReceiptId: row.id } } }));
  if (Object.keys(refreshResponse).join() !== "ackReceiptJws" || typeof refreshResponse.ackReceiptJws !== "string")
    throw new SlackCloudReceiptError("form_signature_refresh_unconfirmed", "retry");
  const currentJws = refreshResponse.ackReceiptJws;
  const refreshed = verifyRetainedSlackAckReceipt(currentJws);
  if (!isDeepStrictEqual(refreshed, work.receipt)) return fail("form_signature_canonical_changed");
  row = await replaceSlackFormReceiptSignature(db, row, "formAck", currentJws);
  input.onSnapshot?.(row);
  work = parseSlackFormAckWork(row.result?.formAck);
  if (!work.receipt) return fail("form_ack_acceptance_missing");
  const originals = readSlackFormOriginalProofs(row);
  const operation = { kind: "receipt", binding: work.receipt.binding, operationId: work.receipt.operationId, deliveryId: work.deliveryId,
    acceptedAckReceipt: currentJws };
  let response = record(await input.protocol({ subject: "github-bot-events", companyId: row.companyId,
    operation: { ...operation, originalOpening: originals.opening } }));
  const digest = slackFormFinalizedReceiptDigest(work.receipt);
  if (response.acceptedReceiptDigest !== digest || typeof response.needsTerminalOriginal !== "boolean") return fail("form_ack_transfer_receipt_changed");
  if (response.needsTerminalOriginal) {
    if (!originals.terminal) return fail("form_terminal_original_proof_missing");
    response = record(await input.protocol({ subject: "github-bot-events", companyId: row.companyId,
      operation: { ...operation, terminalOriginal: originals.terminal } }));
    if (response.acceptedReceiptDigest !== digest || response.needsTerminalOriginal !== false) return fail("form_ack_transfer_receipt_changed");
  }
  await db.transaction(async tx => {
    const [current] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId))).for("update");
    if (!current || current.status !== row.status || !isDeepStrictEqual(current.payload, row.payload) || !isDeepStrictEqual(current.result, row.result)) return fail("form_ack_transfer_custody_changed");
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const retainedResult = Object.fromEntries(Object.entries(current.result ?? {}).filter(([key]) => key !== "openingProof"));
    const completed = await tx.update(chatActions).set({ result: { ...retainedResult, formAck: { ...work, phase: "gc_pending" }, nextAttemptAt: new Date().toISOString() }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId), eq(chatActions.status, row.status),
        sql`${chatActions.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
    if (completed.length !== 1) throw new SlackCloudReceiptError("form_ack_transfer_custody_changed", "retry");
  });
}

export async function reconcileSlackFormNormalAck(db: Db, input: { companyId: string; actionId: string; instanceId: string; connector: unknown;
  onSnapshot?(snapshot: typeof chatActions.$inferSelect): void;
  protocol(values: { subject: string; companyId: string; operation: Record<string, unknown> }): Promise<unknown> }): Promise<void> {
  const [row] = await db.select().from(chatActions).where(and(eq(chatActions.id, input.actionId), eq(chatActions.companyId, input.companyId), eq(chatActions.kind, "slack_form_session"))).limit(1);
  if (!row) return fail("form_ack_session_missing");
  if (row.companyId !== input.companyId) return fail("form_ack_company_changed");
  const work = parseSlackFormAckWork(row.result?.formAck);
  if (work.phase === "transferred") return;
  if (work.phase === "pending") {
    const binding = parseSlackFormBinding(row.payload.binding);
    if (binding.companyId !== input.companyId || binding.instanceId !== input.instanceId || !input.connector || typeof input.connector !== "object") return fail("form_ack_instance_changed");
    const acknowledge = Reflect.get(input.connector, "acknowledgeEventsWithReceipts");
    if (typeof acknowledge !== "function") return fail("form_ack_receipts_unsupported");
    const response = record(await Reflect.apply(acknowledge, input.connector, [{ subject: "github-bot-events", companyId: row.companyId,
      leaseId: work.leaseId, deliveryIds: [work.deliveryId] }]));
    if (!Array.isArray(response.formReceipts) || response.formReceipts.length !== 1) return fail("form_ack_receipt_missing");
    const receipt = record(response.formReceipts[0]);
    if (receipt.deliveryId !== work.deliveryId || typeof receipt.receiptJws !== "string") return fail("form_ack_receipt_changed");
    await db.transaction(tx => acceptSlackFormAckReceipt(tx, { companyId: input.companyId, instanceId: input.instanceId, leaseId: work.leaseId, receiptJws: String(receipt.receiptJws) }));
  }
  await transferSlackFormAckReceipt(db, input);
}

function verifyRetainedSlackAckReceipt(compactJws: string): SlackFormFinalizedReceipt {
  try { return verifySlackFormFinalizedReceipt({ compactJws }); }
  catch (error) {
    if (error instanceof Error && ["PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS is not configured", "PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS is invalid",
      "Cloud runtime identity uses an unknown signing key"].includes(error.message)) throw new SlackCloudReceiptError("form_ack_verifier_unavailable", "retry");
    return fail("form_ack_receipt_invalid");
  }
}
async function releaseSlackAckFact(db: Db, row: typeof chatActions.$inferSelect, input: { companyId: string; actionId: string; instanceId: string;
  protocol(values: { subject: string; companyId: string; operation: Record<string, unknown> }): Promise<unknown> }): Promise<void> {
  const work = parseSlackFormAckWork(row.result?.formAck);
  if (work.phase !== "gc_pending" || !work.receipt || work.receipt.binding.companyId !== input.companyId || work.receipt.binding.instanceId !== input.instanceId)
    return fail("form_ack_gc_authority_changed");
  assertSlackFormReceiptHistory(row, work.receipt);
  const digest = slackFormFinalizedReceiptDigest(work.receipt);
  const response = record(await input.protocol({ subject: "github-bot-events", companyId: row.companyId, operation: {
    kind: "receipt", binding: work.receipt.binding, operationId: work.receipt.operationId, deliveryId: work.deliveryId,
    releaseAckFact: { leaseId: work.leaseId, receiptDigest: digest, appReceiptId: row.id } } }));
  if (Object.keys(response).join() !== "releasedAckDigest" || response.releasedAckDigest !== digest)
    throw new SlackCloudReceiptError("form_ack_gc_unconfirmed", "retry");
  await db.transaction(async tx => {
    const [current] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, row.endpointId))).for("update");
    if (!current || current.status !== row.status || !isDeepStrictEqual(current.payload, row.payload) || !isDeepStrictEqual(current.result, row.result))
      throw new SlackCloudReceiptError("form_ack_gc_changed", "retry");
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const updated = await tx.update(chatActions).set({ result: { ...current.result, formAck: { ...work, phase: "transferred" }, nextAttemptAt: null }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, input.companyId), eq(chatActions.endpointId, row.endpointId), eq(chatActions.status, row.status),
        sql`${chatActions.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
    if (updated.length !== 1) throw new SlackCloudReceiptError("form_ack_gc_changed", "retry");
  });
}
