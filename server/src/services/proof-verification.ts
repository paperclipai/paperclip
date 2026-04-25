import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, prCiStatus, issueKindProofSpecs } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export interface ProofVerificationResult {
  issueId: string;
  identifier: string;
  proofStatus: string;
  updated: boolean;
}

export async function verifyIssueProofByCiResult(
  db: Db,
  params: {
    repositoryFullName: string;
    prNumber: number;
    headSha: string;
  },
): Promise<ProofVerificationResult[]> {
  const { repositoryFullName, prNumber, headSha } = params;

  const ciResult = await db.query.prCiStatus.findFirst({
    where: and(
      eq(prCiStatus.repositoryFullName, repositoryFullName),
      eq(prCiStatus.prNumber, prNumber),
    ),
  });

  if (!ciResult) {
    logger.debug({ repositoryFullName, prNumber }, "No CI result found for PR");
    return [];
  }

  if (ciResult.conclusion !== "success" || ciResult.status !== "completed") {
    logger.debug(
      { repositoryFullName, prNumber, conclusion: ciResult.conclusion, status: ciResult.status },
      "CI not yet successful",
    );
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

    const kindSpec = await db.query.issueKindProofSpecs.findFirst({
      where: eq(issueKindProofSpecs.issueKind, determineIssueKind(issue.title)),
    });

    const requiresCi = kindSpec?.requiresCiProof ?? true;
    if (!requiresCi) {
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
    } else {
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
