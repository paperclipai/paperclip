import { tauriInvoke } from "./tauri-client";

export interface FeedbackVote {
  id: string;
  company_id: string;
  target_type: string;
  target_id: string;
  vote: string;
  reason: string | null;
  created_at: string;
}

export const feedbackApi = {
  vote: (companyId: string, targetType: string, targetId: string, vote: string, reason?: string) =>
    tauriInvoke<FeedbackVote>("vote_on_target", { companyId, targetType, targetId, vote, reason }),
  getVote: (targetType: string, targetId: string) =>
    tauriInvoke<FeedbackVote | null>("get_vote_for_target", { targetType, targetId }),
  list: (companyId: string) =>
    tauriInvoke<FeedbackVote[]>("list_votes", { companyId }),
};
