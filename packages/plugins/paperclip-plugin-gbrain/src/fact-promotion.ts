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
  document_id?: string | null;
  fact_type?: string | null;
}

export interface HindsightMemoryListResponse {
  results: HindsightMemoryUnit[];
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

  const all = list?.results ?? [];
  const matched = all.filter((u) => u.document_id === runId);

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
