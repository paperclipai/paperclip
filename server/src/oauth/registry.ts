import type { OAuthProviderConfig } from "./provider-config.js";
import type { RegisteredProvider, ProviderShape } from "./types.js";
import { buildDefaultShape } from "./default-shape.js";
import { logger } from "../middleware/logger.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly env: Record<string, string | undefined>;

  constructor(opts: { env: Record<string, string | undefined> }) {
    this.env = opts.env;
  }

  register(
    config: OAuthProviderConfig,
    source: "yaml" | "plugin",
    shapeOverride?: ProviderShape,
  ): void {
    const clientId = this.env[config.clientCredentials.clientIdEnv];
    const clientSecret = this.env[config.clientCredentials.clientSecretEnv];
    if (!clientId || !clientSecret) {
      logger.warn(
        { provider: config.id, source },
        "OAuth provider env vars unset; skipping registration",
      );
      return;
    }

    const existing = this.providers.get(config.id);
    if (existing && existing.source === "yaml" && source === "plugin") {
      logger.warn(
        { provider: config.id },
        "plugin contribution shadowed by yaml — plugin skipped",
      );
      return;
    }
    if (existing && source === "yaml") {
      logger.warn(
        { provider: config.id },
        "yaml provider replaces previously-registered entry",
      );
    }

    const defaultShape = buildDefaultShape({
      accountIdField: config.accountIdField,
      accountLabelField: config.accountLabelField,
    });
    const shape: ProviderShape = {
      parseTokenResponse:
        shapeOverride?.parseTokenResponse ?? defaultShape.parseTokenResponse,
      parseAccountInfo:
        shapeOverride?.parseAccountInfo ?? defaultShape.parseAccountInfo,
    };

    this.providers.set(config.id, {
      config,
      clientId,
      clientSecret,
      shape,
      source,
    });
  }

  get(id: string): RegisteredProvider | undefined {
    return this.providers.get(id);
  }

  list(): RegisteredProvider[] {
    return Array.from(this.providers.values());
  }
}
