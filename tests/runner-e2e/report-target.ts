import type { RunnerE2EResult } from "./types.js";

function httpUrl(value: string, base?: string): URL | null {
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** The application under test, rather than the worker's execution environment. */
export function reportTargetUrl(result: RunnerE2EResult | undefined): string | null {
  const value = result?.targetUrl ?? result?.productJourney?.deployment?.origin ?? result?.providerConnection?.target.origin;
  return value ? httpUrl(value)?.href ?? null : null;
}

/** Evidence may live beside the report or at an explicit HTTP(S) destination. */
export function reportEvidenceHref(value: string): string | null {
  const href = value.trim();
  return href && httpUrl(href, "https://paperclip-report.invalid/") ? href : null;
}
