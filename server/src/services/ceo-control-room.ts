import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, companySecretBindings, companySecrets, heartbeatRuns, issueWorkProducts, issues, routines, routineTriggers } from "@paperclipai/db";
import type { CeoControlRoomStatus, CeoControlRoomCategoryKey, CeoControlRoomSeverity, CeoControlRoomSourceStatus } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { dashboardService } from "./dashboard.js";
import { issueService } from "./issues.js";

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

type ConveyorAgentRow = {
  id: string;
  name: string;
  status: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  lastHeartbeatAt: Date | null;
  errorReason: string | null;
};

type ConveyorRunRow = {
  id: string;
  agentId: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastOutputAt: Date | null;
  errorCode: string | null;
  error: string | null;
};

function agentConveyorSummary(agent: ConveyorAgentRow, latestRun: ConveyorRunRow | null) {
  const config = agent.adapterConfig ?? {};
  const localRunAsUser = typeof config.localRunAsUser === "string" && config.localRunAsUser.trim().length > 0
    ? config.localRunAsUser.trim()
    : null;
  const workspace = typeof config.localRunAsWorkspaceDir === "string" && config.localRunAsWorkspaceDir.trim().length > 0
    ? config.localRunAsWorkspaceDir.trim()
    : typeof config.cwd === "string" && config.cwd.trim().length > 0
      ? config.cwd.trim()
      : null;
  const apiUrl = typeof config.env === "object" && config.env !== null
    ? (config.env as Record<string, unknown>).PAPERCLIP_API_URL
    : null;
  const apiUrlValue = typeof apiUrl === "object" && apiUrl !== null && typeof (apiUrl as Record<string, unknown>).value === "string"
    ? (apiUrl as Record<string, unknown>).value as string
    : typeof apiUrl === "string"
      ? apiUrl
      : null;
  const permissions = config.dangerouslySkipPermissions === true
    ? "bypass"
    : typeof config.permissionMode === "string"
      ? config.permissionMode
      : "default";
  const runState = latestRun
    ? `${latestRun.status}${latestRun.errorCode ? `/${latestRun.errorCode}` : ""}`
    : "no recent run";
  const parts = [
    agent.adapterType,
    localRunAsUser ? `run-as ${localRunAsUser}` : null,
    workspace ? `workspace ${workspace}` : null,
    apiUrlValue ? `api ${apiUrlValue}` : null,
    `permissions ${permissions}`,
    `latest ${runState}`,
  ].filter(Boolean);
  return `${agent.name}: ${parts.join(" · ")}`;
}

function proofSignals(input: { executionRunId: string | null; workProductCount: number; completedAt: Date | null; status: string }) {
  const signals = [] as string[];
  if (input.executionRunId) signals.push("run-linked");
  if (input.workProductCount > 0) signals.push(`${input.workProductCount} work product${input.workProductCount === 1 ? "" : "s"}`);
  if (input.completedAt) signals.push("completed");
  if (signals.length === 0) signals.push(`status ${input.status}`);
  return signals.join(" · ");
}

// Issue origins whose deliverable is the run/review output itself (a routine run,
// a productivity review, a durable incident thread) rather than a filed work product.
// A completed issue from one of these origins is self-documenting, so the absence of a
// work product is not a real proof-ledger gap — only substantive work (manual/operator
// issues) should be flagged proof_missing.
export const SELF_DOCUMENTING_PROOF_ORIGIN_KINDS = new Set([
  "routine_execution",
  "issue_productivity_review",
  "operational_loop_incident", // === OPERATIONAL_LOOP_INCIDENT_ORIGIN_KIND (declared below)
]);

export type ProofLedgerItemType = "proof_linked" | "proof_pending" | "proof_indirect" | "proof_missing";

export function classifyProofLedgerEntry(input: {
  status: string;
  executionRunId: string | null;
  workProductCount: number;
  originKind: string | null;
}): ProofLedgerItemType {
  if (input.workProductCount > 0 || input.executionRunId) return "proof_linked";
  // Still under review: proof may legitimately be attached before it closes.
  if (input.status === "in_review") return "proof_pending";
  // Closed work whose proof lives in the run/review/incident thread, not a work product.
  if (input.originKind && SELF_DOCUMENTING_PROOF_ORIGIN_KINDS.has(input.originKind)) return "proof_indirect";
  // Closed substantive work with no machine-checkable proof artifact: the real ledger gap.
  return "proof_missing";
}

export type UnboundSecretItemType = "secret_missing" | "secret_external_ref" | "secret_unbound";

// Classifies a secret surfaced by the unbound/non-active query. An active secret that is
// merely unbound is not a missing secret: external_reference rows are pointers to canonical
// secrets held outside Paperclip (CLI/CPS/Nautilus broker readiness), and active managed rows
// with no binding are registered but not yet consumed by any lane. Only a non-active status is
// a genuine missing/inactive secret.
export function classifyUnboundSecret(input: { status: string; managedMode: string | null }): {
  type: UnboundSecretItemType;
  descriptor: string;
} {
  if (input.status !== "active") {
    return { type: "secret_missing", descriptor: input.status };
  }
  if (input.managedMode === "external_reference") {
    return { type: "secret_external_ref", descriptor: "external reference — canonical secret held outside Paperclip" };
  }
  return { type: "secret_unbound", descriptor: "registered but not bound to any lane" };
}

export type WorkerOfflineAgentItemType = "agent_process_lost" | "agent_offline";

// Matches the process-loss family emitted by the heartbeat reaper (buildProcessLossMessage in
// heartbeat.ts) — every variant begins with "Process lost --" and carries errorCode process_lost.
const PROCESS_LOST_REASON = /process lost/i;

// Classifies an error/paused agent surfaced into the worker_offline category. When the heartbeat
// reaper finalizes an in-flight run whose OS process has vanished (a server restart orphaning the
// run, or an otherwise reaped run), it pins the agent to status=error with a "Process lost -- ..."
// reason. If heartbeat is disabled nothing re-runs the agent, so the flag is a *stale recovery
// artifact* that clears with a plain re-run / clear-error — not a worker that is genuinely offline.
// A genuine fault is distinguishable: it carries a descriptive reason (adapter spawn failure,
// "vault provider is not configured", exit/timeout error) or a non-error status (paused), and must
// stay a warning. We only treat status=error + a process-lost reason as the recoverable orphan; a
// null/other reason or any non-error status is conservatively classified as genuinely offline.
export function classifyWorkerOfflineAgent(input: { status: string; errorReason: string | null }): WorkerOfflineAgentItemType {
  if (input.status === "error" && input.errorReason && PROCESS_LOST_REASON.test(input.errorReason)) {
    return "agent_process_lost";
  }
  return "agent_offline";
}

// A non-empty category only escalates to warning/critical when it contains a genuine problem.
// missing_secret and proof_ledger now carry informational items (external refs, indirect proof)
// that must not inflate the board into a false warning.
export function severityForNonEmptyCategory(
  key: CeoControlRoomCategoryKey,
  items: Array<{ type: string }>,
): CeoControlRoomSeverity {
  switch (key) {
    case "promotion_candidate":
      return "info";
    case "agent_conveyor":
      return items.some((item) => item.type === "lane_attention") ? "warning" : "info";
    case "proof_ledger":
      return items.some((item) => item.type === "proof_missing") ? "warning" : "info";
    case "missing_secret":
      return items.some((item) => item.type === "issue" || item.type === "secret_missing") ? "warning" : "info";
    case "worker_offline":
      // Stale process-lost orphans (server-restart artifacts, recoverable via re-run/clear-error)
      // alone are informational. Any genuinely offline/failing agent (agent_offline), stalled
      // heartbeat run (run), or unavailable external source (source) keeps the category a warning.
      return items.some((item) => item.type !== "agent_process_lost") ? "warning" : "info";
    case "spend_cap":
    case "operational_loop":
      return "critical";
    default:
      return "warning";
  }
}

const OPEN_INCIDENT_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
export const OPERATIONAL_LOOP_INCIDENT_ORIGIN_KIND = "operational_loop_incident";

function incidentTitleForRoutine(title: string) {
  return `Operational incident: ${title}`;
}

function normalizeOperationalIncidentKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function operationalIncidentFingerprint(input: { routineId?: string | null; routineTitle: string }) {
  if (input.routineId) return `operational-loop:routine:${input.routineId}`;
  return `operational-loop:title:${normalizeOperationalIncidentKey(input.routineTitle)}`;
}

export function legacyOperationalIncidentFingerprint(routineTitle: string) {
  return `operational-loop:${routineTitle}`;
}

function normalizeOperatorNote(note?: string | null) {
  const trimmed = note?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function ceoControlRoomService(db: Db) {
  const issuesSvc = issueService(db);

  async function findRoutine(companyId: string, input: { routineId?: string | null; routineTitle?: string | null }) {
    if (input.routineId) {
      const row = await db
        .select()
        .from(routines)
        .where(and(eq(routines.companyId, companyId), eq(routines.id, input.routineId)))
        .then((rows) => rows[0] ?? null);
      if (row) return row;
    }
    if (input.routineTitle?.trim()) {
      return db
        .select()
        .from(routines)
        .where(and(eq(routines.companyId, companyId), eq(routines.title, input.routineTitle.trim())))
        .then((rows) => rows[0] ?? null);
    }
    return null;
  }

  async function pauseRoutine(companyId: string, routineId: string, note?: string | null) {
    const routine = await findRoutine(companyId, { routineId });
    if (!routine) throw notFound("Routine not found");
    const lastResult = normalizeOperatorNote(note) ?? "Paused by CEO Operations: watchdog output is owned by a durable incident";
    await db.transaction(async (tx) => {
      await tx.update(routines).set({ status: "paused", updatedAt: new Date() }).where(eq(routines.id, routine.id));
      await tx
        .update(routineTriggers)
        .set({ enabled: false, updatedAt: new Date(), lastResult })
        .where(eq(routineTriggers.routineId, routine.id));
    });
    return { routineId: routine.id, title: routine.title, status: "paused" as const };
  }

  async function createOrUpdateOperationalIncident(companyId: string, input: { routineId?: string | null; routineTitle: string; note?: string | null }) {
    const routine = await findRoutine(companyId, input);
    const routineTitle = routine?.title ?? input.routineTitle.trim();
    if (!routineTitle) throw notFound("Routine title required");
    const title = incidentTitleForRoutine(routineTitle);
    const incidentFingerprint = operationalIncidentFingerprint({ routineId: routine?.id ?? null, routineTitle });
    const legacyFingerprint = legacyOperationalIncidentFingerprint(routineTitle);
    const note = normalizeOperatorNote(input.note);
    const existing = await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        inArray(issues.status, OPEN_INCIDENT_STATUSES),
        isNull(issues.hiddenAt),
        or(
          and(
            eq(issues.originKind, OPERATIONAL_LOOP_INCIDENT_ORIGIN_KIND),
            eq(issues.originFingerprint, incidentFingerprint),
          ),
          and(
            eq(issues.title, title),
            eq(issues.originFingerprint, legacyFingerprint),
          ),
        ),
      ))
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const body = [
      "CEO Operations detected a recurring watchdog loop and is routing it to one durable incident instead of disposable liveness reports.",
      "",
      `Routine: ${routineTitle}`,
      routine ? `Routine ID: ${routine.id}` : null,
      routine?.assigneeAgentId ? `Suggested owner agent ID: ${routine.assigneeAgentId}` : null,
      "Policy: keep this incident open until the underlying stale/degraded state is actually resolved; append further checks here instead of creating new watchdog issues.",
      note ? `Operator note: ${note}` : null,
      "",
      "Safety: no Vast launch, paid compute, broker action, trading, secret change, or job requeue is authorized by this incident.",
    ].filter(Boolean).join("\n");

    let issue = existing;
    if (issue) {
      await issuesSvc.addComment(issue.id, body, {}, { authorType: "system" });
    } else {
      issue = await issuesSvc.create(companyId, {
        title,
        description: body,
        status: "blocked",
        priority: "high",
        assigneeAgentId: null,
        originKind: OPERATIONAL_LOOP_INCIDENT_ORIGIN_KIND,
        originId: routine?.id ?? null,
        originFingerprint: incidentFingerprint,
      });
    }

    if (routine) {
      await pauseRoutine(companyId, routine.id, "Paused by CEO Operations: durable incident owns this watchdog loop");
    }

    return { issue, routine: routine ? { id: routine.id, title: routine.title, status: "paused" } : null };
  }

  async function resolveOperationalIncident(companyId: string, input: { issueId: string; routineId?: string | null; reenableRoutine?: boolean; note?: string | null }) {
    const [issue] = await db
      .select({ id: issues.id, title: issues.title, companyId: issues.companyId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, input.issueId)))
      .limit(1);
    if (!issue) throw notFound("Issue not found");
    const note = normalizeOperatorNote(input.note);
    await issuesSvc.addComment(issue.id, [
      "CEO Operations marked this durable watchdog incident resolved.",
      note ? `Operator note: ${note}` : null,
      input.reenableRoutine ? "Routine schedule re-enabled by operator." : "Routine schedule remains paused until separately re-enabled.",
    ].filter(Boolean).join("\n"), {}, { authorType: "system" });
    await db.update(issues).set({ status: "done", completedAt: new Date(), updatedAt: new Date() }).where(eq(issues.id, issue.id));
    if (input.reenableRoutine && input.routineId) {
      await db.transaction(async (tx) => {
        await tx.update(routines).set({ status: "active", updatedAt: new Date() }).where(and(eq(routines.companyId, companyId), eq(routines.id, input.routineId!)));
        await tx.update(routineTriggers).set({ enabled: true, updatedAt: new Date(), lastResult: "Re-enabled by CEO Operations after durable incident resolution" }).where(eq(routineTriggers.routineId, input.routineId!));
      });
    }
    return { issueId: issue.id, status: "done" as const, routineReenabled: Boolean(input.reenableRoutine && input.routineId) };
  }

  return {
    pauseRoutine,
    createOrUpdateOperationalIncident,
    resolveOperationalIncident,
    status: async (companyId: string): Promise<CeoControlRoomStatus> => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const [dashboard, budgetOverview, blockedIssueRows, pendingApprovalRows, suspiciousSecretIssueRows, unboundSecretRows, errorAgentRows, staleRunRows, promotionIssueRows, repeatedRoutineRows, noisyRoutineRows, activeOperationalIncidentRows, conveyorAgentRows, recentConveyorRunRows, recentProofIssueRows, proofWorkProductRows] = await Promise.all([
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
          .select({ id: companySecrets.id, key: companySecrets.key, name: companySecrets.name, status: companySecrets.status, managedMode: companySecrets.managedMode })
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
            or(
              sql`lower(${routines.title}) like '%liveness check%'`,
              sql`lower(${routines.title}) like '%active job and worker check%'`,
            ),
          ))
          .limit(20),
        db
          .select({
            id: issues.id,
            title: issues.title,
            originId: issues.originId,
            originFingerprint: issues.originFingerprint,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, OPERATIONAL_LOOP_INCIDENT_ORIGIN_KIND),
            inArray(issues.status, OPEN_INCIDENT_STATUSES),
            isNull(issues.hiddenAt),
          ))
          .limit(100),
        db
          .select({
            id: agents.id,
            name: agents.name,
            status: agents.status,
            adapterType: agents.adapterType,
            adapterConfig: agents.adapterConfig,
            lastHeartbeatAt: agents.lastHeartbeatAt,
            errorReason: agents.errorReason,
          })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.adapterType, ["claude_local", "codex_local", "hermes_local", "process", "http"])))
          .orderBy(agents.name)
          .limit(50),
        db
          .select({
            id: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
            lastOutputAt: heartbeatRuns.lastOutputAt,
            errorCode: heartbeatRuns.errorCode,
            error: heartbeatRuns.error,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, companyId))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(200),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            executionRunId: issues.executionRunId,
            completedAt: issues.completedAt,
            originKind: issues.originKind,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.status, ["done", "in_review"]), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt))
          .limit(10),
        db
          .select({
            issueId: issueWorkProducts.issueId,
            count: sql<number>`count(*)::int`,
          })
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.companyId, companyId))
          .groupBy(issueWorkProducts.issueId)
          .limit(200),
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
        agent_conveyor: category("agent_conveyor", "Agent conveyor", "ok"),
        proof_ledger: category("proof_ledger", "Proof ledger", "ok"),
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
        const classified = classifyUnboundSecret({ status: row.status, managedMode: row.managedMode });
        categories.missing_secret.items.push({ type: classified.type, summary: `${row.name} (${row.key}) — ${classified.descriptor}`, metadata: row });
      }

      for (const row of errorAgentRows) {
        const agentItemType = classifyWorkerOfflineAgent({ status: row.status, errorReason: row.errorReason });
        categories.worker_offline.items.push({ type: agentItemType, summary: `${row.name} is ${row.status}`, metadata: row });
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

      const noisyRoutineByTitle = new Map(noisyRoutineRows.map((row) => [row.title, row]));
      const activeOperationalIncidentFingerprints = new Set(
        activeOperationalIncidentRows.map((row) => row.originFingerprint).filter(Boolean),
      );
      const activeOperationalIncidentTitles = new Set(activeOperationalIncidentRows.map((row) => row.title));
      for (const row of repeatedRoutineRows) {
        const routine = noisyRoutineByTitle.get(row.title) ?? null;
        const fingerprint = operationalIncidentFingerprint({ routineId: routine?.id ?? null, routineTitle: row.title });
        const isCoveredByDurableIncident =
          activeOperationalIncidentFingerprints.has(fingerprint)
          || activeOperationalIncidentTitles.has(incidentTitleForRoutine(row.title));
        if (isCoveredByDurableIncident) continue;
        categories.operational_loop.items.push({
          type: "routine_repeat",
          summary: `${row.title} created ${row.count} inbox issues in the last 24h`,
          metadata: { title: row.title, count: row.count, latestAt: row.latestAt, routine },
        });
      }
      for (const row of noisyRoutineRows.filter((entry) => entry.status === "active" && entry.triggerEnabled)) {
        categories.operational_loop.items.push({
          type: "routine_active_trigger",
          summary: `${row.title} still has an active schedule (${row.cronExpression ?? "unscheduled"})`,
          metadata: row,
        });
      }

      const latestRunByAgent = new Map<string, ConveyorRunRow>();
      for (const row of recentConveyorRunRows as ConveyorRunRow[]) {
        if (!latestRunByAgent.has(row.agentId)) latestRunByAgent.set(row.agentId, row);
      }
      for (const row of conveyorAgentRows as ConveyorAgentRow[]) {
        const latestRun = latestRunByAgent.get(row.id) ?? null;
        const healthy = row.status !== "error" && row.status !== "paused" && (!latestRun || !["failed", "cancelled"].includes(latestRun.status));
        categories.agent_conveyor.items.push({
          type: healthy ? "lane_ready" : "lane_attention",
          summary: agentConveyorSummary(row, latestRun),
          metadata: { agent: row, latestRun },
        });
      }

      const workProductCounts = new Map<string, number>();
      for (const row of proofWorkProductRows as Array<{ issueId: string; count: number }>) {
        workProductCounts.set(row.issueId, Number(row.count) || 0);
      }
      for (const row of recentProofIssueRows) {
        const workProductCount = workProductCounts.get(row.id) ?? 0;
        const proofType = classifyProofLedgerEntry({ status: row.status, executionRunId: row.executionRunId, workProductCount, originKind: row.originKind });
        categories.proof_ledger.items.push({
          type: proofType,
          summary: `${row.identifier ?? row.id}: ${proofSignals({ executionRunId: row.executionRunId, workProductCount, completedAt: row.completedAt, status: row.status })} — ${row.title}`,
          issue: extractIssueRef(row),
          metadata: { executionRunId: row.executionRunId, completedAt: row.completedAt, workProductCount, originKind: row.originKind },
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
        entry.severity = severityForNonEmptyCategory(entry.key, entry.items);
      }

      const orderedCategories = [
        categories.blocked_by_human,
        categories.missing_secret,
        categories.worker_offline,
        categories.operational_loop,
        categories.agent_conveyor,
        categories.proof_ledger,
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
