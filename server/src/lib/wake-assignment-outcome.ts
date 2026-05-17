/**
 * Wake assignment guardrail parity with Meetery `wakeGuardrail` (GST-77 / GST-80 / GST-84).
 * Used for inbox-lite `assignmentOutcome` and `PAPERCLIP_ASSIGNMENT_OUTCOME_JSON` on timer wakes.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";

export const ASSIGNMENT_OUTCOME_SCHEMA_VERSION = 1 as const;

export type CharterParentRef = {
  id: string;
  identifier: string;
  title: string;
};

export type RoutineProjectionInput = {
  nextRunAt: string;
  routineId?: string;
};

export type WakeAssignmentCandidate = {
  issueId: string;
  assigneeAgentId?: string | null;
  blockedByOwnerId?: string | null;
  blockedReason?: string | null;
};

export type WakePolicyInput = {
  retryAttempt: number;
  maxRetries: number;
  candidates: WakeAssignmentCandidate[];
  routine?: RoutineProjectionInput | null;
  charterParent?: CharterParentRef | null;
};

export type WakeGuardrailResult =
  | {
      schemaVersion: typeof ASSIGNMENT_OUTCOME_SCHEMA_VERSION;
      kind: "issue_assigned";
      issueId: string;
      assigneeAgentId: string;
      reason: string;
      userVisible: string;
    }
  | {
      schemaVersion: typeof ASSIGNMENT_OUTCOME_SCHEMA_VERSION;
      kind: "blocked_with_owner";
      issueId: string;
      blockedByOwnerId: string;
      reason: string;
      userVisible: string;
    }
  | {
      schemaVersion: typeof ASSIGNMENT_OUTCOME_SCHEMA_VERSION;
      kind: "idle_with_reason";
      reason: string;
      userVisible: string;
      nextRoutineAt?: string;
      routineId?: string;
      charterParent?: CharterParentRef;
    };

export type EnforceRetryWakeOptions = {
  routine?: RoutineProjectionInput | null;
  charterParent?: CharterParentRef | null;
};

function normalizeReason(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isViableCandidate(candidate: WakeAssignmentCandidate): boolean {
  return Boolean(candidate.assigneeAgentId) || Boolean(candidate.blockedByOwnerId);
}

function selectDeterministicCandidate(
  candidates: WakeAssignmentCandidate[],
): WakeAssignmentCandidate | null {
  const viable = candidates.filter(isViableCandidate);
  if (viable.length === 0) return null;
  const ordered = [...viable].sort((a, b) => a.issueId.localeCompare(b.issueId));
  return ordered[0] ?? null;
}

function charterSentence(parent: CharterParentRef): string {
  return `Parent charter: ${parent.identifier} — ${parent.title}.`;
}

function buildIdleUserVisible(params: {
  idleKind: "empty_inbox" | "retry_exhausted" | "integrity";
  retryAttempt?: number;
  routine?: RoutineProjectionInput | null;
  charterParent?: CharterParentRef | null;
}): string {
  const { idleKind, retryAttempt, routine, charterParent } = params;
  const sentences: string[] = [];

  if (idleKind === "integrity") {
    sentences.push(
      "Recovered an empty wake assignment from the guardrail integrity path. If this repeats across heartbeats, capture logs and escalate to support.",
    );
    if (typeof retryAttempt === "number") {
      sentences.push(`Retry attempt index: ${retryAttempt}.`);
    }
  } else if (idleKind === "retry_exhausted") {
    sentences.push(
      "No assignable issue remained after exhausting the empty-inbox retry budget for this wake.",
    );
  } else {
    sentences.push(
      "No open assigned issues are available in this heartbeat's inbox candidate list.",
    );
  }

  if (routine?.nextRunAt) {
    sentences.push(`Next routine heartbeat is scheduled for ${routine.nextRunAt} (UTC).`);
  } else if (idleKind !== "integrity") {
    sentences.push(
      "No routine enqueue time is on record for this agent (intentional idle until configuration changes).",
    );
  }

  if (charterParent) {
    sentences.push(charterSentence(charterParent));
  }

  return sentences.join(" ");
}

export function evaluateWakeAssignment(input: WakePolicyInput): WakeGuardrailResult {
  const candidate = selectDeterministicCandidate(input.candidates);
  if (candidate?.assigneeAgentId) {
    const issueId = candidate.issueId;
    return {
      schemaVersion: ASSIGNMENT_OUTCOME_SCHEMA_VERSION,
      kind: "issue_assigned",
      issueId,
      assigneeAgentId: candidate.assigneeAgentId,
      reason: "candidate contains an assigned agent",
      userVisible: `Assigned issue ${issueId} is the next unit of work to execute for this agent.`,
    };
  }

  if (candidate?.blockedByOwnerId) {
    const human =
      normalizeReason(candidate.blockedReason) ??
      "candidate is blocked and has an explicit owner";
    return {
      schemaVersion: ASSIGNMENT_OUTCOME_SCHEMA_VERSION,
      kind: "blocked_with_owner",
      issueId: candidate.issueId,
      blockedByOwnerId: candidate.blockedByOwnerId,
      reason: human,
      userVisible: `Issue ${candidate.issueId} is blocked; unblock owner is ${candidate.blockedByOwnerId}. ${human}`,
    };
  }

  const saturatedRetries = input.retryAttempt >= input.maxRetries;
  const reason = saturatedRetries
    ? "retry budget exhausted without assignable or owned-blocked work"
    : "no assignable issues in this retry cycle";

  const userVisible = buildIdleUserVisible({
    idleKind: saturatedRetries ? "retry_exhausted" : "empty_inbox",
    routine: input.routine,
    charterParent: input.charterParent,
  });

  return {
    schemaVersion: ASSIGNMENT_OUTCOME_SCHEMA_VERSION,
    kind: "idle_with_reason",
    reason,
    userVisible,
    ...(input.routine?.nextRunAt
      ? {
          nextRoutineAt: input.routine.nextRunAt,
          ...(input.routine.routineId ? { routineId: input.routine.routineId } : {}),
        }
      : {}),
    ...(input.charterParent ? { charterParent: input.charterParent } : {}),
  };
}

export function enforceNonEmptyRetryWakeResult(
  maybeResult: WakeGuardrailResult | null | undefined,
  retryAttempt: number,
  options?: EnforceRetryWakeOptions,
): WakeGuardrailResult {
  if (maybeResult) return maybeResult;
  const reason = `integrity guard: empty wake result recovered at retry ${retryAttempt}`;
  return {
    schemaVersion: ASSIGNMENT_OUTCOME_SCHEMA_VERSION,
    kind: "idle_with_reason",
    reason,
    userVisible: buildIdleUserVisible({
      idleKind: "integrity",
      retryAttempt,
      routine: options?.routine,
      charterParent: options?.charterParent,
    }),
    ...(options?.routine?.nextRunAt
      ? {
          nextRoutineAt: options.routine.nextRunAt,
          ...(options.routine.routineId ? { routineId: options.routine.routineId } : {}),
        }
      : {}),
    ...(options?.charterParent ? { charterParent: options.charterParent } : {}),
  };
}

export function serializeWakeGuardrailResult(result: WakeGuardrailResult): string {
  return JSON.stringify(result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWakeGuardrailResultJson(raw: string): WakeGuardrailResult | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== ASSIGNMENT_OUTCOME_SCHEMA_VERSION) return null;
    const kind = parsed.kind;
    if (kind === "issue_assigned") {
      if (
        typeof parsed.issueId === "string" &&
        typeof parsed.assigneeAgentId === "string" &&
        typeof parsed.reason === "string" &&
        typeof parsed.userVisible === "string"
      ) {
        return parsed as WakeGuardrailResult;
      }
      return null;
    }
    if (kind === "blocked_with_owner") {
      if (
        typeof parsed.issueId === "string" &&
        typeof parsed.blockedByOwnerId === "string" &&
        typeof parsed.reason === "string" &&
        typeof parsed.userVisible === "string"
      ) {
        return parsed as WakeGuardrailResult;
      }
      return null;
    }
    if (kind === "idle_with_reason") {
      if (typeof parsed.reason === "string" && typeof parsed.userVisible === "string") {
        return parsed as WakeGuardrailResult;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

export type InboxLiteIssueRow = {
  id: string;
  status: string;
  assigneeAgentId: string | null;
};

export type IssueDependencyReadinessLite = {
  unresolvedBlockerIssueIds?: string[];
};

export function issuesToWakeCandidates(
  rows: InboxLiteIssueRow[],
  dependencyReadiness: Map<string, IssueDependencyReadinessLite>,
  blockerAssigneeByIssueId: ReadonlyMap<string, string | null>,
): WakeAssignmentCandidate[] {
  return rows.map((row) => {
    const dep = dependencyReadiness.get(row.id);
    const blockerIds = dep?.unresolvedBlockerIssueIds ?? [];
    let blockedByOwnerId: string | null = null;
    let blockedReason: string | null = null;
    if (blockerIds.length > 0) {
      const ordered = [...blockerIds].sort((a, b) => a.localeCompare(b));
      for (const bid of ordered) {
        const owner = blockerAssigneeByIssueId.get(bid) ?? null;
        if (owner) {
          blockedByOwnerId = owner;
          blockedReason = "blocked by unresolved dependency with assignee owner";
          break;
        }
      }
    }
    return {
      issueId: row.id,
      assigneeAgentId: row.assigneeAgentId,
      blockedByOwnerId,
      blockedReason,
    };
  });
}

export function defaultInboxLiteRetryWindow(): { retryAttempt: number; maxRetries: number } {
  return { retryAttempt: 0, maxRetries: 3 };
}

export function resolveRetryWindowFromWakeContext(context: Record<string, unknown>): {
  retryAttempt: number;
  maxRetries: number;
} {
  const def = defaultInboxLiteRetryWindow();
  const attemptRaw = context.emptyInboxWakeRetryAttempt ?? context.retryAttempt;
  const maxRaw = context.emptyInboxWakeRetryMax ?? context.maxRetries;
  const retryAttempt =
    typeof attemptRaw === "number" && Number.isFinite(attemptRaw)
      ? Math.max(0, Math.trunc(attemptRaw))
      : def.retryAttempt;
  const maxRetries =
    typeof maxRaw === "number" && Number.isFinite(maxRaw) ? Math.max(0, Math.trunc(maxRaw)) : def.maxRetries;
  return { retryAttempt, maxRetries };
}

export async function fetchAssigneesForIssueIds(
  db: Db,
  companyId: string,
  ids: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
  for (const row of rows) {
    map.set(row.id, row.assigneeAgentId);
  }
  return map;
}

export function collectUnresolvedBlockerIds(
  dependencyReadiness: Map<string, IssueDependencyReadinessLite>,
): string[] {
  const out = new Set<string>();
  for (const dep of dependencyReadiness.values()) {
    for (const id of dep.unresolvedBlockerIssueIds ?? []) {
      out.add(id);
    }
  }
  return [...out];
}

export function computeSharedInboxLiteAssignmentOutcome(input: {
  rows: InboxLiteIssueRow[];
  dependencyReadiness: Map<string, IssueDependencyReadinessLite>;
  blockerAssigneeByIssueId: ReadonlyMap<string, string | null>;
  retryAttempt: number;
  maxRetries: number;
}): WakeGuardrailResult {
  const candidates = issuesToWakeCandidates(
    input.rows,
    input.dependencyReadiness,
    input.blockerAssigneeByIssueId,
  );
  return enforceNonEmptyRetryWakeResult(
    evaluateWakeAssignment({
      retryAttempt: input.retryAttempt,
      maxRetries: input.maxRetries,
      candidates,
    }),
    input.retryAttempt,
  );
}
