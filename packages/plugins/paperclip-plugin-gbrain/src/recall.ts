// Wave 2.2 recall path.
//
// On `agent.run.started`, traverse the gbrain graph from the issue page
// (depth=2 by default) and cache the result in plugin state keyed by
// runId. The agent reads it back via the `gbrain_recall_cache` tool —
// no second MCP round-trip per agent run.
//
// Why pre-fetch instead of let the agent traverse on-demand: each agent
// run does many MCP calls already; one cached read is much cheaper than
// teaching every agent to call traverse_graph itself, and lets the
// agent get the graph context "for free" at run start without
// remembering to ask.
//
// Tradeoff: stale-by-the-time-it's-read. If the run mutates gbrain
// (e.g. wave 1's retain at run end) and another tool re-reads after,
// the cache is the snapshot from run.started, not whatever the latest
// mutations are. Acceptable for "starting context" use cases; agents
// that need current state should call traverse_graph directly.

import type { GbrainCallable } from "./pages.js";
import { agentSlug, issueSlug, projectSlug } from "./identity.js";

export const RECALL_STATE_KEY = "gbrain-context";
export const DEFAULT_RECALL_DEPTH = 2;

export interface PrefetchInput {
  client: GbrainCallable;
  issueIdentifier: string | null;
  companyId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  projectId?: string | null;
  projectNameOrKey?: string | null;
  depth: number;
  enrichmentFallback?: boolean;
}

export interface PrefetchResult {
  ok: boolean;
  issuePageSlug: string | null;
  graph: unknown | null;
  reason?: string;
}

interface TraversalCandidate {
  slug: string;
  label: string;
}

export type CachedRecallStatus =
  | "ok"
  | "no-issue-page"
  | "empty"
  | "island"
  | "skipped"
  | "error";

/**
 * Fetch a depth-N traversal of the issue page from gbrain, ready to be
 * stashed under the run scope. Returns ok=false (with a reason) when
 * there's nothing useful to cache — caller should still write the
 * result to state so the tool handler can return a meaningful "no
 * context" payload instead of a state-miss surprise.
 */
export async function prefetchRunContext(input: PrefetchInput): Promise<PrefetchResult> {
  const { client, issueIdentifier, depth } = input;
  if (!issueIdentifier) {
    return { ok: false, issuePageSlug: null, graph: null, reason: "no issue identifier on run" };
  }
  const slug = issueSlug(issueIdentifier);
  if (!slug) {
    return { ok: false, issuePageSlug: null, graph: null, reason: "issue identifier did not yield a slug" };
  }
  const safeDepth = Math.max(1, depth);
  try {
    const graph = await traverseGraph(client, slug, safeDepth);
    if (graph === null || graph === undefined) {
      // gbrain returns null for missing pages — first run on a brand-new
      // issue. Not an error; just nothing in the graph yet.
      return await maybeFallback(input, slug, null, "issue page does not exist yet", safeDepth);
    }
    const classification = classifyGraphShape(graph);
    if (classification.status === "ok") {
      return { ok: true, issuePageSlug: slug, graph };
    }
    return await maybeFallback(
      input,
      slug,
      graph,
      classification.note ?? `issue graph classified as ${classification.status}`,
      safeDepth,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, issuePageSlug: slug, graph: null, reason: `traverse_graph failed: ${msg}` };
  }
}

async function traverseGraph(client: GbrainCallable, slug: string, depth: number): Promise<unknown> {
  return await client.call("traverse_graph", { slug, depth });
}

async function maybeFallback(
  input: PrefetchInput,
  issuePageSlug: string,
  issueGraph: unknown | null,
  issueReason: string,
  depth: number,
): Promise<PrefetchResult> {
  if (input.enrichmentFallback === false) {
    return { ok: true, issuePageSlug, graph: issueGraph, reason: issueReason };
  }

  for (const candidate of fallbackCandidates(input)) {
    try {
      const fallbackGraph = await traverseGraph(input.client, candidate.slug, depth);
      if (fallbackGraph === null || fallbackGraph === undefined) continue;
      if (classifyGraphShape(fallbackGraph).status !== "ok") continue;
      return {
        ok: true,
        issuePageSlug,
        graph: mergeGraphs(issueGraph, fallbackGraph),
        reason: `${issueReason}; enriched with ${candidate.label} graph ${candidate.slug}`,
      };
    } catch {
      // Fallback enrichment is opportunistic; preserve the original issue-page result.
    }
  }

  return { ok: true, issuePageSlug, graph: issueGraph, reason: issueReason };
}

function fallbackCandidates(input: PrefetchInput): TraversalCandidate[] {
  const seen = new Set<string>();
  const candidates: TraversalCandidate[] = [];
  const add = (slug: string | null | undefined, label: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    candidates.push({ slug, label });
  };

  add(agentSlug(input.agentName), "agent");
  if (input.companyId && input.agentId) {
    add(`paperclip/agents/${input.companyId}/${input.agentId}`, "agent");
  }
  add(projectSlug(input.projectNameOrKey), "project");
  if (input.companyId && input.projectId) {
    add(`paperclip/projects/${input.companyId}/${input.projectId}`, "project");
  }
  return candidates;
}

function mergeGraphs(primary: unknown | null, fallback: unknown): unknown {
  if (primary === null || primary === undefined) return fallback;
  if (Array.isArray(primary) && primary.length === 0) return fallback;

  if (Array.isArray(primary) && Array.isArray(fallback)) {
    return dedupeByStableString([...primary, ...fallback]);
  }

  if (isRecord(primary) && isRecord(fallback)) {
    const primaryNodes = Array.isArray(primary.nodes) ? primary.nodes : [];
    const fallbackNodes = Array.isArray(fallback.nodes) ? fallback.nodes : [];
    const primaryEdges = Array.isArray(primary.edges) ? primary.edges : [];
    const fallbackEdges = Array.isArray(fallback.edges) ? fallback.edges : [];
    return {
      ...fallback,
      ...primary,
      nodes: dedupeByStableString([...primaryNodes, ...fallbackNodes]),
      edges: dedupeByStableString([...primaryEdges, ...fallbackEdges]),
    };
  }

  return { issueGraph: primary, enrichmentGraph: fallback };
}

function dedupeByStableString(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = stableString(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stableString(value: unknown): string {
  if (value === undefined) return "undefined";
  if (!isRecord(value)) return JSON.stringify(value);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

export interface CachedRecall {
  fetchedAtIso: string;
  issuePageSlug: string | null;
  depth: number;
  /** Non-null when prefetch reached an existing page. */
  graph: unknown | null;
  /** "ok" only when the traversal found a real neighborhood. */
  status: CachedRecallStatus;
  /** Free-form context for the agent reading the cache. */
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayPropLength(value: Record<string, unknown>, key: string): number | null {
  const prop = value[key];
  return Array.isArray(prop) ? prop.length : null;
}

function classifyGraphShape(graph: unknown): { status: CachedRecallStatus; note?: string } {
  if (Array.isArray(graph)) {
    if (graph.length === 0) {
      return { status: "empty", note: "traverse_graph returned an empty graph" };
    }
    if (graph.length === 1) {
      return { status: "island", note: "traverse_graph returned only the issue page" };
    }
    return { status: "ok" };
  }

  if (!isRecord(graph)) {
    return {
      status: "empty",
      note: "traverse_graph returned an unrecognized empty graph shape",
    };
  }

  const nodeCount = arrayPropLength(graph, "nodes");
  const edgeCount = arrayPropLength(graph, "edges");
  if (nodeCount !== null) {
    if (nodeCount === 0) {
      return { status: "empty", note: "traverse_graph returned zero nodes" };
    }
    if (nodeCount === 1 || edgeCount === 0) {
      return { status: "island", note: "traverse_graph returned no edges from the issue page" };
    }
    return { status: "ok" };
  }

  if (edgeCount !== null) {
    if (edgeCount === 0) {
      return { status: "island", note: "traverse_graph returned no edges" };
    }
    return { status: "ok" };
  }

  return { status: "empty", note: "traverse_graph returned an unrecognized graph shape" };
}

export function buildCacheEntry(input: {
  result: PrefetchResult;
  depth: number;
  nowIso?: string;
}): CachedRecall {
  const fetchedAtIso = input.nowIso ?? new Date().toISOString();
  if (!input.result.ok) {
    const status = input.result.issuePageSlug ? "error" : "skipped";
    return {
      fetchedAtIso,
      issuePageSlug: input.result.issuePageSlug,
      depth: input.depth,
      graph: null,
      status,
      note: input.result.reason,
    };
  }
  if (input.result.graph === null || input.result.graph === undefined) {
    return {
      fetchedAtIso,
      issuePageSlug: input.result.issuePageSlug,
      depth: input.depth,
      graph: null,
      status: "no-issue-page",
      note: input.result.reason,
    };
  }
  const classification = classifyGraphShape(input.result.graph);
  return {
    fetchedAtIso,
    issuePageSlug: input.result.issuePageSlug,
    depth: input.depth,
    graph: input.result.graph,
    status: classification.status,
    note: input.result.reason ?? classification.note,
  };
}
