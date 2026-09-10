/**
 * Native delivery-lifecycle API client.
 *
 * Transport only: every payload type is imported from `@paperclipai/shared`
 * (`packages/shared/src/types/delivery.ts` / `validators/delivery.ts`) and
 * never restated here. Presentation (labels, tones) lives in
 * `ui/src/lib/delivery-display.ts`.
 *
 *   GET  /api/issues/:id/delivery                 → DeliverySummary
 *   GET  /api/issues/:id/delivery/review          → DeliveryReviewSummary
 *   POST /api/issues/:id/delivery                 → DeliverySummary
 *   GET  /api/companies/:companyId/delivery       → DeliveryIssueList (optional projectId)
 *   GET  /api/companies/:companyId/delivery/reconciliation → DeliveryReconciliationInventory
 *   GET/PUT /api/projects/:id/delivery-policy     → DeliveryPolicy | null / DeliveryPolicyWriteInput
 *
 * The server is authoritative for every delivery fact; the board only submits
 * governed operator actions.
 */
import type {
  DeliveryIssueAction,
  DeliveryIssueList,
  DeliveryPolicy,
  DeliveryPolicyWriteInput,
  DeliveryReconciliationInventory,
  DeliveryReviewSummary,
  DeliverySummary,
} from "@paperclipai/shared";
import { api } from "./client";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

export const deliveryApi = {
  getIssueDelivery: (issueId: string) =>
    api.get<DeliverySummary>(`/issues/${encodeURIComponent(issueId)}/delivery`),
  getIssueReview: (issueId: string) =>
    api.get<DeliveryReviewSummary>(`/issues/${encodeURIComponent(issueId)}/delivery/review`),
  actOnIssueDelivery: (issueId: string, action: DeliveryIssueAction) =>
    api.post<DeliverySummary>(`/issues/${encodeURIComponent(issueId)}/delivery`, action),
  getCompanyDelivery: (companyId: string, projectId?: string | null) => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return api.get<DeliveryIssueList>(`/companies/${encodeURIComponent(companyId)}/delivery${query}`);
  },
  getReconciliation: (companyId: string) =>
    api.get<DeliveryReconciliationInventory>(
      `/companies/${encodeURIComponent(companyId)}/delivery/reconciliation`,
    ),
  getProjectPolicy: (projectId: string, companyId?: string) =>
    api.get<DeliveryPolicy | null>(
      withCompanyScope(`/projects/${encodeURIComponent(projectId)}/delivery-policy`, companyId),
    ),
  putProjectPolicy: (projectId: string, policy: DeliveryPolicyWriteInput, companyId?: string) =>
    api.put<DeliveryPolicy>(
      withCompanyScope(`/projects/${encodeURIComponent(projectId)}/delivery-policy`, companyId),
      policy,
    ),
};
