import { ADAPTER_AUTH_MISSING_CHECK_CODE, type AdapterEnvironmentTestResult } from "@paperclipai/shared";

export const ONBOARDING_CONNECTION_TEST_TIMEOUT_MS = 120_000;

/**
 * Whether an adapter environment test result blocks creating the onboarding
 * agent. True on `status === "fail"` and on `warn`/`pass` results carrying
 * `ADAPTER_AUTH_MISSING_CHECK_CODE`.
 */
export function blocksAgentCreate(result: AdapterEnvironmentTestResult): boolean {
  if (result.status === "fail") return true;
  return result.checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE);
}

/** Bound the entire check, including environment preparation and response parsing. */
export async function runOnboardingConnectionTest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("The connection test took too long. Try connecting again.");
      reject(error);
      controller.abort(error);
    }, ONBOARDING_CONNECTION_TEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}
