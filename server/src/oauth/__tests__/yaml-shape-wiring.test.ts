import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderRegistry } from "../registry.js";
import { KNOWN_SHAPES } from "../shapes/index.js";
import type { OAuthProviderConfig } from "../provider-config.js";
import type { ProviderShape } from "../types.js";
import { logger } from "../../middleware/logger.js";

/**
 * Mirrors the resolution helper in `app.ts`: given a YAML config with an
 * optional `shape` field, look the shape up in a static registry and pass it
 * to `ProviderRegistry.register`. Skips registration with an error log when
 * the shape name is not in the registry.
 */
function registerWithShape(
  registry: ProviderRegistry,
  cfg: OAuthProviderConfig,
  shapes: Readonly<Record<string, ProviderShape>>,
): void {
  if (cfg.shape !== undefined) {
    const shape = shapes[cfg.shape];
    if (!shape) {
      logger.error(
        { provider: cfg.id, shape: cfg.shape },
        "OAuth provider references unknown shape module; skipping",
      );
      return;
    }
    registry.register(cfg, "yaml", shape);
    return;
  }
  registry.register(cfg, "yaml");
}

const baseCfg = (id: string): OAuthProviderConfig => ({
  id,
  displayName: id,
  clientCredentials: {
    clientIdEnv: `${id.toUpperCase().replace(/-/g, "_")}_ID`,
    clientSecretEnv: `${id.toUpperCase().replace(/-/g, "_")}_SECRET`,
  },
  endpoints: {
    authorize: "https://x.example/a",
    token: "https://x.example/t",
    accountInfo: "https://x.example/u",
  },
  scopes: { default: [], offered: [] },
  pkce: "required",
  authMethod: "post",
  responseFormat: "json",
  accountIdField: "id",
  accountLabelField: "name",
  refresh: { supported: false },
});

describe("yaml shape wiring", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("KNOWN_SHAPES exposes slack and microsoft", () => {
    expect(KNOWN_SHAPES.slack).toBeDefined();
    expect(KNOWN_SHAPES.microsoft).toBeDefined();
  });

  it("registers a provider with the slack shape when shape: slack is set", () => {
    const env = { SLACK_ID: "id", SLACK_SECRET: "s" } as Record<string, string>;
    const registry = new ProviderRegistry({ env });
    const cfg: OAuthProviderConfig = {
      ...baseCfg("slack"),
      shape: "slack",
    };

    registerWithShape(registry, cfg, KNOWN_SHAPES);

    const reg = registry.get("slack");
    expect(reg).toBeDefined();
    // The slack shape parses the nested `authed_user` form — a probe the
    // default shape (which only reads top-level `access_token`) cannot satisfy.
    const parsed = reg!.shape.parseTokenResponse!({
      authed_user: { access_token: "xoxp-USER", scope: "chat:write" },
    });
    expect(parsed.accessToken).toBe("xoxp-USER");
    expect(parsed.scope).toEqual(["chat:write"]);
  });

  it("skips a provider whose shape is unknown and logs an error", () => {
    const env = { GHOST_ID: "id", GHOST_SECRET: "s" } as Record<string, string>;
    const registry = new ProviderRegistry({ env });
    const cfg: OAuthProviderConfig = {
      ...baseCfg("ghost"),
      shape: "ghost",
    };

    registerWithShape(registry, cfg, KNOWN_SHAPES);

    expect(registry.get("ghost")).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0]!;
    expect(args[0]).toMatchObject({ provider: "ghost", shape: "ghost" });
  });

  it("registers without a shape override when shape is absent (default shape applies)", () => {
    const env = { PLAIN_ID: "id", PLAIN_SECRET: "s" } as Record<string, string>;
    const registry = new ProviderRegistry({ env });
    const cfg = baseCfg("plain");

    registerWithShape(registry, cfg, KNOWN_SHAPES);

    const reg = registry.get("plain");
    expect(reg).toBeDefined();
    // Default shape consumes RFC-6749 flat token responses.
    const parsed = reg!.shape.parseTokenResponse!({
      access_token: "T",
      expires_in: 60,
      scope: "a b",
    });
    expect(parsed.accessToken).toBe("T");
    expect(parsed.scope).toEqual(["a", "b"]);
  });
});
