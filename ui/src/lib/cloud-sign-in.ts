const RECOVERY_KEY = "paperclip.cloud-sign-in-attempt";
const RECOVERY_WINDOW_MS = 5 * 60 * 1000;

export function clearCloudSignInAttempt() {
  try {
    window.sessionStorage.removeItem(RECOVERY_KEY);
  } catch {
    // Storage may be disabled. The manual Cloud sign-in link still works.
  }
}

/** One automatic handoff per tab until a session is verified, with a loop guard. */
export function beginCloudSignIn(url: string): boolean {
  try {
    const previous = Number(window.sessionStorage.getItem(RECOVERY_KEY));
    if (previous > Date.now() - RECOVERY_WINDOW_MS) return false;
    window.sessionStorage.setItem(RECOVERY_KEY, String(Date.now()));
  } catch {
    // Without durable tab state we cannot safely bound automatic navigation.
    return false;
  }
  window.location.replace(url);
  return true;
}
