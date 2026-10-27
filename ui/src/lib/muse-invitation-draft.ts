import { AGENT_ROLES, type AgentRole } from "@paperclipai/shared";

export interface MuseInvitationDraft { name: string; role: AgentRole }
export const emptyMuseInvitationDraft: MuseInvitationDraft = { name: "", role: "general" };

function key(companyId: string, operatorId: string) {
  return `paperclip.muse-invitation.${encodeURIComponent(companyId)}.${encodeURIComponent(operatorId)}`;
}

/** Only the name and role survive navigation. Pairing capabilities never enter storage. */
export function readMuseInvitationDraft(companyId: string, operatorId: string | null): MuseInvitationDraft {
  if (!operatorId) return { ...emptyMuseInvitationDraft };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(companyId, operatorId)) ?? "null");
    if (typeof value === "object" && value !== null && "name" in value && "role" in value
      && typeof value.name === "string" && value.name.length <= 100
      && AGENT_ROLES.some(role => role === value.role)) {
      return { name: value.name, role: AGENT_ROLES.find(role => role === value.role)! };
    }
  } catch { /* Storage is optional; the mounted draft remains usable. */ }
  return { ...emptyMuseInvitationDraft };
}

export function saveMuseInvitationDraft(companyId: string, operatorId: string | null, draft: MuseInvitationDraft) {
  if (!operatorId) return;
  try { localStorage.setItem(key(companyId, operatorId), JSON.stringify({ name: draft.name, role: draft.role })); }
  catch { /* Storage is optional. */ }
}

export function clearMuseInvitationDraft(companyId: string, operatorId: string | null) {
  if (!operatorId) return;
  try { localStorage.removeItem(key(companyId, operatorId)); } catch { /* Storage is optional. */ }
}
