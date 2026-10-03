import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { GitHubClient } from "../auth.js";
import { RefusalError } from "../audit.js";

export interface GetCheckRunsParams {
  prNumber: number;
  name?: string;
}

export interface CheckRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export async function getCheckRuns(
  client: GitHubClient,
  params: unknown,
  _runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseGetCheckRuns(params);
  const { data: pr } = await client.rest.pulls.get({
    owner: client.owner,
    repo: client.name,
    pull_number: p.prNumber,
  });
  const { data } = await client.rest.checks.listForRef({
    owner: client.owner,
    repo: client.name,
    ref: pr.head.sha,
    ...(p.name ? { check_name: p.name } : {}),
    per_page: 100,
  });
  const runs: CheckRunSummary[] = data.check_runs.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    detailsUrl: r.details_url,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  }));
  return { content: `${runs.length} check runs on #${p.prNumber}`, data: { headSha: pr.head.sha, runs } };
}

export interface CreateCheckRunParams {
  name: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped";
  summary?: string;
  details?: string;
  externalId?: string;
}

const MIN_DETAILS_FOR_COMPLETED = 200;

export async function createCheckRun(
  client: GitHubClient,
  params: unknown,
  _runCtx: ToolRunContext,
): Promise<ToolResult> {
  const p = parseCreateCheckRun(params);

  // Compliance refusal: "no merge without evidence". A completed check run
  // must carry ≥200 chars of detail so Build Verifier output is not a stub.
  if (p.status === "completed" && (!p.details || p.details.length < MIN_DETAILS_FOR_COMPLETED)) {
    throw new RefusalError(
      "evidence_too_thin",
      `completed check run requires details ≥${MIN_DETAILS_FOR_COMPLETED} chars`,
    );
  }
  if (p.status === "completed" && !p.conclusion) {
    throw new RefusalError("missing_conclusion", "completed check run requires conclusion");
  }

  const { data } = await client.rest.checks.create({
    owner: client.owner,
    repo: client.name,
    name: p.name,
    head_sha: p.headSha,
    status: p.status,
    ...(p.conclusion ? { conclusion: p.conclusion } : {}),
    ...(p.externalId ? { external_id: p.externalId } : {}),
    output: {
      title: p.name,
      summary: p.summary ?? "",
      ...(p.details ? { text: p.details } : {}),
    },
  });
  return {
    content: `check run ${data.id} (${p.name}) created`,
    data: { id: data.id, htmlUrl: data.html_url, conclusion: data.conclusion ?? null },
  };
}

function parseGetCheckRuns(params: unknown): GetCheckRunsParams {
  if (typeof params !== "object" || params === null) throw new Error("getCheckRuns: params must be an object");
  const p = params as Record<string, unknown>;
  if (typeof p.prNumber !== "number") throw new Error("prNumber required");
  return {
    prNumber: p.prNumber,
    ...(typeof p.name === "string" ? { name: p.name } : {}),
  };
}

function parseCreateCheckRun(params: unknown): CreateCheckRunParams {
  if (typeof params !== "object" || params === null) throw new Error("createCheckRun: params must be an object");
  const p = params as Record<string, unknown>;
  if (typeof p.name !== "string") throw new Error("name required");
  if (typeof p.headSha !== "string") throw new Error("headSha required");
  if (p.status !== "queued" && p.status !== "in_progress" && p.status !== "completed") {
    throw new Error("status must be queued | in_progress | completed");
  }
  return {
    name: p.name,
    headSha: p.headSha,
    status: p.status,
    ...(typeof p.conclusion === "string" ? { conclusion: p.conclusion as CreateCheckRunParams["conclusion"] } : {}),
    ...(typeof p.summary === "string" ? { summary: p.summary } : {}),
    ...(typeof p.details === "string" ? { details: p.details } : {}),
    ...(typeof p.externalId === "string" ? { externalId: p.externalId } : {}),
  };
}
