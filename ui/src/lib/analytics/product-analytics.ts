// Browser product analytics (PostHog) for hosted Paperclip Cloud.
//
// This is the only module that talks to posthog-js. It runs only when the
// signed-in session carries a `browserAnalytics` config, which the server
// sends only for a cloud-managed instance with a PostHog project token and
// `PAPERCLIP_POSTHOG_BROWSER_ENABLED=1`. Without a config nothing here runs
// and posthog-js, which loads with a dynamic `import()`, is never fetched.
// See `ProductAnalyticsGate.tsx` and `server/src/services/cloud-posthog-browser.ts`.
//
// To keep cold loads fast, posthog-js loads only after the page settles
// (first paint, page reads finished, browser idle), or at a deadline.
//
// Identity: after sign-in the user's ID becomes the PostHog person, with email
// and name set as person properties only (never event properties), and the
// browser joins the `workspace` group for this stack. Sign-out resets both.
//
// Product events that the server already sends (`PAPERCLIP_EVENTS`) must never
// be captured here; `product-analytics-events.test.ts` enforces that.

import type { CaptureResult, PostHog, PostHogConfig } from "posthog-js";
import type { BrowserAnalyticsConfig } from "@paperclipai/shared";
import {
  ANALYTICS_MASK_TEXT_SELECTOR,
  ANALYTICS_NO_CAPTURE_CLASS,
  maskReplayAttribute,
  maskReplayText,
  redactAnalyticsUrl,
} from "./privacy";

export type ProductAnalyticsClient = Pick<
  PostHog,
  "init" | "register" | "identify" | "group" | "reset"
>;

export type ProductAnalyticsUser = {
  id: string;
  email: string | null;
  name: string | null;
};

export type ProductAnalyticsOptions = {
  /** Overridable for tests. Defaults to a dynamic import of posthog-js. */
  load?: () => Promise<ProductAnalyticsClient>;
  /** Calls `start` when posthog-js may load; returns a cancel function. */
  schedule: (start: () => void) => () => void;
};

/** Load posthog-js no later than this after the session arrives. */
export const PRODUCT_ANALYTICS_LOAD_DEADLINE_MS = 15_000;

const WORKSPACE_GROUP_TYPE = "workspace";

async function loadPostHog(): Promise<ProductAnalyticsClient> {
  const module = await import("posthog-js");
  return module.default;
}

const GZIP_MAGIC = "\x1f\x8b";

/** Redacts URL secrets in every string, including replay meta events (their `href`). */
function redactStrings(value: unknown): unknown {
  if (typeof value === "string") {
    // Compressed replay data is binary in a string; its attributes were
    // already masked by `maskReplayAttribute` before compression.
    return value.startsWith(GZIP_MAGIC) ? value : redactAnalyticsUrl(value);
  }
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStrings(entry)]));
  }
  return value;
}

/**
 * Last step before an event leaves the browser.
 * - Drops the page title: posthog-js copies `document.title` into page views,
 *   and Paperclip titles name the task and the organization.
 * - Redacts secrets in URLs (`$current_url`, `$referrer`, replay meta `href`,
 *   ...): one-time claim and invite tokens and secret query values.
 */
export function scrubCapturedEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  const scrubbed = redactStrings(event) as CaptureResult;
  if (scrubbed.properties) {
    delete scrubbed.properties.title;
    delete scrubbed.properties.$title;
  }
  return scrubbed;
}

export function buildPostHogInitOptions(
  config: BrowserAnalyticsConfig,
  apiHostname: string,
): Partial<PostHogConfig> {
  return {
    api_host: config.apiHost,
    ...(config.uiHost ? { ui_host: config.uiHost } : {}),
    person_profiles: "identified_only",
    capture_pageview: "history_change",
    capture_pageleave: true,
    // Clicks and their element tree only: never element text or attribute
    // values, so no customer content reaches autocapture events.
    autocapture: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    capture_performance: { web_vitals: true },
    enable_heatmaps: true,
    disable_session_recording: !config.replayEnabled,
    session_recording: {
      // Mask everything; only opted-in UI chrome shows its text (privacy.ts).
      maskAllInputs: true,
      maskTextSelector: ANALYTICS_MASK_TEXT_SELECTOR,
      maskTextFn: maskReplayText,
      // Attributes too (title, aria-label, alt, src, ...): deny by default.
      maskAttributeFn: maskReplayAttribute,
      blockClass: ANALYTICS_NO_CAPTURE_CLASS,
    },
    // Links browser sessions to server events (X-POSTHOG-SESSION-ID and
    // friends). Our own origin only; no third-party request gets them.
    tracing_headers: [apiHostname],
    // Advertising click IDs in URLs are personal data.
    mask_personal_data_properties: true,
    before_send: scrubCapturedEvent,
    // Features we do not use. Off, so posthog-js only calls the endpoints the
    // server proxy allows (server/src/routes/posthog-proxy.ts).
    disable_surveys: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    disable_conversations: true,
  };
}

function superProperties(config: BrowserAnalyticsConfig) {
  return {
    deployment_source: "cloud",
    environment: config.environment,
  };
}

type State = {
  config: BrowserAnalyticsConfig;
  client: ProductAnalyticsClient | null;
  cancelSchedule: (() => void) | null;
  loading: boolean;
};

let state: State | null = null;
let wantedUser: ProductAnalyticsUser | null = null;
let identifiedUserId: string | null = null;

function applyIdentity(client: ProductAnalyticsClient, config: BrowserAnalyticsConfig) {
  const user = wantedUser;
  if (user) {
    if (identifiedUserId === user.id) return;
    const personProperties: Record<string, string> = {};
    if (user.email) personProperties.email = user.email;
    if (user.name) personProperties.name = user.name;
    client.identify(user.id, personProperties);
    client.group(WORKSPACE_GROUP_TYPE, config.stackId);
    identifiedUserId = user.id;
    return;
  }
  if (identifiedUserId !== null) {
    // `reset` also clears super properties; keep the deployment ones.
    client.reset();
    client.register(superProperties(config));
    identifiedUserId = null;
  }
}

/**
 * Start browser analytics for this page session. Idempotent: posthog-js is a
 * page-wide singleton, so later calls (session refetches) keep the first
 * config.
 */
export function startProductAnalytics(
  config: BrowserAnalyticsConfig,
  options: ProductAnalyticsOptions,
): void {
  if (state) return;
  const current: State = { config, client: null, cancelSchedule: null, loading: false };
  state = current;
  const load = options.load ?? loadPostHog;
  current.cancelSchedule = options.schedule(() => {
    // The scheduler may call back more than once (settled page, deadline).
    const cancel = current.cancelSchedule;
    current.cancelSchedule = null;
    cancel?.();
    if (state !== current || current.loading) return;
    current.loading = true;
    load()
      .then((client) => {
        if (state !== current) return;
        client.init(config.token, buildPostHogInitOptions(config, window.location.hostname));
        client.register(superProperties(config));
        current.client = client;
        applyIdentity(client, config);
      })
      .catch(() => {
        // Analytics must never break the board. A failed chunk load leaves it
        // off for this page session.
        if (state === current) current.loading = false;
      });
  });
}

/** Set (or clear, on sign-out) the signed-in user. Safe to call before posthog-js loads. */
export function setProductAnalyticsUser(user: ProductAnalyticsUser | null): void {
  wantedUser = user;
  if (state?.client) applyIdentity(state.client, state.config);
}

/**
 * Cancel a load that has not started yet. posthog-js cannot be unloaded once
 * it runs, so a running client keeps running; sign-out resets its identity
 * through `setProductAnalyticsUser(null)`.
 */
export function cancelPendingProductAnalytics(): void {
  if (!state || state.client || state.loading) return;
  state.cancelSchedule?.();
  state = null;
}

export function resetProductAnalyticsForTest(): void {
  state?.cancelSchedule?.();
  state = null;
  wantedUser = null;
  identifiedUserId = null;
}
