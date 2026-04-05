import { api } from "./client";

export interface BlogRunListItem {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  topic: string;
  lane: string;
  targetSite: string;
  status: string;
  currentStep: string | null;
  approval: {
    mode: string;
    state: string;
    approvalKeyHash: string | null;
  };
  publish: {
    mode: string;
    state: string;
    wordpressPostId: number | null;
    publishIdempotencyKey: string | null;
  };
  publicVerify: {
    state: string;
  };
  latestAttempt: {
    stepKey: string;
    status: string;
    attemptNumber: number;
    errorCode: string | null;
    errorMessage: string | null;
    finishedAt: string | null;
    updatedAt: string;
  } | null;
  latestApproval: {
    targetSlug: string;
    siteId: string;
    approvedAt: string;
    revokedAt: string | null;
  } | null;
  latestVerify: {
    verdict: string | null;
    failureNames: string[];
    summary: string | null;
  } | null;
  publishedUrl: string | null;
  failedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlogRunAttempt {
  id: string;
  blogRunId: string;
  companyId: string;
  stepKey: string;
  attemptNumber: number;
  status: string;
  workerAgentId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlogRunArtifact {
  id: string;
  blogRunId: string;
  companyId: string;
  stepAttemptId: string | null;
  stepKey: string;
  artifactKind: string;
  contentType: string;
  storageKind: string;
  storagePath: string | null;
  bodyPreview: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlogRunApproval {
  id: string;
  blogRunId: string;
  companyId: string;
  targetSlug: string;
  siteId: string;
  artifactHash: string;
  normalizedDomHash: string;
  policyVersion: string;
  approvalKeyHash: string;
  approvalPayload: Record<string, unknown> | null;
  approvedByAgentId: string | null;
  approvedByUserId: string | null;
  approvedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlogRunDetail {
  run: {
    id: string;
    companyId: string;
    projectId: string | null;
    issueId: string | null;
    topic: string;
    lane: string;
    targetSite: string;
    status: string;
    currentStep: string | null;
    approvalMode: string;
    publishMode: string;
    wordpressPostId: number | null;
    publishedUrl: string | null;
    approvalKeyHash: string | null;
    publishIdempotencyKey: string | null;
    contextJson: Record<string, unknown> | null;
    failedReason: string | null;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  attempts: BlogRunAttempt[];
  artifacts: BlogRunArtifact[];
  approvals: BlogRunApproval[];
  stopReason: Record<string, unknown> | null;
}

export const blogRunsApi = {
  create: (
    projectId: string,
    body: {
      topic: string;
      issueId?: string | null;
      lane?: string;
      targetSite?: string;
      approvalMode?: string;
      publishMode?: string;
      contextJson?: Record<string, unknown>;
    },
  ) => api.post(`/projects/${projectId}/blog-runs`, body),
  listForCompany: (companyId: string, options?: { limit?: number; mode?: "active" | "all" }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.mode) params.set("mode", options.mode);
    const qs = params.toString();
    return api.get<BlogRunListItem[]>(`/companies/${companyId}/blog-runs${qs ? `?${qs}` : ""}`);
  },
  get: (runId: string) => api.get<BlogRunDetail>(`/blog-runs/${runId}`),
  requestResumeReview: (
    runId: string,
    body: {
      recoveryAction: string;
      evidenceRefs: string[];
      requestedBy: string;
      notes?: string[];
    },
  ) => api.post(`/blog-runs/${runId}/request-resume-review`, body),
  requestPublishApprovalFromRun: (
    runId: string,
    body: {
      approvedByUserId?: string;
    },
  ) => api.post(`/blog-runs/${runId}/request-publish-approval-from-run`, body),
  runNext: (runId: string) => api.post(`/blog-runs/${runId}/run-next`, {}),
  markResumable: (
    runId: string,
    body: {
      specialistAcknowledgedBy: string;
      operatorReviewedBy: string;
      evidenceRefs: string[];
      confirmedRequirements: string[];
      notes?: string[];
    },
  ) => api.post(`/blog-runs/${runId}/mark-resumable`, body),
};
