import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { OAuthProviderConfigSchema } from "./provider-config.js";
import type { ProviderRegistry } from "./registry.js";
import { logger } from "../middleware/logger.js";

/**
 * Validate and register OAuth provider contributions emitted by plugin
 * manifests. Only manifests whose `kind` is `oauth_provider` or `composite`
 * are inspected; everything else is ignored.
 *
 * Each contribution's `config` is parsed through the same Zod schema the
 * YAML loader uses, so plugins cannot bypass validation. A failed parse
 * throws synchronously — this is treated as a configuration error and is
 * surfaced loudly so plugins ship correct configs before installation.
 */
export function registerPluginContributions(
  registry: ProviderRegistry,
  manifests: PaperclipPluginManifestV1[],
): void {
  for (const manifest of manifests) {
    if (manifest.kind !== "oauth_provider" && manifest.kind !== "composite") {
      if (manifest.oauthProviders && manifest.oauthProviders.length > 0) {
        logger.warn(
          { plugin: manifest.id, kind: manifest.kind },
          "manifest has oauthProviders but kind is not 'oauth_provider' or 'composite'; contributions skipped",
        );
      }
      continue;
    }
    const contributions = manifest.oauthProviders ?? [];
    for (const c of contributions) {
      const result = OAuthProviderConfigSchema.safeParse(c.config);
      if (!result.success) {
        logger.error(
          {
            plugin: manifest.id,
            providerId: c.config.id,
            issues: result.error.issues,
          },
          "plugin OAuth contribution failed validation",
        );
        throw new Error(
          `plugin ${manifest.id} contributed invalid OAuth provider ${c.config.id}: ${result.error.message}`,
        );
      }
      registry.register(result.data, "plugin", c.shape);
    }
  }
}
