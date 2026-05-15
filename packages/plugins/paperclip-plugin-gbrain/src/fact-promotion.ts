// Wave 2 fact-promotion bridge.
//
// After a successful retain, the hindsight plugin POSTs the run's output
// to its per-agent bank. ~1-3 minutes later, hindsight's consolidation
// worker chunks + embeds + extracts memory_units from that document.
// This module waits out the consolidation delay, then materialises each
// resulting memory_unit as a `fact-<uuid>` page in gbrain and links it
// to the issue + agent pages so the graph captures the run's extracted
// learnings, not just its raw output.
//
// Idempotency: gbrain `put_page` is keyed on slug; re-running this for
// the same runId just upserts identical content. add_link is also
// upsert-safe per gbrain's "status: ok" response on duplicate edges.
//
// Durability: this is a one-shot setTimeout. If the paperclip pod
// restarts within the delay window, the promotion for the in-flight run
// is lost. That's acceptable for v1 — the memory_units still live in
// hindsight, the timeline entry on the issue page is already there from
// the sync retain path. Only the per-fact pages are missing.

import { factSlug, agentSlug, issueSlug } from "./identity.js";
import type { GbrainCallable } from "./pages.js";

export interface HindsightMemoryUnit {
  id: string;
  text: string;
  context?: string | null;
  // hindsight `/memories/list` omits `document_id` from the payload but
  // encodes it inside `chunk_id` as `<bankId>_<documentId>_<chunkIndex>`.
  // `document_id` is included for forward-compat when/if the API adds it.
  document_id?: string | null;
  chunk_id?: string | null;
  fact_type?: string | null;
}

// hindsight `/v1/.../memories/list` returns `{items, total, limit, offset}`.
// The plugin first shipped expecting `{results}` which produced silent
// `scanned=0 matched=0 promoted=0`. We accept either to remain robust if
// the API ever stabilises on a different shape.
export interface HindsightMemoryListResponse {
  items?: HindsightMemoryUnit[];
  results?: HindsightMemoryUnit[];
}

// Recover the document_id (= paperclip runId) from a chunk_id of the
// form `<bankId>_<docId>_<chunkIdx>` when the API doesn't populate
// `document_id` directly. Returns null if the chunk_id doesn't start
// with the bankId prefix.
export function extractDocumentId(
  unit: HindsightMemoryUnit,
  bankId: string,
): string | null {
  if (unit.document_id) return unit.document_id;
  const chunkId = unit.chunk_id ?? null;
  if (!chunkId) return null;
  const prefix = `${bankId}_`;
  if (!chunkId.startsWith(prefix)) return null;
  const tail = chunkId.slice(prefix.length);
  // tail = `<docId>_<chunkIdx>` — split on the LAST `_` since
  // chunkIdx is a small integer and docId is a UUID (no underscores).
  const lastUnderscore = tail.lastIndexOf("_");
  if (lastUnderscore < 0) return tail || null;
  return tail.slice(0, lastUnderscore) || null;
}

export interface PromoteFactsInput {
  client: GbrainCallable;
  hindsightFetch: (path: string) => Promise<unknown>;
  bankId: string;
  runId: string;
  issuePageSlug: string;
  agentPageSlug: string;
}

export interface PromoteFactsResult {
  scanned: number;
  matched: number;
  promoted: number;
}

function frontmatterFact(memoryUnitUuid: string, runId: string, factType: string, text: string, context: string | null): string {
  const ctxLine = context ? `context: ${JSON.stringify(context)}\n` : "";
  return (
    `---\n` +
    `type: fact\n` +
    `title: ${JSON.stringify(text.slice(0, 80))}\n` +
    `source_run_id: ${JSON.stringify(runId)}\n` +
    `source_memory_unit_id: ${JSON.stringify(memoryUnitUuid)}\n` +
    `fact_type: ${JSON.stringify(factType || "world")}\n` +
    ctxLine +
    `---\n` +
    text +
    `\n`
  );
}

export async function promoteFactsForRun(input: PromoteFactsInput): Promise<PromoteFactsResult> {
  const { client, hindsightFetch, bankId, runId, issuePageSlug, agentPageSlug } = input;
  const encoded = encodeURIComponent(bankId);
  // Pull a window of recent memory_units; filter client-side by document_id.
  // Limit=100 covers a typical run's extracted facts comfortably.
  const list = (await hindsightFetch(
    `/v1/default/banks/${encoded}/memories/list?limit=100&offset=0`,
  )) as HindsightMemoryListResponse;

  // Hindsight returns `items`; older mocks may return `results`. Accept both.
  const all = list?.items ?? list?.results ?? [];
  const matched = all.filter((u) => extractDocumentId(u, bankId) === runId);

  let promoted = 0;
  for (const u of matched) {
    const slug = factSlug(u.id);
    const content = frontmatterFact(
      u.id,
      runId,
      u.fact_type ?? "world",
      u.text ?? "",
      u.context ?? null,
    );
    await client.call("put_page", { slug, content });
    await client.call("add_link", {
      from: issuePageSlug,
      to: slug,
      link_type: "mentions",
    });
    await client.call("add_link", {
      from: agentPageSlug,
      to: slug,
      link_type: "authored_by",
    });
    promoted += 1;
  }

  return { scanned: all.length, matched: matched.length, promoted };
}

// Convenience: build a hindsightFetch that handles the JSON envelope.
export function makeHindsightFetch(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): (path: string) => Promise<unknown> {
  const trimmed = baseUrl.replace(/\/$/, "");
  return async (path: string) => {
    const resp = await fetchImpl(trimmed + path, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`hindsight GET ${path} -> HTTP ${resp.status}`);
    }
    return resp.json();
  };
}

// Build the per-agent bank_id used by both hindsight retain and the
// fact-promotion query — must match hindsight-paperclip's deriveBankId
// (paperclip::<companyId>::<agentId>).
export function deriveHindsightBankId(companyId: string, agentId: string): string {
  return `paperclip::${companyId}::${agentId}`;
}
