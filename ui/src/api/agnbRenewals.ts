import { agnb, unwrap } from "./agnbClient";

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
  renewals: () => agnb.get<{ ok: boolean; error?: string; renewals: Renewal[] }>("/renewals").then((r) => unwrap(r).renewals),
  createRenewal: (b: { kind: string; name: string; vendor?: string; renewal_date: string; amount_paise?: number; currency?: string; notes?: string }) => agnb.post("/renewals", b),
  patchRenewal: (id: string, b: Record<string, unknown>) => agnb.patch(`/renewals?id=${id}`, b),
  deleteRenewal: (id: string) => agnb.delete(`/renewals?id=${id}`),

  changelog: () => agnb.get<{ ok: boolean; error?: string; changelog: ChangelogDraft[] }>("/changelog-queue").then((r) => unwrap(r).changelog),
  publishChangelog: (id: string) => agnb.patch(`/changelog-queue?id=${id}`, { status: "published" }),
  deleteChangelog: (id: string) => agnb.delete(`/changelog-queue?id=${id}`),
  draftChangelog: () => agnb.post("/crons/run?path=/all-gas-no-brakes/api/internal/changelog-drafter", {}),

  newsletter: () => agnb.get<{ ok: boolean; error?: string; issues: NewsletterIssue[] }>("/newsletter").then((r) => unwrap(r).issues),
  markNewsletterSent: (id: string) => agnb.patch(`/newsletter?id=${id}`, { status: "sent" }),
  deleteNewsletter: (id: string) => agnb.delete(`/newsletter?id=${id}`),
  draftNewsletter: () => agnb.post("/crons/run?path=/all-gas-no-brakes/api/internal/newsletter-drafter", {}),

  pressReleases: () => agnb.get<{ ok: boolean; error?: string; releases: PressRelease[] }>("/press-releases").then((r) => unwrap(r).releases),
  publishPress: (id: string) => agnb.patch(`/press-releases?id=${id}`, { status: "published" }),
  deletePress: (id: string) => agnb.delete(`/press-releases?id=${id}`),
  draftPress: (b: { trigger_event: string; details: string; spokesperson_name?: string; spokesperson_title?: string }) => agnb.post("/press-release", b),
};
