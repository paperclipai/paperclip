import type { PluginContext } from "@paperclipai/plugin-sdk";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "and", "been", "before", "being", "between", "blockers", "could",
  "cite", "did", "does", "doing", "during", "from", "have", "hour", "hours", "ids", "into", "last",
  "latest", "main", "more", "most", "outcomes", "over", "past", "please", "recent", "relevant", "show",
  "some", "than", "that", "their", "there",
  "the", "these", "they", "this", "those", "through", "today", "under", "very", "want", "were", "what",
  "when", "where", "which", "while", "with", "work", "worked", "working", "would", "yesterday",
  "your", "ours", "paperclip", "issue", "issues", "tell", "give", "hey", "wahat",
]);

export type RequestedWindow = {
  from: Date;
  to: Date;
  label: string;
  explicit: boolean;
};

export type EvidenceSource = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  href: string;
};

export type AssistantEvidence = {
  company: { id: string; name: string; issuePrefix: string };
  retrievedAt: string;
  window: { from: string; to: string; label: string; explicit: boolean };
  recentIssues: RecentIssueRow[];
  recentComments: RecentCommentRow[];
  recentRuns: RecentRunRow[];
  historicalMatches: HistoricalIssueRow[];
  blockerEdges: BlockerEdgeRow[];
  sources: EvidenceSource[];
};

type CompanyRow = { id: string; name: string; issue_prefix: string };

export type RecentIssueRow = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project_name: string | null;
  assignee_name: string | null;
  parent_identifier: string | null;
  created_at: string;
  updated_at: string;
  latest_activity_at: string;
  comment_count: string;
  run_count: string;
};

export type RecentCommentRow = {
  id: string;
  issue_id: string;
  issue_identifier: string | null;
  issue_title: string;
  author_name: string | null;
  body: string;
  created_at: string;
};

export type RecentRunRow = {
  id: string;
  issue_id: string | null;
  issue_identifier: string | null;
  issue_title: string | null;
  agent_name: string;
  status: string;
  invocation_source: string;
  trigger_detail: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  error: string | null;
};

export type HistoricalIssueRow = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  project_name: string | null;
  assignee_name: string | null;
  updated_at: string;
  matching_comment: string | null;
};

export type BlockerEdgeRow = {
  blocker_identifier: string | null;
  blocker_title: string;
  blocker_status: string;
  blocked_identifier: string | null;
  blocked_title: string;
  blocked_status: string;
};

function clampWindow(milliseconds: number): number {
  return Math.max(60_000, Math.min(MAX_WINDOW_MS, milliseconds));
}

export function parseRequestedWindow(question: string, now = new Date()): RequestedWindow {
  const normalized = question.toLowerCase();
  const amountMatch = normalized.match(
    /(?:last|past|previous)\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b/,
  );
  if (amountMatch) {
    const amount = Number(amountMatch[1]);
    const unit = amountMatch[2];
    const unitMs = unit.startsWith("min")
      ? 60_000
      : unit.startsWith("hour") || unit.startsWith("hr")
        ? 3_600_000
        : unit.startsWith("week")
          ? 7 * 86_400_000
          : 86_400_000;
    const milliseconds = clampWindow(amount * unitMs);
    return {
      from: new Date(now.getTime() - milliseconds),
      to: now,
      label: `last ${amountMatch[1]} ${unit}`,
      explicit: true,
    };
  }

  const simpleMatch = normalized.match(/(?:last|past|previous)\s+(minute|hour|day|week)\b/);
  if (simpleMatch) {
    const unit = simpleMatch[1];
    const unitMs = unit === "minute" ? 60_000 : unit === "hour" ? 3_600_000 : unit === "week" ? 604_800_000 : 86_400_000;
    return {
      from: new Date(now.getTime() - unitMs),
      to: now,
      label: `last ${unit}`,
      explicit: true,
    };
  }

  if (normalized.includes("yesterday")) {
    const startToday = new Date(now);
    startToday.setUTCHours(0, 0, 0, 0);
    return {
      from: new Date(startToday.getTime() - 86_400_000),
      to: startToday,
      label: "yesterday (UTC)",
      explicit: true,
    };
  }

  if (normalized.includes("today")) {
    const startToday = new Date(now);
    startToday.setUTCHours(0, 0, 0, 0);
    return { from: startToday, to: now, label: "today (UTC)", explicit: true };
  }

  return {
    from: new Date(now.getTime() - DEFAULT_WINDOW_MS),
    to: now,
    label: "last 24 hours (default context)",
    explicit: false,
  };
}

export function extractIssueIdentifiers(question: string): string[] {
  return [...new Set(question.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,11}-\d+\b/g) ?? [])].slice(0, 8);
}

export function extractSearchTerms(question: string): string[] {
  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && token.length <= 48 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
  return [...new Set(tokens)].slice(0, 7);
}

function issueLink(issuePrefix: string, identifier: string) {
  return `/${encodeURIComponent(issuePrefix)}/issues/${encodeURIComponent(identifier)}`;
}

function compactText(value: string | null, limit = 600): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function searchClause(question: string) {
  const identifiers = extractIssueIdentifiers(question);
  const terms = extractSearchTerms(question);
  const params: unknown[] = [];
  const clauses: string[] = [];

  for (const identifier of identifiers) {
    params.push(identifier.toLowerCase());
    clauses.push(`lower(coalesce(i.identifier, '')) = $${params.length + 1}`);
  }
  for (const term of terms) {
    params.push(`%${term}%`);
    const placeholder = `$${params.length + 1}`;
    clauses.push(`(
      i.title ILIKE ${placeholder}
      OR coalesce(i.description, '') ILIKE ${placeholder}
      OR EXISTS (
        SELECT 1 FROM issue_comments search_comment
         WHERE search_comment.company_id = i.company_id
           AND search_comment.issue_id = i.id
           AND search_comment.body ILIKE ${placeholder}
      )
    )`);
  }

  return { identifiers, terms, params, sql: clauses.length > 0 ? clauses.join(" OR ") : "false" };
}

export async function retrieveEvidence(
  ctx: PluginContext,
  companyId: string,
  question: string,
  now = new Date(),
): Promise<AssistantEvidence> {
  const window = parseRequestedWindow(question, now);
  const companyRows = await ctx.db.query<CompanyRow>(
    `SELECT id, name, issue_prefix FROM companies WHERE id = $1 LIMIT 1`,
    [companyId],
  );
  const company = companyRows[0];
  if (!company) throw new Error("Company not found");

  const recentIssues = await ctx.db.query<RecentIssueRow>(
    `SELECT i.id,
            i.identifier,
            i.title,
            left(coalesce(i.description, ''), 900) AS description,
            i.status,
            i.priority,
            p.name AS project_name,
            a.name AS assignee_name,
            parent.identifier AS parent_identifier,
            i.created_at::text AS created_at,
            i.updated_at::text AS updated_at,
            greatest(
              i.updated_at,
              coalesce((SELECT max(c.created_at) FROM issue_comments c
                         WHERE c.company_id = i.company_id AND c.issue_id = i.id), i.updated_at),
              coalesce((SELECT max(r.created_at) FROM heartbeat_runs r
                         WHERE r.company_id = i.company_id
                           AND r.context_snapshot ->> 'issueId' = i.id::text), i.updated_at)
            )::text AS latest_activity_at,
            (SELECT count(*)::text FROM issue_comments c
              WHERE c.company_id = i.company_id AND c.issue_id = i.id) AS comment_count,
            (SELECT count(*)::text FROM heartbeat_runs r
              WHERE r.company_id = i.company_id
                AND r.context_snapshot ->> 'issueId' = i.id::text
                AND r.created_at >= $2::timestamptz
                AND r.created_at <= $3::timestamptz) AS run_count
       FROM issues i
       LEFT JOIN projects p ON p.id = i.project_id AND p.company_id = i.company_id
       LEFT JOIN agents a ON a.id = i.assignee_agent_id AND a.company_id = i.company_id
       LEFT JOIN issues parent ON parent.id = i.parent_id AND parent.company_id = i.company_id
      WHERE i.company_id = $1
        AND i.hidden_at IS NULL
        AND (
          i.updated_at BETWEEN $2::timestamptz AND $3::timestamptz
          OR EXISTS (SELECT 1 FROM issue_comments c
                      WHERE c.company_id = i.company_id AND c.issue_id = i.id
                        AND c.created_at BETWEEN $2::timestamptz AND $3::timestamptz)
          OR EXISTS (SELECT 1 FROM heartbeat_runs r
                      WHERE r.company_id = i.company_id
                        AND r.context_snapshot ->> 'issueId' = i.id::text
                        AND r.created_at BETWEEN $2::timestamptz AND $3::timestamptz)
        )
      ORDER BY latest_activity_at DESC
      LIMIT 18`,
    [companyId, window.from.toISOString(), window.to.toISOString()],
  );

  const recentComments = await ctx.db.query<RecentCommentRow>(
    `SELECT c.id,
            c.issue_id,
            i.identifier AS issue_identifier,
            i.title AS issue_title,
            coalesce(a.name, c.author_user_id, c.author_type, 'Unknown') AS author_name,
            left(c.body, 800) AS body,
            c.created_at::text AS created_at
       FROM issue_comments c
       JOIN issues i ON i.id = c.issue_id AND i.company_id = c.company_id
       LEFT JOIN agents a ON a.id = c.author_agent_id AND a.company_id = c.company_id
      WHERE c.company_id = $1
        AND i.hidden_at IS NULL
        AND c.created_at BETWEEN $2::timestamptz AND $3::timestamptz
      ORDER BY c.created_at DESC
      LIMIT 30`,
    [companyId, window.from.toISOString(), window.to.toISOString()],
  );

  const recentRuns = await ctx.db.query<RecentRunRow>(
    `SELECT r.id,
            r.context_snapshot ->> 'issueId' AS issue_id,
            i.identifier AS issue_identifier,
            i.title AS issue_title,
            a.name AS agent_name,
            r.status,
            r.invocation_source,
            r.trigger_detail,
            r.started_at::text AS started_at,
            r.finished_at::text AS finished_at,
            r.created_at::text AS created_at,
            left(r.error, 500) AS error
       FROM heartbeat_runs r
       JOIN agents a ON a.id = r.agent_id AND a.company_id = r.company_id
       LEFT JOIN issues i ON i.id::text = r.context_snapshot ->> 'issueId' AND i.company_id = r.company_id
      WHERE r.company_id = $1
        AND coalesce(a.metadata -> 'pluginManagedAgent' ->> 'pluginKey', '') <> 'paperclipai.plugin-operator-assistant'
        AND r.created_at BETWEEN $2::timestamptz AND $3::timestamptz
      ORDER BY r.created_at DESC
      LIMIT 30`,
    [companyId, window.from.toISOString(), window.to.toISOString()],
  );

  const search = searchClause(question);
  const historicalMatches = search.params.length === 0
    ? []
    : await ctx.db.query<HistoricalIssueRow>(
        `SELECT i.id,
                i.identifier,
                i.title,
                left(coalesce(i.description, ''), 900) AS description,
                i.status,
                p.name AS project_name,
                a.name AS assignee_name,
                i.updated_at::text AS updated_at,
                (SELECT left(c.body, 700)
                   FROM issue_comments c
                  WHERE c.company_id = i.company_id
                    AND c.issue_id = i.id
                    AND (${search.terms.length > 0
                      ? search.terms.map((_, index) => `c.body ILIKE $${2 + search.identifiers.length + index}`).join(" OR ")
                      : "false"})
                  ORDER BY c.created_at DESC
                  LIMIT 1) AS matching_comment
           FROM issues i
           LEFT JOIN projects p ON p.id = i.project_id AND p.company_id = i.company_id
           LEFT JOIN agents a ON a.id = i.assignee_agent_id AND a.company_id = i.company_id
          WHERE i.company_id = $1
            AND i.hidden_at IS NULL
            AND (${search.sql})
          ORDER BY CASE WHEN ${search.identifiers.length > 0
            ? `(${search.identifiers.map((_, index) => `lower(coalesce(i.identifier, '')) = $${index + 2}`).join(" OR ")})`
            : "false"} THEN 0 ELSE 1 END,
                   i.updated_at DESC
          LIMIT 12`,
        [companyId, ...search.params],
      );

  const relevantIds = [...new Set([
    ...recentIssues.map((issue) => issue.id),
    ...historicalMatches.map((issue) => issue.id),
  ])];
  const blockerEdges = relevantIds.length === 0
    ? []
    : await ctx.db.query<BlockerEdgeRow>(
        `SELECT blocker.identifier AS blocker_identifier,
                blocker.title AS blocker_title,
                blocker.status AS blocker_status,
                blocked.identifier AS blocked_identifier,
                blocked.title AS blocked_title,
                blocked.status AS blocked_status
           FROM issue_relations rel
           JOIN issues blocker ON blocker.id = rel.issue_id AND blocker.company_id = rel.company_id
           JOIN issues blocked ON blocked.id = rel.related_issue_id AND blocked.company_id = rel.company_id
          WHERE rel.company_id = $1
            AND rel.type = 'blocks'
            AND (
              rel.issue_id IN (${relevantIds.map((_, index) => `$${index + 2}`).join(", ")})
              OR rel.related_issue_id IN (${relevantIds.map((_, index) => `$${index + 2}`).join(", ")})
            )
          ORDER BY rel.created_at DESC
          LIMIT 24`,
        [companyId, ...relevantIds],
      );

  const sourceMap = new Map<string, EvidenceSource>();
  for (const issue of [...recentIssues, ...historicalMatches]) {
    if (!issue.identifier) continue;
    sourceMap.set(issue.id, {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      href: issueLink(company.issue_prefix, issue.identifier),
    });
  }

  return {
    company: { id: company.id, name: company.name, issuePrefix: company.issue_prefix },
    retrievedAt: now.toISOString(),
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      label: window.label,
      explicit: window.explicit,
    },
    recentIssues: recentIssues.map((row) => ({ ...row, description: compactText(row.description, 900) })),
    recentComments: recentComments.map((row) => ({ ...row, body: compactText(row.body, 800) ?? "" })),
    recentRuns: recentRuns.map((row) => ({ ...row, error: compactText(row.error, 500) })),
    historicalMatches: historicalMatches.map((row) => ({
      ...row,
      description: compactText(row.description, 900),
      matching_comment: compactText(row.matching_comment, 700),
    })),
    blockerEdges,
    sources: [...sourceMap.values()].slice(0, 16),
  };
}

export function buildGroundedPrompt(question: string, evidence: AssistantEvidence): string {
  return [
    "Answer the operator's question from the Paperclip evidence below.",
    `Requested question: ${question}`,
    `Evidence time window: ${evidence.window.label} (${evidence.window.from} to ${evidence.window.to})`,
    "Use issue identifiers when attributing facts. Distinguish work activity from issue metadata updates. Do not infer completion from a run merely starting. If there is not enough evidence, say so.",
    "Evidence JSON:",
    JSON.stringify({
      company: evidence.company,
      retrievedAt: evidence.retrievedAt,
      window: evidence.window,
      recentIssues: evidence.recentIssues,
      recentComments: evidence.recentComments,
      recentRuns: evidence.recentRuns,
      historicalMatches: evidence.historicalMatches,
      blockerEdges: evidence.blockerEdges,
    }),
  ].join("\n\n");
}
