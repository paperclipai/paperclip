import type { DocumentFormat } from "./issue.js";

export interface CompanyDocumentSummary {
  id: string;
  companyId: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyDocument extends CompanyDocumentSummary {
  body: string;
}

export interface CompanyDocumentRevision {
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
  createdAt: Date;
}
