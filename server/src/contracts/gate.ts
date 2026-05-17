import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { completionContractEvaluations, completionContractOverrides, issueLabels, labels, issueComments, issues } from "@paperclipai/db";
import { evaluateContracts } from "./registry.js";
import type { ContractType, IssueForContracts, CommentForContracts } from "./types.js";

/**
 * Feature flags — set COMPLETION_CONTRACTS_ENFORCING_<CONTRACT_TYPE>=true to enforce.
 * All default to false (shadow mode).
 */
function isEnforcing(contract: ContractType): boolean {
  const envKey = `COMPLETION_CONTRACTS_ENFORCING_${contract.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey] === "true";
}

export interface GateViolation {
  contract: ContractType;
  missing: string;
  evidenceQuery: string;
}

export interface GateResult {
  ok: boolean;
  /** Violations that are enforcing (transition must be blocked) */
  enforcingViolations: GateViolation[];
  /** Violations that are shadow-only (logged but not blocked) */
  shadowViolations: GateViolation[];
}

/**
 * Check whether an issue can transition to `done`.
 * Runs predicates, logs all evaluations, and returns enforcing violations.
 * Call this before persisting a done transition — if enforcingViolations is non-empty, return 422.
 */
export async function checkDoneGate(
  db: Db,
  issueId: string,
  actorAgentId: string | null,
): Promise<GateResult> {
  // Fetch issue with labels
  const [issueRow] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);

  if (!issueRow) {
    return { ok: true, enforcingViolations: [], shadowViolations: [] };
  }

  // Fetch labels
  const issueLabelRows = await db
    .select({ name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.issueId, issueId));

  const issueForContracts: IssueForContracts = {
    id: issueRow.id,
    title: issueRow.title,
    description: issueRow.description,
    originKind: issueRow.originKind,
    labels: issueLabelRows,
  };

  // Fetch comments (asc order for timestamp ordering)
  const commentRows = await db
    .select({
      id: issueComments.id,
      body: issueComments.body,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(issueComments.createdAt);

  const commentsForContracts: CommentForContracts[] = commentRows.map((c) => ({
    id: c.id,
    body: c.body,
    authorAgentId: c.authorAgentId,
    authorUserId: c.authorUserId,
    createdAt: c.createdAt,
  }));

  const evaluation = evaluateContracts(issueForContracts, commentsForContracts);

  // Fetch active overrides for this issue
  const overrideRows = await db
    .select({ contract: completionContractOverrides.contract })
    .from(completionContractOverrides)
    .where(eq(completionContractOverrides.issueId, issueId));
  const overriddenContracts = new Set(overrideRows.map((r) => r.contract));

  // Log all evaluations (shadow mode always logs)
  const now = new Date();
  const evaluationInserts = evaluation.contracts.map((contract) => {
    const violation = evaluation.violations.find((v) => v.contract === contract);
    return {
      companyId: issueRow.companyId,
      issueId,
      contract,
      result: violation ? ("fail" as const) : ("pass" as const),
      missing: violation?.missing ?? null,
      evaluator: "gate" as const,
      agentId: actorAgentId,
      evaluatedAt: now,
    };
  });

  if (evaluationInserts.length > 0) {
    await db.insert(completionContractEvaluations).values(evaluationInserts);
  }

  // Filter out overridden violations
  const activeViolations = evaluation.violations.filter(
    (v) => !overriddenContracts.has(v.contract),
  );

  const enforcingViolations: GateViolation[] = [];
  const shadowViolations: GateViolation[] = [];

  for (const violation of activeViolations) {
    if (isEnforcing(violation.contract)) {
      enforcingViolations.push(violation);
    } else {
      shadowViolations.push(violation);
    }
  }

  return {
    ok: enforcingViolations.length === 0,
    enforcingViolations,
    shadowViolations,
  };
}
