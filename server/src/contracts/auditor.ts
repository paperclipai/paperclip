/**
 * done-gate-audit: post-hoc completion contract auditor.
 *
 * Scans done transitions from the last 24h. In shadow mode, logs violations.
 * In enforcing mode, reverts to in_review and notifies the original closer.
 * Circuit-breaker: 3x reverts in 24h → escalate instead.
 *
 * This module is called by the Platform Engineer agent when the
 * done-gate-audit routine fires. It does NOT run inline — it's invoked
 * as a heartbeat task.
 */

import { and, eq, gte, desc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  issueComments,
  issueLabels,
  labels,
  completionContractEvaluations,
  completionContractOverrides,
} from "@paperclipai/db";
import { evaluateContracts } from "./registry.js";
import type { ContractType, IssueForContracts, CommentForContracts } from "./types.js";

const AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const CIRCUIT_BREAKER_LIMIT = 3;

function isAuditEnforcing(contract: ContractType): boolean {
  const envKey = `COMPLETION_CONTRACTS_AUDIT_ENFORCING_${contract.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey] === "true";
}

export interface AuditIssueResult {
  issueId: string;
  identifier: string;
  contracts: ContractType[];
  shadowViolations: Array<{ contract: ContractType; missing: string }>;
  enforcingViolations: Array<{ contract: ContractType; missing: string }>;
  reverted: boolean;
  circuitBreakerTripped: boolean;
}

export interface AuditRunResult {
  scanned: number;
  shadowViolations: number;
  enforcingViolations: number;
  reverted: number;
  circuitBreakerTrips: number;
}

export async function runDoneGateAudit(db: Db): Promise<AuditRunResult> {
  const windowStart = new Date(Date.now() - AUDIT_WINDOW_MS);

  // Find issues that transitioned to done in the last 24h
  const doneIssues = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      originKind: issues.originKind,
      completedAt: issues.completedAt,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.status, "done"),
        gte(issues.completedAt, windowStart),
      ),
    );

  const result: AuditRunResult = {
    scanned: doneIssues.length,
    shadowViolations: 0,
    enforcingViolations: 0,
    reverted: 0,
    circuitBreakerTrips: 0,
  };

  for (const issue of doneIssues) {
    // Fetch labels
    const issueLabelRows = await db
      .select({ name: labels.name })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(eq(issueLabels.issueId, issue.id));

    const issueForContracts: IssueForContracts = {
      id: issue.id,
      title: issue.title,
      description: issue.description,
      originKind: issue.originKind,
      labels: issueLabelRows,
    };

    const commentRows = await db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(issueComments.createdAt);

    const commentsForContracts: CommentForContracts[] = commentRows;

    const evaluation = evaluateContracts(issueForContracts, commentsForContracts);
    if (evaluation.contracts.length === 0) continue;

    // Fetch active overrides
    const overrideRows = await db
      .select({ contract: completionContractOverrides.contract })
      .from(completionContractOverrides)
      .where(eq(completionContractOverrides.issueId, issue.id));
    const overriddenContracts = new Set(overrideRows.map((r) => r.contract));

    const now = new Date();

    // Log all evaluations
    const evaluationInserts = evaluation.contracts.map((contract) => {
      const violation = evaluation.violations.find((v) => v.contract === contract);
      return {
        companyId: issue.companyId,
        issueId: issue.id,
        contract,
        result: violation ? ("fail" as const) : ("pass" as const),
        missing: violation?.missing ?? null,
        evaluator: "audit" as const,
        agentId: null,
        evaluatedAt: now,
      };
    });
    if (evaluationInserts.length > 0) {
      await db.insert(completionContractEvaluations).values(evaluationInserts);
    }

    const activeViolations = evaluation.violations.filter(
      (v) => !overriddenContracts.has(v.contract),
    );

    const shadowViolations = activeViolations.filter((v) => !isAuditEnforcing(v.contract));
    const enforcingViolations = activeViolations.filter((v) => isAuditEnforcing(v.contract));

    result.shadowViolations += shadowViolations.length;
    result.enforcingViolations += enforcingViolations.length;

    if (enforcingViolations.length === 0) continue;

    // Check circuit-breaker: count how many times this issue was already auditor-reverted in last 24h
    const revertCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          gte(issueComments.createdAt, windowStart),
          sql`${issueComments.body} LIKE '[done-gate-audit] Reverting%'`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));

    if (revertCount >= CIRCUIT_BREAKER_LIMIT) {
      // Escalate to CTO instead of reverting
      result.circuitBreakerTrips++;
      await db.insert(issueComments).values({
        companyId: issue.companyId,
        issueId: issue.id,
        authorType: "agent",
        authorAgentId: null,
        body: `[done-gate-audit] Circuit-breaker tripped — this issue has been reverted ${revertCount}x in the last 24h without resolution. Escalating to CTO.\n- Violations: ${enforcingViolations.map((v) => `${v.contract}: ${v.missing}`).join("; ")}`,
      });
      continue;
    }

    // Revert to in_review and post audit comment
    await db
      .update(issues)
      .set({ status: "in_review" })
      .where(eq(issues.id, issue.id));

    const violationLines = enforcingViolations
      .map((v) => `- Contract: ${v.contract}\n  Missing: ${v.missing}`)
      .join("\n");

    await db.insert(issueComments).values({
      companyId: issue.companyId,
      issueId: issue.id,
      authorType: "agent",
      authorAgentId: null,
      body: `[done-gate-audit] Reverting to in_review.\n${violationLines}\n- Original closer: ${issue.assigneeAgentId ?? "unknown"}\n- Detected at: ${now.toISOString()}`,
    });

    result.reverted++;
  }

  return result;
}
