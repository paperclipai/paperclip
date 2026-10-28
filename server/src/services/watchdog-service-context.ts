import { isUuidLike } from "@paperclipai/shared";
import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { agents, heartbeatRuns, issues, companySecrets, companySecretBindings, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { visibleIssueCondition } from "./issue-visibility.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
export type WatchdogServiceContext = {
  companyId: string;
  agentId: string;
  runId: string;
  assigneeAgentId: string;
  signals: Array<{ type: string; marker: string }>;
  legacyIssues: Array<Record<string, unknown>>;
};

// This function accepts only the authentication middleware's verified source.
// A run header, request payload or contextSnapshot cannot grant this capability.
export async function loadWatchdogServiceContext(db: Db, actor: {
  source?: string; companyId?: string; agentId?: string; runId?: string;
}): Promise<WatchdogServiceContext | null> {
  if (actor.source !== "agent_jwt" || !actor.companyId || !actor.agentId || !actor.runId) return null;
  const [agent] = await db.select().from(agents).where(and(
    eq(agents.id, actor.agentId), eq(agents.companyId, actor.companyId),
  ));
  const config = record(agent?.adapterConfig);
  if (!config || !Object.hasOwn(config, "watchdogService")) return null;
  const service = record(config.watchdogService);
  if (agent.adapterType !== "process" || config.fixedCommand !== true ||
      typeof config.command !== "string" || !config.command || typeof config.cwd !== "string" || !config.cwd ||
      !service || typeof service.assigneeAgentId !== "string" || !isUuidLike(service.assigneeAgentId) ||
      !Array.isArray(service.signals) || service.signals.length === 0) {
    throw forbidden("Invalid administrative watchdog configuration.");
  }
  const signals: WatchdogServiceContext["signals"] = [];
  for (const value of service.signals) {
    const signal = record(value);
    if (!signal || typeof signal.type !== "string" || !/^[a-z][a-z0-9-]*$/.test(signal.type) ||
        typeof signal.marker !== "string" || !/^\[watchdog-[a-z0-9-]+\]$/.test(signal.marker) ||
        signals.some((item) => item.type === signal.type || item.marker === signal.marker)) {
      throw forbidden("Invalid administrative watchdog signal type.");
    }
    signals.push({ type: signal.type, marker: signal.marker });
  }
  const [run] = await db.select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, actor.companyId),
    eq(heartbeatRuns.agentId, actor.agentId),
  )).for("share");
  if (run?.status !== "running") throw forbidden("Watchdog service requires its active authenticated run.");
  const runContext = record(run.contextSnapshot);
  if (runContext?.issueId || runContext?.taskId) throw forbidden("Watchdog service runs cannot borrow an issue context.");
  const legacyIssues = service.legacyIssues ?? [];
  if (!Array.isArray(legacyIssues) || legacyIssues.some((pin) => {
    const value = record(pin);
    return !value || !signals.some((signal) => signal.type === value.type) ||
      typeof value.issueId !== "string" || !isUuidLike(value.issueId) ||
      !["createdByAgentId", "createdByUserId", "originKind", "originId", "originRunId"].every((key) => Object.hasOwn(value, key)) ||
      !(value.createdByAgentId || value.createdByUserId);
  })) throw forbidden("Invalid administrative legacy signal provenance.");
  return { companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId,
    assigneeAgentId: service.assigneeAgentId, signals, legacyIssues };
}

export function watchdogSignalOrigin(context: WatchdogServiceContext, body: Record<string, unknown>) {
  const signal = context.signals.find((item) => typeof body.title === "string" && body.title.startsWith(`${item.marker} `));
  if (!signal || body.status !== "todo" || body.assigneeAgentId !== context.assigneeAgentId ||
      Object.keys(body).some((key) => !["title", "description", "status", "priority", "assigneeAgentId"].includes(key))) {
    throw forbidden("Watchdog may only create its configured signal for the incident owner.");
  }
  return { originKind: "watchdog_service_signal", originId: `${context.agentId}/${signal.type}`, originRunId: context.runId };
}

type WatchdogSignalMatch =
  | { ok: true; signal: WatchdogServiceContext["signals"][number]; originRunId: string | null }
  | { ok: false; reason: string };

/**
 * Checks an issue row against the watchdog context without database reads. A
 * match with an `originRunId` still needs that run verified for this watchdog.
 */
function matchWatchdogSignal(context: WatchdogServiceContext, issue: typeof issues.$inferSelect): WatchdogSignalMatch {
  if (!["todo", "in_progress", "in_review", "blocked"].includes(issue.status) ||
      issue.assigneeAgentId !== context.assigneeAgentId) {
    return { ok: false, reason: "Issue is not an open signal assigned to the incident owner." };
  }
  const legacy = context.legacyIssues.find((pin) => pin.issueId === issue.id &&
    ["createdByAgentId", "createdByUserId", "originKind", "originId", "originRunId"].every(
      (key) => pin[key] === issue[key as keyof typeof issue],
    ));
  if (legacy) return { ok: true, signal: context.signals.find((signal) => signal.type === legacy.type)!, originRunId: null };
  const signal = context.signals.find((item) => issue.originId === `${context.agentId}/${item.type}`);
  if (!signal || issue.createdByAgentId !== context.agentId ||
      issue.originKind !== "watchdog_service_signal" || !issue.originRunId || !isUuidLike(issue.originRunId)) {
    return { ok: false, reason: "Issue provenance is not bound to this watchdog service." };
  }
  return { ok: true, signal, originRunId: issue.originRunId };
}

/** Origin runs among `runIds` that belong to this watchdog, read in one query. */
async function verifiedWatchdogOriginRunIds(db: Db, context: WatchdogServiceContext, runIds: string[]) {
  if (runIds.length === 0) return new Set<string>();
  const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    inArray(heartbeatRuns.id, runIds), eq(heartbeatRuns.agentId, context.agentId),
    eq(heartbeatRuns.companyId, context.companyId),
  ));
  return new Set(rows.map((row) => row.id));
}

export async function assertWatchdogCommentTarget(db: Db, context: WatchdogServiceContext, issueId: string) {
  if (!isUuidLike(issueId)) throw forbidden("Invalid watchdog signal identifier.");
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, context.companyId)));
  if (!issue) throw forbidden("Issue is not an open signal assigned to the incident owner.");
  const match = matchWatchdogSignal(context, issue);
  if (!match.ok) throw forbidden(match.reason);
  if (match.originRunId && !(await verifiedWatchdogOriginRunIds(db, context, [match.originRunId])).has(match.originRunId)) {
    throw forbidden("Watchdog signal origin is not verified.");
  }
  return match.signal;
}

export async function assertWatchdogSecret(db: Db, context: WatchdogServiceContext, key: string) {
  const [binding] = await db.select({ bindingId: companySecretBindings.id, secretId: companySecretBindings.secretId, configPath: companySecretBindings.configPath, versionSelector: companySecretBindings.versionSelector, key: companySecrets.key }).from(companySecretBindings)
    .innerJoin(companySecrets, eq(companySecrets.id, companySecretBindings.secretId))
    .where(and(eq(companySecretBindings.companyId, context.companyId),
      eq(companySecrets.companyId, context.companyId), eq(companySecrets.key, key),
      eq(companySecretBindings.targetType, "agent"), eq(companySecretBindings.targetId, context.agentId),
      eq(companySecretBindings.configPath, "env.DOKPLOY_KEY")));
  if (!binding) throw forbidden("Secret is not the administratively bound watchdog credential.");
  return { ...binding, versionSelector: binding.versionSelector === "latest" ? "latest" as const : Number(binding.versionSelector) };
}

/**
 * `readCondition` applies the caller's private-issue access: signal origin grants none.
 * Hidden issues are skipped, as in the normal issue list.
 * `titleQuery` filters before verification, which reads all origin runs in one query.
 */
export async function listWatchdogSignals(
  db: Db,
  context: WatchdogServiceContext,
  readCondition?: SQL<boolean>,
  titleQuery = "",
) {
  const candidates = await db.select().from(issues).where(and(
    ...(readCondition ? [readCondition] : []),
    eq(issues.companyId, context.companyId), eq(issues.assigneeAgentId, context.assigneeAgentId),
    visibleIssueCondition(),
    inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
    or(and(eq(issues.createdByAgentId, context.agentId), eq(issues.originKind, "watchdog_service_signal")),
      inArray(issues.id, context.legacyIssues.map((pin) => pin.issueId as string))),
  ));
  const query = titleQuery.toLowerCase();
  const matched = candidates
    .filter((issue) => issue.title.toLowerCase().includes(query))
    .map((issue) => ({ issue, match: matchWatchdogSignal(context, issue) }))
    .filter((entry) => entry.match.ok);
  const originRunIds = matched.flatMap(({ match }) => match.ok && match.originRunId ? [match.originRunId] : []);
  const verifiedRuns = await verifiedWatchdogOriginRunIds(db, context, [...new Set(originRunIds)]);
  return matched
    .filter(({ match }) => match.ok && (!match.originRunId || verifiedRuns.has(match.originRunId)))
    .map(({ issue }) => issue);
}
