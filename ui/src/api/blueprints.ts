import { api } from "./client";

export interface AgentBlueprint {
  id: string;
  name: string;
  description: string | null;
  role: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  tags: string[];
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  permissions: Record<string, unknown>;
  instructionsContent: string | null;
  metadata: Record<string, unknown> | null;
  sourceAgentId: string | null;
  sourceBlueprintId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateBlueprintInput = Omit<AgentBlueprint, "id" | "createdAt" | "updatedAt" | "icon" | "sourceAgentId" | "sourceBlueprintId" | "description" | "instructionsContent"> & {
  icon?: string | null;
  description?: string | null;
  instructionsContent?: string | null;
  sourceAgentId?: string | null;
  sourceBlueprintId?: string | null;
};
export type UpdateBlueprintInput = Partial<CreateBlueprintInput>;

export const blueprintsApi = {
  list: (opts?: { search?: string; role?: string }) => {
    const params = new URLSearchParams();
    if (opts?.search) params.set("search", opts.search);
    if (opts?.role) params.set("role", opts.role);
    const qs = params.toString();
    return api.get<AgentBlueprint[]>(`/blueprints${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => api.get<AgentBlueprint>(`/blueprints/${id}`),
  create: (input: CreateBlueprintInput) =>
    api.post<AgentBlueprint>("/blueprints", input),
  update: (id: string, input: UpdateBlueprintInput) =>
    api.patch<AgentBlueprint>(`/blueprints/${id}`, input),
  delete: (id: string) => api.delete(`/blueprints/${id}`),
};
