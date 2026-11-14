import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import type { StoredSecretVersionMaterial } from "../../../secrets/types.js";
import { createLocalEncryptedCipher } from "../../../secrets/local-encrypted-provider.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { SlackCloudReceiptError } from "./cloud-event.js";
import { parseSlackFormBinding, sameSlackFormBinding, type SlackFormOperation } from "./cloud-forms.js";
type Tx = Pick<Db, "select" | "update">;
function fail(code: string): never { throw new SlackCloudReceiptError(code, "attention"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("form_opening_proof_invalid");
  return Object.fromEntries(Object.entries(value));
}
function opening(value: unknown): { rawBody: string; timestamp: string; signature: string } {
  const raw = object(value);
  if (Object.keys(raw).sort().join() !== "rawBody,signature,timestamp" || typeof raw.rawBody !== "string" || raw.rawBody.length > 1398104
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.rawBody)
    || typeof raw.timestamp !== "string" || !/^[0-9]{1,16}$/.test(raw.timestamp) || typeof raw.signature !== "string" || !/^v0=[a-f0-9]{64}$/.test(raw.signature))
    return fail("form_opening_proof_invalid");
  return { rawBody: raw.rawBody, timestamp: raw.timestamp, signature: raw.signature };
}
const digest = (raw: ReturnType<typeof opening>) => createHash("sha256").update(JSON.stringify([raw.rawBody, raw.timestamp, raw.signature])).digest("hex");
export function readSlackFormOriginalProofs(row: Pick<typeof chatActions.$inferSelect, "id" | "companyId" | "endpointId" | "kind" | "payload" | "result">): { opening: ReturnType<typeof opening>; terminal: ReturnType<typeof opening> | null } {
  const saved = object(row.result?.openingProof);
  if (row.kind !== "slack_form_session" || saved.version !== 1 || Object.keys(saved).sort().join() !== "material,version") return fail("form_opening_proof_invalid");
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(createLocalEncryptedCipher("read").decrypt(object(saved.material)))); }
  catch { return fail("form_opening_cipher_unavailable"); }
  const binding = parseSlackFormBinding(row.payload.binding);
  if (value.version !== 1 || value.kind !== "slack_form_original_opening" || value.appReceiptId !== row.id || value.companyId !== row.companyId || value.endpointId !== row.endpointId
    || value.operationId !== row.payload.operationId || value.environment !== row.payload.environment
    || !sameSlackFormBinding(parseSlackFormBinding(value.binding), binding)) return fail("form_opening_cipher_binding_changed");
  const raw = opening(value.original);
  if (digest(raw) !== row.payload.requestDigest) return fail("form_opening_cipher_binding_changed");
  if (value.terminal === undefined) return fail("form_terminal_original_proof_missing");
  return { opening: raw, terminal: value.terminal === null ? null : opening(value.terminal) };
}
export async function retainSlackFormOpeningProof(tx: Tx, input: { companyId: string; appReceiptId: string; operation: SlackFormOperation; original: unknown }): Promise<void> {
  const [row] = await tx.select().from(chatActions).where(and(eq(chatActions.id, input.appReceiptId), eq(chatActions.companyId, input.companyId),
    eq(chatActions.endpointId, input.operation.binding.endpointId), eq(chatActions.kind, "slack_form_session"))).for("update");
  if (!row || row.payload.operationId !== input.operation.id || row.payload.requestDigest !== input.operation.requestDigest
    || !sameSlackFormBinding(parseSlackFormBinding(row.payload.binding), input.operation.binding) || !row.result?.cloudProofAcceptance)
    return fail("form_opening_proof_authority_changed");
  const original = opening(input.original);
  if (digest(original) !== input.operation.requestDigest) return fail("form_opening_proof_changed");
  const terminal = input.operation.closed ? opening({ rawBody: input.operation.closed.evidence.rawBody,
    timestamp: input.operation.closed.evidence.timestamp, signature: input.operation.closed.evidence.signature }) : null;
  if (terminal && digest(terminal) !== input.operation.closed?.requestDigest) return fail("form_terminal_original_proof_changed");
  if (row.result.openingProof !== undefined) {
    if (!isDeepStrictEqual(readSlackFormOriginalProofs(row), { opening: original, terminal })) return fail("form_opening_proof_changed");
    return;
  }
  let material: StoredSecretVersionMaterial;
  try { material = createLocalEncryptedCipher("write").encrypt(JSON.stringify({ version: 1, kind: "slack_form_original_opening", appReceiptId: row.id, companyId: row.companyId,
    endpointId: row.endpointId, operationId: input.operation.id, environment: row.payload.environment, binding: input.operation.binding, original, terminal })); }
  catch { return fail("form_opening_cipher_unavailable"); }
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
  const changed = await tx.update(chatActions).set({ result: { ...row.result, openingProof: { version: 1, material } }, updatedAt: new Date() })
    .where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, input.companyId), sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning({ id: chatActions.id });
  if (changed.length !== 1) return fail("form_opening_proof_custody_changed");
}
