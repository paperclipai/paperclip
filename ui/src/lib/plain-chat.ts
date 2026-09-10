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
// Updates include all mutable configuration, with init-only appId omitted.
// Explicit empty threadDetails clears a previous company association.
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
   * The Plain tenant ID for the customer's currently selected
   * company, or null for no company context. Server-provided only — non-null
   * means the server has already ensured the tenant exists in Plain. Passed
   * as `threadDetails.tenantIdentifier`, which scopes threads *created from
   * now on* to that tenant; it is context, not identity, so
   * `updateSupportChatCompany` may change it within one page lifetime.
   */
  tenantId: string | null;
  /**
   * Stable key for the identity this mount represents. Mount requests with a
   * key different from the mounted one are refused (no documented vendor
   * reset API) until the next full page load.
   */
  identityKey: string;
}

/** The subset of the Plain widget global this module calls. */
interface PlainGlobal {
  init: (config: Record<string, unknown>) => void | Promise<void>;
  update: (config: Record<string, unknown>) => void | Promise<void>;
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

function buildThreadDetails(tenantId: string | null): Record<string, unknown> {
  // Applied by Plain to threads created from this point on; threads that
  // already exist keep the tenant they were created under. Only the tenant
  // reference — never product content.
  return tenantId ? { tenantIdentifier: { tenantId } } : {};
}

function buildConfig(opts: SupportChatMountOptions): Record<string, unknown> {
  return {
    appId: opts.appId,
    theme: opts.theme,
    hideLauncher: false,
    // Never include product content, URLs, or logs here. The identity block
    // is the server-attested customer identity, the thread block is the
    // current-company tenant reference, and nothing else — see the
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
    threadDetails: buildThreadDetails(opts.tenantId),
  };
}

/** Disable the vendor surface for this page after any untrusted transition.
 * Plain's default launcher and panel share the plain-chat shadow host. Remove
 * that host as well as requesting close: a rejected SDK update cannot be
 * relied on to hide itself. Recovery requires a fresh document.
 */
function disableSupportChat() {
  try { plain?.close(); } catch { /* DOM removal below is authoritative. */ }
  document.getElementById("plain-chat")?.remove();
  lastConfig = null;
  setState({ status: "error", launcherVisible: false });
}

/** Push mutable configuration to a mounted widget. */
async function applyConfig(next: Record<string, unknown>) {
  if (!plain || state.status === "error") return;
  try {
    // appId is init-only; Plain rejects it in update configuration.
    const { appId: _appId, ...updateConfig } = next;
    await plain.update(updateConfig);
    lastConfig = next;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[paperclip] Plain chat update failed", err);
    disableSupportChat();
  }
}

async function applyUpdate(patch: Record<string, unknown>) {
  if (!plain || !lastConfig) return;
  await applyConfig({ ...lastConfig, ...patch });
}

/**
 * Mount (or re-show) the Plain chat launcher for the given identity.
 * Idempotent per identity key; refuses a cross-identity swap within one page
 * lifetime (see module header).
 */
export function mountSupportChat(opts: SupportChatMountOptions): Promise<void> {
  return enqueue(async () => {
    if (state.status === "error") return;
    if (mountedIdentityKey !== null) {
      if (mountedIdentityKey !== opts.identityKey) {
        disableSupportChat();
        // eslint-disable-next-line no-console
        console.warn(
          "[paperclip] Support chat is already bound to another account for this page; reload to start a chat session for the new account.",
        );
        return;
      }
      await applyUpdate({ hideLauncher: false, theme: opts.theme });
      if (getSupportChatWidgetStatus() !== "error") setState({ launcherVisible: true });
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
      await Plain.init(config);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Plain chat bootstrap failed", err);
      disableSupportChat();
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
    await applyUpdate({ hideLauncher: true });
    setState({ launcherVisible: false });
  });
}

/** Keep the widget theme in step with the product theme. */
export function updateSupportChatTheme(theme: SupportChatTheme): Promise<void> {
  return enqueue(async () => {
    if (!plain) return;
    await applyUpdate({ theme });
  });
}

/**
 * Point new support threads at the customer's currently selected company
 * (a Plain tenant), or clear the association when no company is selected.
 * Company context is not identity: switching it neither closes an open panel
 * nor re-keys the mounted identity — threads already created keep the tenant
 * they started under. A no-op before the widget mounts (the mount itself
 * carries the initial context).
 */
export function updateSupportChatCompany(tenantId: string | null): Promise<void> {
  return enqueue(async () => {
    if (!plain || !lastConfig) return;
    const next = { ...lastConfig };
    // Omitting this key preserves the previous tenant in Plain. An explicit
    // empty object replaces thread metadata when no company is selected.
    next.threadDetails = buildThreadDetails(tenantId);
    await applyConfig(next);
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
