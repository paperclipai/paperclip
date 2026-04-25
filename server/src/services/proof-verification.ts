import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, prCiStatus, issueKindProofSpecs } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export interface ProofVerificationResult {
  issueId: string;
  identifier: string;
  proofStatus: string;
  updated: boolean;
  reason?: string;
}

export async function verifyIssueProofByCiResult(
  db: Db,
  params: {
    repositoryFullName: string;
    prNumber: number;
    headSha: string;
  },
): Promise<ProofVerificationResult[]> {
  const { repositoryFullName, prNumber } = params;

  const ciResult = await db.query.prCiStatus.findFirst({
    where: and(
      eq(prCiStatus.repositoryFullName, repositoryFullName),
      eq(prCiStatus.prNumber, prNumber),
    ),
  });

  if (!ciResult) {
    logger.debug({ repositoryFullName, prNumber }, "No CI/review result found for PR");
    return [];
  }

  const issueOriginId = `${repositoryFullName}#${prNumber}`;
  const linkedIssues = await db.query.issues.findMany({
    where: and(
      eq(issues.originKind, "github_pull_request"),
      eq(issues.originId, issueOriginId),
    ),
  });

  if (linkedIssues.length === 0) {
    logger.debug({ issueOriginId }, "No issues linked to this PR");
    return [];
  }

  const results: ProofVerificationResult[] = [];

  for (const issue of linkedIssues) {
    const currentProofStatus = (issue as unknown as { proofStatus?: string }).proofStatus ?? "pending";

    if (currentProofStatus === "verified") {
      results.push({
        issueId: issue.id,
        identifier: issue.identifier ?? "unknown",
        proofStatus: currentProofStatus,
        updated: false,
      });
      continue;
    }

    const issueKind = determineIssueKind(issue.title);
    const kindSpec = await db.query.issueKindProofSpecs.findFirst({
      where: eq(issueKindProofSpecs.issueKind, issueKind),
    });

    const requiresCi = kindSpec?.requiresCiProof ?? true;
    const requiresReview = kindSpec?.requiresReviewApproval ?? false;
    const requiresLiveUrl = kindSpec?.requiresLiveUrlProof ?? false;

    const ciPassed = ciResult.conclusion === "success" && ciResult.status === "completed";
    const reviewApproved = ciResult.reviewState === "approved";

    if (requiresCi && !ciPassed) {
      results.push({
        issueId: issue.id,
        identifier: issue.identifier ?? "unknown",
        proofStatus: currentProofStatus,
        updated: false,
        reason: `CI not yet passed (conclusion=${ciResult.conclusion}, status=${ciResult.status})`,
      });
      continue;
    }

    if (requiresReview && !reviewApproved) {
      results.push({
        issueId: issue.id,
        identifier: issue.identifier ?? "unknown",
        proofStatus: currentProofStatus,
        updated: false,
        reason: `Review not yet approved (state=${ciResult.reviewState})`,
      });
      continue;
    }

    if (requiresLiveUrl) {
      results.push({
        issueId: issue.id,
        identifier: issue.identifier ?? "unknown",
        proofStatus: currentProofStatus,
        updated: false,
        reason: "Live URL verification requires Phase 0.2 synthetic prober",
      });
      continue;
    }

    await db
      .update(issues)
      .set({
        proofStatus: "verified",
        proofCiUrl: ciResult.url ?? null,
        proofVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(issues.id, issue.id));

    results.push({
      issueId: issue.id,
      identifier: issue.identifier ?? "unknown",
      proofStatus: "verified",
      updated: true,
    });
  }

  return results;
}

function determineIssueKind(title: string): string {
  const upperTitle = title.toUpperCase();
  if (upperTitle.includes("[FIX]") || upperTitle.includes("FIX:")) return "FIX";
  if (upperTitle.includes("[BUILD]") || upperTitle.includes("BUILD:")) return "BUILD";
  if (upperTitle.includes("[REVIEW]") || upperTitle.includes("REVIEW:")) return "REVIEW";
  if (upperTitle.includes("[DEPLOY]") || upperTitle.includes("DEPLOY:")) return "DEPLOY";
  if (upperTitle.includes("[BREAK]") || upperTitle.includes("BREAK:")) return "BREAK";
  return "FIX";
}
