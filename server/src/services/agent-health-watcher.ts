import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agents, issues } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_ERROR_THRESHOLD_MS = 5 * 60 * 1_000;
const DEFAULT_ALERT_ISSUE_IDENTIFIER = "GST-26";
const RECOVERY_STATUSES = new Set(["idle", "running", "active"]);

interface OpenAlert {
  issueId: string;
  alertedAt: Date;
  errorSince: Date;
}

function formatDuration(durationMs: number): string {
  const minutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes % 60}m`;
}

export function createAgentHealthWatcher(
  db: Db,
  opts?: {
    pollIntervalMs?: number;
    errorThresholdMs?: number;
    alertIssueIdentifier?: string;
    now?: () => Date;
  },
) {
  const pollIntervalMs = Math.max(1_000, opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const errorThresholdMs = Math.max(60_000, opts?.errorThresholdMs ?? DEFAULT_ERROR_THRESHOLD_MS);
  const alertIssueIdentifier = (opts?.alertIssueIdentifier ?? DEFAULT_ALERT_ISSUE_IDENTIFIER).trim();
  const now = opts?.now ?? (() => new Date());
  const issueSvc = issueService(db);
  const openAlertsByAgentId = new Map<string, OpenAlert>();

  async function tick() {
    const currentTime = now();
    const errorAgents = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        role: agents.role,
        status: agents.status,
        pauseReason: agents.pauseReason,
        updatedAt: agents.updatedAt,
        lastError: agentRuntimeState.lastError,
      })
      .from(agents)
      .leftJoin(
        agentRuntimeState,
        and(eq(agentRuntimeState.agentId, agents.id), eq(agentRuntimeState.companyId, agents.companyId)),
      )
      .where(eq(agents.status, "error"));

    const alertIssueByCompanyId = new Map<string, string>();
    const companyIds = [...new Set(errorAgents.map((agent) => agent.companyId))];
    if (companyIds.length > 0) {
      const alertIssues = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(and(inArray(issues.companyId, companyIds), eq(issues.identifier, alertIssueIdentifier)));
      for (const row of alertIssues) {
        alertIssueByCompanyId.set(row.companyId, row.id);
      }
    }

    for (const agent of errorAgents) {
      if (openAlertsByAgentId.has(agent.id)) continue;

      const errorSince = agent.updatedAt;
      const errorDurationMs = currentTime.getTime() - errorSince.getTime();
      if (errorDurationMs < errorThresholdMs) continue;

      const issueId = alertIssueByCompanyId.get(agent.companyId);
      if (!issueId) continue;

      const errorText = agent.lastError?.trim() || agent.pauseReason?.trim() || "(no error detail available)";
      const duration = formatDuration(Math.max(0, errorDurationMs));
      const body = [
        "Adapter health alert",
        "",
        `- Agent: ${agent.name} (${agent.role})`,
        `- Error detail: ${errorText}`,
        `- Duration in error: ${duration}`,
        `- Agent link: [Open agent](/agents/${agent.id})`,
      ].join("\n");

      await issueSvc.addComment(issueId, body, {}, { authorType: "system" });
      openAlertsByAgentId.set(agent.id, { issueId, alertedAt: currentTime, errorSince });
    }

    if (openAlertsByAgentId.size === 0) return;

    const alertedAgentIds = [...openAlertsByAgentId.keys()];
    const agentStatuses = await db
      .select({ id: agents.id, status: agents.status, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, alertedAgentIds));
    const statusByAgentId = new Map(agentStatuses.map((agent) => [agent.id, agent]));

    for (const agentId of alertedAgentIds) {
      const openAlert = openAlertsByAgentId.get(agentId);
      if (!openAlert) continue;

      const agent = statusByAgentId.get(agentId);
      if (!agent) {
        openAlertsByAgentId.delete(agentId);
        continue;
      }
      if (!RECOVERY_STATUSES.has(agent.status)) continue;

      await issueSvc.addComment(
        openAlert.issueId,
        `Adapter health recovered: ${agent.name} is now ${agent.status}.`,
        {},
        { authorType: "system" },
      );
      openAlertsByAgentId.delete(agentId);
    }
  }

  function start() {
    const timer = setInterval(() => {
      void tick().catch((err) => {
        logger.warn({ err }, "agent health watcher tick failed");
      });
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }

  return { tick, start };
}
