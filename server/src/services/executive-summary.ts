import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { createRequire } from "node:module";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyKpis,
  companyMemberships,
  costEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { CompanyKpi, CompanyKpiInput, ExecutiveSummary, ExecutiveSummarySendStatus } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { instanceSettingsService } from "./instance-settings.js";

const ISSUE_TRANSITION_TARGET_STATUSES = new Set(["blocked", "in_progress", "done"]);
const FAILED_RUN_STATUSES = ["failed", "timed_out"] as const;

type CompanyDispatchRow = {
  id: string;
  name: string;
  dailyExecutiveSummaryEnabled: boolean;
  dailyExecutiveSummaryLastSentAt: Date | null;
  dailyExecutiveSummaryLastStatus: string | null;
  dailyExecutiveSummaryLastError: string | null;
};

type DispatchResult =
  | "not_due"
  | "already_done"
  | "disabled"
  | "sent"
  | "failed"
  | "skipped";

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function scheduledSendAtForDay(now: Date, hour: number, minute: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
}

function truncate(value: string, max = 500): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toExecutiveSummaryStatus(value: string | null): ExecutiveSummarySendStatus | null {
  if (value === "ok" || value === "failed" || value === "skipped") return value;
  return null;
}

function alreadyCompletedForToday(company: CompanyDispatchRow, now: Date): boolean {
  const status = toExecutiveSummaryStatus(company.dailyExecutiveSummaryLastStatus);
  if (!company.dailyExecutiveSummaryLastSentAt || (status !== "ok" && status !== "skipped")) {
    return false;
  }
  return company.dailyExecutiveSummaryLastSentAt >= startOfLocalDay(now);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSummaryText(summary: ExecutiveSummary): string {
  const lines: string[] = [];
  lines.push(`${summary.companyName} — Daily Executive Summary`);
  lines.push(`Generated: ${new Date(summary.generatedAt).toLocaleString()}`);
  lines.push("");

  lines.push("Manual KPIs");
  if (summary.manualKpis.length === 0) {
    lines.push("- No manual KPIs published.");
  } else {
    for (const kpi of summary.manualKpis) {
      const note = kpi.note ? ` (${kpi.note})` : "";
      lines.push(`- ${kpi.label}: ${kpi.value} [${kpi.trend}]${note}`);
    }
  }
  lines.push("");

  lines.push("Computed Snapshot");
  lines.push(`- Month spend: ${summary.computedKpis.monthSpendCents} cents`);
  lines.push(`- Month budget: ${summary.computedKpis.monthBudgetCents} cents`);
  lines.push(`- Utilization: ${summary.computedKpis.monthUtilizationPercent}%`);
  lines.push(
    `- Tasks: open ${summary.computedKpis.tasksOpen}, in_progress ${summary.computedKpis.tasksInProgress}, blocked ${summary.computedKpis.tasksBlocked}, done ${summary.computedKpis.tasksDone}`,
  );
  lines.push(`- Pending approvals: ${summary.computedKpis.pendingApprovals}`);
  lines.push(
    `- Budget incidents: ${summary.computedKpis.activeBudgetIncidents} (paused agents ${summary.computedKpis.pausedAgents}, paused projects ${summary.computedKpis.pausedProjects})`,
  );
  lines.push("");

  lines.push("Top Changes (24h)");
  if (summary.topChanges.issueTransitions.length === 0) {
    lines.push("- No notable issue transitions.");
  } else {
    for (const transition of summary.topChanges.issueTransitions) {
      const identifier = transition.issueIdentifier ? `${transition.issueIdentifier} ` : "";
      const from = transition.fromStatus ?? "unknown";
      lines.push(
        `- ${identifier}${transition.issueTitle}: ${from} -> ${transition.toStatus} (${new Date(transition.updatedAt).toLocaleString()})`,
      );
    }
  }
  if (summary.topChanges.failedRuns.length === 0) {
    lines.push("- No failed/timed-out runs.");
  } else {
    for (const run of summary.topChanges.failedRuns) {
      lines.push(
        `- Failed run ${run.runId} (${run.agentName ?? run.agentId}) [${run.status}]${run.error ? `: ${run.error}` : ""}`,
      );
    }
  }
  lines.push(`- Pending approvals snapshot: ${summary.topChanges.pendingApprovals}`);
  lines.push("");
  lines.push("Generated by Paperclip.");

  return lines.join("\n");
}

function renderSummaryHtml(summary: ExecutiveSummary): string {
  const manualKpis = summary.manualKpis.length === 0
    ? "<li>No manual KPIs published.</li>"
    : summary.manualKpis
      .map((kpi) => {
        const note = kpi.note ? ` <span style="color:#6b7280">(${escapeHtml(kpi.note)})</span>` : "";
        return `<li><strong>${escapeHtml(kpi.label)}:</strong> ${escapeHtml(kpi.value)} <span style="color:#6b7280">[${escapeHtml(kpi.trend)}]</span>${note}</li>`;
      })
      .join("");
  const issueTransitions = summary.topChanges.issueTransitions.length === 0
    ? "<li>No notable issue transitions.</li>"
    : summary.topChanges.issueTransitions
      .map((transition) => {
        const identifier = transition.issueIdentifier ? `${escapeHtml(transition.issueIdentifier)} ` : "";
        const from = transition.fromStatus ?? "unknown";
        return `<li>${identifier}${escapeHtml(transition.issueTitle)}: ${escapeHtml(from)} &rarr; ${escapeHtml(transition.toStatus)} (${escapeHtml(new Date(transition.updatedAt).toLocaleString())})</li>`;
      })
      .join("");
  const failedRuns = summary.topChanges.failedRuns.length === 0
    ? "<li>No failed/timed-out runs.</li>"
    : summary.topChanges.failedRuns
      .map((run) => {
        const who = run.agentName ?? run.agentId;
        const suffix = run.error ? `: ${escapeHtml(run.error)}` : "";
        return `<li>${escapeHtml(run.runId)} (${escapeHtml(who)}) [${escapeHtml(run.status)}]${suffix}</li>`;
      })
      .join("");

  return `
<div style="font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; line-height: 1.45;">
  <h2 style="margin: 0 0 8px;">${escapeHtml(summary.companyName)} — Daily Executive Summary</h2>
  <p style="margin: 0 0 16px; color: #6b7280;">Generated ${escapeHtml(new Date(summary.generatedAt).toLocaleString())}</p>

  <h3 style="margin: 16px 0 8px;">Manual KPIs</h3>
  <ul style="margin-top: 0;">${manualKpis}</ul>

  <h3 style="margin: 16px 0 8px;">Computed Snapshot</h3>
  <ul style="margin-top: 0;">
    <li>Month spend: <strong>${summary.computedKpis.monthSpendCents}</strong> cents</li>
    <li>Month budget: <strong>${summary.computedKpis.monthBudgetCents}</strong> cents</li>
    <li>Utilization: <strong>${summary.computedKpis.monthUtilizationPercent}%</strong></li>
    <li>Tasks: open ${summary.computedKpis.tasksOpen}, in_progress ${summary.computedKpis.tasksInProgress}, blocked ${summary.computedKpis.tasksBlocked}, done ${summary.computedKpis.tasksDone}</li>
    <li>Pending approvals: <strong>${summary.computedKpis.pendingApprovals}</strong></li>
    <li>Budget incidents: <strong>${summary.computedKpis.activeBudgetIncidents}</strong> (paused agents ${summary.computedKpis.pausedAgents}, paused projects ${summary.computedKpis.pausedProjects})</li>
  </ul>

  <h3 style="margin: 16px 0 8px;">Top Changes (24h)</h3>
  <ul style="margin-top: 0;">${issueTransitions}</ul>
  <ul style="margin-top: 0;">${failedRuns}</ul>
  <p style="margin: 8px 0 0;">Pending approvals snapshot: <strong>${summary.topChanges.pendingApprovals}</strong></p>
</div>
`.trim();
}

type MailSender = {
  sendMail(input: {
    to: string[];
    replyTo?: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void>;
};

async function importNodemailer() {
  const require = createRequire(import.meta.url);
  return require("nodemailer");
}

async function createSmtpSenderFromEnv(): Promise<MailSender | null> {
  const host = process.env.PAPERCLIP_SMTP_HOST?.trim();
  const from = process.env.PAPERCLIP_SMTP_FROM?.trim();
  if (!host || !from) return null;

  const portRaw = process.env.PAPERCLIP_SMTP_PORT?.trim();
  const secureRaw = process.env.PAPERCLIP_SMTP_SECURE?.trim().toLowerCase();
  const user = process.env.PAPERCLIP_SMTP_USER?.trim();
  const pass = process.env.PAPERCLIP_SMTP_PASS?.trim();
  const port = portRaw ? Number(portRaw) : 587;
  const secure = secureRaw === "true" || secureRaw === "1";
  const replyTo = process.env.PAPERCLIP_SMTP_REPLY_TO?.trim() || undefined;

  const nodemailer = await importNodemailer();
  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });

  return {
    sendMail: async ({ to, subject, text, html }) => {
      await transporter.sendMail({
        from,
        to,
        replyTo,
        subject,
        text,
        html,
      });
    },
  };
}

export function executiveSummaryService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const serviceLogger = logger.child({ service: "executive-summary" });
  let senderPromise: Promise<MailSender | null> | null = null;
  let tickInProgress = false;

  async function getSender() {
    if (!senderPromise) {
      senderPromise = createSmtpSenderFromEnv().catch((err) => {
        serviceLogger.error({ err }, "failed to initialize SMTP sender");
        return null;
      });
    }
    return senderPromise;
  }

  async function listKpis(companyId: string, database: Db | any = db): Promise<CompanyKpi[]> {
    return database
      .select()
      .from(companyKpis)
      .where(eq(companyKpis.companyId, companyId))
      .orderBy(companyKpis.position, companyKpis.createdAt);
  }

  async function replaceKpis(
    companyId: string,
    kpis: CompanyKpiInput[],
    actor: { userId?: string | null; agentId?: string | null },
  ): Promise<CompanyKpi[]> {
    return db.transaction(async (tx) => {
      await tx.delete(companyKpis).where(eq(companyKpis.companyId, companyId));
      if (kpis.length > 0) {
        await tx.insert(companyKpis).values(
          kpis.map((kpi, index) => ({
            companyId,
            label: kpi.label.trim(),
            value: kpi.value.trim(),
            trend: kpi.trend,
            note: kpi.note?.trim() || null,
            position: index,
            updatedByUserId: actor.userId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            updatedAt: new Date(),
          })),
        );
      }
      return listKpis(companyId, tx as unknown as Db);
    });
  }

  async function resolveRecipientEmails(companyId: string, database: Db | any = db): Promise<string[]> {
    const rows = await database
      .select({ email: authUsers.email })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          isNotNull(authUsers.email),
        ),
      );

    const deduped = new Map<string, string>();
    for (const row of rows) {
      const email = row.email.trim();
      if (!email) continue;
      deduped.set(email.toLowerCase(), email);
    }
    return [...deduped.values()];
  }

  async function buildExecutiveSummary(companyId: string, now: Date = new Date(), database: Db | any = db): Promise<ExecutiveSummary> {
    const company = await database
      .select({
        id: companies.id,
        name: companies.name,
        budgetMonthlyCents: companies.budgetMonthlyCents,
        dailyExecutiveSummaryEnabled: companies.dailyExecutiveSummaryEnabled,
        dailyExecutiveSummaryLastSentAt: companies.dailyExecutiveSummaryLastSentAt,
        dailyExecutiveSummaryLastStatus: companies.dailyExecutiveSummaryLastStatus,
        dailyExecutiveSummaryLastError: companies.dailyExecutiveSummaryLastError,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows: Array<any>) => rows[0] ?? null);

    if (!company) throw notFound("Company not found");

    const periodEnd = now;
    const periodStart = new Date(now.getTime() - (24 * 60 * 60 * 1000));

    const [manualKpis, taskRows, monthSpendRow, pendingApprovals, budgetOverview, recipients, transitionRows, failedRuns] =
      await Promise.all([
        listKpis(companyId, database),
        database
          .select({ status: issues.status, count: sql<number>`count(*)` })
          .from(issues)
          .where(eq(issues.companyId, companyId))
          .groupBy(issues.status),
        database
          .select({ monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
          .from(costEvents)
          .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, startOfLocalMonth(now))))
          .then((rows: Array<{ monthSpend: number }>) => rows[0] ?? { monthSpend: 0 }),
        database
          .select({ count: sql<number>`count(*)` })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
          .then((rows: Array<{ count: number }>) => Number(rows[0]?.count ?? 0)),
        budgetService(database as Db).overview(companyId),
        resolveRecipientEmails(companyId, database),
        database
          .select({
            issueId: activityLog.entityId,
            updatedAt: activityLog.createdAt,
            details: activityLog.details,
          })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.action, "issue.updated"),
              gte(activityLog.createdAt, periodStart),
            ),
          )
          .orderBy(desc(activityLog.createdAt))
          .limit(100),
        database
          .select({
            runId: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            agentName: agents.name,
            status: heartbeatRuns.status,
            error: heartbeatRuns.error,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
          })
          .from(heartbeatRuns)
          .leftJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.status, FAILED_RUN_STATUSES as unknown as string[]),
              sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${periodStart.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`))
          .limit(3),
      ]);

    const taskCounts: Record<string, number> = {
      open: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
    };
    for (const row of taskRows) {
      const count = Number(row.count ?? 0);
      if (row.status === "in_progress") taskCounts.inProgress += count;
      if (row.status === "blocked") taskCounts.blocked += count;
      if (row.status === "done") taskCounts.done += count;
      if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
    }

    const issueTransitionsRaw: Array<{
      issueId: string;
      toStatus: string;
      fromStatus: string | null;
      updatedAt: Date;
    }> = [];
    const seenIssueIds = new Set<string>();
    for (const row of transitionRows) {
      if (issueTransitionsRaw.length >= 5) break;
      const details = (row.details ?? null) as Record<string, unknown> | null;
      const toStatus = typeof details?.status === "string" ? details.status : null;
      if (!toStatus || !ISSUE_TRANSITION_TARGET_STATUSES.has(toStatus)) continue;
      if (seenIssueIds.has(row.issueId)) continue;
      const previous = details?._previous;
      const fromStatus =
        previous && typeof previous === "object" && typeof (previous as Record<string, unknown>).status === "string"
          ? ((previous as Record<string, unknown>).status as string)
          : null;
      issueTransitionsRaw.push({
        issueId: row.issueId,
        toStatus,
        fromStatus,
        updatedAt: row.updatedAt,
      });
      seenIssueIds.add(row.issueId);
    }

    const issueIdsForLookup = [...new Set(issueTransitionsRaw.map((item) => item.issueId).filter((value) => isUuid(value)))];
    const issueMetaById = issueIdsForLookup.length > 0
      ? await database
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIdsForLookup))
        .then((rows: Array<{ id: string; identifier: string; title: string }>) => new Map(rows.map((row) => [row.id, row])))
      : new Map<string, { id: string; identifier: string; title: string }>();

    const monthSpendCents = Number(monthSpendRow.monthSpend ?? 0);
    const utilizationPercent =
      company.budgetMonthlyCents > 0
        ? Number(((monthSpendCents / company.budgetMonthlyCents) * 100).toFixed(2))
        : 0;

    return {
      companyId: company.id,
      companyName: company.name,
      generatedAt: now,
      periodStart,
      periodEnd,
      manualKpis,
      computedKpis: {
        monthSpendCents,
        monthBudgetCents: company.budgetMonthlyCents,
        monthUtilizationPercent: utilizationPercent,
        tasksOpen: taskCounts.open,
        tasksInProgress: taskCounts.inProgress,
        tasksBlocked: taskCounts.blocked,
        tasksDone: taskCounts.done,
        pendingApprovals,
        activeBudgetIncidents: budgetOverview.activeIncidents.length,
        pausedAgents: budgetOverview.pausedAgentCount,
        pausedProjects: budgetOverview.pausedProjectCount,
      },
      topChanges: {
        issueTransitions: issueTransitionsRaw.map((row) => {
          const meta = issueMetaById.get(row.issueId);
          return {
            issueId: row.issueId,
            issueIdentifier: meta?.identifier ?? null,
            issueTitle: meta?.title ?? row.issueId,
            fromStatus: row.fromStatus as any,
            toStatus: row.toStatus as any,
            updatedAt: row.updatedAt,
          };
        }),
        failedRuns: failedRuns.map((run: {
          runId: string;
          agentId: string;
          agentName: string | null;
          status: string;
          error: string | null;
          startedAt: Date | null;
          finishedAt: Date | null;
        }) => ({
          runId: run.runId,
          agentId: run.agentId,
          agentName: run.agentName ?? null,
          status: run.status as any,
          error: run.error ? truncate(run.error, 280) : null,
          startedAt: run.startedAt ?? null,
          finishedAt: run.finishedAt ?? null,
        })),
        pendingApprovals,
      },
      dispatch: {
        enabled: company.dailyExecutiveSummaryEnabled,
        lastSentAt: company.dailyExecutiveSummaryLastSentAt,
        lastStatus: toExecutiveSummaryStatus(company.dailyExecutiveSummaryLastStatus),
        lastError: company.dailyExecutiveSummaryLastError,
        recipients,
      },
    };
  }

  async function dispatchForCompany(
    tx: Db | any,
    companyId: string,
    hour: number,
    minute: number,
    now: Date,
  ): Promise<DispatchResult> {
    await tx.execute(sql`select ${companies.id} from ${companies} where ${companies.id} = ${companyId} for update`);
    const company = await tx
      .select({
        id: companies.id,
        name: companies.name,
        dailyExecutiveSummaryEnabled: companies.dailyExecutiveSummaryEnabled,
        dailyExecutiveSummaryLastSentAt: companies.dailyExecutiveSummaryLastSentAt,
        dailyExecutiveSummaryLastStatus: companies.dailyExecutiveSummaryLastStatus,
        dailyExecutiveSummaryLastError: companies.dailyExecutiveSummaryLastError,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows: Array<CompanyDispatchRow>) => rows[0] ?? null);

    if (!company || !company.dailyExecutiveSummaryEnabled) return "disabled";

    const scheduledAt = scheduledSendAtForDay(now, hour, minute);
    if (now < scheduledAt) return "not_due";
    if (alreadyCompletedForToday(company, now)) return "already_done";

    const summary = await buildExecutiveSummary(companyId, now, tx as Db);
    if (summary.dispatch.recipients.length === 0) {
      const error = "No eligible recipient emails for this company.";
      serviceLogger.warn({ companyId }, "skipping executive summary send: no eligible recipients");
      await tx
        .update(companies)
        .set({
          dailyExecutiveSummaryLastSentAt: now,
          dailyExecutiveSummaryLastStatus: "skipped",
          dailyExecutiveSummaryLastError: error,
          updatedAt: now,
        })
        .where(eq(companies.id, company.id));
      await logActivity(tx as Db, {
        companyId,
        actorType: "system",
        actorId: "executive-summary-scheduler",
        action: "executive_summary.skipped_no_recipients",
        entityType: "company",
        entityId: companyId,
        details: { reason: error },
      });
      return "skipped";
    }

    const sender = await getSender();
    if (!sender) {
      const error = "SMTP transport is not configured.";
      await tx
        .update(companies)
        .set({
          dailyExecutiveSummaryLastSentAt: now,
          dailyExecutiveSummaryLastStatus: "failed",
          dailyExecutiveSummaryLastError: error,
          updatedAt: now,
        })
        .where(eq(companies.id, company.id));
      await logActivity(tx as Db, {
        companyId,
        actorType: "system",
        actorId: "executive-summary-scheduler",
        action: "executive_summary.failed",
        entityType: "company",
        entityId: companyId,
        details: { error },
      });
      return "failed";
    }

    const dateLabel = now.toISOString().slice(0, 10);
    try {
      await sender.sendMail({
        to: summary.dispatch.recipients,
        subject: `${summary.companyName} · Daily Executive Summary · ${dateLabel}`,
        text: renderSummaryText(summary),
        html: renderSummaryHtml(summary),
      });

      await tx
        .update(companies)
        .set({
          dailyExecutiveSummaryLastSentAt: now,
          dailyExecutiveSummaryLastStatus: "ok",
          dailyExecutiveSummaryLastError: null,
          updatedAt: now,
        })
        .where(eq(companies.id, company.id));
      await logActivity(tx as Db, {
        companyId,
        actorType: "system",
        actorId: "executive-summary-scheduler",
        action: "executive_summary.sent",
        entityType: "company",
        entityId: companyId,
        details: {
          recipientCount: summary.dispatch.recipients.length,
          recipients: summary.dispatch.recipients,
          periodStart: summary.periodStart.toISOString(),
          periodEnd: summary.periodEnd.toISOString(),
        },
      });
      return "sent";
    } catch (error) {
      const errorMessage = error instanceof Error ? truncate(error.message, 500) : "Unknown SMTP error";
      await tx
        .update(companies)
        .set({
          dailyExecutiveSummaryLastSentAt: now,
          dailyExecutiveSummaryLastStatus: "failed",
          dailyExecutiveSummaryLastError: errorMessage,
          updatedAt: now,
        })
        .where(eq(companies.id, company.id));
      await logActivity(tx as Db, {
        companyId,
        actorType: "system",
        actorId: "executive-summary-scheduler",
        action: "executive_summary.failed",
        entityType: "company",
        entityId: companyId,
        details: { error: errorMessage },
      });
      return "failed";
    }
  }

  return {
    listKpis,
    replaceKpis,
    buildExecutiveSummary,
    tickDaily: async (now: Date = new Date()) => {
      if (tickInProgress) {
        return {
          processed: 0,
          sent: 0,
          failed: 0,
          skipped: 0,
          notDue: 0,
          alreadyDone: 0,
          disabled: 0,
        };
      }

      tickInProgress = true;
      try {
        const generalSettings = await instanceSettings.getGeneral();
        const scheduledAt = scheduledSendAtForDay(
          now,
          generalSettings.dailyExecutiveSummarySendHour,
          generalSettings.dailyExecutiveSummarySendMinute,
        );
        if (now < scheduledAt) {
          return {
            processed: 0,
            sent: 0,
            failed: 0,
            skipped: 0,
            notDue: 0,
            alreadyDone: 0,
            disabled: 0,
          };
        }

        const enabledCompanyRows = await db
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.dailyExecutiveSummaryEnabled, true));

        let sent = 0;
        let failed = 0;
        let skipped = 0;
        let notDue = 0;
        let alreadyDone = 0;
        let disabled = 0;

        for (const row of enabledCompanyRows) {
          const result = await db.transaction((tx) =>
            dispatchForCompany(
              tx as unknown as Db,
              row.id,
              generalSettings.dailyExecutiveSummarySendHour,
              generalSettings.dailyExecutiveSummarySendMinute,
              now,
            ),
          );
          if (result === "sent") sent += 1;
          if (result === "failed") failed += 1;
          if (result === "skipped") skipped += 1;
          if (result === "not_due") notDue += 1;
          if (result === "already_done") alreadyDone += 1;
          if (result === "disabled") disabled += 1;
        }

        return {
          processed: enabledCompanyRows.length,
          sent,
          failed,
          skipped,
          notDue,
          alreadyDone,
          disabled,
        };
      } finally {
        tickInProgress = false;
      }
    },
  };
}
