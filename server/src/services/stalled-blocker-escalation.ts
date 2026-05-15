import { and, asc, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clampIssueRequestDepth } from "@paperclipai/shared";
import {
  agents,
  companies,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

export const STALLED_BLOCKER_ESCALATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.stalledBlockerEscalation;
export const DEFAULT_STALLED_BLOCKER_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const STALLED_BLOCKER_STATUSES = ["blocked", "in_progress"] as const;
const DEPENDENT_CANDIDATE_PRIORITIES = ["critical", "high"] as const;
const MAX_DEPENDENT_CANDIDATES = 250;

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
  },
) => Promise<unknown | null>;

function weekOf(now: Date): number {
  // Unix epoch started on a Thursday 1970-01-01, so this division naturally
  // aligns week boundaries to Thursday 00:00:00 UTC — intentional for
  // calendar-week idempotency windows.
  return Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
}

function stalledBlockerFingerprint(dependentId: string, blockerId: string, now: Date): string {
  return `stalled-blocker-escalation:${dependentId}:${blockerId}:${weekOf(now)}`;
}

function issueLink(identifier: string | null, id: string, prefix: string): string {
  const label = identifier ?? id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function agentMention(name: string, id: string): string {
  return `[@${name}](agent://${id})`;
}

function buildEscalationDescription(input: {
  dependentIdentifier: string | null;
  dependentId: string;
  blockerIdentifier: string | null;
  blockerId: string;
  blockerStatus: string;
  blockerUpdatedAt: Date | null;
  prefix: string;
}): string {
  const dependentLink = issueLink(input.dependentIdentifier, input.dependentId, input.prefix);
  const blockerLink = issueLink(input.blockerIdentifier, input.blockerId, input.prefix);
  const stalledSince = input.blockerUpdatedAt ? input.blockerUpdatedAt.toISOString() : "unknown";

  return [
    `## Stalled-blocker escalation`,
    ``,
    `${blockerLink} has been \`${input.blockerStatus}\` since ${stalledSince} (>24h without an update),`,
    `blocking ${dependentLink}.`,
    ``,
    `**Action required:** drive ${blockerLink} to completion or re-route the block.`,
  ].join("\n");
}

function buildDependentComment(input: {
  blockerIdentifier: string | null;
  blockerId: string;
  blockerStatus: string;
  escalationIdentifier: string | null;
  escalationId: string;
  ctoAgentName: string | null;
  ctoAgentId: string | null;
  prefix: string;
}): string {
  const blockerLink = issueLink(input.blockerIdentifier, input.blockerId, input.prefix);
  const escalationLink = issueLink(input.escalationIdentifier, input.escalationId, input.prefix);
  const ctoMention = input.ctoAgentId && input.ctoAgentName
    ? agentMention(input.ctoAgentName, input.ctoAgentId)
    : null;

  const lines = [
    `**Failure type:** stalled blocker — \`${input.blockerStatus}\` for >24h without an update`,
    `**Failing endpoint / action:** ${blockerLink} (blocker issue, no update in >24h)`,
    `**Unblock owner:** ${escalationLink} (assigned to blocker's assignee)`,
    `**Next wake condition:** ${escalationLink} reaches \`done\``,
  ];

  if (ctoMention) {
    lines.push(``, `Tagging ${ctoMention} for visibility.`);
  }

  return lines.join("\n");
}

export function stalledBlockerEscalationService(db: Db, deps?: { enqueueWakeup?: EnqueueWakeup }) {
  const issuesSvc = issueService(db);

  async function findOpenEscalation(companyId: string, fingerprint: string) {
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALLED_BLOCKER_ESCALATION_ORIGIN_KIND),
          eq(issues.originFingerprint, fingerprint),
          notInArray(issues.status, ["done", "cancelled"]),
          isNull(issues.hiddenAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function findCtoAgent(companyId: string) {
    return db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          inArray(agents.role, ["cto", "ceo"]),
        ),
      )
      .orderBy(
        sql`case when ${agents.role} = 'cto' then 0 else 1 end`,
        asc(agents.createdAt),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getCompanyPrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  async function reconcileStalledBlockerEscalations(opts?: {
    companyId?: string;
    now?: Date;
    stalledThresholdMs?: number;
  }) {
    const now = opts?.now ?? new Date();
    const stalledThresholdMs = opts?.stalledThresholdMs ?? DEFAULT_STALLED_BLOCKER_THRESHOLD_MS;
    const stalledBefore = new Date(now.getTime() - stalledThresholdMs);

    // Step 1: find critical/high blocked dependent issues
    const dependentRows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        title: issues.title,
        identifier: issues.identifier,
        goalId: issues.goalId,
        projectId: issues.projectId,
        billingCode: issues.billingCode,
        requestDepth: issues.requestDepth,
      })
      .from(issues)
      .where(
        and(
          opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
          inArray(issues.priority, DEPENDENT_CANDIDATE_PRIORITIES),
          eq(issues.status, "blocked"),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(MAX_DEPENDENT_CANDIDATES);

    if (dependentRows.length === 0) {
      return { scanned: 0, created: 0, skipped: 0, failed: 0, escalationIssueIds: [], failedPairs: [] };
    }

    const dependentIds = dependentRows.map((r) => r.id);

    // Step 2: for those dependents, find stalled blockers via issueRelations + issues
    const stalledPairRows = await db
      .select({
        dependentId: issueRelations.relatedIssueId,
        blockerId: issueRelations.issueId,
        blockerTitle: issues.title,
        blockerIdentifier: issues.identifier,
        blockerStatus: issues.status,
        blockerAssigneeAgentId: issues.assigneeAgentId,
        blockerUpdatedAt: issues.updatedAt,
        blockerCompanyId: issues.companyId,
      })
      .from(issueRelations)
      .innerJoin(
        issues,
        and(
          eq(issueRelations.issueId, issues.id),
          eq(issueRelations.companyId, issues.companyId),
        ),
      )
      .where(
        and(
          eq(issueRelations.companyId, opts?.companyId ?? issues.companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, dependentIds),
          inArray(issues.status, STALLED_BLOCKER_STATUSES),
          lte(issues.updatedAt, stalledBefore),
          isNull(issues.hiddenAt),
        ),
      );

    const dependentById = new Map(dependentRows.map((r) => [r.id, r]));

    const result = {
      scanned: stalledPairRows.length,
      created: 0,
      skipped: 0,
      failed: 0,
      escalationIssueIds: [] as string[],
      failedPairs: [] as string[],
    };

    const prefixCache = new Map<string, string>();
    const ctoCache = new Map<string, { id: string; name: string } | null>();

    for (const pair of stalledPairRows) {
      const dependent = dependentById.get(pair.dependentId);
      if (!dependent) continue;

      const fingerprint = stalledBlockerFingerprint(pair.dependentId, pair.blockerId, now);

      try {
        const existing = await findOpenEscalation(dependent.companyId, fingerprint);
        if (existing) {
          result.skipped += 1;
          continue;
        }

        let prefix = prefixCache.get(dependent.companyId);
        if (!prefix) {
          prefix = await getCompanyPrefix(dependent.companyId);
          prefixCache.set(dependent.companyId, prefix);
        }

        let ctoAgent = ctoCache.get(dependent.companyId);
        if (ctoAgent === undefined) {
          ctoAgent = await findCtoAgent(dependent.companyId);
          ctoCache.set(dependent.companyId, ctoAgent);
        }

        const assigneeAgentId = pair.blockerAssigneeAgentId ?? ctoAgent?.id ?? null;

        let escalation: Awaited<ReturnType<typeof issuesSvc.create>>;
        try {
          escalation = await issuesSvc.create(dependent.companyId, {
            title: `Escalation: ${pair.blockerIdentifier ?? pair.blockerId} stalled, blocking ${dependent.identifier ?? dependent.id}`,
            description: buildEscalationDescription({
              dependentIdentifier: dependent.identifier,
              dependentId: dependent.id,
              blockerIdentifier: pair.blockerIdentifier,
              blockerId: pair.blockerId,
              blockerStatus: pair.blockerStatus,
              blockerUpdatedAt: pair.blockerUpdatedAt,
              prefix,
            }),
            status: "todo",
            priority: "high",
            parentId: dependent.id,
            goalId: dependent.goalId,
            projectId: dependent.projectId,
            billingCode: dependent.billingCode,
            assigneeAgentId,
            originKind: STALLED_BLOCKER_ESCALATION_ORIGIN_KIND,
            originId: pair.blockerId,
            originFingerprint: fingerprint,
            requestDepth: clampIssueRequestDepth((dependent.requestDepth ?? 0) + 1),
          });
        } catch (error) {
          const maybe = error as { code?: string; constraint?: string; message?: string };
          const uniqueConflict =
            maybe.code === "23505" &&
            (
              maybe.constraint === "issues_active_stalled_blocker_escalation_uq" ||
              (typeof maybe.message === "string" &&
                maybe.message.includes("issues_active_stalled_blocker_escalation_uq"))
            );
          if (!uniqueConflict) throw error;
          result.skipped += 1;
          continue;
        }

        const commentBody = buildDependentComment({
          blockerIdentifier: pair.blockerIdentifier,
          blockerId: pair.blockerId,
          blockerStatus: pair.blockerStatus,
          escalationIdentifier: escalation.identifier,
          escalationId: escalation.id,
          ctoAgentName: ctoAgent?.name ?? null,
          ctoAgentId: ctoAgent?.id ?? null,
          prefix,
        });

        await issuesSvc.addComment(dependent.id, commentBody, {});

        await logActivity(db, {
          companyId: dependent.companyId,
          actorType: "system",
          actorId: "system",
          action: "issue.stalled_blocker_escalation_created",
          entityType: "issue",
          entityId: escalation.id,
          agentId: assigneeAgentId,
          details: {
            source: "stalled_blocker_escalation.reconcile",
            dependentIssueId: dependent.id,
            blockerIssueId: pair.blockerId,
            fingerprint,
          },
        });

        if (assigneeAgentId && deps?.enqueueWakeup) {
          await deps.enqueueWakeup(assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_assigned",
            payload: {
              issueId: escalation.id,
              dependentIssueId: dependent.id,
              blockerIssueId: pair.blockerId,
            },
            requestedByActorType: "system",
            requestedByActorId: "stalled_blocker_escalation",
          });
        }

        result.created += 1;
        result.escalationIssueIds.push(escalation.id);
      } catch (err) {
        logger.error(
          { err, dependentId: pair.dependentId, blockerId: pair.blockerId, fingerprint },
          "stalled-blocker escalation: failed to create escalation",
        );
        result.failed += 1;
        result.failedPairs.push(
          `${dependent.identifier ?? dependent.id}:${pair.blockerIdentifier ?? pair.blockerId}`,
        );
      }
    }

    return result;
  }

  return { reconcileStalledBlockerEscalations };
}
