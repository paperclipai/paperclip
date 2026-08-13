import type {
  CreateGoalRelation,
  Goal,
  GoalMapResponse,
  GoalRelation,
  GoalTarget,
  PromoteRoadmapBlock,
  RoadmapBlock,
  RoadmapBlockEdge,
  RoadmapBlockLink,
  RoadmapResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const goalsApi = {
  list: (companyId: string) => api.get<Goal[]>(`/companies/${companyId}/goals`),
  map: (companyId: string) => api.get<GoalMapResponse>(`/companies/${companyId}/goal-map`),
  get: (id: string) => api.get<Goal>(`/goals/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/companies/${companyId}/goals`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),

  targets: (companyId: string) => api.get<GoalTarget[]>(`/companies/${companyId}/goal-targets`),
  targetCreate: (goalId: string, data: Record<string, unknown>) =>
    api.post<GoalTarget>(`/goals/${goalId}/targets`, data),
  targetUpdate: (id: string, data: Record<string, unknown>) =>
    api.patch<GoalTarget>(`/goal-targets/${id}`, data),
  targetRemove: (id: string) => api.delete<GoalTarget>(`/goal-targets/${id}`),

  relations: (companyId: string) => api.get<GoalRelation[]>(`/companies/${companyId}/goal-relations`),
  relationCreate: (companyId: string, data: CreateGoalRelation) =>
    api.post<GoalRelation>(`/companies/${companyId}/goal-relations`, data),
  relationRemove: (id: string) => api.delete<GoalRelation>(`/goal-relations/${id}`),

  roadmap: (companyId: string) => api.get<RoadmapResponse>(`/companies/${companyId}/roadmap`),
  roadmapBlockCreate: (companyId: string, data: Record<string, unknown>) =>
    api.post<RoadmapBlock>(`/companies/${companyId}/roadmap-blocks`, data),
  roadmapBlockUpdate: (id: string, data: Record<string, unknown>) =>
    api.patch<RoadmapBlock>(`/roadmap-blocks/${id}`, data),
  roadmapBlockRemove: (id: string) => api.delete<RoadmapBlock>(`/roadmap-blocks/${id}`),
  roadmapEdgeCreate: (companyId: string, data: Record<string, unknown>) =>
    api.post<RoadmapBlockEdge>(`/companies/${companyId}/roadmap-block-edges`, data),
  roadmapEdgeRemove: (id: string) => api.delete<RoadmapBlockEdge>(`/roadmap-block-edges/${id}`),
  roadmapLinkCreate: (companyId: string, data: { blockId: string; goalId: string }) =>
    api.post<RoadmapBlockLink>(`/companies/${companyId}/roadmap-block-links`, data),
  roadmapLinkRemove: (id: string) => api.delete<RoadmapBlockLink>(`/roadmap-block-links/${id}`),
  roadmapBlockPromote: (id: string, data: PromoteRoadmapBlock) =>
    api.post<{ goal: Goal; block: RoadmapBlock }>(`/roadmap-blocks/${id}/promote`, data),
};
