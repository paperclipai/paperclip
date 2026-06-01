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

interface AiDraft { title: string; slug: string; description: string; mdx_body: string; keywords?: string[]; categories?: string[] }

export const blogApi = {
  drafts: () => agnb.get<{ ok: boolean; error?: string; drafts: BlogDraft[] }>("/blog-automation").then((r) => unwrap(r).drafts),
  contentAudit: () => agnb.get<{ ok: boolean; error?: string; issues: AuditIssue[] }>("/content-audit").then((r) => unwrap(r).issues),
  utmHygiene: () => agnb.get<{ ok: boolean; error?: string; issues: UtmIssue[] }>("/utm-hygiene").then((r) => unwrap(r).issues),

  // --- writes ---
  aiDraft: (topic: string) => agnb.post<{ ok: boolean; error?: string } & AiDraft>("/blog/ai-draft", { topic }).then((r) => unwrap(r) as AiDraft),
  saveDraft: (b: { title: string; slug?: string; description?: string; mdx_body?: string; status?: string; scheduled_at?: string; frontmatter?: unknown }) =>
    agnb.post<{ ok: boolean; error?: string; id?: string }>("/blog/save", b),
  patchDraft: (id: string, b: { status?: string; scheduled_at?: string | null }) => agnb.patch(`/blog-automation?id=${id}`, b),
  publishDraft: (id: string) => agnb.post(`/blog/${id}/publish`, {}),
  deleteDraft: (id: string) => agnb.delete(`/blog-automation?id=${id}`),
  runContentAudit: () => agnb.post("/crons/run?path=/all-gas-no-brakes/api/internal/content-audit", {}),
  runUtmScan: () => agnb.post("/crons/run?path=/all-gas-no-brakes/api/internal/utm-hygiene-scan", {}),
};
