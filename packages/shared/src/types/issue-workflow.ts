import type {
  IssueWorkflowArtifactKind,
  IssueWorkflowLaneRole,
  IssueWorkflowTemplateKey,
} from "../constants.js";

export interface IssueWorkflowInstance {
  id: string;
  companyId: string;
  rootIssueId: string;
  templateKey: IssueWorkflowTemplateKey;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueWorkflowLane {
  id: string;
  companyId: string;
  workflowInstanceId: string;
  rootIssueId: string;
  issueId: string;
  laneRole: IssueWorkflowLaneRole;
  reviewerAgentId: string | null;
  invalidatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueWorkflowLaneArtifact {
  id: string;
  companyId: string;
  workflowLaneId: string;
  artifactKey: string;
  label: string;
  kind: IssueWorkflowArtifactKind;
  blocking: boolean;
  documentKey: string | null;
  workProductTypes: string[] | null;
  commentMarkers: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}
