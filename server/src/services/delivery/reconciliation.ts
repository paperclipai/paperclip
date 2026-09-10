import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  deliveryPolicies,
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
import { conflict, forbidden } from "../../errors.js";

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
  async function importHistoricalMerge(input: {
    companyId: string;
    issueId: string;
    claim: NonNullable<DeliveryReconciliationWriteInput["provenance"]>;
  }): Promise<{ verified: boolean; reason: string; provenance: DeliveryProvenance | null; unitId?: string }> {
    const reject = (reason: string) => ({ verified: false, reason, provenance: null });
    const [issue] = await db.select().from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
    )).limit(1);
    if (!issue || issue.status !== "done" || !issue.projectId || issue.deliveryKind === "non_code") {
      return reject("historical import requires a completed code issue with a project");
    }
    const [policy] = await db.select().from(deliveryPolicies).where(and(
      eq(deliveryPolicies.companyId, input.companyId), eq(deliveryPolicies.projectId, issue.projectId),
    )).limit(1);
    if (!policy?.repositoryId || policy.targetBranch !== input.claim.targetBranch) {
      return reject("historical target does not match an enrolled project policy");
    }
    const repository = await loadRepository(input.companyId, policy.repositoryId);
    if (!repository || input.claim.repository !== `${repository.owner}/${repository.name}`) {
      return reject("historical repository does not match the enrolled project");
    }
    const mergedSha = input.claim.mergedSha.trim().toLowerCase();
    let headSha = input.claim.headSha?.trim().toLowerCase() ?? mergedSha;
    let sourceBranch = policy.targetBranch;
    let baseSha: string | null = null;
    let prUrl: string | null = null;
    let mergedAt: Date | null = null;
    if (input.claim.prNumber) {
      const result = await github.getPullRequest(
        input.companyId, repository.connectionId, repository.host, repository.owner, repository.name, input.claim.prNumber,
      );
      if (!result.ok) return reject(`historical pull request read failed: ${result.message}`);
      const pr = result.value;
      if (!pr.merged || pr.baseRef !== policy.targetBranch || pr.mergeCommitSha?.toLowerCase() !== mergedSha
        || (input.claim.headSha && pr.headSha.toLowerCase() !== headSha)) {
        return reject("historical pull request does not verify the claimed head and merge");
      }
      headSha = pr.headSha.toLowerCase();
      sourceBranch = pr.headRef;
      baseSha = pr.baseSha;
      prUrl = pr.url;
      mergedAt = pr.mergedAt ? new Date(pr.mergedAt) : null;
    } else if (headSha !== mergedSha) {
      return reject("direct publication requires the published head itself, not an unverified mapping");
    }
    if (input.claim.mergeCommitSha && input.claim.mergeCommitSha.trim().toLowerCase() !== mergedSha) {
      return reject("claimed merge commit differs from the remotely verified revision");
    }
    const included = await github.compareCommits(
      input.companyId, repository.connectionId, repository.host, repository.owner, repository.name, mergedSha, policy.targetBranch,
    );
    if (!included.ok) return reject(`remote inclusion check failed: ${included.message}`);
    if (!included.value.included) return reject("claimed revision is not included in the target branch");
    let squashOrRebase = false;
    if (headSha !== mergedSha) {
      const headIncluded = await github.compareCommits(
        input.companyId, repository.connectionId, repository.host, repository.owner, repository.name, headSha, policy.targetBranch,
      );
      if (!headIncluded.ok) return reject(`historical head inclusion check failed: ${headIncluded.message}`);
      squashOrRebase = !headIncluded.value.included;
    }
    const now = new Date();
    const provenance: DeliveryProvenance = {
      repository: `${repository.owner}/${repository.name}`, githubRepositoryId: repository.githubRepositoryId,
      targetBranch: policy.targetBranch, sourceBranch, submittedHeadSha: headSha, acceptedHeadSha: headSha,
      baseSha, mergedSha, mergeCommitSha: input.claim.prNumber ? mergedSha : null,
      mergeMethod: "unknown",
      squashOrRebase,
      checks: [], reviewStatus: "historical", blockingFindings: 0, verifiedAt: now.toISOString(),
    };
    return db.transaction(async (tx) => {
      // Serialize historical receipt reuse without taking the publication queue's lease.
      const key = `delivery-history:${input.companyId}:${repository.id}:${policy.targetBranch}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      const [currentIssue] = await tx.select().from(issues).where(and(
        eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
      )).limit(1).for("update");
      const [currentPolicy] = await tx.select().from(deliveryPolicies).where(and(
        eq(deliveryPolicies.companyId, input.companyId), eq(deliveryPolicies.id, policy.id),
      )).limit(1).for("share");
      if (currentIssue?.status !== "done" || currentIssue.projectId !== issue.projectId
        || currentIssue.deliveryKind === "non_code" || currentPolicy?.version !== policy.version) {
        return reject("issue or policy changed during historical verification");
      }
      const [attached] = await tx.select().from(deliveryUnitIssues).where(and(
        eq(deliveryUnitIssues.companyId, input.companyId), eq(deliveryUnitIssues.issueId, input.issueId),
      )).limit(1);
      if (attached) return reject("issue acquired a delivery unit during historical verification; reconcile again");
      const [existing] = await tx.select({ unit: deliveryUnits, receipt: deliveryReceipts })
        .from(deliveryUnits).innerJoin(deliveryReceipts, eq(deliveryReceipts.unitId, deliveryUnits.id))
        .where(and(
          eq(deliveryUnits.companyId, input.companyId), eq(deliveryUnits.repositoryId, repository.id),
          eq(deliveryUnits.targetBranch, policy.targetBranch), eq(deliveryUnits.status, "merged"),
          eq(deliveryUnits.headSha, headSha), eq(deliveryUnits.mergedSha, mergedSha),
        )).limit(1);
      if (input.claim.prNumber) {
        const [tracked] = await tx.select({ id: deliveryUnits.id }).from(deliveryUnits).where(and(
          eq(deliveryUnits.companyId, input.companyId), eq(deliveryUnits.repositoryId, repository.id),
          eq(deliveryUnits.prNumber, input.claim.prNumber),
        )).limit(1);
        if (tracked && tracked.id !== existing?.unit.id) {
          return reject("pull request is already tracked by a delivery unit; reconcile that unit instead");
        }
      }
      let unitId = existing?.unit.id;
      if (!unitId) {
        const [unit] = await tx.insert(deliveryUnits).values({
          companyId: input.companyId, projectId: issue.projectId, repositoryId: repository.id,
          primaryIssueId: issue.id, targetBranch: policy.targetBranch, sourceBranch, baseSha, headSha,
          acceptedHeadSha: headSha, mergedSha, mergeCommitSha: provenance.mergeCommitSha,
          status: "merged", artifactReady: true, prNumber: input.claim.prNumber ?? null, prUrl,
          // This terminal unit never executes a merge; the receipt records the unknown historical method.
          mergeMethod: "merge", ownerAgentId: issue.assigneeAgentId,
          mergedAt, lastReconciledAt: now, metadata: { historical: true, directPublication: !input.claim.prNumber },
        }).returning();
        if (!unit) throw new Error("Historical delivery unit was not persisted");
        unitId = unit.id;
        await tx.insert(deliveryReceipts).values({
          companyId: input.companyId, unitId, repository: provenance.repository,
          githubRepositoryId: provenance.githubRepositoryId, targetBranch: provenance.targetBranch,
          sourceBranch, submittedHeadSha: headSha, acceptedHeadSha: headSha, baseSha, mergedSha,
          mergeCommitSha: provenance.mergeCommitSha, mergeMethod: provenance.mergeMethod,
          squashOrRebase: provenance.squashOrRebase, checks: [], reviewStatus: "historical",
          blockingFindings: 0, provenance, evidenceHash: createHash("sha256").update(JSON.stringify(provenance)).digest("hex"),
          verifiedAt: now,
        });
      }
      await tx.insert(deliveryUnitIssues).values({
        companyId: input.companyId, unitId, issueId: issue.id, role: existing ? "covered" : "primary",
      });
      return { verified: true, reason: "historical publication remotely verified", provenance: existing?.receipt.provenance ?? provenance, unitId };
    });
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
  }): Promise<{ verified: boolean; reason: string; provenance: DeliveryProvenance | null; unitId?: string }> {
    if (!input.claim) return { verified: false, reason: "no provenance claim supplied", provenance: null };
    for (const sha of [input.claim.mergedSha, input.claim.headSha, input.claim.mergeCommitSha]) {
      if (sha != null && !EXACT_SHA_PATTERN.test(sha.trim())) {
        return { verified: false, reason: "claimed revision is not an exact 40-hex SHA", provenance: null };
      }
    }
    if (!input.unitId) return importHistoricalMerge({ ...input, claim: input.claim });
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

  function reconciliationItem(
    row: typeof deliveryReconciliations.$inferSelect,
    issue: typeof issues.$inferSelect,
  ): DeliveryReconciliationItem {
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

  async function record(input: {
    companyId: string;
    actor: DeliveryActor;
    write: DeliveryReconciliationWriteInput;
  }): Promise<DeliveryReconciliationItem> {
    if (input.actor.type !== "user") throw forbidden("Historical reconciliation requires an operator");
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.write.issueId)))
      .limit(1);
    if (!issue) throw new Error("Issue not found");
    const [existing] = await db.select().from(deliveryReconciliations).where(and(
      eq(deliveryReconciliations.companyId, input.companyId),
      eq(deliveryReconciliations.idempotencyKey, input.write.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.issueId !== issue.id) throw conflict("Reconciliation idempotency key belongs to another issue");
      return reconciliationItem(existing, issue);
    }
    let unit = await db
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
          if (remote.unitId) unit = { unitId: remote.unitId };
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
      : input.write.outcome ?? outcomeFor(classification, provenance !== null);
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
    return reconciliationItem(row, issue);
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
