import type { TaskCreationProvenance } from "./services/task-creation-provenance.js";

export interface SentryRunReference {
  runId: string;
  companyId?: string;
  agentId?: string;
  includeCreationProvenance?: boolean;
}

export interface SentryRunLinks {
  companyId: string;
  companyPrefix: string;
  agentId: string;
  taskId: string | null;
  taskIdentifier: string | null;
  creationProvenance?: TaskCreationProvenance;
}

export type SentryRunLinkResolver = (reference: SentryRunReference) => Promise<SentryRunLinks | null>;

interface LinkableEvent {
  tags?: Record<string, string | number | boolean | bigint | symbol | null | undefined>;
  contexts?: Record<string, Record<string, unknown> | null | undefined>;
  request?: { headers?: Record<string, string> };
}

let resolveRunLinks: SentryRunLinkResolver | null = null;
const pendingLookups = new Set<Promise<SentryRunLinks | null>>();
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The database is supplied after startup; no run identity lives on an SDK scope. */
export function setSentryRunLinkResolver(resolver: SentryRunLinkResolver | null) {
  resolveRunLinks = resolver;
}

/** Enrich only events already associated with a run. Never read a request URL or body. */
export async function addSentryRunLinks<T extends LinkableEvent>(event: T): Promise<T> {
  if (event.request?.headers) event.request = { ...event.request, headers: Object.fromEntries(
    Object.entries(event.request.headers).filter(([key]) => key.toLowerCase() !== "x-paperclip-source-run-token"),
  ) };
  const failure = event.tags?.event_kind === "run_failure";
  if (failure) event.tags = { ...event.tags, automation_origin_status: "unknown", automation_routine_ids: "unknown", task_shareable: "unknown" };
  const runId = event.tags?.run_id ?? event.contexts?.adapter_stop?.runId;
  const resolver = resolveRunLinks;
  if (!resolver || typeof runId !== "string" || !UUID.test(runId)) return event;
  let base: URL | null = null;
  try {
    base = new URL(process.env.PAPERCLIP_PUBLIC_URL ?? "");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
        base.search || base.hash || base.pathname !== "/") base = null;
  } catch {}
  if (!base && !failure) return event;

  const companyId = event.tags?.company_id;
  const agentId = event.tags?.agent_id;
  // A malformed supplied identity must not widen a lookup to another company.
  if (companyId != null && (typeof companyId !== "string" || !UUID.test(companyId))) return event;
  if (agentId != null && (typeof agentId !== "string" || !UUID.test(agentId))) return event;
  // A deadline cannot cancel a pooled database read. Bound unfinished reads so
  // repeated errors during an outage cannot build an unbounded lookup queue.
  if (pendingLookups.size >= 8) return event;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = resolver({ runId, ...(companyId ? { companyId } : {}), ...(agentId ? { agentId } : {}),
      ...(failure ? { includeCreationProvenance: true } : {}) });
    pendingLookups.add(lookup);
    void lookup.then(() => pendingLookups.delete(lookup), () => pendingLookups.delete(lookup));
    // Optional navigation metadata must not hold an error report behind a slow
    // database. The indexed lookup may finish later; it cannot mutate this event.
    const links = await Promise.race([
      lookup,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1_000); }),
    ]);
    if (!links || !UUID.test(links.companyId) || !UUID.test(links.agentId) ||
        (companyId && links.companyId !== companyId) || (agentId && links.agentId !== agentId)) return event;
    const provenance = links.creationProvenance;
    if (failure && provenance && Array.isArray(provenance.routineIds) && provenance.routineIds.every(id => typeof id === "string" && UUID.test(id))) {
      const routineIds = [...new Set(provenance.routineIds.map(id => id.toLowerCase()))].sort();
      const status = provenance.status === "complete" && routineIds.length <= 5 ? "complete" : "unknown";
      event.tags = { ...event.tags, automation_origin_status: status,
        automation_routine_ids: routineIds.slice(0, 5).join(",") || "none",
        task_shareable: provenance.shareable === true ? "true" : provenance.shareable === false ? "false" : "unknown" };
      event.contexts = { ...event.contexts, paperclip_creation: { status, routineIds: routineIds.slice(0, 100), shareable: provenance.shareable } };
    }
    if (!base || !/^[A-Z][A-Z0-9]*$/.test(links.companyPrefix)) return event;
    const prefix = `/${links.companyPrefix}`;
    const runUrl = new URL(`${prefix}/agents/${links.agentId}/runs/${runId}`, base).href;
    const identifier = links.taskIdentifier;
    const taskKey = identifier && new RegExp(`^${links.companyPrefix}-[1-9][0-9]*$`).test(identifier)
      ? identifier : links.taskId && UUID.test(links.taskId) ? links.taskId : null;
    const taskUrl = taskKey ? new URL(`${prefix}/issues/${taskKey}`, base).href : null;
    // Sentry tag values are bounded to 200 characters. Keep a full long-host URL
    // in context instead of emitting a truncated, unusable navigation tag.
    event.tags = { ...event.tags,
      ...(runUrl.length <= 200 ? { run_url: runUrl } : {}),
      ...(taskUrl && taskUrl.length <= 200 ? { task_url: taskUrl } : {}),
      ...(identifier && identifier.length <= 200 && taskKey === identifier ? { task_identifier: identifier } : {}),
    };
    event.contexts = { ...event.contexts, paperclip: {
      ...event.contexts?.paperclip,
      runPageUrl: runUrl,
      ...(taskUrl ? { taskUrl } : {}),
    } };
  } catch { /* Link enrichment must not discard the original error. */ }
  finally { if (timer) clearTimeout(timer); }
  return event;
}
