import type {
  FeedbackTrace,
  ImprovementScope,
  ImprovementSuggestion,
  ImprovementSuggestionOriginKind,
  ImprovementSuggestionStatus,
  ImprovementTargetLayer,
  InstanceImprovementSuggestion,
} from "@paperclipai/shared";
import { api } from "./client";

type SuggestionFilters = {
  status?: ImprovementSuggestionStatus;
  originKind?: ImprovementSuggestionOriginKind;
  targetLayer?: ImprovementTargetLayer;
  scope?: ImprovementScope;
};

function queryString(filters?: SuggestionFilters) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.originKind) params.set("originKind", filters.originKind);
  if (filters?.targetLayer) params.set("targetLayer", filters.targetLayer);
  if (filters?.scope) params.set("scope", filters.scope);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const improvementSuggestionsApi = {
  listCompany: (companyId: string, filters?: SuggestionFilters) =>
    api.get<ImprovementSuggestion[]>(
      `/companies/${companyId}/improvement-suggestions${queryString(filters)}`,
    ),
  listInstance: (filters?: Omit<SuggestionFilters, "scope">) =>
    api.get<InstanceImprovementSuggestion[]>(`/improvement-suggestions${queryString(filters)}`),
  listFeedback: (companyId: string) =>
    api.get<FeedbackTrace[]>(`/companies/${companyId}/feedback-traces?includePayload=true`),
  review: (
    companyId: string,
    suggestionId: string,
    input: { decision: "accept" | "reject"; note: string },
  ) => api.post<ImprovementSuggestion>(
    `/companies/${companyId}/improvement-suggestions/${suggestionId}/review`,
    input,
  ),
  createImplementationIssue: (companyId: string, suggestionId: string) =>
    api.post<{
      suggestion: ImprovementSuggestion;
      issue: NonNullable<ImprovementSuggestion["implementationIssue"]>;
      created: boolean;
    }>(`/companies/${companyId}/improvement-suggestions/${suggestionId}/implementation-issue`, {}),
};
