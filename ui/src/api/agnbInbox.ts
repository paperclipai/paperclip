import { ported, unwrap } from "./agnbClient";

export interface InboxThread {
  thread_id: string; subject: string | null; status: string | null;
  lead_email: string | null; lead_name: string | null; campaign_name: string | null;
  last_message_at: string | null; last_message_preview: string | null;
}
export interface CampaignDraft {
  id: string; name: string; product_id: string | null; persona_id: string | null;
  status: string; notes: string | null; rocket_campaign_id: string | null;
  created_at: string; created_by: string; approved_at: string | null;
}
export interface ReplyDraft {
  id: string; lead_email: string; lead_name: string | null; subject: string | null;
  body: string; status: string; created_at: string; sent_at: string | null; mailto_url: string | null;
}
export interface ReplyLog {
  id: string; campaign_name: string | null; from_email: string; from_name: string | null;
  subject: string | null; body: string; intent: string; intent_confidence: number | null;
  objection_cluster: string | null; next_action: string | null; received_at: string; logged_by: string;
}

export const inboxApi = {
  // Ported to All Gas No Brakes server — same-origin /api/agnb/inbox.
  threads: (status?: string) =>
    ported<{ ok: boolean; error?: string; threads: InboxThread[] }>(`/inbox${status && status !== "all" ? `?status=${status}` : ""}`).then((r) => unwrap(r).threads),
  threadAction: (id: string, action: "archive" | "unarchive" | "mark_positive") =>
    ported(`/inbox/${id}/action`, { method: "POST", body: { action } }),

  // Ported to All Gas No Brakes server — same-origin /api/agnb/approval (pure DB).
  approvals: () => ported<{ ok: boolean; error?: string; drafts: CampaignDraft[] }>("/approval").then((r) => unwrap(r).drafts),

  // Ported to All Gas No Brakes server — same-origin /api/agnb/reply-drafts (pure DB).
  replyDrafts: (status?: string) =>
    ported<{ ok: boolean; error?: string; drafts: ReplyDraft[] }>(`/reply-drafts${status && status !== "all" ? `?status=${status}` : ""}`).then((r) => unwrap(r).drafts),
  patchReplyDraft: (id: string, status: string) => ported("/reply-drafts", { method: "PATCH", body: { id, status } }),

  // Ported to All Gas No Brakes server — same-origin /api/agnb/replies (pure DB).
  replies: () => ported<{ ok: boolean; error?: string; replies: ReplyLog[] }>("/replies").then((r) => unwrap(r).replies),
};
