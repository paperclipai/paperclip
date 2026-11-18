import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issues, responsibilities, responsibilityStatusReports } from "@paperclipai/db";
import {
  RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS,
  RESPONSIBILITY_STATUS_REPORT_HISTORY_LIMIT,
  RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
  responsibilityStatusReportOutOfDate,
  writeResponsibilityStatusReportSchema,
  type ResponsibilityStatusReportCurrent,
  type ResponsibilityStatusReportEntry,
  type ResponsibilityStatusReportState,
  type ResponsibilityStatusReportStatus,
  type ResponsibilityStatusReportsOverview,
  type WriteResponsibilityStatusReport,
} from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { responsibilitiesDisabledError } from "./responsibilities-disabled.js";
import type { AuthorizationActor } from "./authorization.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import {
  agentWorksUnderResponsibility,
  loadLatestStatusReports,
  loadOpenStatusUpdateRequests,
  loadResponsibilityReporters,
  updateStillRequested,
  type StatusReportRow,
} from "./responsibility-status-reporter.js";

type ResponsibilityRow = typeof responsibilities.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

/** Who writes a report. The server sets it from the caller; it is never read from the body. */
export type StatusReportAuthor = { type: "agent"; agentId: string } | { type: "user"; userId: string };

function entry(row: StatusReportRow): ResponsibilityStatusReportEntry {
  return {
    status: row.status as ResponsibilityStatusReportStatus,
    message: row.message,
    agentId: row.agentId,
    userId: row.userId,
    writtenAt: row.createdAt.toISOString(),
  };
}

function current(row: StatusReportRow | undefined, now: Date): ResponsibilityStatusReportCurrent | null {
  if (!row) return null;
  return { ...entry(row), detail: row.detail, outOfDate: responsibilityStatusReportOutOfDate(row.createdAt, now) };
}

/**
 * Agent-written status for responsibilities (experimental
 * `enableResponsibilities`): the reads (one responsibility, and every active
 * responsibility of an owner in a fixed number of queries), writing a report
 * (the routes check who may), and the owner asking the reporter for an update,
 * which opens a small task for the reporter (origin
 * `responsibility_status_update`, origin id = the responsibility). The
 * reporter rule is `chooseResponsibilityReporter` in packages/shared.
 */
export function responsibilityStatusReportService(db: Db) {
  const settings = instanceSettingsService(db);
  const issuesSvc = issueService(db);

  async function assertEnabled() {
    const experimental = await settings.getExperimental();
    if (experimental.enableResponsibilities !== true) throw responsibilitiesDisabledError();
  }

  async function reporterOf(row: ResponsibilityRow) {
    return (await loadResponsibilityReporters(db, row.companyId, [row])).get(row.id) ?? null;
  }

  async function state(row: ResponsibilityRow, now = new Date()): Promise<ResponsibilityStatusReportState> {
    const [history, reporter, requests] = await Promise.all([
      db.select().from(responsibilityStatusReports)
        .where(and(eq(responsibilityStatusReports.companyId, row.companyId), eq(responsibilityStatusReports.responsibilityId, row.id)))
        .orderBy(desc(responsibilityStatusReports.createdAt), desc(responsibilityStatusReports.id))
        .limit(RESPONSIBILITY_STATUS_REPORT_HISTORY_LIMIT),
      reporterOf(row),
      loadOpenStatusUpdateRequests(db, row.companyId, [row.id]),
    ]);
    return {
      current: current(history[0], now),
      reporterAgentId: reporter?.agentId ?? null,
      updateRequested: updateStillRequested(requests.get(row.id), history[0]),
      history: history.map(entry),
    };
  }

  return {
    assertEnabled,
    state,
    reporterOf,

    /**
     * Every active responsibility of the owner with its current report, its
     * reporter and whether an update is pending. Seven queries whatever the
     * count: the responsibilities, the agents, three for the work under them,
     * the latest reports and the open requests.
     */
    async overview(companyId: string, ownerUserId: string, now = new Date()): Promise<ResponsibilityStatusReportsOverview> {
      const rows = await db.select({ id: responsibilities.id, runByAgentId: responsibilities.runByAgentId })
        .from(responsibilities)
        .where(and(
          eq(responsibilities.companyId, companyId),
          eq(responsibilities.ownerUserId, ownerUserId),
          eq(responsibilities.status, "active"),
        ))
        .orderBy(asc(responsibilities.sortOrder), asc(responsibilities.createdAt), asc(responsibilities.id));
      const ids = rows.map((row) => row.id);
      const [reporters, latest, requests] = await Promise.all([
        loadResponsibilityReporters(db, companyId, rows),
        loadLatestStatusReports(db, companyId, ids),
        loadOpenStatusUpdateRequests(db, companyId, ids),
      ]);
      return {
        ownerUserId,
        freshDays: RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS,
        reports: rows.map((row) => {
          const reporter = reporters.get(row.id) ?? null;
          const report = latest.get(row.id);
          return {
            responsibilityId: row.id,
            current: current(report, now),
            reporterAgentId: reporter?.agentId ?? null,
            reporterBasis: reporter?.basis ?? null,
            updateRequested: updateStillRequested(requests.get(row.id), report),
          };
        }),
      };
    },

    /** An agent may write when it is the reporter or works under the responsibility. */
    async agentMayWrite(row: ResponsibilityRow, agentId: string) {
      const reporter = await reporterOf(row);
      if (reporter?.agentId === agentId) return true;
      return agentWorksUnderResponsibility(db, row, agentId);
    },

    /** Record a report. The route has already decided the author may write it. */
    async write(row: ResponsibilityRow, input: WriteResponsibilityStatusReport, author: StatusReportAuthor) {
      await assertEnabled();
      const data = writeResponsibilityStatusReportSchema.parse(input);
      if (row.status !== "active") {
        throw conflict("Only an active responsibility carries a status", { code: "responsibility_status_not_active" });
      }
      const [created] = await db.insert(responsibilityStatusReports).values({
        companyId: row.companyId,
        responsibilityId: row.id,
        agentId: author.type === "agent" ? author.agentId : null,
        userId: author.type === "user" ? author.userId : null,
        status: data.status,
        message: data.message,
        detail: data.detail ?? null,
      }).returning();
      return created!;
    },

    /**
     * Ask the reporter for an update: a small task assigned to it whose prompt
     * carries the facts and the call. While one is open and unanswered,
     * asking again changes nothing. The route wakes the agent and writes
     * activity.
     */
    async requestUpdate(
      row: ResponsibilityRow,
      actor: { userId: string; runId: string | null; identityContextId: string | null; authorizationActor: AuthorizationActor },
    ): Promise<{ issue: IssueRow | null; created: boolean; agentId: string }> {
      await assertEnabled();
      if (row.status !== "active") {
        throw conflict("Only an active responsibility carries a status", { code: "responsibility_status_not_active" });
      }
      const reporter = await reporterOf(row);
      if (!reporter) {
        throw unprocessable("No agent in this organization can take work, so nobody can write this status; write it yourself", {
          code: "responsibility_status_no_agent",
        });
      }
      const [requests, latest] = await Promise.all([
        loadOpenStatusUpdateRequests(db, row.companyId, [row.id]),
        loadLatestStatusReports(db, row.companyId, [row.id]),
      ]);
      const open = requests.get(row.id);
      if (open && updateStillRequested(open, latest.get(row.id))) {
        return { issue: null, created: false, agentId: open.agentId ?? reporter.agentId };
      }
      const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, row.companyId));
      const backLink = company ? `[Back to ${row.title}](/${company.issuePrefix}/responsibilities/${row.id})` : null;
      const description = [
        `Where does **${row.title}** stand? Look at the work under it and write its status: behind, at risk or on track, with one plain line saying why.`,
        ...(backLink ? ["", backLink] : []),
      ].join("\n");
      const issue = await issuesSvc.create(row.companyId, {
        title: `Status update: ${row.title}`.slice(0, 200),
        description,
        status: "todo",
        priority: "low",
        assigneeAgentId: reporter.agentId,
        originKind: RESPONSIBILITY_STATUS_UPDATE_ORIGIN_KIND,
        originId: row.id,
        createdByUserId: actor.userId,
        createdByAgentId: null,
        trustExplicitResponsibleUserId: true,
        workspaceSelectionActor: actor.authorizationActor,
        originRunId: actor.runId,
        originIdentityContextId: actor.identityContextId,
        actorRunId: actor.runId,
      });
      return { issue: issue as unknown as IssueRow, created: true, agentId: reporter.agentId };
    },

    assertCanBeWrittenBy(author: StatusReportAuthor, allowed: boolean) {
      if (!allowed) {
        throw forbidden(author.type === "agent"
          ? "Only the agent that reports on this responsibility, or an agent working under it, can write its status"
          : "Only the person who owns this responsibility, or a company admin, can write its status");
      }
    },
  };
}
