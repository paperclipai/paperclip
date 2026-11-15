import type { RunnerE2EResult } from "./types.js";

export const SCREENSHOT_PRIVACY_REASONS = [
  "inner-secret-finding", "persisted-state-secret-finding", "reporter-evidence-withheld", "packaged-evidence-secret-finding",
] as const;
export type ScreenshotPrivacyReason = typeof SCREENSHOT_PRIVACY_REASONS[number];
export interface ScreenshotPrivacy { withheld: true; reasons: ScreenshotPrivacyReason[] }

/** Sticky attempt-level privacy custody survives later cleanup/packaging labels.
 * A clean sanitized export cannot certify the original visual evidence. */
export function screenshotPrivacyReasons(result: Pick<RunnerE2EResult, "failureClass" | "screenshotPrivacy">): ScreenshotPrivacyReason[] {
  return [...new Set([
    ...(result.screenshotPrivacy?.reasons ?? []),
    ...(result.failureClass === "secret_leak" && !result.screenshotPrivacy ? ["inner-secret-finding" as const] : []),
  ])];
}

export function withholdPrivateScreenshots(result: RunnerE2EResult, findings: {
  innerSecretFinding?: boolean; persistedStateSecretFinding?: boolean; reporterEvidenceWithheld?: boolean; packagedEvidenceSecretFinding?: boolean;
} = {}): RunnerE2EResult {
  const reasons = [...new Set([
    ...screenshotPrivacyReasons(result),
    ...(findings.innerSecretFinding ? ["inner-secret-finding" as const] : []),
    ...(findings.persistedStateSecretFinding ? ["persisted-state-secret-finding" as const] : []),
    ...(findings.reporterEvidenceWithheld ? ["reporter-evidence-withheld" as const] : []),
    ...(findings.packagedEvidenceSecretFinding ? ["packaged-evidence-secret-finding" as const] : []),
  ])];
  if (!reasons.length) return result;
  return { ...result, screenshotPrivacy: { withheld: true, reasons },
    // Removing only the publication marker also protects older trusted
    // publishers. Original filenames, hashes and private PNG bytes remain.
    screenshots: result.screenshots?.map(({ publication: _, ...screenshot }) => screenshot) };
}

export function screenshotWithholdingNotice(result: Pick<RunnerE2EResult, "failureClass" | "screenshotPrivacy">): string | null {
  const reasons = screenshotPrivacyReasons(result);
  return reasons.length || result.screenshotPrivacy?.withheld ? `Screenshots withheld after a privacy finding (${reasons.join(", ")}); original images remain private.` : null;
}
