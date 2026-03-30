import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import type { InstanceExperimentalSettings } from "@paperclipai/shared";
import { and, inArray, isNull } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

let lastDailyReportUtcDay: string | null = null;
const lastPriorityAlertDay = new Map<string, string>();

export function idleThresholdHours(
  priority: string,
  settings: InstanceExperimentalSettings,
): number {
  switch (priority) {
    case "critical":
      return settings.staleIssueIdleHoursCritical;
    case "high":
      return settings.staleIssueIdleHoursHigh;
    case "medium":
      return settings.staleIssueIdleHoursMedium;
    default:
      return settings.staleIssueIdleHoursLow;
  }
}

export function computeIdleHours(updatedAt: Date, now: Date): number {
  return Math.max(0, (now.getTime() - updatedAt.getTime()) / 3600000);
}

export function staleIssueMonitorService(db: Db) {
  return {
    async tick(now: Date): Promise<void> {
      const settings = await instanceSettingsService(db).getExperimental();
      if (!settings.staleIssueMonitorEnabled) {
        return;
      }

      const rows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.status, [...OPEN_STATUSES]),
            isNull(issues.hiddenAt),
            isNull(issues.completedAt),
            isNull(issues.cancelledAt),
          ),
        );

      const agentIds = [...new Set(rows.map((r) => r.assigneeAgentId).filter(Boolean))] as string[];
      const agentRows =
        agentIds.length === 0
          ? []
          : await db
              .select({ id: agents.id, name: agents.name })
              .from(agents)
              .where(inArray(agents.id, agentIds));
      const agentNameById = new Map(agentRows.map((a) => [a.id, a.name]));

      type StaleRow = (typeof rows)[number] & { idleHours: number; threshold: number };
      const stale: StaleRow[] = [];
      for (const row of rows) {
        const threshold = idleThresholdHours(row.priority, settings);
        const idleHours = computeIdleHours(row.updatedAt, now);
        if (idleHours >= threshold) {
          stale.push({ ...row, idleHours, threshold });
        }
      }

      const staleIds = new Set(stale.map((s) => s.id));
      for (const id of lastPriorityAlertDay.keys()) {
        if (!staleIds.has(id)) {
          lastPriorityAlertDay.delete(id);
        }
      }

      const todayUtc = now.toISOString().slice(0, 10);
      for (const row of stale) {
        if (row.priority !== "critical" && row.priority !== "high") {
          continue;
        }
        if (lastPriorityAlertDay.get(row.id) === todayUtc) {
          continue;
        }
        lastPriorityAlertDay.set(row.id, todayUtc);
        logger.warn(
          {
            issueId: row.id,
            companyId: row.companyId,
            identifier: row.identifier,
            priority: row.priority,
            status: row.status,
            idleHours: Math.round(row.idleHours * 10) / 10,
            thresholdHours: row.threshold,
          },
          "Stale open issue exceeded priority idle threshold",
        );
        await logActivity(db, {
          companyId: row.companyId,
          actorType: "system",
          actorId: "stale-issue-monitor",
          action: "stale_issue.priority_alert",
          entityType: "issue",
          entityId: row.id,
          details: {
            identifier: row.identifier,
            title: row.title,
            priority: row.priority,
            status: row.status,
            idleHours: Math.round(row.idleHours * 10) / 10,
            thresholdHours: row.threshold,
          },
        });
      }

      const ymd = todayUtc;
      if (now.getUTCHours() < 6) {
        return;
      }
      if (lastDailyReportUtcDay === ymd) {
        return;
      }

      lastDailyReportUtcDay = ymd;

      if (stale.length === 0) {
        return;
      }

      const byCompany = new Map<string, StaleRow[]>();
      for (const s of stale) {
        const list = byCompany.get(s.companyId) ?? [];
        list.push(s);
        byCompany.set(s.companyId, list);
      }

      for (const [companyId, companyStale] of byCompany) {
        const groups = new Map<
          string,
          { ownerKey: string; ownerLabel: string; status: string; count: number; maxIdleHours: number }
        >();
        for (const row of companyStale) {
          const ownerKey = row.assigneeAgentId
            ? `agent:${row.assigneeAgentId}`
            : row.assigneeUserId
              ? `user:${row.assigneeUserId}`
              : "unassigned";
          const ownerLabel = row.assigneeAgentId
            ? `Agent ${agentNameById.get(row.assigneeAgentId) ?? row.assigneeAgentId}`
            : row.assigneeUserId
              ? `User ${row.assigneeUserId}`
              : "Unassigned";
          const gk = `${ownerKey}|${row.status}`;
          const existing = groups.get(gk);
          if (existing) {
            existing.count += 1;
            existing.maxIdleHours = Math.max(existing.maxIdleHours, row.idleHours);
          } else {
            groups.set(gk, {
              ownerKey,
              ownerLabel,
              status: row.status,
              count: 1,
              maxIdleHours: row.idleHours,
            });
          }
        }

        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "stale-issue-monitor",
          action: "stale_issue.daily_report",
          entityType: "company",
          entityId: companyId,
          details: {
            reportDateUtc: ymd,
            staleCount: companyStale.length,
            groups: [...groups.values()].sort((a, b) => b.maxIdleHours - a.maxIdleHours),
          },
        });
      }

      logger.info(
        {
          reportDateUtc: ymd,
          totalStale: stale.length,
          companies: byCompany.size,
        },
        "Stale-issue daily report emitted",
      );
    },
  };
}
