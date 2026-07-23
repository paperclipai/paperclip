import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { GitHubClient } from "../auth.js";

export interface ListIssuesParams {
  labels?: string[];
  state?: "open" | "closed" | "all";
  since?: string;
  perPage?: number;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  labels: string[];
  author: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export async function listIssues(
  client: GitHubClient,
  params: unknown,
  _runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseListIssues(params);
  const { data } = await client.rest.issues.listForRepo({
    owner: client.owner,
    repo: client.name,
    state: p.state ?? "open",
    ...(p.labels && p.labels.length > 0 ? { labels: p.labels.join(",") } : {}),
    ...(p.since ? { since: p.since } : {}),
    per_page: Math.min(p.perPage ?? 30, 100),
  });

  // listForRepo returns issues *and* PRs. We filter PRs out — Delivery Lead
  // wants tasks, not PRs. PRs are identified by the `pull_request` field.
  const issues: IssueSummary[] = data
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      labels: i.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
      author: i.user?.login ?? null,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      body: i.body ?? "",
    }));

  return { content: `listed ${issues.length} issues`, data: { issues } };
}

function parseListIssues(params: unknown): ListIssuesParams {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object") throw new Error("listIssues: params must be an object");
  const p = params as Record<string, unknown>;
  const out: ListIssuesParams = {};
  if (Array.isArray(p.labels)) {
    out.labels = p.labels.filter((x): x is string => typeof x === "string");
  }
  if (p.state === "open" || p.state === "closed" || p.state === "all") {
    out.state = p.state;
  }
  if (typeof p.since === "string") out.since = p.since;
  if (typeof p.perPage === "number") out.perPage = p.perPage;
  return out;
}
