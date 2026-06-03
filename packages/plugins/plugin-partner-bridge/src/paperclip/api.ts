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

/** Real client over global fetch to the local Paperclip API (loopback egress gate
 *  blocks ctx.http, so we use global fetch — same rationale as couch-http).
 *  Approval endpoints verified against server/src/routes/approvals.ts:
 *  create = POST /companies/:id/approvals {type, payload}; resolve = POST /approvals/:id/{approve|reject}.
 *  NOTE: /approve and /reject require a board actor (assertBoard); the live bootstrap
 *  must call them with a board-authorized token. */
export class HttpPaperclipApi implements PaperclipApi {
  private base: string;
  private headers: Record<string, string>;
  constructor(cfg: { baseUrl: string; token?: string }) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.headers = { "Content-Type": "application/json", ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) };
  }
  private async req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.base}${path}`, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data: unknown = null; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data: data as T };
  }
  async listComments(issueId: string, sinceTs?: string): Promise<ApiComment[]> {
    const { data } = await this.req<unknown>("GET", `/api/issues/${issueId}/comments`);
    const arr = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
    const mapped = arr.map((c) => ({ id: String(c.id), body: String(c.body ?? ""), createdAt: String(c.createdAt ?? ""), metadata: (c.metadata as Record<string, unknown>) ?? undefined }));
    return sinceTs ? mapped.filter((c) => c.createdAt > sinceTs) : mapped;
  }
  async postComment(issueId: string, body: string, metadata?: Record<string, unknown>): Promise<ApiComment> {
    const { data } = await this.req<Record<string, unknown>>("POST", `/api/issues/${issueId}/comments`, { body, metadata });
    return { id: String(data.id), body: String(data.body ?? body), createdAt: String(data.createdAt ?? ""), metadata };
  }
  async getDocument(issueId: string, key: string): Promise<ApiDocument | null> {
    const { status, data } = await this.req<Record<string, unknown>>("GET", `/api/issues/${issueId}/documents/${encodeURIComponent(key)}`);
    if (status >= 400 || !data) return null;
    return { key: String(data.key), title: String(data.title ?? ""), body: String(data.body ?? ""), format: String(data.format ?? "markdown"), latestRevisionId: String(data.latestRevisionId ?? "") };
  }
  async putDocument(issueId: string, key: string, doc: { title: string; body: string; format: string; baseRevisionId?: string; changeSummary?: string }): Promise<ApiDocument> {
    const { data } = await this.req<Record<string, unknown>>("PUT", `/api/issues/${issueId}/documents/${encodeURIComponent(key)}`, doc);
    return { key, title: doc.title, body: doc.body, format: doc.format, latestRevisionId: String(data.latestRevisionId ?? "") };
  }
  async createIssue(companyId: string, input: { title: string; description: string; assigneeAgentId?: string; status?: string; priority?: string }): Promise<ApiIssue> {
    const { data } = await this.req<Record<string, unknown>>("POST", `/api/companies/${companyId}/issues`, input);
    return { id: String(data.id), identifier: String(data.identifier ?? "") };
  }
  async createApproval(companyId: string, input: { kind: string; summary: string }): Promise<ApiApproval> {
    const { data } = await this.req<Record<string, unknown>>("POST", `/api/companies/${companyId}/approvals`, { type: input.kind, payload: { summary: input.summary } });
    return { id: String(data.id), status: String(data.status ?? "pending") };
  }
  async getApproval(approvalId: string): Promise<ApiApproval | null> {
    const { status, data } = await this.req<Record<string, unknown>>("GET", `/api/approvals/${approvalId}`);
    if (status >= 400 || !data) return null;
    return { id: String(data.id), status: String(data.status ?? "") };
  }
  async resolveApproval(approvalId: string, decision: "approve" | "reject"): Promise<ApiApproval> {
    const { data } = await this.req<Record<string, unknown>>("POST", `/api/approvals/${approvalId}/${decision}`, {});
    return { id: approvalId, status: String(data.status ?? (decision === "approve" ? "approved" : "rejected")) };
  }
}
