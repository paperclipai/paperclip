import type { invites } from "@paperclipai/db";

type InviteRow = typeof invites.$inferSelect;

export function inviteExpired(invite: InviteRow, nowMs: number = Date.now()) {
  return invite.expiresAt.getTime() <= nowMs;
}

export function inviteState(invite: InviteRow, nowMs: number = Date.now()) {
  if (invite.revokedAt) return "revoked" as const;
  if (invite.acceptedAt) return "accepted" as const;
  if (inviteExpired(invite, nowMs)) return "expired" as const;
  return "active" as const;
}
