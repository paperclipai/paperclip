import { createHash } from "node:crypto";
import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  companies,
  issueComments,
  issueImportItems,
  issueImportRuns,
  issueOriginStates,
  issueRelations,
  issues,
  projects,
  providerEventReceipts,
} from "@paperclipai/db";
import type { LinearIssueImportItem, PreviewLinearIssueImport } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

export const LINEAR_ISSUE_ORIGIN_KIND = "linear_issue";
const PREVIEW_TTL_MS = 15 * 60 * 1000;

type ImportActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

type PreviewItemRecord = {
  source: LinearIssueImportItem;
  action: "create" | "link" | "update" | "unchanged";
  issueId: string | null;
  proposed: Record<string, unknown>;
  current: Record<string, unknown> | null;
  conflicts: string[];
  failures: string[];
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalizeIssueImportManifest(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeIssueImportDigest(value: unknown): string {
  return createHash("sha256").update(canonicalizeIssueImportManifest(value), "utf8").digest("hex");
}

export function computeLinearIssueFingerprint(sourceId: string): string {
  return createHash("sha256")
    .update(`${LINEAR_ISSUE_ORIGIN_KIND}\0${sourceId}`, "utf8")
    .digest("hex");
}

export function mapLinearIssueStatus(sourceStatus: string): {
  status: "backlog" | "todo" | "done" | "cancelled";
  conflict: string | null;
} {
  const normalized = sourceStatus.trim().toLowerCase().replace(/[ _-]+/g, " ");
  if (normalized === "todo") return { status: "todo", conflict: null };
  if (normalized === "done" || normalized === "completed") return { status: "done", conflict: null };
  if (normalized === "canceled" || normalized === "cancelled" || normalized === "duplicate") {
    return { status: "cancelled", conflict: null };
  }
  if (normalized === "in progress" || normalized === "in review") {
    return { status: "backlog", conflict: "source_status_requires_accountable_execution_path" };
  }
  if (normalized === "backlog") return { status: "backlog", conflict: null };
  return { status: "backlog", conflict: "source_status_unmapped" };
}

export function sanitizeImportFailure(_error: unknown): string {
  return "Issue import failed";
}

function findCyclicSources(edges: Map<string, string[]>): Set<string> {
  const cyclic = new Set<string>();
  for (const start of edges.keys()) {
    const visit = (node: string, seen: Set<string>): boolean => {
      for (const next of edges.get(node) ?? []) {
        if (next === start) return true;
        if (seen.has(next) || !edges.has(next)) continue;
        const branch = new Set(seen);
        branch.add(next);
        if (visit(next, branch)) return true;
      }
      return false;
    };
    if (visit(start, new Set([start]))) cyclic.add(start);
  }
  return cyclic;
}

type CurrentBlocker = {
  issueId: string;
  sourceId: string | null;
};

function issueCurrentSnapshot(issue: typeof issues.$inferSelect, blockers: CurrentBlocker[]) {
  return {
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    projectId: issue.projectId,
    parentId: issue.parentId,
    blockedByIssueIds: blockers.map((blocker) => blocker.issueId).sort(),
    blockedBySourceIds: blockers
      .flatMap((blocker) => blocker.sourceId ? [blocker.sourceId] : [])
      .sort(),
  };
}

function reportCounts(run: typeof issueImportRuns.$inferSelect) {
  return {
    received: run.receivedCount,
    created: run.createdCount,
    linked: run.linkedCount,
    updated: run.updatedCount,
    unchanged: run.unchangedCount,
    conflicts: run.conflictCount,
    failures: run.failureCount,
    relations: run.relationCount,
    commentsCreated: run.commentCreatedCount,
    commentsDeduplicated: run.commentDeduplicatedCount,
    assignments: run.assignmentCount,
    wakes: run.wakeCount,
  };
}

export function issueImportService(db: Db) {
  async function getReport(companyId: string, runId: string) {
    const run = await db.select().from(issueImportRuns).where(and(
      eq(issueImportRuns.companyId, companyId),
      eq(issueImportRuns.id, runId),
    )).then((rows) => rows[0] ?? null);
    if (!run) return null;
    const items = await db.select().from(issueImportItems).where(and(
      eq(issueImportItems.companyId, companyId),
      eq(issueImportItems.runId, runId),
    )).orderBy(asc(issueImportItems.itemIndex));
    return {
      runId: run.id,
      provider: run.provider,
      status: run.status,
      manifestVersion: run.manifestVersion,
      previewDigest: run.manifestDigest,
      sourceSnapshot: {
        version: run.sourceSnapshotVersion,
        retrievedAt: run.sourceSnapshotRetrievedAt,
      },
      expiresAt: run.expiresAt,
      appliedAt: run.appliedAt,
      actor: { type: run.actorType, id: run.actorId, runId: run.actorRunId },
      counts: reportCounts(run),
      errorSummary: run.errorSummary,
      items: items.map((item) => ({
        sourceId: item.sourceId,
        sourceIdentifier: item.sourceIdentifier,
        sourceVersion: item.sourceVersion,
        sourceUpdatedAt: item.sourceUpdatedAt,
        sourceUrl: item.sourceUrl,
        action: item.action,
        issueId: item.issueId,
        proposed: item.proposed,
        current: item.current,
        applied: item.applied,
        conflicts: item.conflicts,
        failures: item.failures,
        relationResults: item.relationResults,
      })),
    };
  }

  async function preview(companyId: string, manifest: PreviewLinearIssueImport, actor: ImportActor) {
    const company = await db.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, companyId)).then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");

    const digest = computeIssueImportDigest(manifest);
    const sourceIds = manifest.items.map((item) => item.sourceId);
    const referenceSourceIds = [...new Set(manifest.items.flatMap((item) => [
      ...(item.parentSourceId ? [item.parentSourceId] : []),
      ...item.blockedBySourceIds,
    ]))];
    const lookupSourceIds = [...new Set([...sourceIds, ...referenceSourceIds])];
    const existingIssues = lookupSourceIds.length === 0 ? [] : await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, LINEAR_ISSUE_ORIGIN_KIND),
      inArray(issues.originId, lookupSourceIds),
    ));
    const existingBySource = new Map(existingIssues.map((issue) => [issue.originId!, issue]));
    const existingIssueIds = existingIssues.map((issue) => issue.id);
    const currentBlockerRows = existingIssueIds.length === 0 ? [] : await db.select({
      blockedIssueId: issueRelations.relatedIssueId,
      blockerIssueId: issueRelations.issueId,
      blockerOriginKind: issues.originKind,
      blockerOriginId: issues.originId,
    }).from(issueRelations).innerJoin(issues, and(
      eq(issues.companyId, companyId),
      eq(issues.id, issueRelations.issueId),
    )).where(and(
      eq(issueRelations.companyId, companyId),
      eq(issueRelations.type, "blocks"),
      inArray(issueRelations.relatedIssueId, existingIssueIds),
    ));
    const currentBlockersByIssue = new Map<string, CurrentBlocker[]>();
    for (const row of currentBlockerRows) {
      const blockers = currentBlockersByIssue.get(row.blockedIssueId) ?? [];
      blockers.push({
        issueId: row.blockerIssueId,
        sourceId: row.blockerOriginKind === LINEAR_ISSUE_ORIGIN_KIND ? row.blockerOriginId : null,
      });
      currentBlockersByIssue.set(row.blockedIssueId, blockers);
    }
    const originStates = sourceIds.length === 0 ? [] : await db.select().from(issueOriginStates).where(and(
      eq(issueOriginStates.companyId, companyId),
      eq(issueOriginStates.provider, "linear"),
      inArray(issueOriginStates.sourceId, sourceIds),
    ));
    const stateBySource = new Map(originStates.map((state) => [state.sourceId, state]));

    const mappedProjectIds = [...new Set(Object.values(manifest.projectMappings))];
    const validProjects = mappedProjectIds.length === 0 ? [] : await db.select({ id: projects.id }).from(projects).where(and(
      eq(projects.companyId, companyId),
      inArray(projects.id, mappedProjectIds),
    ));
    const validProjectIds = new Set(validProjects.map((project) => project.id));
    const batchSourceIds = new Set(sourceIds);
    const parentCycles = findCyclicSources(new Map(manifest.items.map((item) => [
      item.sourceId,
      item.parentSourceId && batchSourceIds.has(item.parentSourceId) ? [item.parentSourceId] : [],
    ])));
    const blockerCycles = findCyclicSources(new Map(manifest.items.map((item) => [
      item.sourceId,
      item.blockedBySourceIds.filter((sourceId) => batchSourceIds.has(sourceId)),
    ])));

    const previewItems: PreviewItemRecord[] = manifest.items.map((source) => {
      const existing = existingBySource.get(source.sourceId) ?? null;
      const state = stateBySource.get(source.sourceId) ?? null;
      const statusMapping = mapLinearIssueStatus(source.sourceStatus);
      const conflicts: string[] = statusMapping.conflict ? [statusMapping.conflict] : [];
      const failures: string[] = [];
      if (parentCycles.has(source.sourceId)) failures.push("parent_cycle_detected");
      if (blockerCycles.has(source.sourceId)) failures.push("blocker_cycle_detected");
      let projectId: string | null = null;
      if (source.projectSourceId) {
        const mapped = manifest.projectMappings[source.projectSourceId];
        if (!mapped) conflicts.push("project_mapping_missing");
        else if (!validProjectIds.has(mapped)) failures.push("project_mapping_target_invalid");
        else projectId = mapped;
      }
      if (source.parentSourceId && !batchSourceIds.has(source.parentSourceId) && !existingBySource.has(source.parentSourceId)) {
        failures.push("parent_source_unresolved");
      }
      for (const blockerSourceId of source.blockedBySourceIds) {
        if (!batchSourceIds.has(blockerSourceId) && !existingBySource.has(blockerSourceId)) {
          failures.push("blocker_source_unresolved");
        }
      }
      const fingerprint = computeLinearIssueFingerprint(source.sourceId);
      if (existing && existing.originFingerprint !== fingerprint) failures.push("origin_fingerprint_mismatch");
      if (existing && state && state.sourceVersion !== source.sourceVersion) conflicts.push("source_version_drift");
      const currentBlockers = existing ? currentBlockersByIssue.get(existing.id) ?? [] : [];
      if (existing && state) {
        const proposedBlockerSourceIds = [...new Set(source.blockedBySourceIds)].sort();
        const currentBlockerSourceIds = currentBlockers
          .flatMap((blocker) => blocker.sourceId ? [blocker.sourceId] : [])
          .sort();
        if (JSON.stringify(proposedBlockerSourceIds) !== JSON.stringify(currentBlockerSourceIds)) {
          conflicts.push("blocker_relations_drift");
        }
      }
      const proposed = {
        title: source.title,
        description: source.description ?? null,
        status: statusMapping.status,
        priority: source.priority,
        projectId,
        parentSourceId: source.parentSourceId ?? null,
        blockedBySourceIds: source.blockedBySourceIds,
        sourceUrl: source.sourceUrl,
        originKind: LINEAR_ISSUE_ORIGIN_KIND,
        originId: source.sourceId,
        originFingerprint: fingerprint,
        assigneeAgentId: null,
        assigneeUserId: null,
      };
      const action = !existing ? "create" : !state ? "link" : state.sourceVersion === source.sourceVersion ? "unchanged" : "update";
      return {
        source,
        action,
        issueId: existing?.id ?? null,
        proposed,
        current: existing ? issueCurrentSnapshot(existing, currentBlockers) : null,
        conflicts: [...new Set(conflicts)],
        failures: [...new Set(failures)],
      };
    });

    const counts = {
      received: previewItems.length,
      wouldCreate: previewItems.filter((item) => item.action === "create").length,
      wouldLink: previewItems.filter((item) => item.action === "link").length,
      wouldUpdate: previewItems.filter((item) => item.action === "update").length,
      unchanged: previewItems.filter((item) => item.action === "unchanged").length,
      conflicts: previewItems.reduce((sum, item) => sum + item.conflicts.length, 0),
      failures: previewItems.reduce((sum, item) => sum + item.failures.length, 0),
      assignments: 0,
      wakes: 0,
    };
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
    const run = await db.transaction(async (tx) => {
      const [createdRun] = await tx.insert(issueImportRuns).values({
        companyId,
        provider: "linear",
        manifestVersion: manifest.manifestVersion,
        manifestDigest: digest,
        sourceSnapshotVersion: manifest.sourceSnapshot.version,
        sourceSnapshotRetrievedAt: new Date(manifest.sourceSnapshot.retrievedAt),
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorRunId: actor.runId,
        status: counts.failures === 0 ? "preview_ready" : "preview_failed",
        receivedCount: counts.received,
        createdCount: counts.wouldCreate,
        linkedCount: counts.wouldLink,
        updatedCount: counts.wouldUpdate,
        unchangedCount: counts.unchanged,
        conflictCount: counts.conflicts,
        failureCount: counts.failures,
        assignmentCount: 0,
        wakeCount: 0,
        expiresAt,
      }).returning();
      await tx.insert(issueImportItems).values(previewItems.map((item, itemIndex) => ({
        companyId,
        runId: createdRun.id,
        provider: "linear",
        itemIndex,
        sourceId: item.source.sourceId,
        sourceIdentifier: item.source.sourceIdentifier,
        sourceVersion: item.source.sourceVersion,
        sourceUpdatedAt: new Date(item.source.sourceUpdatedAt),
        sourceUrl: item.source.sourceUrl,
        action: item.action,
        issueId: item.issueId,
        sourceData: item.source as unknown as Record<string, unknown>,
        proposed: item.proposed,
        current: item.current,
        applied: null,
        conflicts: item.conflicts,
        failures: item.failures,
        relationResults: null,
      })));
      await tx.insert(activityLog).values({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue_import.previewed",
        entityType: "issue_import_run",
        entityId: createdRun.id,
        details: {
          provider: "linear",
          manifestVersion: manifest.manifestVersion,
          manifestDigest: digest,
          sourceSnapshotVersion: manifest.sourceSnapshot.version,
          sourceSnapshotRetrievedAt: manifest.sourceSnapshot.retrievedAt,
          counts,
        },
      });
      return createdRun;
    });

    return {
      previewRunId: run.id,
      previewDigest: digest,
      expiresAt,
      counts,
      items: previewItems.map((item) => ({
        sourceId: item.source.sourceId,
        sourceIdentifier: item.source.sourceIdentifier,
        action: item.action,
        existingIssueId: item.issueId,
        proposed: item.proposed,
        current: item.current,
        conflicts: item.conflicts,
        failures: item.failures,
      })),
    };
  }

  async function apply(companyId: string, input: { previewRunId: string; previewDigest: string; activate: false }, actor: ImportActor) {
    let mutationStarted = false;
    try {
      const appliedRunId = await db.transaction(async (tx) => {
        const run = await tx.select().from(issueImportRuns).where(and(
          eq(issueImportRuns.companyId, companyId),
          eq(issueImportRuns.id, input.previewRunId),
        )).for("update").then((rows) => rows[0] ?? null);
        if (!run) throw notFound("Issue import preview not found");
        if (run.provider !== "linear") throw unprocessable("Only Linear issue imports are supported");
        if (run.manifestDigest !== input.previewDigest) throw conflict("Issue import preview digest mismatch");
        if (run.status === "applied") throw conflict("Issue import preview has already been applied");
        if (run.status !== "preview_ready") throw conflict("Issue import preview is not applicable");
        if (run.expiresAt.getTime() <= Date.now()) throw conflict("Issue import preview has expired");
        if (input.activate !== false) throw unprocessable("Issue import activation is not supported");

        const itemRows = await tx.select().from(issueImportItems).where(and(
          eq(issueImportItems.companyId, companyId),
          eq(issueImportItems.runId, run.id),
        )).orderBy(asc(issueImportItems.itemIndex));
        if (itemRows.some((item) => item.failures.length > 0)) {
          throw conflict("Issue import preview contains failures");
        }
        mutationStarted = true;
        for (const item of [...itemRows].sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-import:linear:${companyId}:${item.sourceId}`}, 0))`);
        }

        const wakeCountBefore = await tx.select({ count: sql<number>`count(*)::int` }).from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, companyId)).then((rows) => rows[0]?.count ?? 0);
        const sourceIds = itemRows.map((item) => item.sourceId);
        const existingIssues = await tx.select().from(issues).where(and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, LINEAR_ISSUE_ORIGIN_KIND),
          inArray(issues.originId, sourceIds),
        ));
        const issueBySource = new Map(existingIssues.map((issue) => [issue.originId!, issue]));
        const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("update");
        if (!company) throw notFound("Company not found");
        const currentMax = await tx.select({ value: max(issues.issueNumber) }).from(issues)
          .where(eq(issues.companyId, companyId)).then((rows) => rows[0]?.value ?? 0);
        let nextNumber = Math.max(company.issueCounter, currentMax ?? 0);
        const createdSourceIds = new Set<string>();
        let createdCount = 0;
        let linkedCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;

        for (const item of itemRows) {
          const source = item.sourceData as unknown as LinearIssueImportItem;
          let issue = issueBySource.get(item.sourceId) ?? null;
          const expectedFingerprint = computeLinearIssueFingerprint(item.sourceId);
          if (issue && issue.originFingerprint !== expectedFingerprint) throw conflict("Linear origin fingerprint mismatch");
          if (!issue) {
            nextNumber += 1;
            const proposed = item.proposed as Record<string, unknown>;
            [issue] = await tx.insert(issues).values({
              companyId,
              issueNumber: nextNumber,
              identifier: `${company.issuePrefix}-${nextNumber}`,
              title: source.title,
              description: source.description ?? null,
              status: proposed.status as string,
              priority: source.priority,
              projectId: (proposed.projectId as string | null) ?? null,
              assigneeAgentId: null,
              assigneeUserId: null,
              createdByAgentId: actor.agentId,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
              originKind: LINEAR_ISSUE_ORIGIN_KIND,
              originId: item.sourceId,
              originRunId: actor.runId,
              originFingerprint: expectedFingerprint,
            }).returning();
            issueBySource.set(item.sourceId, issue);
            createdSourceIds.add(item.sourceId);
            createdCount += 1;
          } else if (item.action === "update") {
            updatedCount += 1;
          } else if (item.action === "unchanged") {
            unchangedCount += 1;
          } else {
            linkedCount += 1;
          }
          await tx.insert(issueOriginStates).values({
            companyId,
            issueId: issue.id,
            provider: "linear",
            sourceId: item.sourceId,
            sourceIdentifier: item.sourceIdentifier,
            sourceVersion: item.sourceVersion,
            sourceUpdatedAt: item.sourceUpdatedAt,
            sourceUrl: item.sourceUrl,
            lastReconciledRunId: run.id,
            state: "staged",
          }).onConflictDoUpdate({
            target: [issueOriginStates.companyId, issueOriginStates.provider, issueOriginStates.sourceId],
            set: {
              sourceIdentifier: item.sourceIdentifier,
              sourceVersion: item.sourceVersion,
              sourceUpdatedAt: item.sourceUpdatedAt,
              sourceUrl: item.sourceUrl,
              lastReconciledRunId: run.id,
              state: "staged",
              updatedAt: new Date(),
            },
          });
          await tx.update(issueImportItems).set({ issueId: issue.id }).where(eq(issueImportItems.id, item.id));
        }
        if (createdCount > 0) {
          await tx.update(companies).set({ issueCounter: nextNumber, updatedAt: new Date() }).where(eq(companies.id, companyId));
        }

        let relationCount = 0;
        let commentCreatedCount = 0;
        let commentDeduplicatedCount = 0;
        for (const item of itemRows) {
          const source = item.sourceData as unknown as LinearIssueImportItem;
          const issue = issueBySource.get(item.sourceId)!;
          const previewCurrent = item.current as {
            blockedByIssueIds?: string[];
            blockedBySourceIds?: string[];
          } | null;
          const isInitialImport = createdSourceIds.has(item.sourceId);
          const relationResults: Record<string, unknown> = {
            parentApplied: false,
            blockersApplied: 0,
            blockerReconciliation: {
              authority: isInitialImport ? "source_initial" : "paperclip",
              proposedSourceIds: source.blockedBySourceIds,
              currentIssueIds: previewCurrent?.blockedByIssueIds ?? [],
              currentSourceIds: previewCurrent?.blockedBySourceIds ?? [],
              conflict: item.conflicts.includes("blocker_relations_drift"),
            },
          };
          if (source.parentSourceId) {
            const parent = issueBySource.get(source.parentSourceId) ?? await tx.select().from(issues).where(and(
              eq(issues.companyId, companyId),
              eq(issues.originKind, LINEAR_ISSUE_ORIGIN_KIND),
              eq(issues.originId, source.parentSourceId),
            )).then((rows) => rows[0] ?? null);
            if (!parent) throw unprocessable("Parent source disappeared after preview");
            if (createdSourceIds.has(item.sourceId)) {
              await tx.update(issues).set({ parentId: parent.id, updatedAt: new Date() }).where(eq(issues.id, issue.id));
              relationCount += 1;
              relationResults.parentApplied = true;
            }
          }
          if (isInitialImport) {
            for (const blockerSourceId of source.blockedBySourceIds) {
              const blocker = issueBySource.get(blockerSourceId) ?? await tx.select().from(issues).where(and(
                eq(issues.companyId, companyId),
                eq(issues.originKind, LINEAR_ISSUE_ORIGIN_KIND),
                eq(issues.originId, blockerSourceId),
              )).then((rows) => rows[0] ?? null);
              if (!blocker) throw unprocessable("Blocker source disappeared after preview");
              const inserted = await tx.insert(issueRelations).values({
                companyId,
                issueId: blocker.id,
                relatedIssueId: issue.id,
                type: "blocks",
                createdByAgentId: actor.agentId,
                createdByUserId: actor.actorType === "user" ? actor.actorId : null,
              }).onConflictDoNothing().returning({ id: issueRelations.id });
              if (inserted.length > 0) {
                relationCount += 1;
                relationResults.blockersApplied = Number(relationResults.blockersApplied) + 1;
              }
            }
          }
          for (const comment of source.comments) {
            const receipt = await tx.insert(providerEventReceipts).values({
              companyId,
              provider: "linear",
              sourceEventId: comment.sourceEventId,
              sourceCommentId: comment.sourceCommentId,
              issueId: issue.id,
              importRunId: run.id,
            }).onConflictDoNothing().returning({ id: providerEventReceipts.id });
            if (receipt.length === 0) {
              commentDeduplicatedCount += 1;
              continue;
            }
            const [createdComment] = await tx.insert(issueComments).values({
              companyId,
              issueId: issue.id,
              authorType: "system",
              body: comment.body,
              metadata: {
                providerOrigin: "linear",
                sourceCommentId: comment.sourceCommentId,
                sourceEventId: comment.sourceEventId,
                suppressOutboundMirror: true,
              } as never,
            }).returning({ id: issueComments.id });
            await tx.update(providerEventReceipts).set({ issueCommentId: createdComment.id })
              .where(eq(providerEventReceipts.id, receipt[0].id));
            commentCreatedCount += 1;
          }
          await tx.update(issueImportItems).set({
            applied: {
              issueId: issue.id,
              staged: true,
              assigneeAgentId: null,
              assigneeUserId: null,
              sourceVersion: item.sourceVersion,
              sourceUpdatedAt: item.sourceUpdatedAt.toISOString(),
            },
            relationResults,
          }).where(eq(issueImportItems.id, item.id));
        }

        const wakeCountAfter = await tx.select({ count: sql<number>`count(*)::int` }).from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, companyId)).then((rows) => rows[0]?.count ?? 0);
        const wakeCount = wakeCountAfter - wakeCountBefore;
        if (wakeCount !== 0) throw new Error("Issue import unexpectedly emitted agent wakes");
        const conflictCount = itemRows.reduce((sum, item) => sum + item.conflicts.length, 0);
        const [appliedRun] = await tx.update(issueImportRuns).set({
          status: "applied",
          createdCount,
          linkedCount,
          updatedCount,
          unchangedCount,
          conflictCount,
          failureCount: 0,
          relationCount,
          commentCreatedCount,
          commentDeduplicatedCount,
          assignmentCount: 0,
          wakeCount: 0,
          appliedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(issueImportRuns.id, run.id)).returning();
        await tx.insert(activityLog).values({
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue_import.applied",
          entityType: "issue_import_run",
          entityId: run.id,
          details: {
            provider: "linear",
            manifestVersion: run.manifestVersion,
            manifestDigest: run.manifestDigest,
            sourceSnapshotVersion: run.sourceSnapshotVersion,
            sourceSnapshotRetrievedAt: run.sourceSnapshotRetrievedAt.toISOString(),
            counts: reportCounts(appliedRun),
          },
        });
        return run.id;
      });
      return await getReport(companyId, appliedRunId);
    } catch (error) {
      if (mutationStarted) {
        const safeError = sanitizeImportFailure(error);
        await db.transaction(async (tx) => {
          const failedRuns = await tx.update(issueImportRuns).set({
            status: "failed",
            errorSummary: safeError,
            createdCount: 0,
            linkedCount: 0,
            updatedCount: 0,
            unchangedCount: 0,
            relationCount: 0,
            commentCreatedCount: 0,
            commentDeduplicatedCount: 0,
            assignmentCount: 0,
            wakeCount: 0,
            failureCount: sql`${issueImportRuns.failureCount} + 1`,
            updatedAt: new Date(),
          }).where(and(
            eq(issueImportRuns.companyId, companyId),
            eq(issueImportRuns.id, input.previewRunId),
            eq(issueImportRuns.status, "preview_ready"),
          )).returning({ id: issueImportRuns.id, failureCount: issueImportRuns.failureCount });
          if (failedRuns.length > 0) {
            await tx.insert(activityLog).values({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue_import.failed",
              entityType: "issue_import_run",
              entityId: input.previewRunId,
              details: { provider: "linear", failure: safeError, failureCount: failedRuns[0].failureCount },
            });
          }
        });
      }
      throw error;
    }
  }

  return { preview, apply, getReport };
}
