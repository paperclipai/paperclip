import type {
  IssueStatus,
  SummarySlotKey,
  SummarySlotScopeKind,
  SummarySlotStatus,
} from "../constants.js";
import type { DocumentFormat } from "./issue.js";

export interface SummarySlot {
  id: string;
  companyId: string;
  scopeKind: SummarySlotScopeKind;
  scopeId: string | null;
  slotKey: SummarySlotKey;
  documentId: string | null;
  status: SummarySlotStatus;
  failureReason: string | null;
  generatingIssueId: string | null;
  lastGeneratedAt: Date | string | null;
  lastGeneratedByAgentId: string | null;
  lastModel: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SummarySlotDocument {
  id: string;
  companyId: string;
  title: string | null;
  format: DocumentFormat;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface SummarySlotRevision {
  id: string;
  companyId: string;
  documentId: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date | string;
}

export interface SummarySlotIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  assigneeAgentId?: string | null;
}

export interface SummarySlotScopeSelector {
  scopeKind: SummarySlotScopeKind;
  scopeId?: string | null;
  slotKey: SummarySlotKey;
}

export interface GetSummarySlotResponse {
  slot: SummarySlot | null;
  document: SummarySlotDocument | null;
  generatingIssue: SummarySlotIssueRef | null;
}

export interface ListSummarySlotRevisionsResponse {
  slot: SummarySlot | null;
  revisions: SummarySlotRevision[];
}

export interface GenerateSummarySlotRequest {
  scopeId?: string | null;
}

export interface GenerateSummarySlotResponse {
  slot: SummarySlot;
  generatingIssue: SummarySlotIssueRef;
  alreadyGenerating: boolean;
}

export interface WriteSummarySlotRequest {
  scopeId?: string | null;
  markdown: string;
  title?: string | null;
  changeSummary?: string | null;
  baseRevisionId?: string | null;
  generationIssueId?: string | null;
  model?: string | null;
}

export interface WriteSummarySlotResponse {
  slot: SummarySlot;
  document: SummarySlotDocument;
  revision: SummarySlotRevision;
}
