// Resolves the browser performance tracing settings that the authenticated
// session hands to the board UI. See doc/browser-performance-tracing.md.
//
// Browser tracing is for hosted Paperclip Cloud instances only. It stays off
// (`null`) unless both hold:
//   1. the instance is cloud managed (`isCloudManagedInstance`), and
//   2. an operator set `PAPERCLIP_BROWSER_TRACES_ENDPOINT`.
// Self-hosted installs, local development, and tests never match (1), so the
// browser never downloads the tracing SDK there.
//
// Every invalid setting fails closed: the browser receives `null` and the
// server logs one warning naming the variable, never its value.

import type { BrowserTracingConfig } from "@paperclipai/shared";
import { isCloudManagedInstance, type CloudInstanceEnv } from "./services/cloud-instance.js";

export const BROWSER_TRACES_DEFAULT_SERVICE_NAME = "paperclip-web";
export const BROWSER_TRACES_DEFAULT_SAMPLE_RATE = 1;

/** Honeycomb ingest keys carry this prefix; configuration keys never do. */
const HONEYCOMB_INGEST_KEY_PREFIX = "hcaik_";

export type BrowserTracingWarning = (message: string) => void;

function normalize(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isHoneycombHost(hostname: string): boolean {
  return hostname === "honeycomb.io" || hostname.endsWith(".honeycomb.io");
}

/** OTLP/HTTP convention: a base URL gets `/v1/traces` appended. */
export function browserTracesUrl(endpoint: URL): string {
  const url = new URL(endpoint.href);
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/v1/traces")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/traces`;
  }
  return url.href;
}

export function resolveBrowserTracingConfig(
  env: CloudInstanceEnv = process.env,
  warn: BrowserTracingWarning = () => {},
): BrowserTracingConfig | null {
  if (!isCloudManagedInstance(env)) return null;

  const rawEndpoint = normalize(env.PAPERCLIP_BROWSER_TRACES_ENDPOINT);
  if (!rawEndpoint) return null;

  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    warn("PAPERCLIP_BROWSER_TRACES_ENDPOINT is not a valid URL; browser tracing is off");
    return null;
  }
  // A browser on an https page cannot post to plain http (mixed content).
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopbackHost(endpoint.hostname))) {
    warn("PAPERCLIP_BROWSER_TRACES_ENDPOINT must use https; browser tracing is off");
    return null;
  }

  const ingestKey = normalize(env.PAPERCLIP_BROWSER_TRACES_INGEST_KEY);
  // The key is readable by every signed-in browser, so only an ingest-only
  // key may ship. A configuration key could change the Honeycomb account.
  if (ingestKey !== null && !ingestKey.startsWith(HONEYCOMB_INGEST_KEY_PREFIX)) {
    warn("PAPERCLIP_BROWSER_TRACES_INGEST_KEY is not a Honeycomb ingest key (hcaik_…); browser tracing is off");
    return null;
  }
  if (ingestKey === null && isHoneycombHost(endpoint.hostname)) {
    warn("PAPERCLIP_BROWSER_TRACES_INGEST_KEY is required to send browser traces to Honeycomb; browser tracing is off");
    return null;
  }

  let sampleRate = BROWSER_TRACES_DEFAULT_SAMPLE_RATE;
  const rawSampleRate = normalize(env.PAPERCLIP_BROWSER_TRACES_SAMPLE_RATE);
  if (rawSampleRate !== null) {
    const parsed = Number(rawSampleRate);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      warn("PAPERCLIP_BROWSER_TRACES_SAMPLE_RATE must be a number from 0 to 1; browser tracing is off");
      return null;
    }
    if (parsed === 0) return null;
    // Honeycomb weights events by an integer `SampleRate` (1 in N). Sample at
    // exactly 1/N so weighted counts stay correct: 0.3 becomes 1/3.
    sampleRate = 1 / Math.max(1, Math.round(1 / parsed));
  }

  return {
    tracesUrl: browserTracesUrl(endpoint),
    ingestKey,
    serviceName: normalize(env.PAPERCLIP_BROWSER_TRACES_SERVICE_NAME) ?? BROWSER_TRACES_DEFAULT_SERVICE_NAME,
    environment: normalize(env.PAPERCLIP_BROWSER_TRACES_ENVIRONMENT) ?? normalize(env.SENTRY_ENVIRONMENT),
    sampleRate,
  };
}

const warnedMessages = new Set<string>();

/** Logs each distinct configuration warning once per process. */
export function warnOnce(log: (message: string) => void): BrowserTracingWarning {
  return (message) => {
    if (warnedMessages.has(message)) return;
    warnedMessages.add(message);
    log(message);
  };
}
