import { and, eq } from "drizzle-orm";
import { chatGitHubReviews, type Db } from "@paperclipai/db";

/** Publication evidence describes only this exact review and revision. It does
 * not authorize a write or certify the outcome of any other operation. */
export async function githubRecoveryReceipts(db: Db, companyId: string, issueId: string) {
  const reviews = await db.select({ id: chatGitHubReviews.id, runId: chatGitHubReviews.runId,
    repository: chatGitHubReviews.repository, pullNumber: chatGitHubReviews.pullNumber, headSha: chatGitHubReviews.headSha,
    publicationReceipts: chatGitHubReviews.publicationReceipts }).from(chatGitHubReviews).where(and(
    eq(chatGitHubReviews.companyId, companyId), eq(chatGitHubReviews.issueId, issueId),
  ));
  return reviews.flatMap(review => !review.runId ? [] : Object.entries(review.publicationReceipts).flatMap(([part, receipt]) =>
    receipt.id && receipt.url && /^[a-f0-9]{64}$/i.test(receipt.digest) ? [{
      runId: review.runId!, receiptId: `github:${review.id}:${part}`, operationId: "github_review_publication",
      result: { repository: review.repository, pullNumber: review.pullNumber, headSha: review.headSha,
        part, publicationId: receipt.id, url: receipt.url, digest: receipt.digest },
    }] : []));
}
