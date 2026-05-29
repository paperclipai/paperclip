// Manages a board API key for local_trusted mode.
// In local_trusted mode, the browser UI session is attributed to local-board
// (source: local_implicit) which cannot accept request_confirmation interactions.
// This module fetches a real board API key from the server (which creates one for the
// local-board user) and stores it in sessionStorage so the UI can authenticate
// confirmation actions without manual DB edits.

const STORAGE_KEY = "paperclip_local_board_key";

// The substring present in 403 errors that signal a local_implicit auth gap.
export const LOCAL_IMPLICIT_BOARD_AUTH_ERROR_FRAGMENT =
  "request_confirmation interactions require an authenticated board user";

export function getStoredBoardKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeBoardKey(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // ignore — sessionStorage unavailable (e.g. sandboxed iframe)
  }
}

export function clearStoredBoardKey(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function fetchAndStoreBoardKey(): Promise<string> {
  const res = await fetch("/api/board-auth/local-trusted-token", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      (body as { error?: string } | null)?.error ?? "Failed to authenticate board session";
    throw new Error(message);
  }
  const data = (await res.json()) as { token: string };
  storeBoardKey(data.token);
  return data.token;
}

export function isLocalImplicitBoardAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(LOCAL_IMPLICIT_BOARD_AUTH_ERROR_FRAGMENT);
}
