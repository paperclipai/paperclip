/** Stripe key env resolution: test-prefixed vars win, then generic aliases (see root `.env.example`). */

export function trimEnv(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

export function resolveStripeKeysFromProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): { publishableKey: string | undefined; secretKey: string | undefined } {
  return {
    publishableKey:
      trimEnv(env.STRIPE_TEST_PUBLISHABLE_KEY) ?? trimEnv(env.STRIPE_PUBLISHABLE_KEY),
    secretKey: trimEnv(env.STRIPE_TEST_SECRET_KEY) ?? trimEnv(env.STRIPE_SECRET_KEY),
  };
}

/** Populate `STRIPE_PUBLISHABLE_KEY` / `STRIPE_SECRET_KEY` for libraries that read standard names. */
export function syncStripeStandardEnvFromResolved(
  env: NodeJS.ProcessEnv,
  resolved: { publishableKey: string | undefined; secretKey: string | undefined },
): void {
  if (resolved.publishableKey) env.STRIPE_PUBLISHABLE_KEY = resolved.publishableKey;
  if (resolved.secretKey) env.STRIPE_SECRET_KEY = resolved.secretKey;
}
