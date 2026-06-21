import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, companySecretBindings, companySecrets, heartbeatRuns, issues, routines, routineTriggers } from "@paperclipai/db";
import type { CeoControlRoomStatus, CeoControlRoomCategoryKey, CeoControlRoomSourceStatus } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { dashboardService } from "./dashboard.js";

const DEFAULT_EXTERNAL_TIMEOUT_MS = 1_500;
const STALE_RUNNING_RUN_MS = 15 * 60 * 1000;
const SOURCE_UNAVAILABLE_CATEGORY = "worker_offline" as const;

interface ExternalProbe {
  key: string;
  label: string;
  url: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (value?.trim()) return value.trim().replace(/\/+$/, "");
  }
  return null;
}

function parseJsonMaybe(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value.slice(0, 2_000);
  }
}

function sourceStatus(
  key: string,
  label: string,
  state: CeoControlRoomSourceStatus["state"],
  details?: unknown,
  error?: string,
): CeoControlRoomSourceStatus {
  return {
    key,
    label,
    state,
    checkedAt: new Date().toISOString(),
    ...(details === undefined ? {} : { details }),
    ...(error ? { error } : {}),
  };
}

async function probeJsonSource(probe: ExternalProbe): Promise<CeoControlRoomSourceStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_EXTERNAL_TIMEOUT_MS);
  try {
    const response = await fetch(probe.url, { signal: controller.signal });
    const text = await response.text();
    const details = parseJsonMaybe(text);
    if (!response.ok) {
      return sourceStatus(probe.key, probe.label, "unavailable", details, `HTTP ${response.status}`);
    }
    return sourceStatus(probe.key, probe.label, "ok", details);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sourceStatus(probe.key, probe.label, "unavailable", undefined, message);
  } finally {
    clearTimeout(timeout);
  }
}

async function readVastOwnershipFiles(): Promise<CeoControlRoomSourceStatus> {
  const configured = process.env.PAPERCLIP_VAST_OWNERSHIP_FILES
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
  const candidates = configured.length > 0
    ? configured
    : [
      "/root/cps/.vast-ownership.json",
      "/root/cps/vast-ownership.json",
      "/root/cps/var/vast-ownership.json",
      "/root/cli/micro-addon/vast-ownership.json",
    ];

  const found: Array<{ path: string; parsed: unknown }> = [];
  const missing: string[] = [];
  for (const candidate of candidates) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      found.push({ path: candidate, parsed: parseJsonMaybe(text) });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") missing.push(candidate);
      else return sourceStatus("vast_ownership", "Vast ownership files", "unavailable", { candidate }, err instanceof Error ? err.message : String(err));
    }
  }

  if (found.length === 0) {
    return sourceStatus("vast_ownership", "Vast ownership files", "not_configured", { checkedPaths: missing });
  }
  return sourceStatus("vast_ownership", "Vast ownership files", "ok", { files: found });
}

async function pathStatus(key: string, label: string, candidates: string[]): Promise<CeoControlRoomSourceStatus> {
  const checked: Array<{ path: string; status: "ok" | "missing" | "unreadable"; mtime?: string; type?: string; error?: string }> = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      checked.push({
        path: candidate,
        status: "ok",
        mtime: stat.mtime.toISOString(),
        type: stat.isDirectory() ? "directory" : "file",
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      checked.push({
        path: candidate,
        status: code === "ENOENT" ? "missing" : "unreadable",
        error: code === "ENOENT" ? undefined : err instanceof Error ? err.message : String(err),
      });
    }
  }

  const found = checked.filter((entry) => entry.status === "ok");
  if (found.length === 0) return sourceStatus(key, label, "not_configured", { checked });
  return sourceStatus(key, label, "ok", { checked, found });
}

async function localWorkerProcessStatus(): Promise<CeoControlRoomSourceStatus> {
  const procRoot = "/proc";
  const patterns = ["/root/cps", "cps worker", "cps-worker", "run_gptl.py", "micro-addon/kernel.py"];
  const matches: Array<{ pid: number; cmdline: string }> = [];

  try {
    const entries = await fs.readdir(procRoot, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const raw = await fs.readFile(`${procRoot}/${entry.name}/cmdline`, "utf8");
          const cmdline = raw.replace(/\0/g, " ").trim();
          if (!cmdline) return;
          if (patterns.some((pattern) => cmdline.includes(pattern))) {
            matches.push({ pid: Number(entry.name), cmdline: cmdline.slice(0, 500) });
          }
        } catch {
          // Processes can exit while scanning /proc; ignore races.
        }
      }));
  } catch (err) {
    return sourceStatus("cps_local_workers", "CPS/local worker processes", "unavailable", undefined, err instanceof Error ? err.message : String(err));
  }

  if (matches.length === 0) {
    return sourceStatus("cps_local_workers", "CPS/local worker processes", "not_configured", { patterns });
  }
  return sourceStatus("cps_local_workers", "CPS/local worker processes", "ok", { matches });
}

function extractIssueRef(row: {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}) {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
  };
}

function extractApprovalRef(row: {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
}) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: row.payload,
  };
}

function category(key: CeoControlRoomCategoryKey, label: string, severity: "ok" | "info" | "warning" | "critical") {
  return {
    key,
    label,
    severity,
    count: 0,
    items: [] as CeoControlRoomStatus["categories"][number]["items"],
  };
}

export function ceoControlRoomService(db: Db) {
  return {
    status: async (companyId: string): Promise<CeoControlRoomStatus> => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const [dashboard, budgetOverview, blockedIssueRows, pendingApprovalRows, suspiciousSecretIssueRows, unboundSecretRows, errorAgentRows, staleRunRows, promotionIssueRows, repeatedRoutineRows, activeNoisyRoutineRows] = await Promise.all([
        dashboardService(db).summary(companyId),
        budgetService(db).overview(companyId),
        db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, priority: issues.priority })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked"), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt))
          .limit(10),
        db
          .select({ id: approvals.id, type: approvals.type, status: approvals.status, payload: approvals.payload })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
          .orderBy(desc(approvals.createdAt))
          .limit(10),
        db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, priority: issues.priority })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
            or(
              sql`lower(${issues.title}) like '%missing_secret%'`,
              sql`lower(${issues.title}) like '%missing secret%'`,
              sql`lower(${issues.description}) like '%missing_secret%'`,
              sql`lower(${issues.description}) like '%missing secret%'`,
            ),
            isNull(issues.hiddenAt),
          ))
          .orderBy(desc(issues.updatedAt))
          .limit(10),
        db
          .select({ id: companySecrets.id, key: companySecrets.key, name: companySecrets.name, status: companySecrets.status })
          .from(companySecrets)
          .leftJoin(companySecretBindings, eq(companySecretBindings.secretId, companySecrets.id))
          .where(and(eq(companySecrets.companyId, companyId), isNull(companySecrets.deletedAt), or(ne(companySecrets.status, "active"), isNull(companySecretBindings.id))))
          .limit(10),
        db
          .select({ id: agents.id, name: agents.name, status: agents.status, errorReason: agents.errorReason, lastHeartbeatAt: agents.lastHeartbeatAt })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.status, ["error", "paused"])))
          .orderBy(desc(agents.updatedAt))
          .limit(10),
        db
          .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, lastOutputAt: heartbeatRuns.lastOutputAt, startedAt: heartbeatRuns.startedAt, error: heartbeatRuns.error })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(25),
        db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, priority: issues.priority })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.status, ["in_review", "todo", "in_progress"]),
            or(
              sql`lower(${issues.title}) like '%promotion_candidate%'`,
              sql`lower(${issues.title}) like '%promotion candidate%'`,
              sql`lower(${issues.description}) like '%promotion_candidate%'`,
              sql`lower(${issues.description}) like '%promotion candidate%'`,
            ),
            isNull(issues.hiddenAt),
          ))
          .orderBy(desc(issues.updatedAt))
          .limit(10),
        db
          .select({
            title: issues.title,
            count: sql<number>`count(*)::int`,
            latestAt: sql<Date>`max(${issues.createdAt})`,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            isNull(issues.hiddenAt),
            sql`${issues.createdAt} > now() - interval '24 hours'`,
          ))
          .groupBy(issues.title)
          .having(sql`count(*) >= 6`)
          .orderBy(sql`count(*) desc`)
          .limit(10),
        db
          .select({
            id: routines.id,
            title: routines.title,
            status: routines.status,
            triggerId: routineTriggers.id,
            triggerEnabled: routineTriggers.enabled,
            cronExpression: routineTriggers.cronExpression,
            lastTriggeredAt: routines.lastTriggeredAt,
            lastEnqueuedAt: routines.lastEnqueuedAt,
          })
          .from(routines)
          .leftJoin(routineTriggers, eq(routineTriggers.routineId, routines.id))
          .where(and(
            eq(routines.companyId, companyId),
            eq(routines.status, "active"),
            eq(routineTriggers.enabled, true),
            or(
              sql`lower(${routines.title}) like '%liveness check%'`,
              sql`lower(${routines.title}) like '%active job and worker check%'`,
            ),
          ))
          .limit(20),
      ]);

      const microBase = firstNonEmpty(process.env.PAPERCLIP_MICRO_API_BASE, process.env.MICRO_API_BASE, "http://127.0.0.1:8093");
      const externalSources = await Promise.all([
        probeJsonSource({ key: "micro_health", label: "micro /api/health", url: `${microBase}/api/health` }),
        probeJsonSource({ key: "micro_experiments", label: "micro /api/experiments/state", url: `${microBase}/api/experiments/state` }),
        pathStatus("cps_control_plane", "CPS control-plane files", [
          "/root/cps",
          "/root/cli/LEDGER.md",
          "/root/cli/AUTONOMOUS-AUDIT-LOOP.md",
        ]),
        localWorkerProcessStatus(),
        pathStatus("active_experiments", "CPS/micro experiment artifacts", [
          "/root/cli/micro-addon/models/active-card.json",
          "/root/cli/micro-addon/runs",
          "/root/cli/micro-addon/state",
          "/root/cps/runs",
          "/root/cps/artifacts",
        ]),
        readVastOwnershipFiles(),
      ]);

      const categories = {
        blocked_by_human: category("blocked_by_human", "Blocked by human", "ok"),
        missing_secret: category("missing_secret", "Missing secret", "ok"),
        worker_offline: category("worker_offline", "Worker offline", "ok"),
        operational_loop: category("operational_loop", "Operational loop", "ok"),
        spend_cap: category("spend_cap", "Spend cap", "ok"),
        promotion_candidate: category("promotion_candidate", "Promotion candidate", "ok"),
      };

      for (const row of blockedIssueRows) {
        categories.blocked_by_human.items.push({ type: "issue", summary: row.title, issue: extractIssueRef(row) });
      }
      for (const row of pendingApprovalRows) {
        categories.blocked_by_human.items.push({ type: "approval", summary: `${row.type} approval pending`, approval: extractApprovalRef(row) });
      }

      for (const row of suspiciousSecretIssueRows) {
        categories.missing_secret.items.push({ type: "issue", summary: row.title, issue: extractIssueRef(row) });
      }
      for (const row of unboundSecretRows) {
        categories.missing_secret.items.push({ type: "secret", summary: `${row.name} (${row.key}) is ${row.status === "active" ? "unbound" : row.status}`, metadata: row });
      }

      for (const row of errorAgentRows) {
        categories.worker_offline.items.push({ type: "agent", summary: `${row.name} is ${row.status}`, metadata: row });
      }
      const staleThreshold = Date.now() - STALE_RUNNING_RUN_MS;
      for (const row of staleRunRows) {
        const lastSignal = row.lastOutputAt ?? row.startedAt;
        if (!lastSignal || lastSignal.getTime() >= staleThreshold) continue;
        categories.worker_offline.items.push({ type: "run", summary: `Run ${row.id} has no output since ${lastSignal.toISOString()}`, metadata: row });
      }
      for (const source of externalSources) {
        if (source.state === "unavailable") {
          categories[SOURCE_UNAVAILABLE_CATEGORY].items.push({ type: "source", summary: `${source.label} unavailable`, metadata: source });
        }
      }

      for (const row of repeatedRoutineRows) {
        categories.operational_loop.items.push({
          type: "routine_repeat",
          summary: `${row.title} created ${row.count} inbox issues in the last 24h`,
          metadata: { title: row.title, count: row.count, latestAt: row.latestAt },
        });
      }
      for (const row of activeNoisyRoutineRows) {
        categories.operational_loop.items.push({
          type: "routine_active_trigger",
          summary: `${row.title} still has an active schedule (${row.cronExpression ?? "unscheduled"})`,
          metadata: row,
        });
      }

      for (const incident of budgetOverview.activeIncidents) {
        categories.spend_cap.items.push({ type: "budget", summary: `${incident.scopeName} budget incident is active`, metadata: incident });
      }
      if (company.status === "paused" && company.pauseReason?.toLowerCase().includes("budget")) {
        categories.spend_cap.items.push({ type: "company", summary: `Company paused: ${company.pauseReason}`, metadata: { status: company.status, pauseReason: company.pauseReason } });
      }

      for (const row of promotionIssueRows) {
        categories.promotion_candidate.items.push({ type: "issue", summary: row.title, issue: extractIssueRef(row) });
      }
      for (const row of pendingApprovalRows.filter((approval) => approval.type === "request_board_approval")) {
        categories.promotion_candidate.items.push({ type: "approval", summary: "Board approval request may be promotion candidate", approval: extractApprovalRef(row) });
      }

      for (const entry of Object.values(categories)) {
        entry.count = entry.items.length;
        if (entry.count === 0) continue;
        entry.severity = entry.key === "promotion_candidate" ? "info" : entry.key === "spend_cap" ? "critical" : entry.key === "operational_loop" ? "critical" : "warning";
      }

      const orderedCategories = [
        categories.blocked_by_human,
        categories.missing_secret,
        categories.worker_offline,
        categories.operational_loop,
        categories.spend_cap,
        categories.promotion_candidate,
      ];

      return {
        companyId,
        generatedAt: new Date().toISOString(),
        summary: {
          openIssues: dashboard.tasks.open,
          blockedIssues: dashboard.tasks.blocked,
          pendingApprovals: dashboard.pendingApprovals + dashboard.budgets.pendingApprovals,
          monthSpendCents: dashboard.costs.monthSpendCents,
          monthBudgetCents: dashboard.costs.monthBudgetCents,
          activeBudgetIncidents: dashboard.budgets.activeIncidents,
          unavailableSources: externalSources.filter((source) => source.state === "unavailable").length,
        },
        sources: [
          sourceStatus("paperclip_dashboard", "Paperclip dashboard", "ok", dashboard),
          ...externalSources,
        ],
        categories: orderedCategories,
        safety: {
          readOnly: true,
          brokerActions: false,
          paidComputeActions: false,
          note: "CEO Control Room v0 only reads local/API status and classifies escalation candidates.",
        },
      };
    },
  };
}
