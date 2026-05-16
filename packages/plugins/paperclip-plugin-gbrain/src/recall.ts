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
import { issueSlug } from "./identity.js";

export const RECALL_STATE_KEY = "gbrain-context";
export const DEFAULT_RECALL_DEPTH = 2;

export interface PrefetchInput {
  client: GbrainCallable;
  issueIdentifier: string | null;
  depth: number;
}

export interface PrefetchResult {
  ok: boolean;
  issuePageSlug: string | null;
  graph: unknown | null;
  reason?: string;
}

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
  try {
    const graph = await client.call("traverse_graph", {
      slug,
      depth: Math.max(1, depth),
    });
    if (graph === null || graph === undefined) {
      // gbrain returns null for missing pages — first run on a brand-new
      // issue. Not an error; just nothing in the graph yet.
      return { ok: true, issuePageSlug: slug, graph: null, reason: "issue page does not exist yet" };
    }
    return { ok: true, issuePageSlug: slug, graph };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, issuePageSlug: slug, graph: null, reason: `traverse_graph failed: ${msg}` };
  }
}

export interface CachedRecall {
  fetchedAtIso: string;
  issuePageSlug: string | null;
  depth: number;
  /** Non-null when prefetch succeeded against an existing page. */
  graph: unknown | null;
  /** "ok" when graph is present and non-null; otherwise a human reason. */
  status: "ok" | "no-issue-page" | "skipped" | "error";
  /** Free-form context for the agent reading the cache. */
  note?: string;
}

export function buildCacheEntry(input: {
  result: PrefetchResult;
  depth: number;
  nowIso?: string;
}): CachedRecall {
  const fetchedAtIso = input.nowIso ?? new Date().toISOString();
  if (!input.result.ok) {
    return {
      fetchedAtIso,
      issuePageSlug: input.result.issuePageSlug,
      depth: input.depth,
      graph: null,
      status: "skipped",
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
  return {
    fetchedAtIso,
    issuePageSlug: input.result.issuePageSlug,
    depth: input.depth,
    graph: input.result.graph,
    status: "ok",
  };
}
