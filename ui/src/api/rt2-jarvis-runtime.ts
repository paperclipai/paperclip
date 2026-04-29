import { api } from "./client";
import type {
  Rt2JarvisAutoPolicyDecision,
  Rt2JarvisQualityReviewQueue,
  Rt2JarvisRewriteProposal,
  Rt2JarvisRewriteProposalInput,
  Rt2JarvisRewriteProposalList,
  Rt2JarvisReverseDesignProposal,
  Rt2JarvisSkillCapability,
  Rt2JarvisTaskAdvice,
} from "@paperclipai/shared";

function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const value = search.toString();
  return value ? `?${value}` : "";
}

export const rt2JarvisRuntimeApi = {
  getTaskAdvice: (
    companyId: string,
    taskIssueId: string,
  ): Promise<Rt2JarvisTaskAdvice> =>
    api.get<Rt2JarvisTaskAdvice>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/tasks/${encodeURIComponent(taskIssueId)}/advice`,
    ),

  getQualityReviews: (companyId: string): Promise<Rt2JarvisQualityReviewQueue> =>
    api.get<Rt2JarvisQualityReviewQueue>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/quality-reviews`,
    ),

  listRewriteProposals: (companyId: string): Promise<Rt2JarvisRewriteProposalList> =>
    api.get<Rt2JarvisRewriteProposalList>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/rewrite-proposals`,
    ),

  createRewriteProposal: (
    companyId: string,
    input: Rt2JarvisRewriteProposalInput,
  ): Promise<Rt2JarvisRewriteProposal> =>
    api.post<Rt2JarvisRewriteProposal>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/rewrite-proposals`,
      input,
    ),

  requestRewriteApproval: (
    companyId: string,
    proposalId: string,
  ): Promise<Rt2JarvisRewriteProposal> =>
    api.post<Rt2JarvisRewriteProposal>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/rewrite-proposals/${encodeURIComponent(proposalId)}/request-approval`,
      {},
    ),

  approveQualityReview: (
    companyId: string,
    evaluationId: string,
    feedback?: string,
  ) =>
    api.post(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/quality-reviews/${encodeURIComponent(evaluationId)}/approve`,
      { feedback },
    ),

  rejectQualityReview: (
    companyId: string,
    evaluationId: string,
    feedback: string,
  ) =>
    api.post(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/quality-reviews/${encodeURIComponent(evaluationId)}/reject`,
      { feedback },
    ),

  decideAutoPolicy: (
    companyId: string,
    params: { aiScore: number; deliverableType?: string; mode?: "shadow" | "copilot" | "auto" },
  ): Promise<Rt2JarvisAutoPolicyDecision> =>
    api.get<Rt2JarvisAutoPolicyDecision>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/auto-policy${qs(params)}`,
    ),

  proposeReverseDesignedTasks: (
    companyId: string,
    input: { title: string; type: string; description?: string; projectId?: string },
  ): Promise<Rt2JarvisReverseDesignProposal> =>
    api.post<Rt2JarvisReverseDesignProposal>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/reverse-design-tasks`,
      input,
    ),

  listSkillCapabilities: (
    companyId: string,
    agentId?: string,
  ): Promise<Rt2JarvisSkillCapability[]> =>
    api.get<Rt2JarvisSkillCapability[]>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/skill-capabilities${qs({ agentId })}`,
    ),

  createSkillCapability: (
    companyId: string,
    input: { agentId: string; skillKey: string; skillId?: string; injectionType?: string; context?: Record<string, unknown> },
  ): Promise<Rt2JarvisSkillCapability> =>
    api.post<Rt2JarvisSkillCapability>(
      `/companies/${encodeURIComponent(companyId)}/rt2/jarvis/skill-capabilities`,
      input,
    ),
};
