import { api } from "./client";

export interface ThroughputRow {
  date: string;
  done: number;
  cancelled: number;
}

export interface FlowRow {
  date: string;
  backlog: number;
  active: number;
  review: number;
  blocked: number;
  terminal: number;
}

export const analyticsApi = {
  throughput: (
    companyId: string,
    params: { days?: number; deptLabelId?: string; initiativeId?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.days) qs.set("days", String(params.days));
    if (params.deptLabelId) qs.set("deptLabelId", params.deptLabelId);
    if (params.initiativeId) qs.set("initiativeId", params.initiativeId);
    const q = qs.toString();
    return api.get<ThroughputRow[]>(
      `/companies/${companyId}/analytics/throughput${q ? `?${q}` : ""}`,
    );
  },
  flow: (
    companyId: string,
    params: { days?: number; deptLabelId?: string; initiativeId?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.days) qs.set("days", String(params.days));
    if (params.deptLabelId) qs.set("deptLabelId", params.deptLabelId);
    if (params.initiativeId) qs.set("initiativeId", params.initiativeId);
    const q = qs.toString();
    return api.get<FlowRow[]>(
      `/companies/${companyId}/analytics/flow${q ? `?${q}` : ""}`,
    );
  },
};
