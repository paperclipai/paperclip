import { agnb, unwrap } from "./agnbClient";

/**
 * Same-origin fetch for AGNB endpoints already ported into the Paperclip
 * server (under /api/agnb/*). As each route group migrates off the standalone
 * AGNB app, its client call moves here. See docs/migration/AGNB_CONSOLIDATION.md.
 */
async function ported<T>(path: string): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AGNB request failed: ${res.status}`);
  }
  return res.json();
}

/** Same-origin write (POST/PATCH/DELETE) for ported /api/agnb/* endpoints. */
async function portedSend<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errBody?.error ?? `AGNB request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

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
  // Ported to Paperclip server — same-origin /api/agnb/blog-automation.
  drafts: () => ported<{ ok: boolean; error?: string; drafts: BlogDraft[] }>("/blog-automation").then((r) => unwrap(r).drafts),
  // Ported to Paperclip server — same-origin /api/agnb/content-audit (pure-DB read of scan results).
  contentAudit: () => ported<{ ok: boolean; error?: string; issues: AuditIssue[] }>("/content-audit").then((r) => unwrap(r).issues),
  // Ported to Paperclip server — same-origin /api/agnb/utm-hygiene (pure-DB read of scan results).
  utmHygiene: () => ported<{ ok: boolean; error?: string; issues: UtmIssue[] }>("/utm-hygiene").then((r) => unwrap(r).issues),

  // --- writes ---
  // PHASE 5: ai-draft calls Gemini (LLM) — left cross-origin.
  aiDraft: (topic: string) => agnb.post<{ ok: boolean; error?: string } & AiDraft>("/blog/ai-draft", { topic }).then((r) => unwrap(r) as AiDraft),
  // Ported to Paperclip server — same-origin /api/agnb/blog/save.
  saveDraft: (b: { title: string; slug?: string; description?: string; mdx_body?: string; status?: string; scheduled_at?: string; frontmatter?: unknown }) =>
    portedSend<{ ok: boolean; error?: string; id?: string }>("/blog/save", "POST", b),
  // Ported to Paperclip server — same-origin /api/agnb/blog-automation?id=.
  patchDraft: (id: string, b: { status?: string; scheduled_at?: string | null }) =>
    portedSend(`/blog-automation?id=${id}`, "PATCH", b),
  // PHASE 5: publish performs GitHub commit + Cloud Run rebuild (external) — left cross-origin.
  publishDraft: (id: string) => agnb.post(`/blog/${id}/publish`, {}),
  // Ported to Paperclip server — same-origin /api/agnb/blog-automation?id=.
  deleteDraft: (id: string) => portedSend(`/blog-automation?id=${id}`, "DELETE"),
  // PHASE 5: cron triggers — left cross-origin.
  runContentAudit: () => agnb.post("/crons/run?path=/all-gas-no-brakes/api/internal/content-audit", {}),
  runUtmScan: () => agnb.post("/crons/run?path=/all-gas-no-brakes/api/internal/utm-hygiene-scan", {}),
};
