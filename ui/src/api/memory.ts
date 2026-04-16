import { api } from "./client";

// ── Types ─────────────────────────────────────────────────────────

export interface MemoryBinding {
  id: string;
  companyId: string;
  key: string;
  providerKey: string;
  pluginId: string | null;
  config: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryBindingTarget {
  id: string;
  bindingId: string;
  targetType: "company" | "agent";
  targetId: string;
  priority: number;
  createdAt: string;
}

export interface MemoryOperation {
  id: string;
  bindingId: string;
  bindingKey: string | null;
  providerKey: string | null;
  operationType: string;
  agentId: string | null;
  projectId: string | null;
  issueId: string | null;
  runId: string | null;
  sourceRef: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  latencyMs: number | null;
  success: boolean;
  error: string | null;
  createdAt: string;
}

export interface MemoryOperationListResult {
  items: MemoryOperation[];
  total: number;
  limit: number;
  offset: number;
}

// ── API ───────────────────────────────────────────────────────────

export const memoryApi = {
  // Bindings
  listBindings: (companyId: string) =>
    api.get<MemoryBinding[]>(`/companies/${companyId}/memory-bindings`),

  getBinding: (bindingId: string) =>
    api.get<MemoryBinding>(`/memory-bindings/${bindingId}`),

  createBinding: (companyId: string, data: {
    key: string;
    providerKey: string;
    pluginId?: string | null;
    config?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    enabled?: boolean;
  }) => api.post<MemoryBinding>(`/companies/${companyId}/memory-bindings`, data),

  updateBinding: (bindingId: string, data: {
    key?: string;
    providerKey?: string;
    pluginId?: string | null;
    config?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    enabled?: boolean;
  }) => api.patch<MemoryBinding>(`/memory-bindings/${bindingId}`, data),

  deleteBinding: (bindingId: string) =>
    api.delete<{ ok: true }>(`/memory-bindings/${bindingId}`),

  // Binding targets
  listTargets: (bindingId: string) =>
    api.get<MemoryBindingTarget[]>(`/memory-bindings/${bindingId}/targets`),

  addTarget: (bindingId: string, data: {
    targetType: "company" | "agent";
    targetId: string;
    priority?: number;
  }) => api.post<MemoryBindingTarget>(`/memory-bindings/${bindingId}/targets`, data),

  removeTarget: (targetId: string) =>
    api.delete<{ ok: true }>(`/memory-binding-targets/${targetId}`),

  // Operations (audit log)
  listOperations: (companyId: string, params?: {
    bindingId?: string;
    agentId?: string;
    operationType?: string;
    success?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }) => {
    const search = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) search.set(k, String(v));
      }
    }
    const qs = search.toString();
    return api.get<MemoryOperationListResult>(
      `/companies/${companyId}/memory-operations${qs ? `?${qs}` : ""}`,
    );
  },
};
