import {
  connectionMethodRequiresConfiguration,
  connectionMethodSupportsAutomaticOAuth,
  getAvailableConnectionMethods,
  type AppDefinition,
  type ConnectionMethodDef,
} from "@paperclipai/shared";

/**
 * One-method sign-in skips the access step. These providers' warnings (Railway
 * project scope, Circleback sharing outside the workspace) must still be read
 * before authorizing, so the sign-in screen repeats them.
 */
export const SIGN_IN_GUIDANCE_SLUGS: ReadonlySet<string> = new Set(["railway", "circleback", "github"]);

export function availableToolConnectionMethods(entry: AppDefinition): ConnectionMethodDef[] {
  return getAvailableConnectionMethods(entry).filter((method) => (method.purpose ?? "tool") !== "channel");
}

/** A single sign-in method that Paperclip can start on its own, with nothing to fill in first. */
export function canUseAutomaticOAuthFastPath(entry: AppDefinition | null | undefined): boolean {
  if (!entry) return false;
  const methods = availableToolConnectionMethods(entry);
  const method = methods.length === 1 ? methods[0] : null;
  return Boolean(method && connectionMethodSupportsAutomaticOAuth(method) && !connectionMethodRequiresConfiguration(method));
}

/**
 * Connecting is one click: the fast path applies and there is nothing the
 * person must read or choose before the provider's own sign-in page.
 */
export function isOneClickOAuthApp(entry: AppDefinition | null | undefined): boolean {
  return Boolean(entry) && canUseAutomaticOAuthFastPath(entry) && !SIGN_IN_GUIDANCE_SLUGS.has(entry!.slug) && entry!.slug !== "google-workspace";
}

/** Query flag that asks the connect flow to start sign-in without its confirmation screen. */
export const ONE_CLICK_PARAM = "autostart";

const UNCLAIMED_MS = 15_000;
let reserved: { popup: Window; timer: number } | null = null;

/**
 * Open the sign-in window while a click still has user activation, for a
 * connect flow that is about to mount. Browsers refuse the window once the
 * click is over, so the flow cannot open it for itself after navigation.
 */
export function reserveOneClickPopup(): boolean {
  releaseOneClickPopup();
  let popup: Window | null = null;
  try {
    popup = window.open("about:blank", "_blank", "popup,width=720,height=760,resizable=yes,scrollbars=yes");
    if (popup) popup.opener = null;
  } catch {
    popup = null;
  }
  if (!popup) return false;
  reserved = { popup, timer: window.setTimeout(releaseOneClickPopup, UNCLAIMED_MS) };
  return true;
}

/** Whether a window opened by a card click is waiting for the flow. */
export function hasOneClickPopup(): boolean {
  return Boolean(reserved && !reserved.popup.closed);
}

/** Hand the reserved window to the flow that will navigate it. */
export function takeOneClickPopup(): Window | null {
  if (!reserved) return null;
  const { popup, timer } = reserved;
  window.clearTimeout(timer);
  reserved = null;
  return popup.closed ? null : popup;
}

/** Close a reserved window nobody is going to use. */
export function releaseOneClickPopup(): void {
  if (!reserved) return;
  window.clearTimeout(reserved.timer);
  try {
    reserved.popup.close();
  } catch {
    // The window is already gone.
  }
  reserved = null;
}
