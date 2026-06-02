import { agnb, unwrap } from "./agnbClient";

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
  threads: (status?: string) =>
    agnb.get<{ ok: boolean; error?: string; threads: InboxThread[] }>(`/inbox${status && status !== "all" ? `?status=${status}` : ""}`).then((r) => unwrap(r).threads),
  threadAction: (id: string, action: "archive" | "unarchive" | "mark_positive") =>
    agnb.post(`/inbox/${id}/action`, { action }),

  approvals: () => agnb.get<{ ok: boolean; error?: string; drafts: CampaignDraft[] }>("/approval").then((r) => unwrap(r).drafts),
  approvalAction: (id: string, action: "approve" | "reject" | "finalize") =>
    agnb.postAbs(`/all-gas-no-brakes/api/internal/approval/${id}`, { action }),

  replyDrafts: (status?: string) =>
    agnb.get<{ ok: boolean; error?: string; drafts: ReplyDraft[] }>(`/reply-drafts${status && status !== "all" ? `?status=${status}` : ""}`).then((r) => unwrap(r).drafts),
  patchReplyDraft: (id: string, status: string) => agnb.patch("/reply-drafts", { id, status }),

  replies: () => agnb.get<{ ok: boolean; error?: string; replies: ReplyLog[] }>("/replies").then((r) => unwrap(r).replies),
};
