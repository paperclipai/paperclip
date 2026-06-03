import { randomUUID } from "node:crypto";
import type { ApiApproval, ApiComment, ApiDocument, ApiIssue, PaperclipApi } from "./types.js";

/** In-memory fake for unit/integration tests. */
export class FakePaperclipApi implements PaperclipApi {
  comments = new Map<string, ApiComment[]>();
  private seq = 0;

  async postComment(issueId: string, body: string, metadata?: Record<string, unknown>): Promise<ApiComment> {
    const c: ApiComment = { id: randomUUID(), body, createdAt: new Date(Date.now() + ++this.seq).toISOString(), metadata };
    const list = this.comments.get(issueId) ?? [];
    list.push(c); this.comments.set(issueId, list);
    return c;
  }
  async listComments(issueId: string, sinceTs?: string): Promise<ApiComment[]> {
    const list = this.comments.get(issueId) ?? [];
    return sinceTs ? list.filter((c) => c.createdAt > sinceTs) : [...list];
  }
  issues: ApiIssue[] = [];
  async createIssue(_companyId: string, _input: { title: string; description: string }): Promise<ApiIssue> {
    const iss: ApiIssue = { id: randomUUID(), identifier: `PRO-${++this.seq}` };
    this.issues.push(iss);
    return iss;
  }
  docs = new Map<string, ApiDocument>();
  async putDocument(issueId: string, key: string, doc: { title: string; body: string; format: string }): Promise<ApiDocument> {
    const d: ApiDocument = { key, title: doc.title, body: doc.body, format: doc.format, latestRevisionId: randomUUID() };
    this.docs.set(`${issueId}::${key}`, d);
    return d;
  }
  async getDocument(issueId: string, key: string): Promise<ApiDocument | null> {
    return this.docs.get(`${issueId}::${key}`) ?? null;
  }
  approvals = new Map<string, ApiApproval>();
  async createApproval(_companyId: string, _input: { kind: string; summary: string }): Promise<ApiApproval> {
    const ap: ApiApproval = { id: randomUUID(), status: "pending" };
    this.approvals.set(ap.id, ap);
    return ap;
  }
  async getApproval(id: string): Promise<ApiApproval | null> { return this.approvals.get(id) ?? null; }
  async resolveApproval(id: string, decision: "approve" | "reject"): Promise<ApiApproval> {
    const ap = this.approvals.get(id) ?? { id, status: "pending" };
    const next = { ...ap, status: decision === "approve" ? "approved" : "rejected" };
    this.approvals.set(id, next);
    return next;
  }
}
