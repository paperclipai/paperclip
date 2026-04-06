import type {
  DeliverableType,
  DeliverableStatus,
  DeliverablePriority,
  DeliverableContentKind,
  DeliverableStageStatus,
} from "../constants.js";

export interface Deliverable {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  title: string;
  description: string | null;
  type: DeliverableType;
  status: DeliverableStatus;
  priority: DeliverablePriority;
  currentStageIndex: number;
  reviewPipelineTemplateId: string | null;
  submittedByAgentId: string | null;
  submittedByUserId: string | null;
  dueAt: Date | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contents?: DeliverableContent[];
  stages?: DeliverableReviewStage[];
  comments?: DeliverableComment[];
}

export interface DeliverableContent {
  id: string;
  deliverableId: string;
  kind: DeliverableContentKind;
  title: string;
  body: string | null;
  url: string | null;
  filePath: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  metadata: Record<string, unknown> | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliverableReviewStage {
  id: string;
  deliverableId: string;
  stageIndex: number;
  label: string;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  status: DeliverableStageStatus;
  decisionNote: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliverableComment {
  id: string;
  deliverableId: string;
  stageId: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewPipelineTemplate {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  stages: ReviewPipelineTemplateStage[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewPipelineTemplateStage {
  label: string;
  reviewerAgentId?: string;
  reviewerUserId?: string;
  role?: string;
}

export interface ProjectReviewDefault {
  projectId: string;
  companyId: string;
  reviewPipelineTemplateId: string;
  createdAt: Date;
  updatedAt: Date;
}
