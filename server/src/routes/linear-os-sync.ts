import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { type Db, issues as issuesTable, agents as agentsTable } from "@valadrien-os/db";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/activity-log.js";

/**
 * One-way bridge: Linear issues labeled `os:dispatch` (and not yet `os:synced`) become
 * ValAdrien OS tasks, routed by provenance, then get `os:synced` written back to Linear.
 *
 * Deterministic + idempotent — runs on a Vercel cron (see `vercel.json`); no-op if
 * `LINEAR_API_KEY` is unset. Design + rationale:
 * `dotfiles/bridges/sentry-braintrust-to-linear-to-os.md`. Linear = human/planning layer,
 * ValAdrien OS = agent-execution layer; only `os:dispatch`-flagged issues flow to the fleet,
 * so nothing executes unseen.
 */
const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
const DISPATCH_LABEL = "os:dispatch";
const SYNCED_LABEL = "os:synced";
// `os:synced` label id in the Valadrien workspace (bridge doc); override if the label is recreated.
const SYNCED_LABEL_ID = process.env.LINEAR_SYNCED_LABEL_ID ?? "4bf02128-5391-446a-b938-e0922c24e3a9";
// provenance label -> OS agent name (resolved to an id per company at run time).
const PROVENANCE_ROUTE: Record<string, string> = {
  "source:sentry": "Veye", // SRE — auto-remediate-known / escalate-unknown
  "source:braintrust": "Bati", // engineer — eval regressions are code/prompt fixes
};
const DEFAULT_AGENT = "Sol"; // escalate anything unrouted

type LinearLabel = { id: string; name: string };
type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  labels: { nodes: LinearLabel[] };
};
type DispatchPage = {
  issues: {
    nodes: LinearIssue[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

async function linear<T = unknown>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    // Don't let a hung Linear response pin the serverless invocation to the
    // platform hard timeout — bound every call so the cron stays reliable.
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors) {
    throw new Error(`Linear API error (${res.status}): ${JSON.stringify(json.errors ?? "request failed")}`);
  }
  return json.data as T;
}

type SyncResult = { linear: string; agent: string; created: boolean; error?: string };

export async function runLinearOsSync(
  db: Db,
  opts: { apiKey: string; companyId: string },
): Promise<SyncResult[]> {
  const { apiKey, companyId } = opts;
  const issues = issueService(db);

  // 1. Linear issues flagged for dispatch, not yet synced. Paginate with a cursor
  //    so we never skip candidates once more than one page matches.
  const allNodes: LinearIssue[] = [];
  let after: string | null = null;
  do {
    const page: DispatchPage = await linear<DispatchPage>(
      apiKey,
      `query DispatchIssues($after: String) {
        issues(first: 100, after: $after, filter: { labels: { some: { name: { eq: "${DISPATCH_LABEL}" } } } }) {
          nodes { id identifier title description url labels { nodes { id name } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
    );
    allNodes.push(...page.issues.nodes);
    after = page.issues.pageInfo.hasNextPage ? page.issues.pageInfo.endCursor : null;
  } while (after);

  // Exclude `os:synced` here (post-filter): Linear's label filter can't reliably
  // express "has os:dispatch AND NOT os:synced" in one clause, and the label
  // write-back below is the authoritative idempotency guard regardless.
  const candidates = allNodes.filter(
    (n) => !n.labels.nodes.some((l) => l.name === SYNCED_LABEL),
  );

  // Resolve routing agents by name once (robust to id changes).
  const agentRows = await db
    .select({ id: agentsTable.id, name: agentsTable.name })
    .from(agentsTable)
    .where(eq(agentsTable.companyId, companyId));
  const idByName = new Map(agentRows.map((a) => [a.name, a.id]));

  const results: SyncResult[] = [];
  for (const issue of candidates) {
    const src = issue.labels.nodes.map((l) => l.name).find((n) => n.startsWith("source:"));
    const agentName = (src && PROVENANCE_ROUTE[src]) || DEFAULT_AGENT;
    const assigneeAgentId = idByName.get(agentName) ?? idByName.get(DEFAULT_AGENT) ?? null;

    // Isolate each issue: one bad Linear id / write must not abort the rest of the batch.
    try {
      // Idempotency guard #2 (survives a failed label write): don't re-create for the same Linear id.
      const existing = await db
        .select({ id: issuesTable.id })
        .from(issuesTable)
        .where(
          and(
            eq(issuesTable.companyId, companyId),
            eq(issuesTable.originKind, "linear"),
            eq(issuesTable.originId, issue.id),
          ),
        )
        .limit(1);
      const created = existing.length === 0;
      if (created) {
        const osIssue = await issues.create(companyId, {
          title: issue.title,
          description: `From Linear ${issue.identifier}: ${issue.url}\n\n${issue.description ?? ""}`,
          assigneeAgentId,
          status: "todo",
          priority: "medium",
          originKind: "linear",
          originId: issue.id,
        });
        // Mutating action → activity log entry (repo guideline for server endpoints).
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "linear-os-sync",
          agentId: assigneeAgentId,
          action: "issue.created",
          entityType: "issue",
          entityId: osIssue.id,
          details: {
            source: "linear-bridge",
            linearId: issue.id,
            linearIdentifier: issue.identifier,
            routedAgent: agentName,
          },
        });
      }

      // Idempotency guard #1: write `os:synced` back so we never re-dispatch. Linear has no
      // atomic add-label, so set the full label-id set (existing + synced).
      const labelIds = Array.from(new Set([...issue.labels.nodes.map((l) => l.id), SYNCED_LABEL_ID]));
      await linear(
        apiKey,
        `mutation MarkSynced($id: String!, $labelIds: [String!]) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
        }`,
        { id: issue.id, labelIds },
      );

      results.push({ linear: issue.identifier, agent: agentName, created });
    } catch (err) {
      results.push({
        linear: issue.identifier,
        agent: agentName,
        created: false,
        error: err instanceof Error ? err.message : "sync failed",
      });
    }
  }
  return results;
}

export function linearOsSyncRoutes(db: Db): Router {
  const router = Router();
  // Vercel cron target (GET). Requires CRON_SECRET (Vercel sends
  // `Authorization: Bearer <CRON_SECRET>` on cron requests). No-op if LINEAR_API_KEY is unset.
  router.get("/internal/linear-os-sync", async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    // Fail closed: an unset secret must NOT leave this mutating endpoint open.
    if (!cronSecret) {
      res.status(503).json({ error: "CRON_SECRET not configured" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      res.status(200).json({ skipped: "LINEAR_API_KEY not configured" });
      return;
    }
    // OS company the dispatched tasks land in (Veye/Bati/Sol live here).
    const companyId = process.env.LINEAR_SYNC_COMPANY_ID ?? "e8a1e79f-2711-4dfc-a701-e4f9978c472b"; // ValAdrien.DEV
    try {
      const results = await runLinearOsSync(db, { apiKey, companyId });
      res.status(200).json({ ok: true, synced: results.length, results });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "sync failed" });
    }
  });
  return router;
}
