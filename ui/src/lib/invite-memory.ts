const PENDING_INVITE_STORAGE_KEY = "paperclip:pending-invite-token";

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function rememberPendingInviteToken(token: string) {
  const normalized = token.trim();
  if (!normalized || !canUseStorage()) return;
  try {
    window.localStorage.setItem(PENDING_INVITE_STORAGE_KEY, normalized);
  } catch {
    // Ignore storage failures and keep the invite flow usable.
  }
}

export function clearPendingInviteToken(expectedToken?: string) {
  if (!canUseStorage()) return;
  try {
    const current = window.localStorage.getItem(PENDING_INVITE_STORAGE_KEY);
    if (expectedToken && current !== expectedToken.trim()) return;
    window.localStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function getRememberedInvitePath() {
  if (!canUseStorage()) return null;
  try {
    const token = window.localStorage.getItem(PENDING_INVITE_STORAGE_KEY)?.trim();
    return token ? `/invite/${token}` : null;
  } catch {
    return null;
  }
}
