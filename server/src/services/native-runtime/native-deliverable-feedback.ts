import { and, eq } from "drizzle-orm";
import { assets, issueAttachments, issueWorkProducts, type Db } from "@paperclipai/db";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

function evidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && typeof entry.ref === "string") return [entry.ref];
    return [];
  });
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

/** Files cited as completed output must be reachable outside the agent workspace. */
export async function validateNativeDeliverableEvidence(
  db: Db,
  binding: { companyId: string; issueId: string; objective: string },
  result: PrpStructuredRunResult,
): Promise<void> {
  if (result.reportedWorkDisposition !== "done") return;
  const fileRequested = explicitlyRequestsFileOutput(binding.objective);
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
        ? await db.select({ id: issueAttachments.id }).from(issueAttachments)
            .innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, binding.companyId)))
            .where(and(eq(issueAttachments.id, id), eq(issueAttachments.companyId, binding.companyId), eq(issueAttachments.issueId, binding.issueId)))
            .limit(1)
        : [];
      if (!attachment) {
        throw new Error("Completion cites no registered attachment on this task. Use register_deliverable for the requested file and cite deliverable:<attachmentId> from its receipt. No human completion approval was created.");
      }
      registeredAttachment = true;
      continue;
    }
    // URLs and typed durable refs are not workspace paths. Verification commands
    // belong in verification; do not scan prose or upload files named by a model.
    const localFile = /^(?:file:|\.{0,2}\/|[a-z]:[\\/])/iu.test(ref)
      || (!/^[a-z][a-z0-9+.-]*:/iu.test(ref) && /^[^\r\n]+\.[a-z0-9]{1,16}(?::\d+(?::\d+)?)?$/iu.test(ref));
    if (localFile && (fileRequested || artifactRefs.has(value))) {
      throw new Error("Completion cites a workspace-only file that the user cannot download. Before finishing, use register_deliverable for requested file outputs and cite deliverable:<attachmentId> from the receipt, with /api/attachments/<attachmentId>/content as the download link. For repository changes, cite an accessible PR or registered work product instead. No human completion approval was created.");
    }
  }
  if (fileRequested && !registeredAttachment) {
    const products = refs.size ? await db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, binding.companyId), eq(issueWorkProducts.issueId, binding.issueId),
    )) : [];
    const accessibleProduct = products.some(product => {
      if (["failed", "cancelled", "archived"].includes(product.status)) return false;
      const resource = product.metadata?.resourceRef as { kind?: unknown; path?: unknown } | undefined;
      const accessible = (typeof product.url === "string" && /^https?:\/\//iu.test(product.url)) ||
        (resource?.kind === "workspace_file" && typeof resource.path === "string" && resource.path.length > 0);
      return accessible && [product.url, `work_product:${product.id}`, `work-product:${product.id}`, `artifact:${product.id}`]
        .some(ref => typeof ref === "string" && refs.has(ref));
    });
    if (!accessibleProduct) throw new Error("The requested file has no accessible delivery evidence. Use register_deliverable and cite deliverable:<attachmentId>, or cite a registered accessible work product for this task. Empty evidence and a verification result cannot substitute for the requested file. Continue publishing or report a concrete blocker; no human completion approval was created.");
  }
}
