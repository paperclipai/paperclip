import { describe, expect, it } from "vitest";
import { getConnectableAppDefinition } from "./app-definitions.js";
import { isConnectorFeatureEnabled, nativeConnectorRequiresCustomerOAuthApp } from "./connector-availability.js";
import { appDefinitionSchema } from "./validators/app-definition.js";
import { instanceExperimentalSettingsSchema } from "./validators/instance.js";

describe("connector availability", () => {
  const ordinary = getConnectableAppDefinition("notion")!;
  const gated = { ...ordinary, slug: "private-research", name: "Private Research", experimentalFeatureKey: "enableCases" as const };

  it("honors feature metadata for an arbitrary connector and leaves ungated connectors alone", () => {
    for (const settings of [undefined, null, {}, { enableCases: false }]) {
      expect(isConnectorFeatureEnabled(gated, settings)).toBe(false);
      expect(isConnectorFeatureEnabled(ordinary, settings)).toBe(true);
    }
    expect(isConnectorFeatureEnabled(gated, { enablePaperclipNotebook: true })).toBe(false);
    expect(isConnectorFeatureEnabled(gated, { enableCases: true })).toBe(true);
  });

  it("validates the feature key and declares Notebook's hidden rollout in its manifest", () => {
    expect(appDefinitionSchema.parse(gated).experimentalFeatureKey).toBe("enableCases");
    expect(appDefinitionSchema.safeParse({ ...gated, experimentalFeatureKey: "typoFeature" }).success).toBe(false);
    const notebook = getConnectableAppDefinition("paperclip-notebook")!;
    expect(notebook.experimentalFeatureKey).toBe("enablePaperclipNotebook");
    expect(isConnectorFeatureEnabled(notebook, {})).toBe(false);
    expect(isConnectorFeatureEnabled(notebook, { enablePaperclipNotebook: true })).toBe(true);
  });

  it("gates only the built-in Google Workspace connector, default off, while verification is pending", () => {
    const workspace = getConnectableAppDefinition("google-workspace")!;
    expect(workspace.experimentalFeatureKey).toBe("enableGoogleWorkspaceConnector");
    expect(isConnectorFeatureEnabled(workspace, instanceExperimentalSettingsSchema.parse({}))).toBe(false);
    expect(isConnectorFeatureEnabled(workspace, { enableGoogleWorkspaceConnector: true })).toBe(true);
    // Saved per-service Google connections keep working; only the unified entry is gated.
    for (const slug of ["gmail", "google-drive", "google-calendar", "google-docs", "google-sheets"]) {
      expect(getConnectableAppDefinition(slug)?.experimentalFeatureKey).toBeUndefined();
    }
  });
});

describe("Slack tool connection guidance", () => {
  // BUG-06: Slack's MCP server has no dynamic client registration, so this method needs a
  // customer-created Slack app. Its guidance must say so and link to Slack's app settings.
  it("describes the customer-created Slack app honestly and links to Slack app settings", () => {
    const method = getConnectableAppDefinition("slack")!.methods.find((candidate) => candidate.key === "mcp-oauth")!;
    expect(method.whenToUse).not.toMatch(/quickest/i);
    expect(method.consoleLinks?.register).toBe("https://api.slack.com/apps");
  });
});

describe("native connectors that need a customer-created OAuth app", () => {
  it("flags Slack only while its chat setup is unavailable", () => {
    const slack = getConnectableAppDefinition("slack")!;
    expect(nativeConnectorRequiresCustomerOAuthApp(slack, {})).toBe(true);
    expect(nativeConnectorRequiresCustomerOAuthApp(slack, { enableChatConnectors: true })).toBe(false);
  });

  it("does not flag connectors with a managed, dynamic-registration, or credential path", () => {
    // Asana declares a Paperclip Cloud managed method, so it is never flagged,
    // even while that method's broker profile is unavailable.
    const asana = getConnectableAppDefinition("asana")!;
    expect(nativeConnectorRequiresCustomerOAuthApp(asana, {})).toBe(false);
    expect(nativeConnectorRequiresCustomerOAuthApp({ ...asana, ownershipAvailability: {
      platform_shared: true, platform_provisioned: false, customer: true, dcr: true,
    } }, {})).toBe(false);
    for (const slug of ["notion", "linear", "github"]) {
      expect(nativeConnectorRequiresCustomerOAuthApp(getConnectableAppDefinition(slug)!, {}), slug).toBe(false);
    }
    expect(nativeConnectorRequiresCustomerOAuthApp(null, {})).toBe(false);
  });
});
