import type { IssueAcceptanceCriterionState } from "../constants.js";

export interface IssueAcceptanceCriterion {
  id: string;
  companyId: string;
  issueId: string;
  text: string;
  state: IssueAcceptanceCriterionState;
  notes: string | null;
  position: number;
  evidenceWorkProductId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  resolvedByAgentId: string | null;
  resolvedByUserId: string | null;
  resolvedByRunId: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
