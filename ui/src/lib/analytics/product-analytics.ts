// Browser product analytics (PostHog) for hosted Paperclip Cloud.
//
// This is the only module that talks to posthog-js. It runs only when the
// signed-in session carries a `browserAnalytics` config, which the server
// sends only for a cloud-managed instance with a PostHog project token and
// `PAPERCLIP_POSTHOG_BROWSER_ENABLED=1`. Without a config nothing here runs
// and posthog-js is never fetched.
//
// posthog-js is not an npm dependency of the board. It loads as PostHog's
// browser script (`/static/array.js`) through the same-origin proxy, like the
// extensions it loads itself (recorder, web vitals). So it is in no bundle
// chunk, and self-hosted installs, which have no proxy, can never load it.
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

import type { BrowserAnalyticsConfig } from "@paperclipai/shared";
import {
  ANALYTICS_MASK_TEXT_SELECTOR,
  ANALYTICS_NO_CAPTURE_CLASS,
  maskReplayAttribute,
  redactAnalyticsUrl,
} from "./privacy";

/** The posthog-js calls this module makes. */
export interface ProductAnalyticsClient {
  init(token: string, config: PostHogInitOptions): unknown;
  register(properties: Record<string, unknown>): void;
  identify(distinctId: string, personProperties?: Record<string, unknown>): void;
  group(groupType: string, groupKey: string): void;
  reset(): void;
}

/** An event as posthog-js hands it to `before_send`. */
export type CapturedEvent = {
  event: string;
  properties: Record<string, unknown>;
  timestamp?: Date;
  [key: string]: unknown;
};

/** The posthog-js `init` options this module sets (posthog-js `PostHogConfig`). */
export type PostHogInitOptions = {
  api_host: string;
  ui_host?: string;
  person_profiles: "identified_only";
  capture_pageview: "history_change";
  capture_pageleave: boolean;
  autocapture: boolean;
  mask_all_text: boolean;
  mask_all_element_attributes: boolean;
  capture_performance: { web_vitals: boolean };
  enable_heatmaps: boolean;
  disable_session_recording: boolean;
  session_recording: {
    maskAllInputs: boolean;
    maskTextSelector: string;
    maskAttributeFn: (name: string, value: string, element?: Element | null) => string;
    blockClass: string;
  };
  tracing_headers: string[];
  mask_personal_data_properties: boolean;
  before_send: (event: CapturedEvent | null) => CapturedEvent | null;
  disable_surveys: boolean;
  disable_product_tours: boolean;
  disable_web_experiments: boolean;
  disable_conversations: boolean;
};

export type ProductAnalyticsUser = {
  id: string;
  email: string | null;
  name: string | null;
};

export type ProductAnalyticsOptions = {
  /** Overridable for tests. Defaults to loading PostHog's script through the proxy. */
  load?: (config: BrowserAnalyticsConfig) => Promise<ProductAnalyticsClient>;
  /** Calls `start` when posthog-js may load; returns a cancel function. */
  schedule: (start: () => void) => () => void;
};

/** Load posthog-js no later than this after the session arrives. */
export const PRODUCT_ANALYTICS_LOAD_DEADLINE_MS = 15_000;

const WORKSPACE_GROUP_TYPE = "workspace";

/** PostHog's browser build, served by the assets host through the proxy. */
export const POSTHOG_SCRIPT_PATH = "/static/array.js";

type WindowWithPostHog = Window & { posthog?: Partial<ProductAnalyticsClient> };

function loadPostHog(config: BrowserAnalyticsConfig): Promise<ProductAnalyticsClient> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${config.apiHost}${POSTHOG_SCRIPT_PATH}`;
    script.async = true;
    script.onload = () => {
      const client = (window as WindowWithPostHog).posthog;
      if (client && typeof client.init === "function") resolve(client as ProductAnalyticsClient);
      else reject(new Error("posthog_script_did_not_load"));
    };
    script.onerror = () => reject(new Error("posthog_script_did_not_load"));
    document.head.appendChild(script);
  });
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
  // Plain objects only: a `Date` (the event timestamp) and other class
  // instances pass through unchanged.
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
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
export function scrubCapturedEvent(event: CapturedEvent | null): CapturedEvent | null {
  if (!event) return event;
  const scrubbed = redactStrings(event) as CapturedEvent;
  if (scrubbed.properties) {
    delete scrubbed.properties.title;
    delete scrubbed.properties.$title;
  }
  return scrubbed;
}

export function buildPostHogInitOptions(
  config: BrowserAnalyticsConfig,
  apiHostname: string,
): PostHogInitOptions {
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
      // Text shows; only marked customer content and secrets mask (privacy.ts).
      maskAllInputs: true,
      maskTextSelector: ANALYTICS_MASK_TEXT_SELECTOR,
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
    load(config)
      .then((client) => {
        if (state !== current) return;
        client.init(config.token, buildPostHogInitOptions(config, window.location.hostname));
        client.register(superProperties(config));
        current.client = client;
        applyIdentity(client, config);
      })
      .catch(() => {
        // Analytics must never break the board. A failed script load leaves it
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
 * Forget the signed-in person now. Sign-out calls this before it leaves the
 * page (Cloud sign-out navigates away while the session query is still
 * populated), so the next person in this browser never inherits the identity.
 */
export function resetProductAnalyticsIdentity(): void {
  setProductAnalyticsUser(null);
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
