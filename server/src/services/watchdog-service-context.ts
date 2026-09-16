import { isUuidLike } from "@paperclipai/shared";
import { and, eq, inArray, or } from "drizzle-orm";
import { agents, heartbeatRuns, issues, companySecrets, companySecretBindings, type Db } from "@paperclipai/db";
import { forbidden, HttpError } from "../errors.js";

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

export async function assertWatchdogCommentTarget(db: Db, context: WatchdogServiceContext, issueId: string) {
  if (!isUuidLike(issueId)) throw forbidden("Invalid watchdog signal identifier.");
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, context.companyId)));
  if (!issue || !["todo", "in_progress", "in_review", "blocked"].includes(issue.status) ||
      issue.assigneeAgentId !== context.assigneeAgentId) {
    throw forbidden("Issue is not an open signal assigned to the incident owner.");
  }
  const legacy = context.legacyIssues.find((pin) => pin.issueId === issueId &&
    ["createdByAgentId", "createdByUserId", "originKind", "originId", "originRunId"].every(
      (key) => pin[key] === issue[key as keyof typeof issue],
    ));
  if (legacy) return context.signals.find((signal) => signal.type === legacy.type)!;
  const signal = context.signals.find((item) => issue.originId === `${context.agentId}/${item.type}`);
  if (!signal || issue.createdByAgentId !== context.agentId ||
      issue.originKind !== "watchdog_service_signal" || !issue.originRunId || !isUuidLike(issue.originRunId)) {
    throw forbidden("Issue provenance is not bound to this watchdog service.");
  }
  const [originRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, issue.originRunId), eq(heartbeatRuns.agentId, context.agentId),
    eq(heartbeatRuns.companyId, context.companyId),
  ));
  if (!originRun) throw forbidden("Watchdog signal origin is not verified.");
  return signal;
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

export async function listWatchdogSignals(db: Db, context: WatchdogServiceContext) {
  const candidates = await db.select().from(issues).where(and(
    eq(issues.companyId, context.companyId), eq(issues.assigneeAgentId, context.assigneeAgentId),
    inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
    or(and(eq(issues.createdByAgentId, context.agentId), eq(issues.originKind, "watchdog_service_signal")),
      inArray(issues.id, context.legacyIssues.map((pin) => pin.issueId as string))),
  ));
  const verified = [];
  for (const issue of candidates) {
    try {
      await assertWatchdogCommentTarget(db, context, issue.id);
      verified.push(issue);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
    }
  }
  return verified;
}
