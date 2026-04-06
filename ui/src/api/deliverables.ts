import { api } from "./client";

export interface Deliverable {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  title: string;
  description: string | null;
  type: string;
  status: string;
  priority: string;
  currentStageIndex: number;
  reviewPipelineTemplateId: string | null;
  submittedByAgentId: string | null;
  submittedByUserId: string | null;
  dueAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contents?: DeliverableContent[];
  stages?: DeliverableReviewStage[];
  comments?: DeliverableComment[];
}

export interface DeliverableContent {
  id: string;
  deliverableId: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  filePath: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  metadata: Record<string, unknown> | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableReviewStage {
  id: string;
  deliverableId: string;
  stageIndex: number;
  label: string;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  status: string;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableComment {
  id: string;
  deliverableId: string;
  stageId: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDeliverableInput {
  title: string;
  description?: string;
  type?: string;
  priority?: string;
  projectId?: string;
  issueId?: string;
  dueAt?: string;
  templateId?: string;
  stages?: Array<{ label: string; reviewerAgentId?: string; reviewerUserId?: string }>;
}

export interface UpdateDeliverableInput {
  title?: string;
  description?: string;
  priority?: string;
  dueAt?: string | null;
}

export const deliverablesApi = {
  list: (companyId: string, filters?: { status?: string; projectId?: string; issueId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return api.get<Deliverable[]>(`/companies/${companyId}/deliverables${qs}`);
  },
  get: (id: string) => api.get<Deliverable>(`/deliverables/${id}`),
  create: (companyId: string, data: CreateDeliverableInput) =>
    api.post<Deliverable>(`/companies/${companyId}/deliverables`, data),
  update: (id: string, data: UpdateDeliverableInput) =>
    api.patch<Deliverable>(`/deliverables/${id}`, data),
  remove: (id: string) => api.delete<Deliverable>(`/deliverables/${id}`),
  submit: (id: string) => api.post<Deliverable>(`/deliverables/${id}/submit`, {}),
  approveStage: (id: string, stageId: string, decisionNote?: string) =>
    api.post<Deliverable>(`/deliverables/${id}/stages/${stageId}/approve`, { decisionNote }),
  requestChanges: (id: string, stageId: string, decisionNote?: string) =>
    api.post<Deliverable>(`/deliverables/${id}/stages/${stageId}/request-changes`, { decisionNote }),
  rejectStage: (id: string, stageId: string, decisionNote?: string) =>
    api.post<Deliverable>(`/deliverables/${id}/stages/${stageId}/reject`, { decisionNote }),
  skipStage: (id: string, stageId: string) =>
    api.post<Deliverable>(`/deliverables/${id}/stages/${stageId}/skip`, {}),
  reassign: (id: string, agentId: string) =>
    api.post<Deliverable>(`/deliverables/${id}/reassign`, { agentId }),
  reopen: (id: string) => api.post<Deliverable>(`/deliverables/${id}/reopen`, {}),
  addContent: (id: string, data: Record<string, unknown>) =>
    api.post<DeliverableContent>(`/deliverables/${id}/contents`, data),
  updateContent: (id: string, contentId: string, data: Record<string, unknown>) =>
    api.patch<DeliverableContent>(`/deliverables/${id}/contents/${contentId}`, data),
  removeContent: (id: string, contentId: string) =>
    api.delete<void>(`/deliverables/${id}/contents/${contentId}`),
  addStage: (id: string, data: { label: string; reviewerAgentId?: string; reviewerUserId?: string }) =>
    api.post<DeliverableReviewStage>(`/deliverables/${id}/stages`, data),
  updateStage: (id: string, stageId: string, data: Record<string, unknown>) =>
    api.patch<DeliverableReviewStage>(`/deliverables/${id}/stages/${stageId}`, data),
  removeStage: (id: string, stageId: string) =>
    api.delete<void>(`/deliverables/${id}/stages/${stageId}`),
  listComments: (id: string) =>
    api.get<DeliverableComment[]>(`/deliverables/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<DeliverableComment>(`/deliverables/${id}/comments`, { body }),
};
