import type { RunnerE2EResult } from "./types.js";

/** The application under test, rather than the worker's execution environment. */
export function reportTargetUrl(result: RunnerE2EResult | undefined): string | null {
  const value = result?.targetUrl ?? result?.productJourney?.deployment?.origin ?? result?.providerConnection?.target.origin;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
