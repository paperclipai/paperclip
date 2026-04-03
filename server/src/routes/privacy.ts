import { Router } from "express";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { captureAnalyticsSnapshot } from "../services/analytics.js";
import { checkContractorLifecycles } from "../services/contractor-lifecycle.js";
import { decayStaleMemories } from "../services/agent-memory.js";
import { runAllWeeklyReports } from "../services/weekly-reports.js";
import { runAllDailyStandups } from "../services/daily-standup.js";
import {
  companies,
  agents,
  issues,
  issueComments,
  issueApprovals,
  issueAttachments,
  issueLabels,
  issueDocuments,
  issueWorkProducts,
  issueReadStates,
  issueInboxArchives,
  goals,
  projects,
  projectGoals,
  projectWorkspaces,
  executionWorkspaces,
  workspaceOperations,
  workspaceRuntimeServices,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  financeEvents,
  activityLog,
  approvals,
  approvalComments,
  companySkills,
  companySecrets,
  companyMemberships,
  companySubscriptions,
  companyLogos,
  libraryFiles,
  libraryFileEvents,
  playbooks,
  playbookRuns,
  knowledgePages,
  knowledgePageRevisions,
  messagingBridges,
  budgetPolicies,
  budgetIncidents,
  labels,
  documents,
  documentRevisions,
  assets,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  routines,
  routineTriggers,
  routineRuns,
  principalPermissionGrants,
  invites,
  joinRequests,
  pluginCompanySettings,
  authSessions,
} from "@ironworksai/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertBoard } from "./authz.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";

/* ─── Data Retention Defaults (configurable) ──────────────────────── */

const DEFAULT_RETENTION = {
  heartbeatRunEvents: 90,   // days
  activityLog: 365,         // days
  costEvents: 365,          // days
  financeEvents: 365,       // days
  expiredSessions: 30,      // days after session expiry
};

export function privacyRoutes(db: Db) {
  const router = Router();

  /**
   * GET /companies/:companyId/privacy/data-export
   * GDPR Article 20 — Data portability.
   * Exports all personal and company data as structured JSON.
   */
  router.get("/companies/:companyId/privacy/data-export", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    // Gather all data categories
    const [
      companyAgents,
      companyProjects,
      companyGoals,
      companyIssues,
      companyComments,
      companyCosts,
      companyActivity,
      companyApprovals,
      companySkillsList,
      companyLibraryFiles,
      companyPlaybooks,
      companyPlaybookRuns,
      companyKnowledgePages,
      companyRoutines,
    ] = await Promise.all([
      db.select().from(agents).where(eq(agents.companyId, companyId)).limit(10000),
      db.select().from(projects).where(eq(projects.companyId, companyId)).limit(10000),
      db.select().from(goals).where(eq(goals.companyId, companyId)).limit(10000),
      db.select().from(issues).where(eq(issues.companyId, companyId)).limit(10000),
      db.select().from(issueComments).where(eq(issueComments.companyId, companyId)).limit(10000),
      db.select().from(costEvents).where(eq(costEvents.companyId, companyId)).limit(10000),
      db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).limit(10000),
      db.select().from(approvals).where(eq(approvals.companyId, companyId)).limit(10000),
      db.select().from(companySkills).where(eq(companySkills.companyId, companyId)).limit(10000),
      db.select().from(libraryFiles).where(eq(libraryFiles.companyId, companyId)).limit(10000),
      db.select().from(playbooks).where(eq(playbooks.companyId, companyId)).limit(10000),
      db.select().from(playbookRuns).where(eq(playbookRuns.companyId, companyId)).limit(10000),
      db.select().from(knowledgePages).where(eq(knowledgePages.companyId, companyId)).limit(10000),
      db.select().from(routines).where(eq(routines.companyId, companyId)).limit(10000),
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      format: "ironworks-data-export-v1",
      company: {
        id: company.id,
        name: company.name,
        description: company.description,
        issuePrefix: company.issuePrefix,
        createdAt: company.createdAt,
      },
      agents: companyAgents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        title: a.title,
        status: a.status,
        createdAt: a.createdAt,
      })),
      projects: companyProjects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        createdAt: p.createdAt,
      })),
      goals: companyGoals.map((g) => ({
        id: g.id,
        title: g.title,
        description: g.description,
        level: g.level,
        status: g.status,
        createdAt: g.createdAt,
      })),
      issues: companyIssues.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        description: i.description,
        status: i.status,
        priority: i.priority,
        createdAt: i.createdAt,
        completedAt: i.completedAt,
      })),
      comments: companyComments.map((c) => ({
        id: c.id,
        issueId: c.issueId,
        body: c.body,
        createdAt: c.createdAt,
      })),
      costEvents: companyCosts.map((c) => ({
        id: c.id,
        agentId: c.agentId,
        costCents: c.costCents,
        provider: c.provider,
        occurredAt: c.occurredAt,
      })),
      activity: companyActivity.map((a) => ({
        id: a.id,
        action: a.action,
        actorType: a.actorType,
        entityType: a.entityType,
        createdAt: a.createdAt,
      })),
      approvals: companyApprovals.map((a) => ({
        id: a.id,
        status: a.status,
        createdAt: a.createdAt,
      })),
      skills: companySkillsList.map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        createdAt: s.createdAt,
      })),
      libraryFiles: companyLibraryFiles.map((f) => ({
        id: f.id,
        filePath: f.filePath,
        title: f.title,
        visibility: f.visibility,
        createdAt: f.createdAt,
      })),
      playbooks: companyPlaybooks.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        runCount: p.runCount,
        createdAt: p.createdAt,
      })),
      playbookRuns: companyPlaybookRuns.map((r) => ({
        id: r.id,
        playbookId: r.playbookId,
        status: r.status,
        totalSteps: r.totalSteps,
        completedSteps: r.completedSteps,
        startedAt: r.startedAt,
      })),
      knowledgeBase: companyKnowledgePages.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        visibility: p.visibility,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      routines: companyRoutines.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status,
        createdAt: r.createdAt,
      })),
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ironworks-data-export-${company.issuePrefix}-${new Date().toISOString().split("T")[0]}.json"`,
    );
    res.json(exportData);
  });

  /**
   * POST /companies/:companyId/privacy/erasure-request
   * GDPR Article 17 — Right to erasure.
   * Archives the company immediately, schedules permanent deletion after grace period.
   */
  router.post("/companies/:companyId/privacy/erasure-request", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const actor = getActorInfo(req);
    const { confirm } = req.body as { confirm?: boolean };

    if (!confirm) {
      throw badRequest("Must confirm erasure by setting confirm: true");
    }

    // Archive the company immediately (soft delete)
    await db
      .update(companies)
      .set({
        status: "pending_erasure",
        updatedAt: new Date(),
      })
      .where(eq(companies.id, companyId));

    // Log the erasure request
    await db.insert(activityLog).values({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "privacy.erasure_requested",
      entityType: "company",
      entityId: companyId,
      details: {
        requestedAt: new Date().toISOString(),
        scheduledDeletionAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        requestedBy: actor.actorId,
      },
    });

    res.json({
      status: "erasure_scheduled",
      message: "Company data has been scheduled for permanent deletion in 30 days. Contact support to cancel.",
      scheduledDeletionAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  /**
   * GET /companies/:companyId/privacy/summary
   * Returns a summary of what personal data is stored for this company.
   */
  router.get("/companies/:companyId/privacy/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const counts = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(agents).where(eq(agents.companyId, companyId)),
      db.select({ count: sql<number>`count(*)` }).from(issues).where(eq(issues.companyId, companyId)),
      db.select({ count: sql<number>`count(*)` }).from(issueComments).where(eq(issueComments.companyId, companyId)),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
      db.select({ count: sql<number>`count(*)` }).from(costEvents).where(eq(costEvents.companyId, companyId)),
      db.select({ count: sql<number>`count(*)` }).from(activityLog).where(eq(activityLog.companyId, companyId)),
      db.select({ count: sql<number>`count(*)` }).from(libraryFiles).where(eq(libraryFiles.companyId, companyId)),
    ]);

    res.json({
      dataCategories: [
        { category: "Agents", description: "AI agent profiles and configurations", count: Number(counts[0][0]?.count ?? 0) },
        { category: "Issues", description: "Tasks, descriptions, and assignments", count: Number(counts[1][0]?.count ?? 0) },
        { category: "Comments", description: "Issue comments and discussions", count: Number(counts[2][0]?.count ?? 0) },
        { category: "Execution Logs", description: "Agent heartbeat run records", count: Number(counts[3][0]?.count ?? 0) },
        { category: "Cost Events", description: "Token usage and billing records", count: Number(counts[4][0]?.count ?? 0) },
        { category: "Activity Log", description: "Audit trail of actions taken", count: Number(counts[5][0]?.count ?? 0) },
        { category: "Library Files", description: "Document metadata and ownership records", count: Number(counts[6][0]?.count ?? 0) },
      ],
      retentionPolicies: {
        executionLogs: `${DEFAULT_RETENTION.heartbeatRunEvents} days`,
        activityLog: `${DEFAULT_RETENTION.activityLog} days`,
        costEvents: `${DEFAULT_RETENTION.costEvents} days`,
        sessions: `${DEFAULT_RETENTION.expiredSessions} days after expiry`,
      },
      rights: {
        access: "GET /api/companies/:id/privacy/data-export",
        erasure: "POST /api/companies/:id/privacy/erasure-request",
        portability: "GET /api/companies/:id/privacy/data-export",
      },
    });
  });

  /**
   * POST /privacy/retention/run-cleanup
   * Runs the data retention cleanup job manually.
   * Normally this runs on a daily schedule.
   */
  router.post("/privacy/retention/run-cleanup", async (req, res) => {
    assertBoard(req);
    const result = await runRetentionCleanup(db);
    res.json(result);
  });

  return router;
}

/* ─── GDPR Erasure: Full Company Data Deletion ─────────────────────── */

/**
 * Permanently deletes ALL data belonging to a company.
 * Deletion order respects foreign-key constraints (children before parents).
 * Tables without a companyId column are NOT touched here.
 */
export async function deleteCompanyData(db: Db, companyId: string): Promise<void> {
  logger.info({ companyId }, "beginning GDPR erasure for company");

  // ── Tier 1: leaf rows that reference issues / approvals / comments ──────
  await db.delete(issueReadStates).where(eq(issueReadStates.companyId, companyId));
  await db.delete(issueInboxArchives).where(eq(issueInboxArchives.companyId, companyId));
  await db.delete(issueLabels).where(eq(issueLabels.companyId, companyId));
  // issueAttachments references issueComments (set null) and issues (cascade) and assets
  await db.delete(issueAttachments).where(eq(issueAttachments.companyId, companyId));
  await db.delete(issueApprovals).where(eq(issueApprovals.companyId, companyId));
  await db.delete(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId));

  // ── Tier 2: document junction rows ─────────────────────────────────────
  await db.delete(issueDocuments).where(eq(issueDocuments.companyId, companyId));

  // ── Tier 3: issue comments (before issues) ──────────────────────────────
  await db.delete(issueComments).where(eq(issueComments.companyId, companyId));

  // ── Tier 4: approval comments then approvals ────────────────────────────
  await db.delete(approvalComments).where(eq(approvalComments.companyId, companyId));
  await db.delete(approvals).where(eq(approvals.companyId, companyId));

  // ── Tier 5: document revisions then documents ───────────────────────────
  // document_revisions has onDelete: cascade from documents, but we delete explicitly
  await db.delete(documentRevisions).where(eq(documentRevisions.companyId, companyId));
  await db.delete(documents).where(eq(documents.companyId, companyId));

  // ── Tier 6: library file events then library files ──────────────────────
  await db.delete(libraryFileEvents).where(eq(libraryFileEvents.companyId, companyId));
  await db.delete(libraryFiles).where(eq(libraryFiles.companyId, companyId));

  // ── Tier 7: knowledge page revisions then knowledge pages ───────────────
  await db.delete(knowledgePageRevisions).where(eq(knowledgePageRevisions.companyId, companyId));
  await db.delete(knowledgePages).where(eq(knowledgePages.companyId, companyId));

  // ── Tier 8: playbook runs then playbooks ────────────────────────────────
  // playbookRunSteps has no companyId — cascade deletes them with playbookRuns.
  // playbookSteps has no companyId — cascade deletes them with playbooks.
  await db.delete(playbookRuns).where(eq(playbookRuns.companyId, companyId));
  await db.delete(playbooks).where(eq(playbooks.companyId, companyId));

  // ── Tier 9: routines (triggers and runs cascade from routines) ───────────
  await db.delete(routineRuns).where(eq(routineRuns.companyId, companyId));
  await db.delete(routineTriggers).where(eq(routineTriggers.companyId, companyId));
  await db.delete(routines).where(eq(routines.companyId, companyId));

  // ── Tier 10: workspace-level objects ────────────────────────────────────
  await db.delete(workspaceOperations).where(eq(workspaceOperations.companyId, companyId));
  await db.delete(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, companyId));
  await db.delete(executionWorkspaces).where(eq(executionWorkspaces.companyId, companyId));
  await db.delete(projectWorkspaces).where(eq(projectWorkspaces.companyId, companyId));

  // ── Tier 11: issues then goals and projects ──────────────────────────────
  await db.delete(issues).where(eq(issues.companyId, companyId));
  await db.delete(projectGoals).where(eq(projectGoals.companyId, companyId));
  await db.delete(goals).where(eq(goals.companyId, companyId));
  await db.delete(projects).where(eq(projects.companyId, companyId));

  // ── Tier 12: finance and cost events ────────────────────────────────────
  await db.delete(financeEvents).where(eq(financeEvents.companyId, companyId));
  await db.delete(costEvents).where(eq(costEvents.companyId, companyId));

  // ── Tier 13: heartbeat events then heartbeat runs ───────────────────────
  await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
  await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));

  // ── Tier 14: agent sub-objects then agents ───────────────────────────────
  await db.delete(agentConfigRevisions).where(eq(agentConfigRevisions.companyId, companyId));
  await db.delete(agentApiKeys).where(eq(agentApiKeys.companyId, companyId));
  await db.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, companyId));
  await db.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId));
  await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  await db.delete(agents).where(eq(agents.companyId, companyId));

  // ── Tier 15: activity log ────────────────────────────────────────────────
  await db.delete(activityLog).where(eq(activityLog.companyId, companyId));

  // ── Tier 16: miscellaneous company-scoped tables ─────────────────────────
  await db.delete(labels).where(eq(labels.companyId, companyId));
  await db.delete(assets).where(eq(assets.companyId, companyId));
  await db.delete(companySkills).where(eq(companySkills.companyId, companyId));

  // ── Tier 17: secrets (company_secret_versions has no companyId; cascade removes them) ─
  await db.delete(companySecrets).where(eq(companySecrets.companyId, companyId));

  // ── Tier 18: messaging, budget, permissions, invites ────────────────────
  await db.delete(messagingBridges).where(eq(messagingBridges.companyId, companyId));
  await db.delete(budgetIncidents).where(eq(budgetIncidents.companyId, companyId));
  await db.delete(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
  await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
  await db.delete(joinRequests).where(eq(joinRequests.companyId, companyId));
  await db.delete(invites).where(eq(invites.companyId, companyId));
  await db.delete(pluginCompanySettings).where(eq(pluginCompanySettings.companyId, companyId));
  await db.delete(companyLogos).where(eq(companyLogos.companyId, companyId));

  // ── Tier 19: subscriptions and memberships (before company row) ──────────
  await db.delete(companySubscriptions).where(eq(companySubscriptions.companyId, companyId));
  await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));

  // ── Tier 20: the company itself ──────────────────────────────────────────
  await db.delete(companies).where(eq(companies.id, companyId));

  logger.info({ companyId }, "GDPR erasure complete — company and all data permanently deleted");
}

/* ─── Data Retention Cleanup Job ──────────────────────────────────── */

/** Grace period (days) between erasure request and permanent deletion. */
const ERASURE_GRACE_PERIOD_DAYS = 30;

export async function runRetentionCleanup(db: Db): Promise<{
  heartbeatRunEvents: number;
  activityLog: number;
  costEvents: number;
  financeEvents: number;
  expiredSessions: number;
  companiesErased: number;
  doneIssuesAutoArchived: number;
}> {
  const results = {
    heartbeatRunEvents: 0,
    activityLog: 0,
    costEvents: 0,
    financeEvents: 0,
    expiredSessions: 0,
    companiesErased: 0,
    doneIssuesAutoArchived: 0,
  };

  const now = new Date();

  // ── GDPR erasure: permanently delete companies past their grace period ───
  const erasureThreshold = new Date(
    now.getTime() - ERASURE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
  const pendingErasures = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.status, "pending_erasure"),
        lt(companies.updatedAt, erasureThreshold),
      ),
    );

  for (const { id: companyId } of pendingErasures) {
    try {
      await deleteCompanyData(db, companyId);
      results.companiesErased += 1;
    } catch (err) {
      logger.error({ err, companyId }, "GDPR erasure failed for company");
    }
  }

  // Heartbeat run events older than retention period
  const hreThreshold = new Date(now.getTime() - DEFAULT_RETENTION.heartbeatRunEvents * 24 * 60 * 60 * 1000);
  const hreResult = await db
    .delete(heartbeatRunEvents)
    .where(lt(heartbeatRunEvents.createdAt, hreThreshold));
  results.heartbeatRunEvents = (hreResult as unknown as { rowCount?: number }).rowCount ?? 0;

  // Activity log older than retention period
  const alThreshold = new Date(now.getTime() - DEFAULT_RETENTION.activityLog * 24 * 60 * 60 * 1000);
  const alResult = await db
    .delete(activityLog)
    .where(lt(activityLog.createdAt, alThreshold));
  results.activityLog = (alResult as unknown as { rowCount?: number }).rowCount ?? 0;

  // Cost events older than retention period
  const ceThreshold = new Date(now.getTime() - DEFAULT_RETENTION.costEvents * 24 * 60 * 60 * 1000);
  const ceResult = await db
    .delete(costEvents)
    .where(lt(costEvents.occurredAt, ceThreshold));
  results.costEvents = (ceResult as unknown as { rowCount?: number }).rowCount ?? 0;

  // Finance events older than retention period
  const feThreshold = new Date(now.getTime() - DEFAULT_RETENTION.financeEvents * 24 * 60 * 60 * 1000);
  const feResult = await db
    .delete(financeEvents)
    .where(lt(financeEvents.occurredAt, feThreshold));
  results.financeEvents = (feResult as unknown as { rowCount?: number }).rowCount ?? 0;

  // Expired auth sessions older than grace period
  const sessionThreshold = new Date(now.getTime() - DEFAULT_RETENTION.expiredSessions * 24 * 60 * 60 * 1000);
  const sessionResult = await db
    .delete(authSessions)
    .where(lt(authSessions.expiresAt, sessionThreshold));
  results.expiredSessions = (sessionResult as unknown as { rowCount?: number }).rowCount ?? 0;

  // Auto-archive done issues older than 7 days from all users' inboxes
  const doneArchiveThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const doneIssues = await db
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(and(eq(issues.status, "done"), lt(issues.updatedAt, doneArchiveThreshold)));

  if (doneIssues.length > 0) {
    // Group by company so we can fetch members per company efficiently
    const issuesByCompany = new Map<string, string[]>();
    for (const issue of doneIssues) {
      const existing = issuesByCompany.get(issue.companyId);
      if (existing) existing.push(issue.id);
      else issuesByCompany.set(issue.companyId, [issue.id]);
    }

    for (const [companyId, companyIssueIds] of issuesByCompany) {
      // Find all user members of this company
      const members = await db
        .select({ principalId: companyMemberships.principalId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
          ),
        );

      if (members.length === 0) continue;

      const archivedAt = now;
      const updatedAt = now;

      // Upsert archive records for each (issue, user) pair
      for (const issueId of companyIssueIds) {
        for (const { principalId: userId } of members) {
          await db
            .insert(issueInboxArchives)
            .values({ companyId, issueId, userId, archivedAt, updatedAt })
            .onConflictDoUpdate({
              target: [issueInboxArchives.companyId, issueInboxArchives.issueId, issueInboxArchives.userId],
              set: { archivedAt, updatedAt },
            });
          results.doneIssuesAutoArchived += 1;
        }
      }
    }
  }

  logger.info({ results }, "data retention cleanup completed");
  return results;
}

/**
 * Start the daily retention cleanup scheduler.
 * Call this from server startup.
 */
export function startRetentionScheduler(db: Db): NodeJS.Timeout {
  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const HOURLY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // Run once on startup (delayed 60s to avoid slowing boot)
  const initialTimeout = setTimeout(() => {
    runRetentionCleanup(db).catch((err) =>
      logger.error({ err }, "initial retention cleanup failed"),
    );
    captureAnalyticsSnapshot(db).catch((err) =>
      logger.error({ err }, "initial analytics snapshot failed"),
    );
    checkContractorLifecycles(db).catch((err) =>
      logger.error({ err }, "initial contractor lifecycle check failed"),
    );
    decayStaleMemories(db).catch((err) =>
      logger.error({ err }, "initial memory decay failed"),
    );
  }, 60_000);

  // Then run daily
  const interval = setInterval(() => {
    runRetentionCleanup(db).catch((err) =>
      logger.error({ err }, "scheduled retention cleanup failed"),
    );
    captureAnalyticsSnapshot(db).catch((err) =>
      logger.error({ err }, "scheduled analytics snapshot failed"),
    );
    decayStaleMemories(db).catch((err) =>
      logger.error({ err }, "scheduled memory decay failed"),
    );
  }, CLEANUP_INTERVAL_MS);

  // Hourly: contractor lifecycle checks
  setInterval(() => {
    checkContractorLifecycles(db)
      .then((terminated) => {
        if (terminated > 0) {
          logger.info({ terminated }, "contractor lifecycle check completed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "scheduled contractor lifecycle check failed");
      });
  }, HOURLY_INTERVAL_MS);

  // ── CT-aware scheduled tasks ──────────────────────────────────────────
  // Check every minute whether it's time to run CT-scheduled jobs.
  // Weekly reports: Sunday 18:00 CT
  // Daily standups: every day 08:00 CT
  const MINUTE_MS = 60 * 1000;
  let lastStandupDate = "";
  let lastWeeklyDate = "";

  setInterval(() => {
    const now = new Date();
    const ctParts = now.toLocaleString("en-US", {
      timeZone: "America/Chicago",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });

    // Parse CT time components
    const hourMatch = ctParts.match(/(\d{2}):(\d{2})/);
    const ctHour = hourMatch ? parseInt(hourMatch[1], 10) : -1;
    const ctMinute = hourMatch ? parseInt(hourMatch[2], 10) : -1;
    const isSunday = ctParts.startsWith("Sun");
    const dateKey = now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    // Daily standups at 08:00 CT (run once per day)
    if (ctHour === 8 && ctMinute === 0 && lastStandupDate !== dateKey) {
      lastStandupDate = dateKey;
      runAllDailyStandups(db).catch((err) =>
        logger.error({ err }, "scheduled daily standups failed"),
      );
    }

    // Weekly reports on Sunday at 18:00 CT (run once per week)
    if (isSunday && ctHour === 18 && ctMinute === 0 && lastWeeklyDate !== dateKey) {
      lastWeeklyDate = dateKey;
      runAllWeeklyReports(db).catch((err) =>
        logger.error({ err }, "scheduled weekly reports failed"),
      );
    }
  }, MINUTE_MS);

  // Return the interval so it can be cleared on shutdown
  return interval;
}
