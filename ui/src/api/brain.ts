import { api } from "./client";

export interface BrainNode {
  id: string;
  slug: string;
  name: string;
  type: BrainEntityType;
  backlinks: number;
  tier?: number;
  sourceAgent?: string;
}

export interface BrainLink {
  source: string;
  target: string;
  type: string;
}

export interface BrainGraph {
  nodes: BrainNode[];
  links: BrainLink[];
}

export type BrainEntityType =
  | "person"
  | "company"
  | "deal"
  | "ticket"
  | "project"
  | "invoice"
  | "meeting"
  | "concept"
  | "summary";

export interface BrainPageMeta {
  slug: string;
  title: string;
  type: BrainEntityType;
  created: string;
  updated: string;
  sourceAgent?: string;
  odooRef?: string;
  tier?: number;
  tags?: string[];
  backlinks: number;
}

export interface BrainPage extends BrainPageMeta {
  content: string;
  linkedEntities: { slug: string; name: string; type: BrainEntityType; relationship: string }[];
}

export interface BrainDirectory {
  name: string;
  type: BrainEntityType;
  count: number;
}

export interface BrainSearchResult {
  slug: string;
  title: string;
  type: BrainEntityType;
  snippet: string;
  score: number;
  sourceAgent?: string;
}

export interface BrainActivityEvent {
  id: string;
  timestamp: string;
  agentName: string;
  action: "created" | "updated" | "linked" | "enriched" | "deleted";
  entitySlug: string;
  entityType: BrainEntityType;
  summary: string;
}

export interface BrainStats {
  totalPages: number;
  totalLinks: number;
  orphanCount: number;
  lastDreamCycle: string | null;
  pagesByType: Record<BrainEntityType, number>;
}

export interface DreamCycleStatus {
  lastRun: string | null;
  pagesProcessed: number;
  entitiesEnriched: number;
  orphansFixed: number;
  nextScheduled: string;
}

export const brainApi = {
  getGraph: (companyId: string, params?: { types?: string; depth?: number }) =>
    api.get<BrainGraph>(
      `/companies/${companyId}/brain/graph${params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString()}` : ""}`,
    ),

  listPages: (companyId: string, directory?: string) =>
    api.get<BrainPageMeta[]>(
      `/companies/${companyId}/brain/pages${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
    ),

  getPage: (companyId: string, slug: string) =>
    api.get<BrainPage>(`/companies/${companyId}/brain/pages/${encodeURIComponent(slug)}`),

  updatePage: (companyId: string, slug: string, body: { title: string; content: string; type: BrainEntityType }) =>
    api.put<BrainPage>(`/companies/${companyId}/brain/pages/${encodeURIComponent(slug)}`, body),

  deletePage: (companyId: string, slug: string) =>
    api.delete(`/companies/${companyId}/brain/pages/${encodeURIComponent(slug)}`),

  search: (companyId: string, body: { query: string; mode?: "hybrid" | "keyword" | "semantic"; limit?: number }) =>
    api.post<BrainSearchResult[]>(`/companies/${companyId}/brain/search`, body),

  traverse: (companyId: string, body: { slug: string; type?: string; depth?: number }) =>
    api.post<BrainGraph>(`/companies/${companyId}/brain/traverse`, body),

  listDirectories: (companyId: string) =>
    api.get<BrainDirectory[]>(`/companies/${companyId}/brain/directories`),

  getActivity: (companyId: string, params?: { since?: string; limit?: number }) =>
    api.get<BrainActivityEvent[]>(
      `/companies/${companyId}/brain/activity${params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString()}` : ""}`,
    ),

  getStats: (companyId: string) =>
    api.get<BrainStats>(`/companies/${companyId}/brain/stats`),

  getDreamStatus: (companyId: string) =>
    api.get<DreamCycleStatus>(`/companies/${companyId}/brain/dream/status`),

  triggerDream: (companyId: string) =>
    api.post<{ message: string }>(`/companies/${companyId}/brain/dream/trigger`, {}),

  triggerOdooSync: (companyId: string) =>
    api.post<{ message: string }>(`/companies/${companyId}/brain/sync/odoo`, {}),
};
