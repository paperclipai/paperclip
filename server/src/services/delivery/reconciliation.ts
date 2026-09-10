import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  deliveryReceipts,
  deliveryReconciliations,
  deliveryRepositories,
  deliveryUnitIssues,
  deliveryUnits,
  issueWorkProducts,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  DeliveryDisposition,
  DeliveryProvenance,
  DeliveryReconciliationClassification,
  DeliveryReconciliationInventory,
  DeliveryReconciliationItem,
  DeliveryReconciliationOutcome,
} from "@paperclipai/shared";
import type { DeliveryActor } from "./units.js";
import { createGitHubDeliveryClient, type GitHubDeliveryClient } from "./github-client.js";
import type { DeliveryRepositoryRow } from "./policy.js";

export type DeliveryReconciliationWriteInput = {
  idempotencyKey: string;
  issueId: string;
  classification: DeliveryReconciliationClassification;
  outcome?: string;
  note?: string;
  provenance?: {
    repository: string;
    targetBranch: string;
    mergedSha: string;
    mergeCommitSha?: string | null;
    headSha?: string | null;
    prNumber?: number | null;
  } | null;
};

export interface DeliveryReconciliationService {
  inventory(input: { companyId: string; projectId?: string | null }): Promise<DeliveryReconciliationInventory>;
  record(input: {
    companyId: string;
    actor: DeliveryActor;
    write: DeliveryReconciliationWriteInput;
  }): Promise<DeliveryReconciliationItem>;
  list(input: { companyId: string; issueId?: string | null }): Promise<DeliveryReconciliationItem[]>;
}

const RECONCILIATION_SCAN_LIMIT = 2_000;

function outcomeFor(classification: DeliveryReconciliationClassification, hasReceipt: boolean): DeliveryReconciliationOutcome {
  if (classification === "code_verified") return hasReceipt ? "verified" : "needs_candidate";
  if (classification === "code_unverified") return "needs_merge";
  if (classification === "non_code") return "dispositioned";
  return "unresolved";
}

const EXACT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
export function deliveryReconciliationService(
  db: Db,
  deps: {
    github?: GitHubDeliveryClient;
    loadRepository?: (companyId: string, repositoryId: string) => Promise<DeliveryRepositoryRow | null>;
  } = {},
): DeliveryReconciliationService {
  const github = deps.github ?? createGitHubDeliveryClient(db);
  const loadRepository = deps.loadRepository ?? (async (companyId: string, repositoryId: string) =>
    db
      .select()
      .from(deliveryRepositories)
      .where(and(eq(deliveryRepositories.companyId, companyId), eq(deliveryRepositories.id, repositoryId)))
      .limit(1)
      .then((rows) => rows[0] ?? null));
  async function loadVerified(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return new Map<string, { mergedSha: string; provenance: DeliveryProvenance; unitId: string }>();
    const rows = await db
      .select({
        issueId: deliveryUnitIssues.issueId,
        unitId: deliveryUnits.id,
        mergedSha: deliveryReceipts.mergedSha,
        provenance: deliveryReceipts.provenance,
      })
      .from(deliveryUnitIssues)
      .innerJoin(deliveryUnits, eq(deliveryUnits.id, deliveryUnitIssues.unitId))
      .innerJoin(deliveryReceipts, eq(deliveryReceipts.unitId, deliveryUnits.id))
      .where(and(
        eq(deliveryUnitIssues.companyId, companyId),
        inArray(deliveryUnitIssues.issueId, issueIds),
        eq(deliveryUnits.status, "merged"),
      ));
    const byIssue = new Map<string, { mergedSha: string; provenance: DeliveryProvenance; unitId: string }>();
    for (const row of rows) {
      if (!byIssue.has(row.issueId)) {
        byIssue.set(row.issueId, { mergedSha: row.mergedSha, provenance: row.provenance, unitId: row.unitId });
      }
    }
    return byIssue;
  }

  async function inventory(input: {
    companyId: string;
    projectId?: string | null;
  }): Promise<DeliveryReconciliationInventory> {
    const doneIssues = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        projectId: issues.projectId,
        status: issues.status,
        deliveryKind: issues.deliveryKind,
        deliveryDisposition: issues.deliveryDisposition,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.status, "done"),
        isNull(issues.hiddenAt),
        ...(input.projectId ? [eq(issues.projectId, input.projectId)] : []),
      ))
      .orderBy(desc(issues.completedAt))
      .limit(RECONCILIATION_SCAN_LIMIT);

    const issueIds = doneIssues.map((issue) => issue.id);
    const verified = await loadVerified(input.companyId, issueIds);
    const unitRows = issueIds.length === 0
      ? []
      : await db
        .select({
          issueId: deliveryUnitIssues.issueId,
          unitId: deliveryUnits.id,
          status: deliveryUnits.status,
          prNumber: deliveryUnits.prNumber,
          prUrl: deliveryUnits.prUrl,
          headSha: deliveryUnits.headSha,
          mergedSha: deliveryUnits.mergedSha,
          repositoryId: deliveryUnits.repositoryId,
          targetBranch: deliveryUnits.targetBranch,
        })
        .from(deliveryUnitIssues)
        .innerJoin(deliveryUnits, eq(deliveryUnits.id, deliveryUnitIssues.unitId))
        .where(and(
          eq(deliveryUnitIssues.companyId, input.companyId),
          inArray(deliveryUnitIssues.issueId, issueIds),
        ))
        .orderBy(desc(deliveryUnits.createdAt));
    const unitByIssue = new Map<string, (typeof unitRows)[number]>();
    for (const row of unitRows) {
      if (!unitByIssue.has(row.issueId)) unitByIssue.set(row.issueId, row);
    }
    const prIssueIds = issueIds.length === 0
      ? new Set<string>()
      : new Set((await db
        .select({ issueId: issueWorkProducts.issueId })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, input.companyId),
          inArray(issueWorkProducts.issueId, issueIds),
          eq(issueWorkProducts.type, "pull_request"),
        ))).map((row) => row.issueId));
    const repositories = new Map<string, string>();
    if (unitRows.length > 0) {
      const repoRows = await db
        .select({ id: deliveryRepositories.id, owner: deliveryRepositories.owner, name: deliveryRepositories.name })
        .from(deliveryRepositories)
        .where(eq(deliveryRepositories.companyId, input.companyId));
      for (const row of repoRows) repositories.set(row.id, `${row.owner}/${row.name}`);
    }

    const reconciliationRows = issueIds.length === 0
      ? []
      : await db
        .select()
        .from(deliveryReconciliations)
        .where(and(
          eq(deliveryReconciliations.companyId, input.companyId),
          inArray(deliveryReconciliations.issueId, issueIds),
        ))
        .orderBy(desc(deliveryReconciliations.reconciledAt));
    const reconciliationByIssue = new Map<string, (typeof reconciliationRows)[number]>();
    for (const row of reconciliationRows) {
      if (!reconciliationByIssue.has(row.issueId)) reconciliationByIssue.set(row.issueId, row);
    }

    const counts: Record<DeliveryReconciliationClassification, number> = {
      code_verified: 0,
      code_unverified: 0,
      non_code: 0,
      unknown: 0,
    };
    const items: DeliveryReconciliationItem[] = doneIssues.map((issue) => {
      const receipt = verified.get(issue.id) ?? null;
      const unit = unitByIssue.get(issue.id) ?? null;
      const priorReconciliation = reconciliationByIssue.get(issue.id) ?? null;
      let classification: DeliveryReconciliationClassification;
      if (receipt) {
        classification = "code_verified";
      } else if (issue.deliveryKind === "non_code") {
        classification = "non_code";
      } else if (unit || prIssueIds.has(issue.id) || issue.deliveryKind === "code") {
        classification = "code_unverified";
      } else if (priorReconciliation) {
        classification = priorReconciliation.classification;
      } else {
        classification = "unknown";
      }
      counts[classification] += 1;
      const disposition = (issue.deliveryDisposition ?? priorReconciliation?.disposition ?? null) as DeliveryDisposition | null;
      return {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        projectId: issue.projectId,
        issueStatus: issue.status,
        classification,
        outcome: outcomeFor(classification, Boolean(receipt)),
        unitId: unit?.unitId ?? null,
        repository: receipt?.provenance.repository
          ?? (unit ? repositories.get(unit.repositoryId) ?? null : null),
        targetBranch: receipt?.provenance.targetBranch ?? unit?.targetBranch ?? null,
        prNumber: unit?.prNumber ?? null,
        prUrl: unit?.prUrl ?? null,
        headSha: receipt?.provenance.acceptedHeadSha ?? unit?.headSha ?? null,
        mergedSha: receipt?.mergedSha ?? unit?.mergedSha ?? null,
        // Only verified receipt provenance is surfaced. Operator reconciliation
        // notes stay in the reconciliation record, never presented as proof.
        provenance: receipt?.provenance ?? null,
        disposition,
        reconciledAt: priorReconciliation?.reconciledAt.toISOString() ?? null,
      };
    });

    return {
      companyId: input.companyId,
      generatedAt: new Date().toISOString(),
      counts,
      items,
    };
  }
  /**
   * Verify an operator's historical merge claim against GitHub: the claimed
   * revision must be an exact SHA, the claimed repository and branch must
   * match the issue's delivery unit, and the revision must be included in
   * that target branch remotely. Returns verified provenance, never the raw
   * operator claim.
   */
  async function verifyClaimedMergeRemotely(input: {
    companyId: string;
    issueId: string;
    unitId: string | null;
    claim: DeliveryReconciliationWriteInput["provenance"];
  }): Promise<{ verified: boolean; reason: string; provenance: DeliveryProvenance | null }> {
    if (!input.claim) return { verified: false, reason: "no provenance claim supplied", provenance: null };
    if (!input.unitId) return { verified: false, reason: "issue has no delivery unit", provenance: null };
    for (const sha of [input.claim.mergedSha, input.claim.headSha, input.claim.mergeCommitSha]) {
      if (sha != null && !EXACT_SHA_PATTERN.test(sha.trim())) {
        return { verified: false, reason: "claimed revision is not an exact 40-hex SHA", provenance: null };
      }
    }
    const [unit] = await db
      .select()
      .from(deliveryUnits)
      .where(and(eq(deliveryUnits.companyId, input.companyId), eq(deliveryUnits.id, input.unitId)))
      .limit(1);
    if (!unit) return { verified: false, reason: "delivery unit not found", provenance: null };
    const repository = await loadRepository(input.companyId, unit.repositoryId);
    if (!repository) return { verified: false, reason: "delivery repository not verified", provenance: null };
    if (input.claim.targetBranch !== unit.targetBranch) {
      return { verified: false, reason: "claimed branch does not match the unit target branch", provenance: null };
    }
    if (input.claim.repository !== `${repository.owner}/${repository.name}`) {
      return { verified: false, reason: "claimed repository does not match the unit repository", provenance: null };
    }
    const mergedSha = input.claim.mergedSha.trim().toLowerCase();
    const included = await github.compareCommits(
      input.companyId,
      repository.connectionId,
      repository.host,
      repository.owner,
      repository.name,
      mergedSha,
      unit.targetBranch,
    );
    if (!included.ok) {
      return { verified: false, reason: `remote inclusion check failed: ${included.message}`, provenance: null };
    }
    if (!included.value.included) {
      return { verified: false, reason: "claimed revision is not included in the target branch", provenance: null };
    }
    const headSha = input.claim.headSha?.trim().toLowerCase() ?? mergedSha;
    return {
      verified: true,
      reason: "remotely verified",
      provenance: {
        repository: `${repository.owner}/${repository.name}`,
        githubRepositoryId: repository.githubRepositoryId,
        targetBranch: unit.targetBranch,
        sourceBranch: unit.sourceBranch,
        submittedHeadSha: headSha,
        acceptedHeadSha: headSha,
        baseSha: unit.baseSha,
        mergedSha,
        mergeCommitSha: input.claim.mergeCommitSha?.trim().toLowerCase() ?? null,
        mergeMethod: unit.mergeMethod,
        squashOrRebase: unit.mergeMethod !== "merge",
        checks: [],
        reviewStatus: "historical",
        blockingFindings: 0,
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  async function record(input: {
    companyId: string;
    actor: DeliveryActor;
    write: DeliveryReconciliationWriteInput;
  }): Promise<DeliveryReconciliationItem> {
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.write.issueId)))
      .limit(1);
    if (!issue) throw new Error("Issue not found");
    const unit = await db
      .select({ unitId: deliveryUnitIssues.unitId })
      .from(deliveryUnitIssues)
      .where(and(
        eq(deliveryUnitIssues.companyId, input.companyId),
        eq(deliveryUnitIssues.issueId, input.write.issueId),
      ))
      .orderBy(desc(deliveryUnitIssues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    // Operator-supplied provenance is a claim, not evidence. `code_verified`
    // requires either an existing verified receipt or a live remote inclusion
    // check of the claimed merge revision in the unit's repository and target
    // branch. Anything else is stored as `code_unverified` so the inventory
    // never presents an assertion as verified provenance.
    let classification = input.write.classification;
    let provenance: DeliveryProvenance | null = null;
    let note = input.write.note ?? null;
    if (classification === "code_verified") {
      const verified = await loadVerified(input.companyId, [input.write.issueId]);
      const receipt = verified.get(input.write.issueId) ?? null;
      if (receipt) {
        provenance = receipt.provenance;
      } else {
        const remote = await verifyClaimedMergeRemotely({
          companyId: input.companyId,
          issueId: input.write.issueId,
          unitId: unit?.unitId ?? null,
          claim: input.write.provenance,
        });
        if (remote.verified && remote.provenance) {
          provenance = remote.provenance;
        } else {
          classification = "code_unverified";
          note = [
            note,
            `Operator code_verified claim not remotely verified (${remote.reason}); stored as code_unverified.`,
          ].filter(Boolean).join(" ");
        }
      }
    }
    const outcome = classification !== input.write.classification
      ? outcomeFor(classification, false)
      : input.write.outcome ?? outcomeFor(classification, false);
    const now = new Date();
    await db
      .insert(deliveryReconciliations)
      .values({
        companyId: input.companyId,
        issueId: input.write.issueId,
        unitId: unit?.unitId ?? null,
        classification,
        outcome,
        observedStatus: issue.status,
        provenance,
        disposition: issue.deliveryDisposition ?? null,
        note,
        reconciledByActorType: input.actor.type,
        reconciledByActorId: input.actor.id,
        idempotencyKey: input.write.idempotencyKey,
        reconciledAt: now,
      })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(deliveryReconciliations)
      .where(and(
        eq(deliveryReconciliations.companyId, input.companyId),
        eq(deliveryReconciliations.idempotencyKey, input.write.idempotencyKey),
      ))
      .limit(1);
    if (!row) throw new Error("Reconciliation was not persisted");
    return {
      issueId: row.issueId,
      identifier: issue.identifier,
      title: issue.title,
      projectId: issue.projectId,
      issueStatus: row.observedStatus,
      classification: row.classification,
      outcome: row.outcome as DeliveryReconciliationOutcome,
      unitId: row.unitId,
      repository: row.provenance?.repository ?? null,
      targetBranch: row.provenance?.targetBranch ?? null,
      prNumber: null,
      prUrl: null,
      headSha: row.provenance?.acceptedHeadSha ?? null,
      mergedSha: row.provenance?.mergedSha ?? null,
      provenance: row.provenance,
      disposition: row.disposition,
      reconciledAt: row.reconciledAt.toISOString(),
    };
  }

  async function list(input: { companyId: string; issueId?: string | null }) {
    const rows = await db
      .select({
        row: deliveryReconciliations,
        identifier: issues.identifier,
        title: issues.title,
        projectId: issues.projectId,
      })
      .from(deliveryReconciliations)
      .innerJoin(issues, eq(issues.id, deliveryReconciliations.issueId))
      .where(and(
        eq(deliveryReconciliations.companyId, input.companyId),
        ...(input.issueId ? [eq(deliveryReconciliations.issueId, input.issueId)] : []),
      ))
      .orderBy(desc(deliveryReconciliations.reconciledAt))
      .limit(500);
    return rows.map(({ row, identifier, title, projectId }) => ({
      issueId: row.issueId,
      identifier,
      title,
      projectId,
      issueStatus: row.observedStatus,
      classification: row.classification,
      outcome: row.outcome as DeliveryReconciliationOutcome,
      unitId: row.unitId,
      repository: row.provenance?.repository ?? null,
      targetBranch: row.provenance?.targetBranch ?? null,
      prNumber: null,
      prUrl: null,
      headSha: row.provenance?.acceptedHeadSha ?? null,
      mergedSha: row.provenance?.mergedSha ?? null,
      provenance: row.provenance,
      disposition: row.disposition,
      reconciledAt: row.reconciledAt.toISOString(),
    }));
  }

  return { inventory, record, list };
}
