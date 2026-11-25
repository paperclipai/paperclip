import { agents, chatConversations, type Db } from "@paperclipai/db";
import { isUuidLike, normalizeAgentUrlKey } from "@paperclipai/shared";
import { and, eq, ne } from "drizzle-orm";
import { HttpError } from "../../errors.js";
import { isConversation } from "../agent-conversations.js";
import { assertAssignableAgent } from "../agent-assignability.js";
import { agentInteractionDenial } from "../agent-interaction-policy.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";

/**
 * The owner a blocked report names, resolved against the company.
 * `board` covers the board and named people; `agent` is a resolved agent;
 * `unresolved` is an agent name that matches no agent or more than one.
 */
export type NativeBlockerOwnerResolution =
  | { kind: "board" }
  | { kind: "agent"; agentId: string }
  | { kind: "unresolved"; name: string | null; ambiguous: boolean }
  | { kind: "unspecified" };

export type BlockerHandoffEligibility =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "not_task_owner"
        | "conversation_or_chat_locked"
        | "unavailable"
        | "unassignable"
        | "interaction_denied";
      message: string;
    };

type AgentRow = { id: string; name: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function initials(name: string): string | null {
  const words = normalizeAgentUrlKey(name)?.split("-") ?? [];
  return words.length > 1 ? words.map((word) => word[0]).join("") : null;
}

function foldName(name: string): string {
  return name.trim().normalize("NFC").toLocaleLowerCase();
}

/**
 * Match an agent reference by exact ID, then by exact name (case-folded, so
 * non-ASCII names match), then by URL-key name, then by the name's initials
 * ("RDL" for "Release Desk Lead"). A tier with several matches is ambiguous;
 * it never falls through to a looser tier.
 */
export function matchBlockerOwnerAgent(rows: readonly AgentRow[], reference: string):
  { agentId: string; ambiguous?: never } | { agentId: null; ambiguous: boolean } {
  const raw = reference.trim();
  if (isUuidLike(raw)) {
    const byId = rows.find((row) => row.id.toLowerCase() === raw.toLowerCase());
    return byId ? { agentId: byId.id } : { agentId: null, ambiguous: false };
  }
  const folded = foldName(raw);
  const key = normalizeAgentUrlKey(raw);
  if (!folded) return { agentId: null, ambiguous: false };
  for (const tier of [
    (row: AgentRow) => foldName(row.name) === folded,
    (row: AgentRow) => Boolean(key) && normalizeAgentUrlKey(row.name) === key,
    (row: AgentRow) => Boolean(key) && initials(row.name) === key,
  ]) {
    const matches = rows.filter(tier);
    if (matches.length === 1) return { agentId: matches[0]!.id };
    if (matches.length > 1) return { agentId: null, ambiguous: true };
  }
  return { agentId: null, ambiguous: false };
}

/** Resolve a provider-reported `blocker.owner` without trusting its shape. */
export async function resolveNativeBlockerOwner(
  db: Db,
  input: { companyId: string; owner: unknown; lockSources?: boolean },
): Promise<NativeBlockerOwnerResolution> {
  const owner = record(input.owner);
  if (owner.kind === "board" || owner.owner === "board") return { kind: "board" };
  // A person cannot be woken as an agent; the board is where people act.
  if (owner.kind === "user") return { kind: "board" };
  if (owner.kind !== "agent") return { kind: "unspecified" };
  const name = typeof owner.name === "string" && owner.name.trim() ? owner.name.trim() : null;
  if (!name) return { kind: "unresolved", name: null, ambiguous: false };
  const query = db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(and(eq(agents.companyId, input.companyId), ne(agents.status, "terminated")));
  const rows = await (input.lockSources ? query.for("share", { noWait: true }) : query);
  const match = matchBlockerOwnerAgent(rows, name);
  return match.agentId
    ? { kind: "agent", agentId: match.agentId }
    : { kind: "unresolved", name, ambiguous: match.ambiguous ?? false };
}

/** Tasks bound to an external chat channel lock their agent assignment (`chat_binding_agent_locked`). */
export async function hasExternalChatBinding(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<boolean> {
  const [binding] = await db
    .select({ id: chatConversations.id })
    .from(chatConversations)
    .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issueId)))
    .limit(1);
  return Boolean(binding);
}

/**
 * Single authority check for handing a blocked task to another named agent.
 * Shared across report-time feedback, finalizer arbitration, and the committer's
 * under-lock recheck so all three layers enforce the exact same invariants.
 */
export async function evaluateBlockerAgentHandoff(
  db: Db,
  input: {
    companyId: string;
    issue: {
      id: string;
      conversationAgentId: string | null;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
    };
    actorAgentId: string | null;
    targetAgentId: string;
    unblockAction: string;
    requireTaskOwner?: boolean;
    lockSources?: boolean;
  },
): Promise<BlockerHandoffEligibility> {
  if (
    input.requireTaskOwner &&
    (!input.actorAgentId || input.issue.assigneeUserId || input.issue.assigneeAgentId !== input.actorAgentId)
  ) {
    return {
      allowed: false,
      reason: "not_task_owner",
      message: "Only the task's current assignee can hand this task off to another agent.",
    };
  }
  if (isConversation(input.issue) || await hasExternalChatBinding(db, input.companyId, input.issue.id)) {
    return {
      allowed: false,
      reason: "conversation_or_chat_locked",
      message: 'This task is bound to a conversation or external chat channel, so its agent assignment cannot be handed off to another agent. Create a separate task for that agent or report a person-owned blocker with kind "user".',
    };
  }
  const agentQuery = db.select().from(agents).where(and(
    eq(agents.id, input.targetAgentId),
    eq(agents.companyId, input.companyId),
  )).limit(1);
  const [ownerAgent] = await (input.lockSources ? agentQuery.for("share", { noWait: true }) : agentQuery);
  if (!ownerAgent || ownerAgent.status === "terminated" || !(await evaluateAgentInvokabilityFromDb(db, ownerAgent)).invokable) {
    return {
      allowed: false,
      reason: "unavailable",
      message: "The named blocker owner is not available in this company. Choose an available agent or name a person.",
    };
  }
  try {
    await assertAssignableAgent(db, input.companyId, input.targetAgentId, { kind: "work" });
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        allowed: false,
        reason: "unassignable",
        message: `The named blocker owner cannot be assigned this task: ${error.message}. Choose an available agent or name a person.`,
      };
    }
    throw error;
  }
  const denial = await agentInteractionDenial(db, {
    companyId: input.companyId,
    actorAgentId: input.actorAgentId,
    operation: "assign",
    issueId: input.issue.id,
    targetAgentId: input.targetAgentId,
    texts: [input.unblockAction],
    lock: input.lockSources,
  });
  if (denial) {
    return {
      allowed: false,
      reason: "interaction_denied",
      message: `The named blocker owner cannot receive this task: agent interaction is disabled by ${denial.permission}. Choose another agent or name a person.`,
    };
  }
  return { allowed: true };
}
