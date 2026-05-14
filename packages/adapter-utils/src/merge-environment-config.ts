/**
 * Merge an adapter's per-agent config with an environment's config (env wins).
 *
 * - Top-level only — no deep merge. Nested objects (nodeSelector, resources)
 *   override wholesale; adapter writers can deep-merge themselves where
 *   semantically appropriate.
 * - environmentConfig keys with null/undefined values are skipped so the
 *   adapter's default isn't blown away by a partially-populated environment.
 * - environmentConfig === null|undefined returns adapterConfig unchanged
 *   (zero-cost path for agents that have no env assigned).
 */
export function mergeEnvironmentConfig<
  A extends Record<string, unknown>,
  E extends Record<string, unknown>,
>(adapterConfig: A, environmentConfig: E | undefined | null): A & E {
  if (!environmentConfig) return adapterConfig as A & E;
  const merged: Record<string, unknown> = { ...adapterConfig };
  for (const [key, value] of Object.entries(environmentConfig)) {
    if (value === null || value === undefined) continue;
    merged[key] = value;
  }
  return merged as A & E;
}
