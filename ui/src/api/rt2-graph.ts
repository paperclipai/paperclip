import type { Rt2GraphReport, Rt2ProjectGraph } from "@paperclipai/shared";
import { api } from "./client";

export const rt2GraphApi = {
  getProjectGraph: (companyId: string, projectId: string) =>
    api.get<Rt2ProjectGraph>(`/companies/${companyId}/rt2/graph?projectId=${encodeURIComponent(projectId)}`),
  getProjectGraphReport: (companyId: string, projectId: string) =>
    api.get<Rt2GraphReport>(`/companies/${companyId}/rt2/graph-report?projectId=${encodeURIComponent(projectId)}`),
};
