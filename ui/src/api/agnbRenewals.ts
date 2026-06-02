import { agnb, unwrap } from "./agnbClient";

/**
 * Same-origin fetch for AGNB endpoints already ported into the Paperclip
 * server (under /api/agnb/*). As each route group migrates off the standalone
 * AGNB app, its client call moves here. See docs/migration/AGNB_CONSOLIDATION.md.
 */
async function ported<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AGNB request failed: ${res.status}`);
  }
  return res.json();
}

export interface Renewal {
  id: string; kind: string; name: string; vendor: string | null; amount_paise: number | null; currency: string | null;
  renewal_date: string; status: string; notes: string | null; owner_email: string | null; last_reminded_at: string | null; created_at: string;
}
export interface ChangelogDraft {
  id: string; version: string | null; period_start: string; period_end: string; commit_count: number; markdown: string; status: string; published_at: string | null; created_at: string;
}
export interface NewsletterIssue {
  id: string; issue_number: number | null; period_start: string | null; period_end: string | null; subject: string | null; intro: string | null; blog_ids: string[]; body_html: string | null; status: string; sent_at: string | null; created_at: string;
}
export interface PressRelease {
  id: string; trigger_event: string; headline: string | null; subhead: string | null; body: string | null; quote: string | null; spokesperson_name: string | null; spokesperson_title: string | null; status: string; created_at: string;
}

export const renewalsApi = {
  // Ported to Paperclip server — same-origin /api/agnb/renewals.
  renewals: () => ported<{ ok: boolean; error?: string; renewals: Renewal[] }>("/renewals").then((r) => unwrap(r).renewals),
  createRenewal: (b: { kind: string; name: string; vendor?: string; renewal_date: string; amount_paise?: number; currency?: string; notes?: string }) =>
    ported("/renewals", { method: "POST", body: b }),
  patchRenewal: (id: string, b: Record<string, unknown>) => ported(`/renewals?id=${id}`, { method: "PATCH", body: b }),
  deleteRenewal: (id: string) => ported(`/renewals?id=${id}`, { method: "DELETE" }),

  // Ported to Paperclip server — same-origin /api/agnb/changelog-queue.
  changelog: () => ported<{ ok: boolean; error?: string; changelog: ChangelogDraft[] }>("/changelog-queue").then((r) => unwrap(r).changelog),
  publishChangelog: (id: string) => ported(`/changelog-queue?id=${id}`, { method: "PATCH", body: { status: "published" } }),
  deleteChangelog: (id: string) => ported(`/changelog-queue?id=${id}`, { method: "DELETE" }),
  // PHASE 5: cron changelog-drafter (LLM) — left cross-origin.
  draftChangelog: () => agnb.post("/crons/run?path=/all-gas-no-brakes/api/internal/changelog-drafter", {}),

  // Ported to Paperclip server — same-origin /api/agnb/newsletter.
  newsletter: () => ported<{ ok: boolean; error?: string; issues: NewsletterIssue[] }>("/newsletter").then((r) => unwrap(r).issues),
  markNewsletterSent: (id: string) => ported(`/newsletter?id=${id}`, { method: "PATCH", body: { status: "sent" } }),
  deleteNewsletter: (id: string) => ported(`/newsletter?id=${id}`, { method: "DELETE" }),
  // PHASE 5: cron newsletter-drafter (LLM) — left cross-origin.
  draftNewsletter: () => agnb.post("/crons/run?path=/all-gas-no-brakes/api/internal/newsletter-drafter", {}),

  // Ported to Paperclip server — same-origin /api/agnb/press-releases.
  pressReleases: () => ported<{ ok: boolean; error?: string; releases: PressRelease[] }>("/press-releases").then((r) => unwrap(r).releases),
  publishPress: (id: string) => ported(`/press-releases?id=${id}`, { method: "PATCH", body: { status: "published" } }),
  deletePress: (id: string) => ported(`/press-releases?id=${id}`, { method: "DELETE" }),
  // PHASE 5: press-release drafter calls Gemini (LLM) — left cross-origin.
  draftPress: (b: { trigger_event: string; details: string; spokesperson_name?: string; spokesperson_title?: string }) => agnb.post("/press-release", b),
};
