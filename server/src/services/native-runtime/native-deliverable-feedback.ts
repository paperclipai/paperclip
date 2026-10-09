import { and, eq } from "drizzle-orm";
import { assets, documents, documentRevisions, heartbeatRuns, issueDocuments, issueAttachments, issueWorkProducts, type Db } from "@paperclipai/db";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

function evidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && typeof entry.ref === "string") return [entry.ref];
    return [];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function hasCurrentPublicationReceipt(db: Db, companyId: string, receipts: unknown, attachment: {
  id: string; filename: string | null; byteSize: number; sha256: string;
}): Promise<boolean> {
  for (const value of Object.values(record(receipts))) {
    const receipt = record(value);
    const input = record(receipt.input);
    const result = record(receipt.result);
    if ((result.disposition !== "applied" && result.disposition !== "duplicate") ||
        !Array.isArray(result.entityRefs) || result.entityRefs[0] !== attachment.id) continue;
    if (receipt.operationId === "register_deliverable" &&
        result.commandId === `deliverable-prepared:${attachment.id}` &&
        typeof input.filename === "string" && input.filename.trim() === attachment.filename &&
        input.byteSize === attachment.byteSize &&
        typeof input.sha256 === "string" && input.sha256.trim().toLowerCase() === attachment.sha256.toLowerCase()) return true;
    if (receipt.operationId !== "reuse_chat_attachment" ||
        result.commandId !== `chat-attachment-reused:${attachment.id}`) continue;
    const prepared = record(result.prepared);
    const source = record(result.source);
    if (prepared.attachmentId !== attachment.id ||
        source.attachmentId !== input.attachmentId || source.commentId !== input.sourceCommentId ||
        typeof prepared.sha256 !== "string" || prepared.sha256.toLowerCase() !== attachment.sha256.toLowerCase() ||
        typeof source.sha256 !== "string" || source.sha256.toLowerCase() !== attachment.sha256.toLowerCase()) continue;
    if ("filename" in prepared || "byteSize" in prepared) {
      if (prepared.filename === attachment.filename && prepared.byteSize === attachment.byteSize) return true;
      continue;
    }
    // Older committed reuse receipts contain the authenticated source and hash,
    // but not its filename/size. Only an intact, matching source can supply those
    // missing facts; this does not authorize a new reuse or bypass its tool gate.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    if (typeof source.attachmentId !== "string" || !uuid.test(source.attachmentId) ||
        typeof source.commentId !== "string" || !uuid.test(source.commentId)) continue;
    const [original] = await db.select({ filename: assets.originalFilename, byteSize: assets.byteSize, sha256: assets.sha256 })
      .from(issueAttachments).innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, companyId)))
      .where(and(eq(issueAttachments.id, source.attachmentId), eq(issueAttachments.companyId, companyId),
        eq(issueAttachments.issueCommentId, source.commentId))).limit(1);
    if (original?.filename === attachment.filename && original.byteSize === attachment.byteSize &&
        original.sha256.toLowerCase() === attachment.sha256.toLowerCase()) return true;
  }
  return false;
}

/** Recognize explicit output requests, not incidental mentions of source files.
 * The current server-bound objective is authoritative; summaries cannot invent
 * an output requirement or erase a user's request for a file.
 */
export function explicitlyRequestsFileOutput(objective: string): boolean {
  return objective.split(/(?:[.!?](?:\s|$)|\n|[;,]|\bbut\b)/iu).some(clause => {
    const file = /\b(?:files?|attachments?|downloads?|pdf|spreadsheets?|workbooks?|slide decks?|powerpoints?|docx|xlsx|csv)\b|\b[^\s/]+\.(?:md|txt|pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|svg|zip)\b/giu;
    const create = /\b(?:create|make|write|save|export|attach|send|generate|produce|prepare|provide|give|return|build)\b/iu.exec(clause);
    if (create && /\b(?:do not|don't|never|no need to)\s*$/iu.test(clause.slice(0, create.index))) return false;
    const output = create ? clause.slice(create.index + create[0].length) : "";
    const fileObject = [...output.matchAll(file)].some(match => {
      const prefix = output.slice(0, match.index);
      const suffix = output.slice(match.index + match[0].length);
      // "Create no files" is a prohibition, even though it contains a creation
      // verb. Negate this object only; another explicit output can still count.
      if (/\b(?:no|zero|without(?:\s+any)?)\s+(?:(?:new|temporary|downloadable|attached|additional)\s+)*$/iu.test(prefix)) return false;
      // "Write a summary of this PDF" names input, not a requested file.
      // Explicit export destinations still count after such input references.
      const destination = /\b(?:as|into|to)\s+(?:(?:a|an|the|new|separate|markdown|word|excel)\s+)*$/iu.test(prefix);
      if (!destination && /\b(?:of|about|on|from|using|for|with)\b/iu.test(prefix)) return false;
      if (/^files?$/iu.test(match[0]) && /^\s+(?:permissions?|systems?|formats?|names?|paths?|types?|sizes?|descriptors?)\b/iu.test(suffix)) return false;
      return true;
    });
    return fileObject ||
      (!/\b(?:no|without)\s+(?:downloadable|attached)/iu.test(clause) && /\b(?:downloadable|attached)\s+(?:file|report|document|checklist|draft)\b/iu.test(clause));
  });
}

/** An explicitly requested document on the task must be published there. */
export function explicitlyRequestsTaskDocumentOutput(objective: string): boolean {
  // Keep comma-separated conditions with their imperative. This is a narrow
  // unconditional-output guard, not an interpreter of whether a condition held.
  return objective.split(/(?:[.!?](?:\s|$)|\n|;)/iu).some(statement => {
    // Check conditions before separating contrastive instructions: "create a
    // document, but only if ..." must not become an unconditional requirement.
    if (/\b(?:if|unless|when|once|otherwise|provided that|in case)\b/iu.test(statement)) return false;
    return statement.split(/\bbut\b/iu).some(clause => {
      if (/\boptionally\b/iu.test(clause)) return false;
      const create = /\b(?:create|make|write|save|publish|prepare|provide|attach)\b/iu.exec(clause);
      if (!create) return false;
      const before = clause.slice(0, create.index);
      if (/\b(?:do not|don['’]t|never|no need to|may|could|can)\b/iu.test(before)) return false;
      if (/\b(?:explain|describe|discuss|review)\b/iu.test(before)) return false;
      const output = clause.slice(create.index + create[0].length);
      return [...output.matchAll(/\b(?:document|doc)\b/giu)].some(match => {
        const prefix = output.slice(0, match.index);
        if (/\b(?:of|about|from|using|for|with|without|no|zero)\b/iu.test(prefix)) return false;
        return /^\s+(?:on|to|in|attached to)\s+(?:this|the|current)\s+(?:task|issue)\b/iu.test(output.slice(match.index + match[0].length));
      });
    });
  });
}

/** Current attached revisions with server-owned publication proof. Joining the
 * revision to its originating run preserves completed work across continuations
 * without accepting stale, foreign-task, or provider-invented document refs.
 */
export async function publishedTaskDocuments(db: Db, binding: { companyId: string; issueId: string }) {
  const saved = await db.select({ id: documents.id, revisionId: documents.latestRevisionId,
    key: issueDocuments.key, resultJson: heartbeatRuns.resultJson })
    .from(issueDocuments)
    .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, binding.companyId)))
    .innerJoin(documentRevisions, and(eq(documentRevisions.id, documents.latestRevisionId),
      eq(documentRevisions.documentId, documents.id), eq(documentRevisions.companyId, binding.companyId)))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, documentRevisions.createdByRunId),
      eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.nativeIssueId, binding.issueId),
      eq(heartbeatRuns.runtimeMode, "native")))
    .where(and(eq(issueDocuments.companyId, binding.companyId), eq(issueDocuments.issueId, binding.issueId)));
  return saved.filter(document => Object.values(record(document.resultJson?.semanticToolReceipts)).some(value => {
    const receipt = record(value), result = record(receipt.result), published = record(result.document);
    return receipt.operationId === "write_document" && ["applied", "duplicate"].includes(String(result.disposition))
      && published.id === document.id && published.latestRevisionId === document.revisionId;
  })).map(({ id, revisionId, key }) => ({ id, revisionId, key }));
}

/** Files cited as completed output must be reachable outside the agent workspace. */
export async function validateNativeDeliverableEvidence(
  db: Db,
  binding: { companyId: string; issueId: string; runId: string; objective: string; semanticToolReceipts: unknown },
  result: PrpStructuredRunResult,
): Promise<void> {
  if (result.reportedWorkDisposition !== "done") return;
  const fileRequested = explicitlyRequestsFileOutput(binding.objective);
  const taskDocumentRequested = explicitlyRequestsTaskDocumentOutput(binding.objective);
  const publishedTaskDocument = taskDocumentRequested && (await publishedTaskDocuments(db, binding)).length > 0;
  const artifactRefs = new Set(evidenceRefs(result.artifacts));
  const refs = new Set([
    ...evidenceRefs(result.evidence),
    ...artifactRefs,
    ...result.completionClaim.criteria.flatMap(({ evidenceRefs }) => evidenceRefs),
  ]);
  let registeredAttachment = false;
  for (const value of refs) {
    if (typeof value !== "string") continue;
    const ref = value.trim();
    const attachmentPath = /^\/api\/attachments\/([^/?#]+)\/content(?:[?#].*)?$/u.exec(ref);
    if (ref.startsWith("deliverable:") || attachmentPath) {
      const id = attachmentPath?.[1] ?? ref.slice("deliverable:".length);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
      const [attachment] = uuid.test(id)
        ? await db.select({ id: issueAttachments.id, originatingRunId: issueAttachments.originatingRunId,
            filename: assets.originalFilename, byteSize: assets.byteSize, sha256: assets.sha256 }).from(issueAttachments)
            .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, binding.companyId)))
            .where(and(eq(issueAttachments.id, id), eq(issueAttachments.companyId, binding.companyId), eq(issueAttachments.issueId, binding.issueId)))
            .limit(1)
        : [];
      if (!attachment) {
        throw new Error("Completion cites no registered attachment on this task. Use register_deliverable for the requested file and cite deliverable:<attachmentId> from its receipt. No human completion approval was created.");
      }
      // A prior output (or user input) can be useful context, but does not prove
      // this run published the newly requested output. The receipt survives a
      // controller restart of this run; a replacement can re-register preserved
      // workspace bytes internally rather than asking the user to confirm them.
      if ((fileRequested || taskDocumentRequested) && attachment.originatingRunId !== binding.runId) continue;
      if ((fileRequested || taskDocumentRequested) && !await hasCurrentPublicationReceipt(db, binding.companyId, binding.semanticToolReceipts, attachment)) {
        throw new Error("This attachment has no matching verified publication receipt for this run's requested output. Inspect any preserved file and use register_deliverable to verify its current filename, size, and SHA-256, then cite the new receipt. No human completion approval was created.");
      }
      registeredAttachment = true;
      continue;
    }
    // URLs and typed durable refs are not workspace paths. Verification commands
    // belong in verification; do not scan prose or upload files named by a model.
    const localFile = /^(?:file:|\.{0,2}\/|[a-z]:[\\/])/iu.test(ref)
      || (!/^[a-z][a-z0-9+.-]*:/iu.test(ref) && /^[^\r\n]+\.[a-z0-9]{1,16}(?::\d+(?::\d+)?)?$/iu.test(ref));
    if (localFile && taskDocumentRequested && !publishedTaskDocument) {
      throw new Error("The requested task document is only a workspace file. Publish it on this task with write_document, or attach the verified file with register_deliverable and cite deliverable:<attachmentId>. Reuse completed work; do not request a new completion approval.");
    }
    if (localFile && (fileRequested || artifactRefs.has(value))) {
      throw new Error("Completion cites a workspace-only file that the user cannot download. Before finishing, use register_deliverable for requested file outputs and cite deliverable:<attachmentId> from the receipt, with /api/attachments/<attachmentId>/content as the download link. For repository changes, cite an accessible PR or registered work product instead. No human completion approval was created.");
    }
  }
  if (taskDocumentRequested && !publishedTaskDocument && !registeredAttachment) {
    throw new Error("The requested document has not been published on this task. Use write_document, or register_deliverable with its verified attachment receipt. A workspace path or final message alone is not the requested task document. Reuse completed work without requesting a new completion approval.");
  }
  if (fileRequested && !registeredAttachment) {
    const products = refs.size ? await db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, binding.companyId), eq(issueWorkProducts.issueId, binding.issueId),
    )) : [];
    const accessibleProduct = products.some(product => {
      if (product.createdByRunId !== binding.runId) return false;
      if (["failed", "cancelled", "archived"].includes(product.status)) return false;
      // A workspace_file resource is only a locator: registration neither checks
      // its current bytes nor keeps them alive after workspace cleanup. Requested
      // files need a published URL or the verified attachment receipt above.
      const accessible = typeof product.url === "string" && /^https?:\/\//iu.test(product.url);
      return accessible && [product.url, `work_product:${product.id}`, `work-product:${product.id}`, `artifact:${product.id}`]
        .some(ref => typeof ref === "string" && refs.has(ref));
    });
    if (!accessibleProduct) throw new Error("The requested file has no accessible delivery evidence. Use register_deliverable and cite deliverable:<attachmentId>, or cite an accessible work product registered by this run for this task. Empty evidence, prior-run output, and a verification result cannot substitute for the requested file. Continue publishing or report a concrete blocker; no human completion approval was created.");
  }
}
