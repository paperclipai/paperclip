import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1, PluginStatus } from "@paperclipai/shared";
import { resolveHostFeaturesFromProvider } from "./host-features.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.paperclip-ee",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Paperclip EE",
  description: "Enterprise availability provider.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: ["ui.page.register"],
  entrypoints: { worker: "./dist/worker.js" },
  hostFeatures: {
    schemaVersion: 1,
    features: ["apps.named_mcp_gateways", "apps.access_profiles"],
  },
};

describe("host feature lifecycle resolver", () => {
  it("enables declared features only while canonical EE is ready", () => {
    expect(resolveHostFeaturesFromProvider({
      pluginKey: manifest.id,
      status: "ready",
      manifestJson: manifest,
    }).hostFeatures).toEqual(["apps.named_mcp_gateways", "apps.access_profiles"]);
  });

  it.each<PluginStatus>([
    "installed",
    "disabled",
    "error",
    "upgrade_pending",
    "uninstalled",
  ])("fails closed while EE is %s", (status) => {
    expect(resolveHostFeaturesFromProvider({
      pluginKey: manifest.id,
      status,
      manifestJson: manifest,
    }).hostFeatures).toEqual([]);
  });

  it("fails closed for a missing, unauthorized, or malformed provider", () => {
    expect(resolveHostFeaturesFromProvider(null).hostFeatures).toEqual([]);
    expect(resolveHostFeaturesFromProvider({
      pluginKey: "acme.paperclip-ee",
      status: "ready",
      manifestJson: { ...manifest, id: "acme.paperclip-ee" },
    }).hostFeatures).toEqual([]);
    expect(resolveHostFeaturesFromProvider({
      pluginKey: manifest.id,
      status: "ready",
      manifestJson: { ...manifest, hostFeatures: { schemaVersion: 1, features: ["apps.unknown"] } } as never,
    }).hostFeatures).toEqual([]);
  });
});
