import { createHash } from "node:crypto";
import { and, asc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issueComments, issues, routines, routineTriggers } from "@paperclipai/db";
import type { IssueBlockerAttention as SharedIssueBlockerAttention } from "@paperclipai/shared";
import { issueService } from "./issues.js";

export const BLOCKED_ISSUE_ESCALATION_ACTION_KEY = "blocked_issue_escalation_v1" as const;
export const BLOCKED_ISSUE_ESCALATION_ORIGIN_KIND = "internal_action" as const;
export const BLOCKED_ISSUE_ESCALATION_MARKER = "<!-- paperclip:blocker-escalation:v1" as const;
export const BLOCKED_ISSUE_ESCALATION_ENABLED_ENV = "PAPERCLIP_NO_DEAD_BLOCKS_STAGE_2B_ENABLED" as const;
export const DEFAULT_BLOCKED_ISSUE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BLOCKED_ISSUE_ESCALATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BLOCKED_ISSUE_ESCALATION_BATCH_SIZE = 25;

export type BlockedIssueEscalationIssue = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  updatedAt: Date | string;
};

export type BlockedIssueEscalationCandidate = {
  issue: BlockedIssueEscalationIssue;
  attention: SharedIssueBlockerAttention;
  reason: "leaderless" | "stale";
};

export type CompanyDecider = {
  id: string;
  name: string;
};

type CompanyAgent = {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  reportsTo: string | null;
  status?: string;
};

type EscalationMarker = {
  version: 1;
  issueId: string;
  fingerprint: string;
  deciderId: string;
  createdAt: string;
};

function asDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function ageMs(value: Date | string, now: Date) {
  return now.getTime() - asDate(value).getTime();
}

export function selectBlockedIssueEscalationCandidates(input: {
  issues: BlockedIssueEscalationIssue[];
  attentionByIssueId: Map<string, SharedIssueBlockerAttention>;
  now: Date;
  staleThresholdMs?: number;
}) {
  const staleThresholdMs = input.staleThresholdMs ?? DEFAULT_BLOCKED_ISSUE_STALE_THRESHOLD_MS;
  return input.issues.flatMap((issue): BlockedIssueEscalationCandidate[] => {
    if (issue.status === "done" || issue.status === "cancelled") return [];
    const attention = input.attentionByIssueId.get(issue.id);
    if (!attention || attention.state === "covered" || attention.state === "none") return [];
    if (attention.state === "needs_attention") {
      return [{ issue, attention, reason: "leaderless" }];
    }
    if (attention.state === "stalled" && ageMs(issue.updatedAt, input.now) > staleThresholdMs) {
      return [{ issue, attention, reason: "stale" }];
    }
    return [];
  });
}

export function resolveCompanyDecider(companyAgents: CompanyAgent[], companyId: string): CompanyDecider | null {
  const candidates = companyAgents
    .filter((agent) => agent.companyId === companyId)
    .filter((agent) => agent.status !== "terminated")
    .filter((agent) => {
      const role = agent.role.trim().toLowerCase();
      const title = (agent.title ?? "").trim().toLowerCase();
      return role === "ceo" || title === "ceo" || title === "chief executive officer";
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const decider = candidates[0];
  return decider ? { id: decider.id, name: decider.name } : null;
}

export function buildBlockedIssueEscalationFingerprint(
  candidate: BlockedIssueEscalationCandidate,
  deciderId: string,
) {
  const value = JSON.stringify({
    issueId: candidate.issue.id,
    reason: candidate.reason,
    deciderId,
    sampleBlockerIdentifier: candidate.attention.sampleBlockerIdentifier,
    sampleStalledBlockerIdentifier: candidate.attention.sampleStalledBlockerIdentifier,
    unresolvedBlockerCount: candidate.attention.unresolvedBlockerCount,
    attentionBlockerCount: candidate.attention.attentionBlockerCount,
  });
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildBlockedIssueEscalationComment(
  candidate: BlockedIssueEscalationCandidate,
  decider: CompanyDecider,
  fingerprint: string,
  createdAt: Date,
) {
  const marker: EscalationMarker = {
    version: 1,
    issueId: candidate.issue.id,
    fingerprint,
    deciderId: decider.id,
    createdAt: createdAt.toISOString(),
  };
  const identifier = candidate.issue.identifier ?? candidate.issue.id;
  const blocker = candidate.attention.sampleBlockerIdentifier ?? "the unresolved blocker chain";
  const reason = candidate.reason === "leaderless"
    ? "the blocker chain has no invokable owner"
    : "the blocker chain has remained stalled beyond the configured threshold";
  return [
    `${BLOCKED_ISSUE_ESCALATION_MARKER} ${JSON.stringify(marker)} -->`,
    `**No-Dead-Blocks escalation — ${identifier} requires a decision**`,
    `[@${decider.name}](agent://${decider.id})`,
    "",
    `This blocked ticket is an escalation candidate because ${reason}.`,
    "",
    `1. **Decision needed:** determine the disposition for blocker **${blocker}** and whether it should remain the dependency for this ticket.`,
    `2. **Named decider:** [@${decider.name}](agent://${decider.id}) is the company CEO/default decider for this escalation.`,
    `3. **Concrete unblock action:** record the decision, then assign or resume the blocker owner (or remove/resolve the blocker) and update **${identifier}** with the resulting next action.`,
    "",
    "Please leave the decision and next action on this issue so the block has a durable, inspectable disposition.",
  ].join("\n");
}

export function parseBlockedIssueEscalationMarker(body: string): EscalationMarker | null {
  const match = body.match(/<!-- paperclip:blocker-escalation:v1 (\{[^\n]+\}) -->/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as Partial<EscalationMarker>;
    if (
      value.version !== 1 ||
      typeof value.issueId !== "string" ||
      typeof value.fingerprint !== "string" ||
      typeof value.deciderId !== "string" ||
      typeof value.createdAt !== "string"
    ) return null;
    return value as EscalationMarker;
  } catch {
    return null;
  }
}

export function isBlockedIssueEscalationSuppressed(input: {
  marker: EscalationMarker | null;
  fingerprint: string;
  now: Date;
  cooldownMs: number;
}) {
  if (!input.marker || input.marker.fingerprint !== input.fingerprint) return false;
  const createdAt = new Date(input.marker.createdAt).getTime();
  return Number.isFinite(createdAt) && input.now.getTime() - createdAt < input.cooldownMs;
}

function isFeatureEnabled(runtimeEnv: NodeJS.ProcessEnv) {
  return ["1", "true", "yes", "on"].includes(
    (runtimeEnv[BLOCKED_ISSUE_ESCALATION_ENABLED_ENV] ?? "").trim().toLowerCase(),
  );
}

export function isBlockedIssueEscalationEnabled(runtimeEnv: NodeJS.ProcessEnv = process.env) {
  return isFeatureEnabled(runtimeEnv);
}

export type BlockedIssueEscalationSweepSummary = {
  enabled: boolean;
  companyId: string;
  companiesScanned: number;
  candidatesFound: number;
  escalationsPosted: number;
  suppressedByCooldown: number;
  skippedWithoutDecider: number;
};

export function createBlockedIssueEscalationRunner(
  db: Db,
  options: {
    runtimeEnv?: NodeJS.ProcessEnv;
    staleThresholdMs?: number;
    cooldownMs?: number;
    batchSize?: number;
  } = {},
) {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const issueSvc = issueService(db);
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_BLOCKED_ISSUE_STALE_THRESHOLD_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_BLOCKED_ISSUE_ESCALATION_COOLDOWN_MS;
  const batchSize = options.batchSize ?? DEFAULT_BLOCKED_ISSUE_ESCALATION_BATCH_SIZE;

  return {
    async run(companyId: string, now = new Date()): Promise<BlockedIssueEscalationSweepSummary> {
      const summary: BlockedIssueEscalationSweepSummary = {
        enabled: isFeatureEnabled(runtimeEnv),
        companyId,
        companiesScanned: 0,
        candidatesFound: 0,
        escalationsPosted: 0,
        suppressedByCooldown: 0,
        skippedWithoutDecider: 0,
      };
      if (!summary.enabled) return summary;

      const [blockedIssues, companyAgents] = await Promise.all([
        db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            updatedAt: issues.updatedAt,
            parentId: issues.parentId,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked"))),
        db
          .select({ id: agents.id, companyId: agents.companyId, name: agents.name, role: agents.role, title: agents.title, reportsTo: agents.reportsTo, status: agents.status })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
      ]);
      summary.companiesScanned = 1;
      if (blockedIssues.length === 0) return summary;

      const attention = await issueSvc.listBlockerAttention(companyId, blockedIssues);
      const candidates = selectBlockedIssueEscalationCandidates({
        issues: blockedIssues,
        attentionByIssueId: attention,
        now,
        staleThresholdMs,
      });
      summary.candidatesFound = candidates.length;
      const decider = resolveCompanyDecider(companyAgents, companyId);
      if (!decider) {
        summary.skippedWithoutDecider = candidates.length;
        return summary;
      }

      for (const candidate of candidates.slice(0, batchSize)) {
        const fingerprint = buildBlockedIssueEscalationFingerprint(candidate, decider.id);
        const posted = await db.transaction(async (tx) => {
          await tx.execute(sql`select id from ${issues} where id = ${candidate.issue.id} and company_id = ${companyId} for update`);
          const previous = await tx
            .select({ body: issueComments.body, createdAt: issueComments.createdAt })
            .from(issueComments)
            .where(and(
              eq(issueComments.companyId, companyId),
              eq(issueComments.issueId, candidate.issue.id),
              isNull(issueComments.deletedAt),
              ilike(issueComments.body, `%${BLOCKED_ISSUE_ESCALATION_MARKER}%`),
            ))
            .orderBy(sql`${issueComments.createdAt} desc`)
            .limit(1)
            .then((rows) => rows[0] ?? null);
          const marker = previous ? parseBlockedIssueEscalationMarker(previous.body) : null;
          if (isBlockedIssueEscalationSuppressed({ marker, fingerprint, now, cooldownMs })) return false;

          await issueSvc.addComment(
            candidate.issue.id,
            buildBlockedIssueEscalationComment(candidate, decider, fingerprint, now),
            {},
            { authorType: "system" },
            tx,
          );
          return true;
        });
        if (posted) summary.escalationsPosted += 1;
        else summary.suppressedByCooldown += 1;
      }
      return summary;
    },
  };
}

function nextHourlyUtcTick(after: Date) {
  const next = new Date(after.getTime());
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

/**
 * Creates the feature's routine-register entry only when the explicit flag is
 * enabled. The existing routine scheduler then owns cadence, run records, and
 * operator visibility; this function does not create a second timer.
 */
export async function ensureBlockedIssueEscalationRoutines(db: Db, now = new Date()) {
  const activeCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.status, "active"));
  let routinesCreated = 0;
  await db.transaction(async (tx) => {
    for (const company of activeCompanies) {
      const existing = await tx
        .select()
        .from(routines)
        .where(and(
          eq(routines.companyId, company.id),
          eq(routines.originKind, BLOCKED_ISSUE_ESCALATION_ORIGIN_KIND),
          eq(routines.originId, BLOCKED_ISSUE_ESCALATION_ACTION_KEY),
        ))
        .orderBy(asc(routines.createdAt), asc(routines.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const routine = existing
        ? (await tx
            .update(routines)
            .set({
              title: "No-Dead-Blocks escalation sweep",
              description: "Hourly visibility-register sweep for leaderless or stale blocked tickets.",
              assigneeAgentId: null,
              status: "active",
              concurrencyPolicy: "skip_if_active",
              catchUpPolicy: "skip_missed",
              updatedAt: now,
            })
            .where(eq(routines.id, existing.id))
            .returning()
          ).at(0) ?? existing
        : (await tx
            .insert(routines)
            .values({
              companyId: company.id,
              title: "No-Dead-Blocks escalation sweep",
              description: "Hourly visibility-register sweep for leaderless or stale blocked tickets.",
              assigneeAgentId: null,
              status: "active",
              concurrencyPolicy: "skip_if_active",
              catchUpPolicy: "skip_missed",
              activityGatePolicy: "always",
              activityGateScope: "company",
              originKind: BLOCKED_ISSUE_ESCALATION_ORIGIN_KIND,
              originId: BLOCKED_ISSUE_ESCALATION_ACTION_KEY,
              variables: [],
              createdAt: now,
              updatedAt: now,
            })
            .returning()
          ).at(0);
      if (!existing) routinesCreated += 1;
      if (!routine) continue;

      const trigger = await tx
        .select()
        .from(routineTriggers)
        .where(and(eq(routineTriggers.routineId, routine.id), eq(routineTriggers.kind, "schedule")))
        .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (trigger) {
        await tx
          .update(routineTriggers)
          .set({
            enabled: true,
            cronExpression: "0 * * * *",
            timezone: "UTC",
            nextRunAt: trigger.nextRunAt && trigger.nextRunAt > now ? trigger.nextRunAt : nextHourlyUtcTick(now),
            updatedAt: now,
          })
          .where(eq(routineTriggers.id, trigger.id));
      } else {
        await tx.insert(routineTriggers).values({
          companyId: company.id,
          routineId: routine.id,
          kind: "schedule",
          label: "Hourly No-Dead-Blocks escalation sweep",
          enabled: true,
          cronExpression: "0 * * * *",
          timezone: "UTC",
          nextRunAt: nextHourlyUtcTick(now),
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  });
  return { companiesEnsured: activeCompanies.length, routinesCreated };
}

export async function disableBlockedIssueEscalationRoutines(db: Db, now = new Date()) {
  return db.transaction(async (tx) => {
    const managed = await tx
      .select({ id: routines.id })
      .from(routines)
      .where(and(
        eq(routines.originKind, BLOCKED_ISSUE_ESCALATION_ORIGIN_KIND),
        eq(routines.originId, BLOCKED_ISSUE_ESCALATION_ACTION_KEY),
      ));
    if (managed.length === 0) return { routinesPaused: 0, triggersDisabled: 0 };
    const routineIds = managed.map((routine) => routine.id);
    const paused = await tx
      .update(routines)
      .set({ status: "paused", updatedAt: now })
      .where(inArray(routines.id, routineIds))
      .returning({ id: routines.id });
    const disabled = await tx
      .update(routineTriggers)
      .set({ enabled: false, updatedAt: now })
      .where(and(inArray(routineTriggers.routineId, routineIds), eq(routineTriggers.kind, "schedule")))
      .returning({ id: routineTriggers.id });
    return { routinesPaused: paused.length, triggersDisabled: disabled.length };
  });
}
