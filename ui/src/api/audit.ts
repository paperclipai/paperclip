import { api } from "./client";

/**
 * Agent audit API client (PAP-14464, Phase 3b).
 *
 * Consumes the unified read API shipped by Phase 2c
 * (`server/src/routes/activity.ts` → `services/agent-action-audit.ts`):
 *   GET /companies/:companyId/audit/agent-actions
 * Gated server-side by the `audit:view_agent_actions` board permission — the
 * client renders an upsell/permission-denied state when the request 403s
 * (see `ui/src/pages/CompanyAudit.tsx`). CSV export streams from the sibling
 * `.csv` endpoint, which logs the export action itself.
 */

/** Render-ready entity snippets attached to each row at read time (no N+1). */
export interface AuditEntitySnippet {
  issue: { id: string; identifier: string | null; title: string | null } | null;
  comment: { id: string; excerpt: string } | null;
  document: { id: string; key: string } | null;
}

/** One enriched `activity_log` row from the agent-action audit feed. */
export interface AuditActionRecord {
  id: string;
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin" | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  entity: AuditEntitySnippet;
}

export interface AuditActionsResponse {
  items: AuditActionRecord[];
  nextCursor: string | null;
}

/** Server-side filters for the audit feed. All optional. */
export interface AuditActionFilters {
  agentId?: string | null;
  responsibleUserId?: string | null;
  runId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Action-domain prefix, e.g. `issue.` or `issue.comment_added`. */
  action?: string | null;
  /** ISO-8601 with offset. */
  from?: string | null;
  to?: string | null;
  actorType?: "agent" | "user" | "system" | "plugin" | null;
  cursor?: string | null;
  limit?: number;
}

function buildAuditQuery(filters: AuditActionFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (filters.agentId) search.set("agentId", filters.agentId);
  if (filters.responsibleUserId) search.set("responsibleUserId", filters.responsibleUserId);
  if (filters.runId) search.set("runId", filters.runId);
  if (filters.entityType) search.set("entityType", filters.entityType);
  if (filters.entityId) search.set("entityId", filters.entityId);
  if (filters.action) search.set("action", filters.action);
  if (filters.from) search.set("from", filters.from);
  if (filters.to) search.set("to", filters.to);
  if (filters.actorType) search.set("actorType", filters.actorType);
  if (filters.cursor) search.set("cursor", filters.cursor);
  if (filters.limit != null) search.set("limit", String(filters.limit));
  return search;
}

export const auditApi = {
  /**
   * Cursor-paginated agent-action feed. Returns `{ items, nextCursor }`.
   * Throws `ApiError` with status 403 when the caller lacks
   * `audit:view_agent_actions`.
   */
  listAgentActions: (companyId: string, filters: AuditActionFilters = {}) => {
    const search = buildAuditQuery(filters);
    const qs = search.toString();
    return api.get<AuditActionsResponse>(
      `/companies/${companyId}/audit/agent-actions${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * Fetch the filtered feed as a CSV blob. The server logs an `audit.exported`
   * activity row for the export itself (training-data export precedent).
   */
  exportAgentActionsCsv: async (
    companyId: string,
    filters: Omit<AuditActionFilters, "cursor" | "limit"> = {},
  ): Promise<Blob> => {
    const search = buildAuditQuery(filters);
    const qs = search.toString();
    const res = await fetch(
      `/api/companies/${companyId}/audit/agent-actions.csv${qs ? `?${qs}` : ""}`,
      { credentials: "include", headers: { Accept: "text/csv" } },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const message = (body as { error?: string } | null)?.error ?? `Export failed: ${res.status}`;
      throw new Error(message);
    }
    return res.blob();
  },
};
