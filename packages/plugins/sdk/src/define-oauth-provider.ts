import type { OAuthProviderContribution } from "@paperclipai/shared";

/**
 * Identity helper for plugin authors contributing OAuth providers.
 *
 * Returns the contribution unchanged. The function exists purely for type
 * inference and editor autocomplete: declaring a contribution via
 * `defineOAuthProvider({...})` constrains the literal to
 * {@link OAuthProviderContribution} so authors get errors before the host
 * runs Zod validation at registration time.
 */
export function defineOAuthProvider<T extends OAuthProviderContribution>(
  contribution: T,
): T {
  return contribution;
}
