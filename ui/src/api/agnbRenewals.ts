import { ported, unwrap } from "./agnbClient";

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
  // Ported to All Gas No Brakes server — same-origin /api/agnb/renewals.
  renewals: () => ported<{ ok: boolean; error?: string; renewals: Renewal[] }>("/renewals").then((r) => unwrap(r).renewals),
  createRenewal: (b: { kind: string; name: string; vendor?: string; renewal_date: string; amount_paise?: number; currency?: string; notes?: string }) =>
    ported("/renewals", { method: "POST", body: b }),
  patchRenewal: (id: string, b: Record<string, unknown>) => ported(`/renewals?id=${id}`, { method: "PATCH", body: b }),
  deleteRenewal: (id: string) => ported(`/renewals?id=${id}`, { method: "DELETE" }),

  // Ported to All Gas No Brakes server — same-origin /api/agnb/changelog-queue.
  changelog: () => ported<{ ok: boolean; error?: string; changelog: ChangelogDraft[] }>("/changelog-queue").then((r) => unwrap(r).changelog),
  publishChangelog: (id: string) => ported(`/changelog-queue?id=${id}`, { method: "PATCH", body: { status: "published" } }),
  deleteChangelog: (id: string) => ported(`/changelog-queue?id=${id}`, { method: "DELETE" }),

  // Ported to All Gas No Brakes server — same-origin /api/agnb/newsletter.
  newsletter: () => ported<{ ok: boolean; error?: string; issues: NewsletterIssue[] }>("/newsletter").then((r) => unwrap(r).issues),
  markNewsletterSent: (id: string) => ported(`/newsletter?id=${id}`, { method: "PATCH", body: { status: "sent" } }),
  deleteNewsletter: (id: string) => ported(`/newsletter?id=${id}`, { method: "DELETE" }),

  // Ported to All Gas No Brakes server — same-origin /api/agnb/press-releases.
  pressReleases: () => ported<{ ok: boolean; error?: string; releases: PressRelease[] }>("/press-releases").then((r) => unwrap(r).releases),
  publishPress: (id: string) => ported(`/press-releases?id=${id}`, { method: "PATCH", body: { status: "published" } }),
  deletePress: (id: string) => ported(`/press-releases?id=${id}`, { method: "DELETE" }),
};
