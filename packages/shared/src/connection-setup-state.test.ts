import { describe, expect, it } from "vitest";
import {
  CONNECTABLE_APP_DEFINITIONS,
  getAvailableConnectionMethods,
  getConnectableAppDefinition,
} from "./app-definitions.js";
import {
  connectionSetupStateForApp,
  connectionSetupVerbForApp,
  type ConnectionSetupState,
} from "./connection-setup-state.js";

/**
 * These assert against the shipped catalog rather than fixtures, because the
 * claim being protected is about real connectors: the gallery card's verb has
 * to match what the connect screen then asks for.
 */
describe("connectionSetupStateForApp", () => {
  it("puts one-click OAuth connectors in the authorize state", () => {
    for (const slug of ["notion", "linear", "sentry", "stripe", "jira"]) {
      expect(connectionSetupStateForApp(getConnectableAppDefinition(slug)), slug).toBe("authorize");
    }
  });

  it.each(["gmail", "asana"])("follows %s ownership availability rather than the catalog order", (slug) => {
    // These providers publish a Paperclip-managed method, but it is
    // `platform_shared` and therefore unavailable until an operator configures
    // the cloud connector. The state has to reflect what this instance can
    // actually do, or the card promises one click and the screen shows a form.
    const app = getConnectableAppDefinition(slug)!;
    expect(connectionSetupStateForApp(app)).toBe("register");
    expect(
      connectionSetupStateForApp({
        ...app,
        ownershipAvailability: { ...app.ownershipAvailability, platform_shared: true },
      }),
    ).toBe("authorize");
  });

  it("reserves register for providers that genuinely cannot issue a client", () => {
    for (const slug of ["box", "xero"]) {
      expect(connectionSetupStateForApp(getConnectableAppDefinition(slug)), slug).toBe("register");
    }
  });

  it("treats an API key as a paste, and says so on the card", () => {
    for (const slug of ["honcho", "mem0", "openrouter"]) {
      expect(connectionSetupStateForApp(getConnectableAppDefinition(slug)), slug).toBe("paste");
      expect(connectionSetupVerbForApp(getConnectableAppDefinition(slug)), slug).toBe("Add key");
    }
  });

  it("reaches instant only when the catalog already knows the endpoint", () => {
    // Composio and Context7 ship a fixed server URL and ask for nothing.
    expect(connectionSetupStateForApp(getConnectableAppDefinition("composio"))).toBe("instant");
    expect(connectionSetupStateForApp(getConnectableAppDefinition("context7"))).toBe("instant");
  });

  it("does not promise instant for a provider-generated URL", () => {
    // Zapier, Arcade and Executor declare no server URL: the operator brings
    // one. Calling these instant is the mistake this helper exists to prevent.
    for (const slug of ["zapier", "arcade", "executor"]) {
      expect(connectionSetupStateForApp(getConnectableAppDefinition(slug)), slug).toBe("paste");
    }
  });

  it("does not promise instant for a templated endpoint", () => {
    // Shopify's URL has a {storeDomain} placeholder the operator fills in.
    expect(connectionSetupStateForApp(getConnectableAppDefinition("shopify"))).toBe("paste");
  });

  it("defaults the AI providers to their subscription sign-in", () => {
    for (const slug of ["anthropic", "openai", "xai"]) {
      expect(connectionSetupStateForApp(getConnectableAppDefinition(slug)), slug).toBe("authorize");
      expect(connectionSetupVerbForApp(getConnectableAppDefinition(slug)), slug).toBe("Connect");
    }
  });

  it("never says Add key for something that does not want a secret", () => {
    for (const app of CONNECTABLE_APP_DEFINITIONS) {
      if (connectionSetupVerbForApp(app) !== "Add key") continue;
      const wantsSecret = getAvailableConnectionMethods(app)
        .filter((method) => (method.purpose ?? "tool") !== "channel")
        .some((method) => (method.credentialFields?.length ?? 0) > 0);
      expect(wantsSecret, app.slug).toBe(true);
    }
  });

  it("resolves a state for every connectable tool connector", () => {
    const states = new Map<string, ConnectionSetupState | null>();
    for (const app of CONNECTABLE_APP_DEFINITIONS) {
      const hasToolMethod = app.methods.some((method) => (method.purpose ?? "tool") !== "channel");
      if (!hasToolMethod) continue;
      states.set(app.slug, connectionSetupStateForApp(app));
    }
    expect([...states].filter(([, state]) => state === null)).toEqual([]);
  });

  it("returns null rather than guessing for an unknown app", () => {
    expect(connectionSetupStateForApp(null)).toBeNull();
  });

  it("survives a gallery row that carries no method list", () => {
    // Rows are assembled from the gallery, live connections and custom
    // endpoints, so a row can reach a card without methods. Throwing here would
    // take the whole connectors page down with it.
    const partial = { slug: "mystery", name: "Mystery" } as never;
    expect(connectionSetupStateForApp(partial)).toBeNull();
    expect(connectionSetupVerbForApp(partial)).toBe("Connect");
  });
});
