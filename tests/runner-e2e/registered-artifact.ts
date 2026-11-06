import { createHash } from "node:crypto";
import type { IssueAttachment } from "../../packages/shared/src/types/issue.js";
import type { IssueWorkProduct } from "../../packages/shared/src/types/work-product.js";
import type { RunnerApi } from "./api.js";

export class RegisteredArtifactNotFoundError extends Error {
  constructor(artifactName: string) {
    super(`Expected one registered artifact ${artifactName} from the tested run; observed 0`);
    this.name = "RegisteredArtifactNotFoundError";
  }
}

const REGISTERED_ARTIFACT_STATUSES = new Set(["active", "ready_for_review", "approved"]);

/** Registration, attribution and downloaded bytes must agree independently. */
export async function readRegisteredArtifacts(api: RunnerApi, issueId: string, runId: string, names: readonly string[]) {
  if (names.length === 0) return [];
  const [products, attachments] = await Promise.all([
    api.get<IssueWorkProduct[]>(`/api/issues/${encodeURIComponent(issueId)}/work-products`),
    api.get<IssueAttachment[]>(`/api/issues/${encodeURIComponent(issueId)}/attachments`),
  ]);
  // The file name identifies a deliverable; its work-product title is a
  // human-facing label the agent may choose, so it is not part of identity.
  const filenameOf = (product: IssueWorkProduct) =>
    attachments.find(attachment => attachment.id === product.metadata?.attachmentId)?.originalFilename;
  return Promise.all(names.map(async name => {
    const registered = products.filter(product => product.issueId === issueId &&
      product.createdByRunId === runId && product.type === "artifact" &&
      REGISTERED_ARTIFACT_STATUSES.has(product.status) && (product.title === name || filenameOf(product) === name));
    if (registered.length === 0) throw new RegisteredArtifactNotFoundError(name);
    if (registered.length !== 1) throw new Error(`Expected one registered artifact ${name} from the tested run; observed ${registered.length}`);
    const product = registered[0]!;
    const attachmentId = product.metadata?.attachmentId;
    const matching = attachments.filter(attachment => attachment.id === attachmentId &&
      attachment.issueId === issueId && attachment.originatingRunId === runId &&
      attachment.originalFilename === name);
    if (matching.length !== 1) throw new Error(`Registered artifact ${name} lacks its run-attributed attachment`);
    const attachment = matching[0]!;
    if (!Number.isSafeInteger(attachment.byteSize) || attachment.byteSize < 0 || attachment.byteSize > 262_144) {
      throw new Error(`Registered artifact ${name} has an invalid or excessive size`);
    }
    const bytes = await api.getAttachmentContent(attachment.id);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== attachment.byteSize || sha256 !== attachment.sha256) {
      throw new Error(`Downloaded registered artifact ${name} disagrees with stored bytes`);
    }
    return { name, mimeType: attachment.contentType, content: bytes.toString("utf8"),
      contentVerified: true, attachmentId: attachment.id, workProductId: product.id, sha256 };
  }));
}
