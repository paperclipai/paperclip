import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, standupPolicies } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";

export const STANDUP_FALLBACK_ORIGIN_KIND = "standup_fallback";

export function standupFallbackFingerprint(agentId: string, quotaResetsAt: string): string {
  return `standup_fallback:weekly:${agentId}:${quotaResetsAt}`;
}

async function findCeoAgentId(db: Db, companyId: string): Promise<string | null> {
  const result = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
    .orderBy(agents.createdAt)
    .limit(1);
  return result[0]?.id ?? null;
}

async function isStandupParticipant(db: Db, companyId: string, agentId: string): Promise<boolean> {
  const result = await db
    .select({ id: standupPolicies.id })
    .from(standupPolicies)
    .where(
      and(
        eq(standupPolicies.companyId, companyId),
        eq(standupPolicies.status, "active"),
        sql`${standupPolicies.participantAgentIds} @> ${JSON.stringify([agentId])}::jsonb`,
      ),
    )
    .limit(1);
  return result.length > 0;
}

async function hasOpenFallbackForWindow(db: Db, companyId: string, fingerprint: string): Promise<boolean> {
  const result = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, STANDUP_FALLBACK_ORIGIN_KIND),
        eq(issues.originFingerprint, fingerprint),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .limit(1);
  return result.length > 0;
}

const STANDUP_TEMPLATE = `## Standup Fallback — CRO claude_local quota exhausted

The CRO's claude_local adapter hit its weekly quota limit and cannot run until the quota resets. Fill in this standup manually or reassign to an agent with remaining quota.

---

## CAR Daily Standup — Manual Submission

Fill in all 19 required fields and submit this issue as \`done\` when complete.

| Field | Value |
|-------|-------|
| whatHappened | |
| why | |
| nextAction | |
| owner | |
| dueTime | |
| proofTarget | |
| blockerOrAuthorityGap | |
| immediateActionTaken | |
| historicalContext | |
| decisionPosition | |
| dissentOrChallenge | |
| existentialRiskAssessment | |
| commandersIntent | |
| evidenceInputs | |
| opportunityCase | |
| failureCase | |
| riskCase | |
| roleVote | |
| chosenPaperAction | |

---

**Schema meaning:** Each leader must explain what happened, why, what action is next, who owns it, when it is due, where proof will appear, what authority gap exists if any, what immediate action was taken, what recent history they used, whether they agree or disagree with any halt/blocking decision, what dissent or challenge they are raising, whether a full-company halt is putting the company and leadership roles at risk, the plain-English commander's intent that names the chosen paper-work-forward action, the evidence they read this run, the best case for moving forward, the best case against the current path or halt, the risk view, their explicit agree/disagree/challenge vote, and the concrete paper-only action they choose.`;

/**
 * Creates a standup fallback issue when a claude_local agent's heartbeat fails
 * due to weekly quota exhaustion and the agent is a standup participant.
 *
 * Deduplicates per (agentId, quotaResetsAt) so exactly one open fallback
 * issue exists per quota window per agent.
 */
export async function checkAndFireStandupFallback(
  db: Db,
  companyId: string,
  agentId: string,
  quotaResetsAt: string | null,
): Promise<void> {
  try {
    const isParticipant = await isStandupParticipant(db, companyId, agentId);
    if (!isParticipant) {
      logger.debug({ companyId, agentId }, "standup-fallback: agent is not a standup participant, skipping");
      return;
    }

    const windowKey = quotaResetsAt ?? "unknown";
    const fingerprint = standupFallbackFingerprint(agentId, windowKey);

    const alreadyOpen = await hasOpenFallbackForWindow(db, companyId, fingerprint);
    if (alreadyOpen) {
      logger.debug({ companyId, agentId, fingerprint }, "standup-fallback: open fallback already exists, skipping");
      return;
    }

    const ceoAgentId = await findCeoAgentId(db, companyId);

    const resetLabel = quotaResetsAt ? ` (quota resets ${quotaResetsAt})` : "";
    const title = `[STANDUP FALLBACK] CRO quota-exhausted — manual standup required${resetLabel}`;

    const issuesSvc = issueService(db);
    await issuesSvc.create(companyId, {
      title,
      description: STANDUP_TEMPLATE,
      status: "todo",
      priority: "high",
      assigneeAgentId: ceoAgentId ?? undefined,
      originKind: STANDUP_FALLBACK_ORIGIN_KIND,
      originFingerprint: fingerprint,
    });

    logger.info(
      { companyId, agentId, quotaResetsAt, fingerprint },
      "standup-fallback: created standup fallback issue",
    );
  } catch (err) {
    logger.warn({ err, companyId, agentId }, "standup-fallback: failed to create fallback issue");
  }
}
