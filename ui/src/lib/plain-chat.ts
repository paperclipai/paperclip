// The Plain support chat widget controller.
//
// Activated only when `GET /api/support-chat/session` answers 200 — see
// `SupportChatGate.tsx`. A self-hosted instance answers 404, so this module's
// script injection never runs there and the page makes no request to Plain's
// CDN.
//
// Everything here goes through documented Plain widget APIs only
// (https://www.plain.com/docs/product/channels/chat-customization):
// `Plain.init`, `Plain.update`, `Plain.open`, `Plain.close`. Plain documents
// no teardown/identity-reset call, so this controller enforces a
// one-identity-per-page-lifetime policy instead of guessing at vendor
// internals:
//
// - The first successful `mountSupportChat` binds the page to that identity
//   key (user id + attestation mode).
// - A later mount for the *same* key re-shows the launcher via `Plain.update`.
// - A later mount for a *different* key refuses and leaves the widget hidden
//   until a full page load. On Cloud this situation cannot be reached: tenant
//   sign-out is a top-level navigation (`useSignOut`), so the document — and
//   the widget with it — is gone before another account can sign in.
// - `hideSupportChat` (sign-out with the document still alive) closes the
//   panel and hides the launcher through `Plain.update({ hideLauncher: true })`.
//
// `Plain.update`'s partial-config merge behavior is not documented, so every
// update call passes the complete last-known config with the changed fields
// applied — correct under both merge and replace semantics.
//
// Operations queue on one shared promise chain (same pattern as
// `ui/src/lib/sentry.ts`), so a sign-out issued while the vendor script is
// still loading runs strictly after the mount it races, never interleaved
// with it.

import { useSyncExternalStore } from "react";

export const PLAIN_SCRIPT_URL = "https://chat.cdn-plain.com/index.js";

export type SupportChatTheme = "light" | "dark";

export interface SupportChatCustomerDetails {
  email: string;
  emailHash: string;
  fullName?: string | null;
  externalId?: string | null;
}

export interface SupportChatMountOptions {
  appId: string;
  theme: SupportChatTheme;
  customer: SupportChatCustomerDetails | null;
  /**
   * Stable key for the identity this mount represents. Mount requests with a
   * key different from the mounted one are refused (no documented vendor
   * reset API) until the next full page load.
   */
  identityKey: string;
}

/** The subset of the Plain widget global this module calls. */
interface PlainGlobal {
  init: (config: Record<string, unknown>) => void;
  update: (config: Record<string, unknown>) => void;
  open: () => void;
  close: () => void;
}

type WidgetState = {
  status: "idle" | "loading" | "ready" | "error";
  /** True while the launcher is intentionally visible for the mounted identity. */
  launcherVisible: boolean;
};

let state: WidgetState = { status: "idle", launcherVisible: false };
const listeners = new Set<() => void>();

let queue: Promise<void> = Promise.resolve();
let scriptPromise: Promise<PlainGlobal | null> | null = null;
let plain: PlainGlobal | null = null;
let mountedIdentityKey: string | null = null;
let lastConfig: Record<string, unknown> | null = null;

function setState(patch: Partial<WidgetState>) {
  const next = { ...state, ...patch };
  if (next.status === state.status && next.launcherVisible === state.launcherVisible) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Run controller operations one at a time, in call order. */
function enqueue(op: () => Promise<void>): Promise<void> {
  const next = queue.then(op);
  queue = next.catch(() => {});
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getLauncherActive(): boolean {
  return state.status === "ready" && state.launcherVisible;
}

function getStatus(): WidgetState["status"] {
  return state.status;
}

/**
 * True while the Plain launcher is mounted and visible. The sidebar feedback
 * flag hides itself only on this signal, so a script/config failure — or a
 * refused identity swap — keeps the original feedback entry point reachable.
 */
export function useSupportChatLauncherActive(): boolean {
  return useSyncExternalStore(subscribe, getLauncherActive, getLauncherActive);
}

/** Current widget status, for tests and diagnostics. */
export function getSupportChatWidgetStatus(): WidgetState["status"] {
  return state.status;
}

export function useSupportChatWidgetStatus(): WidgetState["status"] {
  return useSyncExternalStore(subscribe, getStatus, getStatus);
}

function readPlainGlobal(): PlainGlobal | null {
  const candidate = (window as unknown as { Plain?: unknown }).Plain;
  if (
    candidate &&
    typeof (candidate as PlainGlobal).init === "function" &&
    typeof (candidate as PlainGlobal).update === "function"
  ) {
    return candidate as PlainGlobal;
  }
  return null;
}

/**
 * Inject the Plain widget script once and resolve its global. Resolves `null`
 * on load failure — the controller fails open into the flag fallback rather
 * than crashing anything.
 */
function loadPlainScript(): Promise<PlainGlobal | null> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve) => {
    const existing = readPlainGlobal();
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = PLAIN_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(readPlainGlobal());
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return scriptPromise;
}

function buildConfig(opts: SupportChatMountOptions): Record<string, unknown> {
  return {
    appId: opts.appId,
    theme: opts.theme,
    hideLauncher: false,
    // Never include product content, URLs, or logs here. The identity block
    // is the server-attested customer identity and nothing else — see the
    // support-chat session route.
    ...(opts.customer
      ? {
          customerDetails: {
            email: opts.customer.email,
            emailHash: opts.customer.emailHash,
            ...(opts.customer.fullName ? { fullName: opts.customer.fullName } : {}),
            ...(opts.customer.externalId ? { externalId: opts.customer.externalId } : {}),
          },
        }
      : {}),
  };
}

function applyUpdate(patch: Record<string, unknown>) {
  if (!plain || !lastConfig) return;
  const next = { ...lastConfig, ...patch };
  try {
    plain.update(next);
    lastConfig = next;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[paperclip] Plain chat update failed", err);
  }
}

/**
 * Mount (or re-show) the Plain chat launcher for the given identity.
 * Idempotent per identity key; refuses a cross-identity swap within one page
 * lifetime (see module header).
 */
export function mountSupportChat(opts: SupportChatMountOptions): Promise<void> {
  return enqueue(async () => {
    if (mountedIdentityKey !== null) {
      if (mountedIdentityKey !== opts.identityKey) {
        // eslint-disable-next-line no-console
        console.warn(
          "[paperclip] Support chat is already bound to another account for this page; reload to start a chat session for the new account.",
        );
        return;
      }
      applyUpdate({ hideLauncher: false, theme: opts.theme });
      setState({ launcherVisible: true });
      return;
    }

    setState({ status: "loading", launcherVisible: false });
    const Plain = await loadPlainScript();
    if (!Plain) {
      setState({ status: "error", launcherVisible: false });
      return;
    }
    const config = buildConfig(opts);
    try {
      Plain.init(config);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Plain chat bootstrap failed", err);
      setState({ status: "error", launcherVisible: false });
      return;
    }
    plain = Plain;
    lastConfig = config;
    mountedIdentityKey = opts.identityKey;
    setState({ status: "ready", launcherVisible: true });
  });
}

/**
 * Hide the support chat surface: close an open panel and hide the launcher.
 * Called when the signed-in session goes away while the document survives
 * (self-hosted/dev-preview sign-out). A no-op before the widget mounts.
 */
export function hideSupportChat(): Promise<void> {
  return enqueue(async () => {
    if (!plain) return;
    try {
      plain.close();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Plain chat close failed", err);
    }
    applyUpdate({ hideLauncher: true });
    setState({ launcherVisible: false });
  });
}

/** Keep the widget theme in step with the product theme. */
export function updateSupportChatTheme(theme: SupportChatTheme): Promise<void> {
  return enqueue(async () => {
    if (!plain) return;
    applyUpdate({ theme });
  });
}

/** Test-only: reset module state between test cases. */
export function resetSupportChatForTests() {
  state = { status: "idle", launcherVisible: false };
  queue = Promise.resolve();
  scriptPromise = null;
  plain = null;
  mountedIdentityKey = null;
  lastConfig = null;
}
