import { issueComments, issues, taskProviderOutputPolicies, type Db } from "@paperclipai/db";
import { and, eq, or } from "drizzle-orm";
import { LOW_TRUST_REVIEW_PRESET, type SourceTrustMetadata } from "@paperclipai/shared";
import { sourceTrustMetadataSchema } from "@paperclipai/shared/validators/trust-policy";
import { unprocessable } from "../errors.js";
import { DEFAULT_INSERT_CHUNK_ROWS } from "./batch-insert.js";

type ImportTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ImportScope = { companyId: string; issueId: string; issueCommentId?: string | null };

export function normalizeImportedSourceTrust(value: unknown): SourceTrustMetadata | null {
  if (value == null) return null;
  const parsed = sourceTrustMetadataSchema.safeParse(value);
  if (!parsed.success || parsed.data.preset !== LOW_TRUST_REVIEW_PRESET) {
    throw unprocessable("Imported source trust must describe low-trust history, not grant trust");
  }
  // A portable promotion cannot authenticate local review or bind historical identities.
  return { preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined" };
}

export function assertImportedAttachmentStorageScope(rows: Array<ImportScope & { objectKey: string }>): void {
  for (const row of rows) {
    const prefix = `${row.companyId}/issues/${row.issueId}/`;
    if (typeof row.objectKey !== "string" || !row.objectKey.startsWith(prefix)
      || row.objectKey.includes("..")
      || !row.objectKey.slice(prefix.length).split("/").every(segment => /^[a-zA-Z0-9._-]+$/.test(segment) && segment !== ".")) {
      throw unprocessable("Imported attachment storage must belong to its destination company and task");
    }
  }
}

export async function retainImportedTaskOutputPolicies(tx: ImportTransaction, rows: ImportScope[]): Promise<void> {
  const scopes = new Map<string, ImportScope>();
  for (const row of rows) {
    const previous = scopes.get(row.issueId);
    if (previous && previous.companyId !== row.companyId) {
      throw unprocessable("Imported content must belong to its destination company and task");
    }
    scopes.set(row.issueId, row);
  }
  // Lock in one order across writers; ownership must remain true until content commits.
  const issueIds = [...scopes.keys()].sort();
  for (let start = 0; start < issueIds.length; start += DEFAULT_INSERT_CHUNK_ROWS) {
    const ids = issueIds.slice(start, start + DEFAULT_INSERT_CHUNK_ROWS);
    const destinations = await tx.select({ id: issues.id, companyId: issues.companyId })
      .from(issues).where(or(...ids.map(id => and(eq(issues.id, id), eq(issues.companyId, scopes.get(id)!.companyId)))))
      .orderBy(issues.id).for("update");
    if (destinations.length !== ids.length || destinations.some(row => scopes.get(row.id)?.companyId !== row.companyId)) {
      throw unprocessable("Imported content must belong to its destination company and task");
    }
  }

  const commentScopes = new Map(rows.flatMap(row => row.issueCommentId ? [[row.issueCommentId, row] as const] : []));
  const commentIds = [...commentScopes.keys()].sort();
  const commentsById = new Map<string, { companyId: string; issueId: string }>();
  for (let start = 0; start < commentIds.length; start += DEFAULT_INSERT_CHUNK_ROWS) {
    const comments = await tx.select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
      .from(issueComments).where(or(...commentIds.slice(start, start + DEFAULT_INSERT_CHUNK_ROWS).map(id => {
        const scope = commentScopes.get(id)!;
        return and(eq(issueComments.id, id), eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, scope.issueId));
      })))
      .orderBy(issueComments.id).for("share");
    for (const comment of comments) commentsById.set(comment.id, comment);
  }
  for (const row of rows) {
    if (!row.issueCommentId) continue;
    const comment = commentsById.get(row.issueCommentId);
    if (!comment || comment.companyId !== row.companyId || comment.issueId !== row.issueId) {
      throw unprocessable("Imported attachment comment must belong to its destination company and task");
    }
  }

  for (let start = 0; start < issueIds.length; start += DEFAULT_INSERT_CHUNK_ROWS) {
    await tx.insert(taskProviderOutputPolicies).values(issueIds.slice(start, start + DEFAULT_INSERT_CHUNK_ROWS).map(issueId => ({
      companyId: scopes.get(issueId)!.companyId, issueId, disposition: "forbidden" as const,
    }))).onConflictDoUpdate({
      target: taskProviderOutputPolicies.issueId,
      set: { disposition: "forbidden" },
    });
  }
}
