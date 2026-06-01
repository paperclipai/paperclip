import { agnb, unwrap } from "./agnbClient";

export interface BlogDraft {
  id: string; title: string; slug: string; description: string | null; status: string;
  cluster_type: string | null; scheduled_at: string | null; published_at: string | null;
  deployment_url: string | null; github_pr_url: string | null; error_message: string | null;
  created_by: string | null; updated_at: string; created_at: string;
}
export interface AuditIssue {
  id: string; blog_path: string; blog_title: string | null; issue_type: string; severity: string; details: string | null; detected_at: string; resolved_at: string | null;
}
export interface UtmIssue {
  id: string; source_kind: string; source_id: string; source_name: string | null; url: string; issue_type: string; severity: string; details: string | null; detected_at: string;
}

export const blogApi = {
  drafts: () => agnb.get<{ ok: boolean; error?: string; drafts: BlogDraft[] }>("/blog-automation").then((r) => unwrap(r).drafts),
  contentAudit: () => agnb.get<{ ok: boolean; error?: string; issues: AuditIssue[] }>("/content-audit").then((r) => unwrap(r).issues),
  utmHygiene: () => agnb.get<{ ok: boolean; error?: string; issues: UtmIssue[] }>("/utm-hygiene").then((r) => unwrap(r).issues),
};
