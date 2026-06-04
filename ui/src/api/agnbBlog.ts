import { ported, unwrap } from "./agnbClient";

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
  // Ported to All Gas No Brakes server — same-origin /api/agnb/blog-automation.
  drafts: () => ported<{ ok: boolean; error?: string; drafts: BlogDraft[] }>("/blog-automation").then((r) => unwrap(r).drafts),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/content-audit (pure-DB read of scan results).
  contentAudit: () => ported<{ ok: boolean; error?: string; issues: AuditIssue[] }>("/content-audit").then((r) => unwrap(r).issues),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/utm-hygiene (pure-DB read of scan results).
  utmHygiene: () => ported<{ ok: boolean; error?: string; issues: UtmIssue[] }>("/utm-hygiene").then((r) => unwrap(r).issues),

  // --- writes ---
  // Ported to All Gas No Brakes server — same-origin /api/agnb/blog/save.
  saveDraft: (b: { title: string; slug?: string; description?: string; mdx_body?: string; status?: string; scheduled_at?: string; frontmatter?: unknown }) =>
    ported<{ ok: boolean; error?: string; id?: string }>("/blog/save", { method: "POST", body: b }),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/blog-automation?id=.
  patchDraft: (id: string, b: { status?: string; scheduled_at?: string | null }) =>
    ported(`/blog-automation?id=${id}`, { method: "PATCH", body: b }),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/blog-automation?id=.
  deleteDraft: (id: string) => ported(`/blog-automation?id=${id}`, { method: "DELETE" }),
};
