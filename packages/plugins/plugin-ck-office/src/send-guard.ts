/**
 * Outbound mail safety — architectural, not prompt-based.
 *
 * Rules (owner 2026-07-12):
 *  1) Test/experiment/debug content NEVER leaves to anyone except Alan's own addresses.
 *  2) Venue/live sends require CK_ESPO_SEND_LIVE=1 AND non-test content.
 *  3) Default is TEST-LOCKED (redirect to alan@treshermanos.ch).
 */

export const ALAN_PRIMARY_EMAIL = "alan@treshermanos.ch";

/** Addresses that may receive test/experiment traffic. */
export const ALAN_SAFE_RECIPIENTS: readonly string[] = [
  "alan@treshermanos.ch",
  "alan@treshermanos.com",
];

const TEST_TO_DEFAULT = process.env.CK_ESPO_SEND_TEST_TO || ALAN_PRIMARY_EMAIL;
let configuredLiveSend: boolean | null = null;

/** Patterns that mark content as test/experiment — must never reach a venue. */
const TEST_CONTENT_PATTERNS: RegExp[] = [
  /\b(kurzer\s+)?test\b/i,
  /\btesting\b/i,
  /\bexperiment(?:al)?\b/i,
  /\bdebug\b/i,
  /\bsmoke\s*test\b/i,
  /\bapprove\s+path\s+fix\b/i,
  /\bbitte\s+ignorieren\b/i,
  /\bplease\s+ignore\b/i,
  /\bdo\s+not\s+read\b/i,
  /\bignore\s+this\s+(email|mail|message)\b/i,
  /\[test[\u2192>]/i,
  /^test[\s:\-–—]/i,
];

export function normalizeEmail(addr: string): string {
  return String(addr || "").trim().toLowerCase();
}

export function isAlanSafeRecipient(addr: string): boolean {
  const e = normalizeEmail(addr);
  if (!e) return false;
  if (ALAN_SAFE_RECIPIENTS.includes(e)) return true;
  // Any @treshermanos.ch|.com address Alan controls
  return /@treshermanos\.(ch|com)$/.test(e);
}

export function looksLikeTestOrExperiment(subject: string, body: string): boolean {
  const hay = `${subject || ""}\n${body || ""}`;
  return TEST_CONTENT_PATTERNS.some((re) => re.test(hay));
}

/** Live venue delivery is opt-in only. Default OFF. */
export function espSendLiveEnabled(): boolean {
  return configuredLiveSend ?? process.env.CK_ESPO_SEND_LIVE === "1";
}

/**
 * Plugin workers deliberately do not inherit arbitrary host environment
 * variables. Set the operator-controlled instance setting during worker setup
 * so the approval-gated send path can actually deliver live when enabled.
 */
export function setEspoSendLiveEnabled(enabled: boolean | null): void {
  configuredLiveSend = enabled;
}

export function testInbox(): string {
  const configured = normalizeEmail(process.env.CK_ESPO_SEND_TEST_TO || "");
  if (configured && isAlanSafeRecipient(configured)) return configured;
  return TEST_TO_DEFAULT;
}

export type SendRoute =
  | {
      ok: true;
      requestedTo: string;
      deliverTo: string;
      subject: string;
      testLock: boolean;
      liveSend: boolean;
      blockedTestToVenue: boolean;
      note?: string;
    }
  | { ok: false; error: string };

/**
 * Resolve where an Espo outbound email may actually be delivered.
 * Throws no errors — returns { ok: false } when the send must be refused entirely.
 */
export function resolveEspoSendRoute(opts: {
  to: string;
  subject: string;
  body: string;
}): SendRoute {
  const requestedTo = normalizeEmail(opts.to);
  if (!requestedTo) return { ok: false, error: "recipient required" };

  const subject = String(opts.subject || "");
  const body = String(opts.body || "");
  const isTest = looksLikeTestOrExperiment(subject, body);

  // HARD STOP: test content to a non-Alan address is never allowed.
  if (isTest && !isAlanSafeRecipient(requestedTo)) {
    return {
      ok: false,
      error:
        `REFUSED: message looks like a test/experiment and cannot be sent to '${requestedTo}'. ` +
        `Only Alan's own addresses (${ALAN_SAFE_RECIPIENTS.join(", ")}) may receive test mail. ` +
        `Use alan@treshermanos.ch for verification.`,
    };
  }

  // Alan-safe recipient: deliver directly (test or real).
  if (isAlanSafeRecipient(requestedTo)) {
    return {
      ok: true,
      requestedTo,
      deliverTo: requestedTo,
      subject,
      testLock: false,
      liveSend: false,
      blockedTestToVenue: false,
      note: isTest ? "test-to-alan" : "alan-direct",
    };
  }

  // Venue / external recipient: live only when explicitly armed AND not test content.
  if (espSendLiveEnabled() && !isTest) {
    return {
      ok: true,
      requestedTo,
      deliverTo: requestedTo,
      subject,
      testLock: false,
      liveSend: true,
      blockedTestToVenue: false,
    };
  }

  // Default: test-lock redirect to Alan's inbox.
  const deliverTo = testInbox();
  return {
    ok: true,
    requestedTo,
    deliverTo,
    subject: `[TEST→${requestedTo}] ${subject}`.slice(0, 250),
    testLock: true,
    liveSend: false,
    blockedTestToVenue: false,
    note: "test-lock-redirect",
  };
}
