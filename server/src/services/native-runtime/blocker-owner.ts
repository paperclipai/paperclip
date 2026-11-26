import { agents, type Db } from "@paperclipai/db";
import { isUuidLike, normalizeAgentUrlKey } from "@paperclipai/shared";
import { and, eq, ne } from "drizzle-orm";

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
