import type {
  WorkflowTemplate,
  WorkflowTemplateDetail,
  WorkflowTemplateListItem,
  WorkflowInvokeResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const workflowTemplatesApi = {
  list: (companyId: string) =>
    api.get<WorkflowTemplateListItem[]>(`/companies/${companyId}/workflow-templates`),

  get: (id: string) =>
    api.get<WorkflowTemplateDetail>(`/workflow-templates/${id}`),

  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<WorkflowTemplate>(`/companies/${companyId}/workflow-templates`, data),

  update: (id: string, data: Record<string, unknown>) =>
    api.patch<WorkflowTemplate>(`/workflow-templates/${id}`, data),

  remove: (id: string) =>
    api.delete<void>(`/workflow-templates/${id}`),

  invoke: (id: string, data: Record<string, unknown>) =>
    api.post<WorkflowInvokeResponse>(`/workflow-templates/${id}/invoke`, data),
};
