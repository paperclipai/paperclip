export interface ApiComment { id: string; body: string; createdAt: string; metadata?: Record<string, unknown>; }
export interface ApiDocument { key: string; title: string; body: string; format: string; latestRevisionId: string; }
export interface ApiIssue { id: string; identifier: string; }
export interface ApiApproval { id: string; status: string; }

export interface PaperclipApi {
  listComments(issueId: string, sinceTs?: string): Promise<ApiComment[]>;
  postComment(issueId: string, body: string, metadata?: Record<string, unknown>): Promise<ApiComment>;
  getDocument(issueId: string, key: string): Promise<ApiDocument | null>;
  putDocument(issueId: string, key: string, doc: { title: string; body: string; format: string; baseRevisionId?: string; changeSummary?: string }): Promise<ApiDocument>;
  createIssue(companyId: string, input: { title: string; description: string; assigneeAgentId?: string; status?: string; priority?: string }): Promise<ApiIssue>;
  createApproval(companyId: string, input: { kind: string; summary: string }): Promise<ApiApproval>;
  getApproval(approvalId: string): Promise<ApiApproval | null>;
  resolveApproval(approvalId: string, decision: "approve" | "reject"): Promise<ApiApproval>;
}
