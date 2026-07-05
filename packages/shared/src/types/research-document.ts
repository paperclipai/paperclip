// A research document is any issue document written under the `research` key
// (or a `research-*` fallback key produced when the base document is locked).
// The Research Section surfaces these company-wide so researched topics live in
// one place instead of being scattered across tasks and conversations.
export interface ResearchDocument {
  documentId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  key: string;
  title: string | null;
  format: string;
  excerpt: string;
  latestRevisionNumber: number;
  // Who started the research — the human (or agent) who created the parent task.
  startedByUserId: string | null;
  startedByAgentId: string | null;
  startedByAgentName: string | null;
  startedByLabel: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResearchDocumentDetail extends ResearchDocument {
  body: string;
}
