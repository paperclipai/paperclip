import { and, eq } from "drizzle-orm";
import { assets, issueAttachments, type Db } from "@paperclipai/db";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

function evidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && typeof entry.ref === "string") return [entry.ref];
    return [];
  });
}

/** Files cited as completed output must be reachable outside the agent workspace. */
export async function validateNativeDeliverableEvidence(
  db: Db,
  binding: { companyId: string; issueId: string },
  result: PrpStructuredRunResult,
): Promise<void> {
  if (result.reportedWorkDisposition !== "done") return;
  const refs = new Set([
    ...evidenceRefs(result.evidence),
    ...evidenceRefs(result.artifacts),
    ...result.completionClaim.criteria.flatMap(({ evidenceRefs }) => evidenceRefs),
  ]);
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
      continue;
    }
    // URLs and typed durable refs are not workspace paths. Verification commands
    // belong in verification; do not scan prose or upload files named by a model.
    const localFile = /^(?:file:|\.{0,2}\/|[a-z]:[\\/])/iu.test(ref)
      || (!/^[a-z][a-z0-9+.-]*:/iu.test(ref) && /^[^\r\n]+\.[a-z0-9]{1,16}(?::\d+(?::\d+)?)?$/iu.test(ref));
    if (localFile) {
      throw new Error("Completion cites a workspace-only file that the user cannot download. Before finishing, use register_deliverable for requested file outputs and cite deliverable:<attachmentId> from the receipt, with /api/attachments/<attachmentId>/content as the download link. For repository changes, cite an accessible PR or registered work product instead. No human completion approval was created.");
    }
  }
}
