import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueThreadInteractions, issueWorkProducts } from "@paperclipai/db";
import type {
  OutcomeContract,
  OutcomeEvaluation,
} from "@paperclipai/shared";

export async function evaluateOutcomeContract(
  db: Db,
  issueId: string,
  contract: OutcomeContract,
): Promise<OutcomeEvaluation> {
  switch (contract.kind) {
    case "merged_pr":
      return evaluateMergedPr(db, issueId, contract);
    case "signed_off_decision":
      return evaluateSignedOffDecision(db, issueId, contract);
  }
}

async function evaluateMergedPr(
  db: Db,
  issueId: string,
  contract: OutcomeContract,
): Promise<OutcomeEvaluation> {
  const requirePrimary = contract.params?.requirePrimary === true;

  const conditions = [
    eq(issueWorkProducts.issueId, issueId),
    eq(issueWorkProducts.type, "pull_request"),
    eq(issueWorkProducts.status, "merged"),
  ];

  if (requirePrimary) {
    conditions.push(eq(issueWorkProducts.isPrimary, true));
  }

  const rows = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(...conditions))
    .then((r) => r);

  if (rows.length > 0) {
    return { satisfied: true };
  }

  const hint = requirePrimary
    ? "Link a merged primary GitHub PR via POST /api/issues/{id}/work-products with type='pull_request', status='merged', isPrimary=true"
    : "Link a merged GitHub PR via POST /api/issues/{id}/work-products with type='pull_request' and status='merged'";

  return {
    satisfied: false,
    missing: [
      {
        code: "no_merged_pr",
        message: "No merged pull request found for this issue.",
        hint,
      },
    ],
  };
}

async function evaluateSignedOffDecision(
  db: Db,
  issueId: string,
  contract: OutcomeContract,
): Promise<OutcomeEvaluation> {
  const rows = await db
    .select({
      id: issueThreadInteractions.id,
      resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
      resolvedByUserId: issueThreadInteractions.resolvedByUserId,
      status: issueThreadInteractions.status,
    })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "accepted"),
      ),
    )
    .then((r) => r);

  if (rows.length === 0) {
    return {
      satisfied: false,
      missing: [
        {
          code: "no_accepted_confirmation",
          message: "No accepted request_confirmation interaction found for this issue.",
          hint: "Create a request_confirmation interaction via POST /api/issues/{id}/interactions and have the required signer accept it.",
        },
      ],
    };
  }

  const signers = contract.signers;
  if (!signers || signers.length === 0) {
    return { satisfied: true };
  }

  const signerMatch = rows.some((row) => {
    return signers.some((signer) => {
      if (signer.kind === "agent") {
        return row.resolvedByAgentId === signer.id;
      }
      if (signer.kind === "user") {
        return row.resolvedByUserId === signer.id;
      }
      return false;
    });
  });

  if (signerMatch) {
    return { satisfied: true };
  }

  return {
    satisfied: false,
    missing: [
      {
        code: "signer_mismatch",
        message: "The confirmation was accepted, but not by one of the required signers.",
        hint: `Required signers: ${signers.map((s) => `${s.kind}:${s.id}`).join(", ")}. Have the correct signer accept a request_confirmation interaction.`,
      },
    ],
  };
}
