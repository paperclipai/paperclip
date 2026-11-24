import { afterEach, beforeEach } from "vitest";

export function enableRunFailureReporting(): void {
  let previousMode: string | undefined;
  beforeEach(() => {
    previousMode = process.env.PAPERCLIP_SENTRY_RUN_FAILURES;
    process.env.PAPERCLIP_SENTRY_RUN_FAILURES = "unexpected";
  });
  afterEach(() => {
    if (previousMode === undefined) delete process.env.PAPERCLIP_SENTRY_RUN_FAILURES;
    else process.env.PAPERCLIP_SENTRY_RUN_FAILURES = previousMode;
  });
}
