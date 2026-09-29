import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { issueComments, nativeToolReceipts, nativeToolReceiptReferences, type Db } from "@paperclipai/db";

export type NativeToolReceipt = { operationId: string; input: unknown; result: unknown };
export type NativeToolReceiptBinding = { companyId: string; issueId: string; runId: string };
export type NativeToolReceiptReferenceKind = "publication" | "attachment-reuse" | "generated-comment";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digestKey = (key: string) => createHash("sha256").update(key).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function validReuseResult(receipt: NativeToolReceipt): boolean {
  const result = record(receipt.result);
  const prepared = record(result.prepared);
  return ["applied", "duplicate"].includes(String(result.disposition)) &&
    typeof prepared.attachmentId === "string" && UUID.test(prepared.attachmentId) &&
    Array.isArray(result.entityRefs) && result.entityRefs[0] === prepared.attachmentId &&
    result.commandId === `chat-attachment-reused:${prepared.attachmentId}`;
}

function parseReceipt(value: unknown): NativeToolReceipt {
  const receipt = record(value);
  if (typeof receipt.operationId !== "string" || !receipt.operationId ||
      !Object.hasOwn(receipt, "input") || !Object.hasOwn(receipt, "result")) {
    throw new Error("native_tool_receipt_invalid");
  }
  return receipt as NativeToolReceipt;
}

/** Caller holds the authenticated run lock. A hash collision/corrupt key is an
 * integrity failure, never an absent receipt that permits repeating an effect. */
export async function readNativeToolReceipt(db: Db, binding: NativeToolReceiptBinding, key: string, legacy?: unknown): Promise<NativeToolReceipt | null> {
  const [row] = await db.select().from(nativeToolReceipts).where(and(
    eq(nativeToolReceipts.companyId, binding.companyId), eq(nativeToolReceipts.runId, binding.runId),
    eq(nativeToolReceipts.keySha256, digestKey(key)),
  )).limit(1);
  if (!row) {
    const receipts = record(legacy);
    return Object.hasOwn(receipts, key) ? parseReceipt(receipts[key]) : null;
  }
  if (row.issueId !== binding.issueId || row.idempotencyKey !== key) throw new Error("native_tool_receipt_binding_mismatch");
  return parseReceipt(row.receipt);
}

export function nativeToolReceiptReferencesFor(receipt: NativeToolReceipt): Array<{ kind: NativeToolReceiptReferenceKind; target: string }> {
  const input = record(receipt.input);
  const result = record(receipt.result);
  const references: Array<{ kind: NativeToolReceiptReferenceKind; target: string }> = [];
  const add = (kind: NativeToolReceiptReferenceKind, target: unknown) => {
    if (typeof target === "string" && UUID.test(target)) references.push({ kind, target });
  };
  if (receipt.operationId === "report_progress") add("generated-comment", result.commentId);
  // A known input tuple remains a duplicate-effect fence even when its old
  // result is damaged. Lookup must report that damage, never repeat the effect.
  if (receipt.operationId === "reuse_chat_attachment" &&
      typeof input.sourceCommentId === "string" && UUID.test(input.sourceCommentId) &&
      typeof input.attachmentId === "string" && UUID.test(input.attachmentId)) {
    references.push({ kind: "attachment-reuse", target: `${input.sourceCommentId}/${input.attachmentId}` });
  }
  if (!["applied", "duplicate"].includes(String(result.disposition))) return references;
  const refs = Array.isArray(result.entityRefs) ? result.entityRefs : [];
  if (receipt.operationId === "register_deliverable" &&
      typeof result.attachmentId === "string" && UUID.test(result.attachmentId) &&
      refs[0] === result.attachmentId && result.commandId === `deliverable-prepared:${result.attachmentId}`) {
    add("publication", refs[0]);
    // Register-deliverable has no dedicated commentId. Its exact server command
    // and attachment binding authenticate the legacy comment-ID references.
    for (const target of refs) add("generated-comment", target);
  }
  const prepared = record(result.prepared);
  if (receipt.operationId === "reuse_chat_attachment" &&
      typeof prepared.attachmentId === "string" && UUID.test(prepared.attachmentId) &&
      refs[0] === prepared.attachmentId && result.commandId === `chat-attachment-reused:${prepared.attachmentId}`) {
    add("publication", refs[0]);
    if (typeof prepared.commentId === "string" && refs.includes(prepared.commentId)) add("generated-comment", prepared.commentId);
  }
  return references.filter((ref, index) => references.findIndex(prior => prior.kind === ref.kind && prior.target === ref.target) === index);
}

/** Shares the caller's transaction with its actual business effect. */
export async function insertNativeToolReceipt(db: Db, binding: NativeToolReceiptBinding, key: string, receipt: NativeToolReceipt): Promise<void> {
  parseReceipt(receipt);
  const keySha256 = digestKey(key);
  await db.insert(nativeToolReceipts).values({ ...binding, keySha256, idempotencyKey: key, receipt });
  const references = nativeToolReceiptReferencesFor(receipt);
  if (references.length) await db.insert(nativeToolReceiptReferences).values(references.map(ref => ({
    companyId: binding.companyId, runId: binding.runId, keySha256, ...ref,
  })));
  const comments = references.filter(ref => ref.kind === "generated-comment").map(ref => ref.target);
  if (comments.length) await db.update(issueComments).set({ nativeToolGenerated: true }).where(and(
    eq(issueComments.companyId, binding.companyId), eq(issueComments.issueId, binding.issueId),
    eq(issueComments.createdByRunId, binding.runId), inArray(issueComments.id, comments),
  ));
}

export async function findNativeToolReceiptReference(db: Db, binding: NativeToolReceiptBinding,
  kind: NativeToolReceiptReferenceKind, target: string): Promise<NativeToolReceipt | null> {
  const [row] = await db.select({ receipt: nativeToolReceipts.receipt, issueId: nativeToolReceipts.issueId,
    keySha256: nativeToolReceipts.keySha256, idempotencyKey: nativeToolReceipts.idempotencyKey })
    .from(nativeToolReceiptReferences).innerJoin(nativeToolReceipts, and(
      eq(nativeToolReceipts.companyId, nativeToolReceiptReferences.companyId),
      eq(nativeToolReceipts.runId, nativeToolReceiptReferences.runId),
      eq(nativeToolReceipts.keySha256, nativeToolReceiptReferences.keySha256),
    )).where(and(
      eq(nativeToolReceiptReferences.companyId, binding.companyId), eq(nativeToolReceiptReferences.runId, binding.runId),
      eq(nativeToolReceiptReferences.kind, kind), eq(nativeToolReceiptReferences.target, target),
    )).orderBy(nativeToolReceiptReferences.keySha256).limit(1);
  if (!row) return null;
  if (row.issueId !== binding.issueId || digestKey(row.idempotencyKey) !== row.keySha256) throw new Error("native_tool_receipt_binding_mismatch");
  const receipt = parseReceipt(row.receipt);
  if (!nativeToolReceiptReferencesFor(receipt).some(ref => ref.kind === kind && ref.target === target)) {
    throw new Error("native_tool_receipt_reference_mismatch");
  }
  if (kind === "attachment-reuse" && !validReuseResult(receipt)) throw new Error("native_tool_receipt_invalid");
  return receipt;
}
