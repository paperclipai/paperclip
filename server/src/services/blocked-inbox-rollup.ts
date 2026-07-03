import { agents, type Db } from "@paperclipai/db";
import type { Issue, IssueBlockedInboxAttention } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { issueService } from "./issues.js";

export const BLOCKED_INBOX_ROLLUP_BUCKETS = ["CEO", "EM", "MM", "OM", "founder", "external", "other"] as const;

export type BlockedInboxRollupBucket = typeof BLOCKED_INBOX_ROLLUP_BUCKETS[number];

type BlockedInboxIssue = Issue & {
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  lastActivityAt?: Date | string | null;
};

export interface BlockedInboxRollupIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  state: IssueBlockedInboxAttention["state"];
  reason: IssueBlockedInboxAttention["reason"];
  ownerBucket: BlockedInboxRollupBucket;
  ownerLabel: string;
  stoppedSinceAt: string | null;
  ageDays: number | null;
  actionLabel: string;
  actionDetail: string | null;
}

export interface BlockedInboxRollup {
  generatedAt: string;
  totalBlocked: number;
  stateCounts: Record<IssueBlockedInboxAttention["state"], number>;
  ownerBuckets: Record<BlockedInboxRollupBucket, number>;
  staleCloseCandidates: BlockedInboxRollupIssueSummary[];
  founderDigestCandidates: BlockedInboxRollupIssueSummary[];
  items: BlockedInboxRollupIssueSummary[];
}

interface AgentBucketInfo {
  name: string | null;
  role: string | null;
  title: string | null;
}

export interface BuildBlockedInboxRollupOptions {
  generatedAt?: Date;
  staleAfterDays?: number;
}

function emptyStateCounts(): BlockedInboxRollup["stateCounts"] {
  return {
    needs_attention: 0,
    awaiting_decision: 0,
    external_wait: 0,
    recovery_open: 0,
    missing_disposition: 0,
  };
}

function emptyOwnerBuckets(): BlockedInboxRollup["ownerBuckets"] {
  return {
    CEO: 0,
    EM: 0,
    MM: 0,
    OM: 0,
    founder: 0,
    external: 0,
    other: 0,
  };
}

function parseDateMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ageDaysSince(value: string | Date | null | undefined, generatedAt: Date): number | null {
  const ms = parseDateMs(value);
  if (ms === null) return null;
  return Math.max(0, Math.floor((generatedAt.getTime() - ms) / 86_400_000));
}

function agentBucket(agent: AgentBucketInfo | null | undefined): BlockedInboxRollupBucket {
  if (!agent) return "other";
  const haystack = [agent.name, agent.role, agent.title].filter(Boolean).join(" ").toLowerCase();
  if (/\b(ceo|chief executive)\b/.test(haystack)) return "CEO";
  if (/\b(engineering manager|eng manager|em)\b/.test(haystack)) return "EM";
  if (/\b(marketing manager|growth manager|mm)\b/.test(haystack)) return "MM";
  if (/\b(operations manager|ops manager|om)\b/.test(haystack)) return "OM";
  return "other";
}

function ownerBucketForAttention(
  attention: IssueBlockedInboxAttention,
  agentById: ReadonlyMap<string, AgentBucketInfo>,
): BlockedInboxRollupBucket {
  if (attention.owner.type === "external") return "external";
  if (attention.owner.type === "board" || attention.owner.type === "user") return "founder";
  if (attention.owner.type === "agent" && attention.owner.agentId) {
    return agentBucket(agentById.get(attention.owner.agentId));
  }
  return "other";
}

function ownerLabelForAttention(
  attention: IssueBlockedInboxAttention,
  agentById: ReadonlyMap<string, AgentBucketInfo>,
) {
  if (attention.owner.label) return attention.owner.label;
  if (attention.owner.type === "external") return "External";
  if (attention.owner.type === "board") return "Board/founder";
  if (attention.owner.type === "user") return "Founder/user";
  if (attention.owner.type === "agent" && attention.owner.agentId) {
    const agent = agentById.get(attention.owner.agentId);
    return agent?.name ?? agent?.title ?? agent?.role ?? attention.owner.agentId;
  }
  return "Unknown";
}

function compareCandidateIssues(left: BlockedInboxRollupIssueSummary, right: BlockedInboxRollupIssueSummary) {
  const leftAge = left.ageDays ?? -1;
  const rightAge = right.ageDays ?? -1;
  if (leftAge !== rightAge) return rightAge - leftAge;
  return (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title);
}

export function buildBlockedInboxRollup(
  issues: BlockedInboxIssue[],
  agentById: ReadonlyMap<string, AgentBucketInfo>,
  options: BuildBlockedInboxRollupOptions = {},
): BlockedInboxRollup {
  const generatedAt = options.generatedAt ?? new Date();
  const staleAfterDays = options.staleAfterDays ?? 14;
  const stateCounts = emptyStateCounts();
  const ownerBuckets = emptyOwnerBuckets();
  const items: BlockedInboxRollupIssueSummary[] = [];

  for (const issue of issues) {
    const attention = issue.blockedInboxAttention;
    if (!attention) continue;
    const ownerBucket = ownerBucketForAttention(attention, agentById);
    const ageDays = ageDaysSince(attention.stoppedSinceAt ?? issue.updatedAt, generatedAt);
    stateCounts[attention.state] = (stateCounts[attention.state] ?? 0) + 1;
    ownerBuckets[ownerBucket] += 1;
    items.push({
      id: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      state: attention.state,
      reason: attention.reason,
      ownerBucket,
      ownerLabel: ownerLabelForAttention(attention, agentById),
      stoppedSinceAt: attention.stoppedSinceAt,
      ageDays,
      actionLabel: attention.action.label,
      actionDetail: attention.action.detail,
    });
  }

  return {
    generatedAt: generatedAt.toISOString(),
    totalBlocked: items.length,
    stateCounts,
    ownerBuckets,
    staleCloseCandidates: items
      .filter((item) => item.ageDays !== null && item.ageDays >= staleAfterDays)
      .sort(compareCandidateIssues),
    founderDigestCandidates: items
      .filter((item) => item.ownerBucket === "founder" || item.ownerBucket === "external")
      .sort(compareCandidateIssues),
    items,
  };
}

function formatCountMap<T extends string>(entries: readonly T[], counts: Record<T, number>) {
  return entries.map((entry) => `- ${entry}: ${counts[entry] ?? 0}`).join("\n");
}

function formatIssueLine(item: BlockedInboxRollupIssueSummary) {
  const id = item.identifier ?? item.id;
  const age = item.ageDays === null ? "age unknown" : `${item.ageDays}d`;
  return `- ${id} (${item.ownerBucket}, ${item.state}, ${age}): ${item.title} -> ${item.actionLabel}`;
}

export function renderBlockedInboxRollupMarkdown(rollup: BlockedInboxRollup) {
  const stale = rollup.staleCloseCandidates.length > 0
    ? rollup.staleCloseCandidates.slice(0, 25).map(formatIssueLine).join("\n")
    : "- None";
  const founder = rollup.founderDigestCandidates.length > 0
    ? rollup.founderDigestCandidates.slice(0, 25).map(formatIssueLine).join("\n")
    : "- None";

  return [
    `# Blocked Inbox Rollup - ${rollup.generatedAt}`,
    "",
    `Total blocked inbox items: ${rollup.totalBlocked}`,
    "",
    "## Owner Buckets",
    formatCountMap(BLOCKED_INBOX_ROLLUP_BUCKETS, rollup.ownerBuckets),
    "",
    "## Attention States",
    `- awaiting_decision: ${rollup.stateCounts.awaiting_decision}`,
    `- needs_attention: ${rollup.stateCounts.needs_attention}`,
    `- external_wait: ${rollup.stateCounts.external_wait}`,
    `- recovery_open: ${rollup.stateCounts.recovery_open}`,
    `- missing_disposition: ${rollup.stateCounts.missing_disposition}`,
    "",
    "## Proposed Close Candidates (>14d stale)",
    stale,
    "",
    "## Founder Digest Candidates",
    founder,
  ].join("\n");
}

export function blockedInboxRollupService(db: Db) {
  return {
    async build(companyId: string, options: BuildBlockedInboxRollupOptions = {}) {
      const rows = await issueService(db).list(companyId, {
        attention: "blocked",
        status: "blocked",
        includeBlockedInboxAttention: true,
      }) as BlockedInboxIssue[];
      const agentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          title: agents.title,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      return buildBlockedInboxRollup(
        rows,
        new Map(agentRows.map((agent) => [agent.id, agent])),
        options,
      );
    },
  };
}
