import type {
  DecisionTrainingExample,
  DecisionTrainingPreview,
  DecisionTrainingSourceKind,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export interface DecisionTrainingListItem {
  example: DecisionTrainingExample;
  issueTitle: string;
  issueIdentifier: string;
}

export interface DecisionTrainingFilters {
  project?: string;
  kind?: DecisionTrainingSourceKind;
  author?: string;
  q?: string;
}

/** The durable (source + issue) target a training example anchors to. */
export interface DecisionTrainingTarget {
  sourceKind: DecisionTrainingSourceKind;
  sourceId: string;
  issueId: string;
}

export const decisionTrainingApi = {
  list: (companyId: string, filters: DecisionTrainingFilters = {}, options?: RequestOptions) => {
    const params = new URLSearchParams();
    if (filters.project) params.set("project", filters.project);
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.author) params.set("author", filters.author);
    if (filters.q) params.set("q", filters.q);
    const query = params.toString();
    return api.get<DecisionTrainingListItem[]>(
      `/companies/${companyId}/decision-training${query ? `?${query}` : ""}`,
      options,
    );
  },
  get: (id: string, options?: RequestOptions) =>
    api.get<DecisionTrainingExample>(`/decision-training/${id}`, options),
  /**
   * Preview the state a new example would freeze, without persisting it. Powers
   * the create drawer's "state frozen with this example" panel.
   */
  preview: (companyId: string, target: DecisionTrainingTarget) =>
    api.post<DecisionTrainingPreview>(`/companies/${companyId}/decision-training/preview`, target),
  create: (companyId: string, input: DecisionTrainingTarget & { notes: string }) =>
    api.post<DecisionTrainingExample>(`/companies/${companyId}/decision-training`, input),
  updateNotes: (id: string, notes: string) =>
    api.patch<DecisionTrainingExample>(`/decision-training/${id}`, { notes }),
  delete: (id: string) => api.delete<void>(`/decision-training/${id}`),
};
