import type {
  ExecutionWorktree,
  ExecutionWorktreeSummary,
  ExecutionWorktreeStatus,
  ExecutionWorktreeCloseReadiness,
  WorktreeOverviewResponse,
  WorktreeLoginHandoffTicketResponse,
  WorktreeOperation,
  WorktreeRuntimeControlTarget,
} from "@paperclipai/shared";
import { api } from "./client";
import { sanitizeWorktreeRuntimeControlTarget } from "./worktree-runtime-control";

type WorktreeOverviewFilters = {
  projectId?: string;
  status?: ExecutionWorktreeStatus[];
  limit?: number;
  offset?: number;
};

function normalizeWorktreeOverview(response: WorktreeOverviewResponse): WorktreeOverviewResponse {
  return {
    ...response,
    items: response.items.map((item) => ({
      ...item,
      lastUpdatedAt: new Date(item.lastUpdatedAt),
      primaryService: item.primaryService
        ? {
            ...item.primaryService,
            updatedAt: new Date(item.primaryService.updatedAt),
          }
        : null,
      linkedIssues: item.linkedIssues.map((issue) => ({
        ...issue,
        updatedAt: new Date(issue.updatedAt),
      })),
    })),
  };
}

export const executionWorktreesApi = {
  listOverview: async (companyId: string, filters?: WorktreeOverviewFilters) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.status?.length) params.set("status", filters.status.join(","));
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    const qs = params.toString();
    const response = await api.get<WorktreeOverviewResponse>(
      `/companies/${companyId}/workspace-overview${qs ? `?${qs}` : ""}`,
    );
    return normalizeWorktreeOverview(response);
  },
  listSummaries: (
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.projectWorkspaceId) params.set("projectWorkspaceId", filters.projectWorkspaceId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.reuseEligible) params.set("reuseEligible", "true");
    params.set("summary", "true");
    const qs = params.toString();
    return api.get<ExecutionWorktreeSummary[]>(
      `/companies/${companyId}/execution-workspaces${qs ? `?${qs}` : ""}`,
    );
  },
  list: (
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.projectWorkspaceId) params.set("projectWorkspaceId", filters.projectWorkspaceId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.reuseEligible) params.set("reuseEligible", "true");
    const qs = params.toString();
    return api.get<ExecutionWorktree[]>(`/companies/${companyId}/execution-workspaces${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => api.get<ExecutionWorktree>(`/execution-workspaces/${id}`),
  getCloseReadiness: (id: string) =>
    api.get<ExecutionWorktreeCloseReadiness>(`/execution-workspaces/${id}/close-readiness`),
  listWorkspaceOperations: (id: string) =>
    api.get<WorktreeOperation[]>(`/execution-workspaces/${id}/workspace-operations`),
  controlRuntimeServices: (
    id: string,
    action: "start" | "stop" | "restart",
    target: WorktreeRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ExecutionWorktree; operation: WorktreeOperation }>(
      `/execution-workspaces/${id}/runtime-services/${action}`,
      sanitizeWorktreeRuntimeControlTarget(target),
    ),
  controlRuntimeCommands: (
    id: string,
    action: "start" | "stop" | "restart" | "run",
    target: WorktreeRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ExecutionWorktree; operation: WorktreeOperation }>(
      `/execution-workspaces/${id}/runtime-commands/${action}`,
      sanitizeWorktreeRuntimeControlTarget(target),
    ),
  repair: (id: string) =>
    api.post<{ workspace: ExecutionWorktree; operation: WorktreeOperation }>(
      `/execution-workspaces/${id}/runtime-commands/repair`,
      {},
    ),
  /**
   * Mint a single-use workspace login handoff (PAP-17572).
   *
   * The returned URL carries a short-lived ticket, so the caller must navigate to
   * it rather than store or share it. The server answers the navigation with an
   * HTTP redirect, which is what keeps the ticket out of browser history.
   */
  requestLoginHandoff: (id: string, next?: string) =>
    api.post<WorktreeLoginHandoffTicketResponse>(
      `/execution-workspaces/${id}/login-handoff`,
      next ? { next } : {},
    ),
  update: (id: string, data: Record<string, unknown>) => api.patch<ExecutionWorktree>(`/execution-workspaces/${id}`, data),
  /**
   * Reconcile a git-worktree branch divergence via the S4 (`PAP-1586`) op.
   *
   * Hits `POST /execution-workspaces/:id/reconcile-branch`. That route is the reviewed,
   * OpenAPI-documented backend contract and already ships on `master`: it was merged ahead of this
   * client change in `server/src/routes/execution-workspaces.ts` (route registration:
   * `router.post("/execution-workspaces/:id/reconcile-branch", ...)`, landed in PR #9170, with the
   * `forward` auto-reconcile path in PR #9172). This client is therefore additive against an
   * existing endpoint, not a call to a missing one. Keep this path byte-identical to the backend
   * route; the drift is pinned by a regression test in `execution-workspaces.test.ts`.
   * - `mode: "forward"` — server re-verifies `ancestryVerdict === "ancestor"` (client hint is
   *   never trusted); no `reason` needed.
   * - `mode: "override"` — audited break-glass; the server rejects agent actors, re-checks
   *   `runtime:manage` permission, and requires a non-empty operator `reason`.
   * - `mode: "quarantine_restore"` — lossless dirty-worktree repair; the server quarantines the
   *   dirty changes onto a rescue branch and restores the recorded branch. No `reason` needed.
   */
  reconcile: (
    id: string,
    body: { mode: "forward" } | { mode: "override"; reason: string } | { mode: "quarantine_restore" },
  ) => api.post<ExecutionWorktree>(`/execution-workspaces/${id}/reconcile-branch`, body),
};
