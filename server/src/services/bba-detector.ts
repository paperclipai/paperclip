import type { FailureClass } from "./bba-memory/types.js";

const PATTERNS: Array<{ re: RegExp; cls: FailureClass }> = [
  { re: /navigation timeout|timed out|net::err_timed_out/i, cls: "NAVIGATION_TIMEOUT" },
  { re: /network|net::|fetch failed|ECONNREFUSED/i, cls: "NETWORK_ERROR" },
  { re: /captcha/i, cls: "CAPTCHA_VISIBLE" },
  { re: /otp|one.time.pas/i, cls: "OTP_REQUIRED" },
  { re: /wrong.cred|invalid.password|incorrect.pass/i, cls: "WRONG_CREDS" },
  { re: /rate.limit|too many req/i, cls: "RATE_LIMITED" },
  { re: /session.not.detect|not authenticated/i, cls: "SESSION_NOT_DETECTED" },
  { re: /browser.crash|target closed|session.closed/i, cls: "BROWSER_CRASH" },
  { re: /selector.not.found|no element/i, cls: "SELECTOR_NOT_FOUND" },
];

export async function classifyFailure({ errorMessage }: { errorMessage: string }): Promise<FailureClass> {
  for (const { re, cls } of PATTERNS) {
    if (re.test(errorMessage)) return cls;
  }
  return "UNKNOWN";
}
